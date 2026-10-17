import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatAgentModel, ClaudeAgentModel, claudeMessages, newAgentSession, runAgentTurn, sessionTitle, textCalls, type AgentEvent, type AgentModel, type AgentReply, type AgentTool } from '../src';

/** A model that answers from a script, recording what it was sent. */
function scripted(replies: AgentReply[], free = false): AgentModel & { seen: { messages: unknown[] }[] } {
  const seen: { messages: unknown[] }[] = [];
  return {
    name: 'Test AI',
    free,
    provider: 'test',
    seen,
    async reply(req) {
      seen.push({ messages: structuredClone(req.messages) });
      const r = replies.shift() ?? { text: 'Done.', calls: [], stop: 'end' };
      if (r.text) req.onText?.(r.text);
      return r;
    },
  };
}

const log: string[] = [];
const tools: AgentTool[] = [
  { name: 'look', description: 'Look', group: 'read', writes: false, input: z.object({ what: z.string(), count: z.number().int().nullable().optional() }), summary: (i) => `Look at ${i.what}`, run: (i) => (log.push(`look ${i.what} ${i.count}`), { data: { saw: i.what, count: i.count } }) },
  { name: 'change', description: 'Change', group: 'quest', writes: true, input: z.object({ to: z.string() }), summary: (i) => `Change to ${i.to}`, run: (i) => (log.push(`change ${i.to}`), { data: 'ok', link: { tab: 'quest', key: 'k', label: 'The quest' } }) },
  { name: 'broken', description: 'Fails', group: 'read', writes: false, input: z.object({}), summary: () => 'Break', run: () => { throw new Error('it broke'); } },
];

const call = (name: string, input: unknown, id = name) => ({ id, name, input });

describe('the AI workspace loop', () => {
  it('runs the tools the AI asks for, sends the results back and ends on its answer', async () => {
    log.length = 0;
    const model = scripted([
      { text: 'Let me look.', calls: [call('look', { what: 'quests', count: '3' })], stop: 'tools' },
      { text: 'There are three.', calls: [], stop: 'end' },
    ]);
    const s = newAgentSession();
    const events: AgentEvent[] = [];
    const r = await runAgentTurn(model, s, { text: 'How many quests?', context: 'Editing My.esp' }, tools, { onEvent: (e) => events.push(e) });
    expect(r).toMatchObject({ text: 'There are three.', changes: [] });
    // Quoted numbers from small models are read as numbers.
    expect(log).toEqual(['look quests 3']);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(s.messages[0]).toEqual({ role: 'user', text: 'How many quests?', context: 'Editing My.esp' });
    const results = (s.messages[2] as any).results;
    expect(results[0]).toMatchObject({ id: 'look', status: 'done', summary: 'Look at quests', writes: false });
    expect(JSON.parse(results[0].content)).toEqual({ saw: 'quests', count: 3 });
    expect(events.map((e) => e.type)).toEqual(['text', 'call', 'result', 'text']);
  });

  it('tells the AI about wrong input, unknown tools and failures instead of stopping', async () => {
    const model = scripted([{ text: '', calls: [call('look', { count: 2 }, 'a'), call('nope', {}, 'b'), call('broken', {}, 'c')], stop: 'tools' }]);
    const s = newAgentSession();
    await runAgentTurn(model, s, { text: 'x' }, tools);
    const [a, b, c] = (s.messages[2] as any).results;
    expect(a).toMatchObject({ status: 'error', isError: true });
    expect(a.content).toContain("what: Invalid input");
    expect(a.content).toContain('It takes:');
    expect(b.content).toBe('There is no tool called "nope".');
    expect(c).toMatchObject({ status: 'error', content: 'Failed: it broke' });
  });

  it("doesn't run a call again that already failed this turn, and says so", async () => {
    log.length = 0;
    const model = scripted([
      { text: '', calls: [call('broken', {}, 'a')], stop: 'tools' },
      { text: '', calls: [call('broken', {}, 'b'), call('look', { what: 'x' }, 'c')], stop: 'tools' },
      { text: '', calls: [call('look', { what: 'x' }, 'd')], stop: 'tools' },
    ]);
    const s = newAgentSession();
    await runAgentTurn(model, s, { text: 'x' }, tools);
    const second = (s.messages[4] as any).results;
    expect(second[0]).toMatchObject({ status: 'error' });
    expect(second[0].content).toMatch(/already made exactly this call this turn and it failed:\nFailed: it broke\nDon't repeat it/);
    // A reading call that worked isn't repeated either: its result is already there.
    expect(log).toEqual(['look x undefined']);
    expect((s.messages[6] as any).results[0].content).toMatch(/already made exactly this call this turn, and its result is above/);
    // After a change, the same look is run again.
    log.length = 0;
    const again = scripted([
      { text: '', calls: [call('look', { what: 'x' }, 'a')], stop: 'tools' },
      { text: '', calls: [call('change', { to: 'y' }, 'b')], stop: 'tools' },
      { text: '', calls: [call('look', { what: 'x' }, 'c')], stop: 'tools' },
    ]);
    await runAgentTurn(again, newAgentSession(), { text: 'x' }, tools);
    expect(log).toEqual(['look x undefined', 'change y', 'look x undefined']);
  });

  it('shows only the offered tools, adds a topic when asked, and still runs any tool by name', async () => {
    log.length = 0;
    const seenTools: string[][] = [];
    const replies: AgentReply[] = [
      { text: '', calls: [call('more_tools', { topic: 'changes' }, 'a')], stop: 'tools' },
      { text: '', calls: [call('change', { to: 'x' }, 'b'), call('broken', {}, 'c')], stop: 'tools' },
      { text: 'Done.', calls: [], stop: 'end' },
    ];
    const model: AgentModel = { name: 'Small', free: true, provider: 'test', reply: async (req) => (seenTools.push(req.tools.map((t) => t.name)), replies.shift()!) };
    const s = newAgentSession();
    const r = await runAgentTurn(model, s, { text: 'x' }, tools, { offer: { tools: [tools[0]!], topics: { changes: { about: 'changing things', tools: [tools[1]!] } } } });
    expect(seenTools[0]).toEqual(['look', 'more_tools']);
    expect(seenTools[1]).toEqual(['look', 'change', 'more_tools']);
    expect((s.messages[2] as any).results[0].content).toBe('You can now also use: change.');
    // "broken" was never offered, but a model that knows its name can still use it.
    expect((s.messages[4] as any).results.map((x: any) => x.status)).toEqual(['done', 'error']);
    expect(r.changes).toEqual(['Change to x']);
  });

  it('ends a turn that keeps repeating the same calls', async () => {
    const same = () => ({ text: '', calls: [call('look', { what: 'x' }, `c${Math.random()}`)], stop: 'tools' as const });
    const model = scripted([same(), same(), same(), same(), same(), same(), same()], true);
    const r = await runAgentTurn(model, newAgentSession(), { text: 'x' }, tools);
    expect(r.error).toMatch(/kept repeating the same calls/);
    // One look, three warnings, then the stop: not all ten rounds.
    expect(model.seen.length).toBe(5);
  });

  it('makes each change one labelled step, asks first when told to, and lists what changed', async () => {
    log.length = 0;
    const labels: string[] = [];
    const model = scripted([{ text: '', calls: [call('change', { to: 'A' }, '1'), call('change', { to: 'B' }, '2')], stop: 'tools' }]);
    const s = newAgentSession();
    const r = await runAgentTurn(model, s, { text: 'change it' }, tools, {
      transaction: async (label, fn) => (labels.push(label), fn()),
      approve: async (c) => c.id === '1',
    });
    expect(log).toEqual(['change A']);
    expect(labels).toEqual(['AI: Change to A']);
    expect(r.changes).toEqual(['Change to A']);
    const [one, two] = (s.messages[2] as any).results;
    expect(one).toMatchObject({ status: 'done', link: { tab: 'quest', key: 'k' } });
    expect(two).toMatchObject({ status: 'declined', isError: true });
  });

  it("sends the editor's checks back once after changes, so the AI can fix what it broke", async () => {
    const model = scripted([
      { text: '', calls: [call('change', { to: 'A' })], stop: 'tools' },
      { text: 'Changed.', calls: [], stop: 'end' },
      { text: 'Fixed the stage too.', calls: [], stop: 'end' },
    ]);
    let checks = 0;
    const s = newAgentSession();
    const r = await runAgentTurn(model, s, { text: 'go' }, tools, { checkChanges: async () => (checks++, ['Stage 20 is never reached']) });
    expect(checks).toBe(1);
    expect(r.text).toBe('Fixed the stage too.');
    const fb = s.messages.find((m) => m.role === 'user' && m.text.startsWith("The editor's checks"));
    expect(fb).toBeDefined();
    expect((fb as any).text).toContain('- Stage 20 is never reached');
  });

  it('limits the tool calls in a turn', async () => {
    const many = Array.from({ length: 20 }, (_, i) => call('look', { what: `w${i}` }, `c${i}`));
    const model = scripted([{ text: '', calls: many, stop: 'tools' }], true);
    const s = newAgentSession();
    await runAgentTurn(model, s, { text: 'x' }, tools);
    const results = (s.messages[2] as any).results;
    expect(results.filter((r: any) => r.status === 'done')).toHaveLength(15);
    expect(results[15].content).toContain('used its 15 tool calls');
  });

  it('answers every call when stopped, so the conversation can go on', async () => {
    const abort = new AbortController();
    const model = scripted([{ text: '', calls: [call('look', { what: 'a' }, 'x')], stop: 'tools' }]);
    model.reply = async () => (abort.abort(), { text: '', calls: [call('look', { what: 'a' }, 'x')], stop: 'tools' });
    const s = newAgentSession();
    const r = await runAgentTurn(model, s, { text: 'x' }, tools, { signal: abort.signal });
    expect(r.error).toBe('Stopped.');
    expect(s.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ id: 'x', status: 'stopped' }] });
  });

  it('runs nothing from a declined answer', async () => {
    log.length = 0;
    const model = scripted([{ text: '', calls: [call('change', { to: 'A' })], stop: 'refusal' }]);
    const s = newAgentSession();
    const r = await runAgentTurn(model, s, { text: 'x' }, tools);
    expect(log).toEqual([]);
    expect(r.error).toMatch(/declined/);
    expect(s.messages.at(-1)).toMatchObject({ role: 'tool' });
  });

  it('titles a conversation from its first message', () => {
    expect(sessionTitle('  What is in   my plugin? ')).toBe('What is in my plugin?');
    expect(sessionTitle('x'.repeat(10) + ' ' + 'word '.repeat(20)).length).toBeLessThanOrEqual(61);
  });
});

describe('talking to Claude', () => {
  it("sends Claude's own answers back unchanged, with tool results as tool_result blocks", () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'look', input: { what: 'x' } }];
    const msgs = claudeMessages([
      { role: 'user', text: 'Hi', context: 'Editing My.esp' },
      { role: 'assistant', text: '', calls: [{ id: 't1', name: 'look', input: { what: 'x' } }], provider: 'claude', raw },
      { role: 'tool', results: [{ id: 't1', name: 'look', content: '{}', summary: 's', writes: false, status: 'done' }, { id: 't2', name: 'x', content: 'no', isError: true, summary: 's', writes: false, status: 'error' }] },
      // Another AI's answer, rebuilt as text and tool_use.
      { role: 'assistant', text: 'From Ollama', calls: [], provider: 'ollama' },
    ]);
    expect(msgs[0]).toEqual({ role: 'user', content: 'Hi\n\n<editor_context>\nEditing My.esp\n</editor_context>' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: raw });
    expect(msgs[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }, { type: 'tool_result', tool_use_id: 't2', content: 'no', is_error: true }] });
    expect(msgs[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'From Ollama' }] });
  });

  it('streams text, reads tool calls, and caches the rules and tools', async () => {
    let params: any;
    const content = [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu', name: 'look', input: { what: 'q' } }];
    const fake = {
      beta: {
        messages: {
          stream: (p: any) => {
            params = p;
            const handlers: ((d: string) => void)[] = [];
            return { on: (_: string, h: (d: string) => void) => handlers.push(h), finalMessage: async () => (handlers.forEach((h) => h('Looking.')), { content, stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: null } }) };
          },
        },
      },
    };
    const m = new ClaudeAgentModel('', fake as any);
    const deltas: string[] = [];
    const r = await m.reply({ system: 'rules', messages: [{ role: 'user', text: 'hi' }], tools, onText: (d) => deltas.push(d) });
    expect(r).toEqual({ text: 'Looking.', calls: [{ id: 'tu', name: 'look', input: { what: 'q' } }], stop: 'tools', raw: content, usage: { input: 100, output: 20, cacheRead: 5000, cacheWrite: 0 } });
    expect(deltas).toEqual(['Looking.']);
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(params.tools[0]).toMatchObject({ name: 'look', eager_input_streaming: true, input_schema: { type: 'object', properties: { what: { type: 'string' } } } });
    expect(params.tools[0].input_schema.$schema).toBeUndefined();
  });
});

describe('talking to a free AI', () => {
  function server(...answers: ({ status?: number; text?: string; json?: unknown })[]) {
    const calls: { url: string; body: any }[] = [];
    const fetch = async (url: string, init: { body?: string }) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
      const a = url.endsWith('/api/show') ? { json: { model_info: { 'x.context_length': 32768 } } } : (answers.shift() ?? { json: {} });
      return { ok: !a.status || a.status < 400, status: a.status ?? 200, json: async () => a.json, text: async () => a.text ?? '' };
    };
    return { calls, fetch };
  }

  it('mends a number past its limit and an empty list where none is meant', async () => {
    log.length = 0;
    const shape: AgentTool = { name: 'shape', description: '', group: 'world', writes: false, input: z.object({ width: z.number().min(64).max(4096).nullable().optional(), points: z.array(z.number()).min(1).nullable().optional() }), summary: () => 'Shape', run: (i) => (log.push(JSON.stringify(i)), { data: 'ok' }) };
    const model = scripted([{ text: '', calls: [call('shape', { width: 5, points: [] }, 'a'), call('shape', { width: 99999 }, 'b')], stop: 'tools' }]);
    const s = newAgentSession();
    await runAgentTurn(model, s, { text: 'x' }, [shape]);
    expect(log).toEqual(['{"width":64,"points":null}', '{"width":4096}']);
  });

  it('takes tool calls a model wrote out as text', () => {
    const r = textCalls('Let me look.\n<tool_call>\n{"name": "look", "arguments": {"what": "mead"}}\n</tool_call>\n<tool_call>{"name": "nope", "arguments": {}}</tool_call>', tools);
    expect(r!.calls.map((c) => [c.name, c.input])).toEqual([['look', { what: 'mead' }]]);
    // An unknown tool stays as text; the call that was taken is removed from it.
    expect(r!.text).toBe('Let me look.\n\n<tool_call>{"name": "nope", "arguments": {}}</tool_call>');
    expect(textCalls('No calls here.', tools)).toBeNull();
  });

  it("calls the page's fetch as a plain function, as browsers require", async () => {
    const real = globalThis.fetch;
    // Like a browser: fetch run as a method of another object fails ("Illegal invocation").
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'Hi.' }, finish_reason: 'stop' }] }), { status: 200 }));
    } as typeof fetch;
    try {
      const m = new ChatAgentModel({ kind: 'openai', url: 'http://127.0.0.1:1/v1', model: 'x' });
      expect((await m.reply({ system: 's', messages: [{ role: 'user', text: 'hi' }], tools })).text).toBe('Hi.');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('uses function calling on OpenAI-style services and sends results as tool messages', async () => {
    const { calls, fetch } = server({ json: { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{"what":"inns"}' } }] }, finish_reason: 'tool_calls' }] } }, { json: { choices: [{ message: { content: 'Two inns.' }, finish_reason: 'stop' }] } });
    const m = new ChatAgentModel({ kind: 'openai', url: 'https://x.test/v1', apiKey: 'k', model: 'm' }, fetch);
    const s = newAgentSession();
    const r = await runAgentTurn(m, s, { text: 'Which inns?' }, tools);
    expect(r.text).toBe('Two inns.');
    expect(calls[0]!.url).toBe('https://x.test/v1/chat/completions');
    expect(calls[0]!.body.tools[0]).toMatchObject({ type: 'function', function: { name: 'look', parameters: { type: 'object' } } });
    const second = calls[1]!.body.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{"what":"inns"}' } }] });
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });

  it("uses Ollama's own tool calls, with the window sized to the conversation", async () => {
    const { calls, fetch } = server({ json: { message: { content: '', tool_calls: [{ function: { name: 'look', arguments: { what: 'caves' } } }] }, done_reason: 'stop' } }, { json: { message: { content: '<think>hmm</think>Three caves.' }, done_reason: 'stop' } });
    const m = new ChatAgentModel({ kind: 'ollama', model: 'qwen3:14b' }, fetch);
    const r = await runAgentTurn(m, newAgentSession(), { text: 'Caves?' }, tools);
    expect(r.text).toBe('Three caves.');
    const chat = calls.filter((c) => c.url.endsWith('/api/chat'));
    expect(chat[0]!.body.tools).toHaveLength(3);
    expect(chat[0]!.body.options.num_ctx).toBeLessThanOrEqual(32768);
    expect(chat[1]!.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'look' });
  });

  it("gives the tools in words to a model that can't call them, and reads its JSON answers", async () => {
    log.length = 0;
    const { calls, fetch } = server(
      { status: 400, text: 'registry.ollama.ai/library/gemma does not support tools' },
      { json: { message: { content: '{"say": "", "calls": [{"tool": "look", "input": {"what": "books"}}]}' }, done_reason: 'stop' } },
      { json: { message: { content: '```json\n{"say": "Five books.", "calls": []}\n```' }, done_reason: 'stop' } },
    );
    const m = new ChatAgentModel({ kind: 'ollama', model: 'gemma' }, fetch);
    const r = await runAgentTurn(m, newAgentSession(), { text: 'Books?' }, tools);
    expect(r.text).toBe('Five books.');
    expect(log).toEqual(['look books undefined']);
    expect(m.jsonTools).toBe(true);
    const chat = calls.filter((c) => c.url.endsWith('/api/chat'));
    expect(chat[1]!.body.tools).toBeUndefined();
    expect(chat[1]!.body.format).toBe('json');
    expect(chat[1]!.body.messages[0].content).toContain('You can use these tools:\n- look: Look');
    expect(chat[2]!.body.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('Tool results:\nlook:') });
  });
});

describe('projects for bigger jobs', () => {
  it('keeps a brief and a to-do list the AI works through', async () => {
    const { projectTools, projectSummary } = await import('../src');
    const s = newAgentSession();
    const tools = new Map(projectTools(s).map((t) => [t.name, t]));
    const run = (name: string, input: unknown) => tools.get(name)!.run(tools.get(name)!.input.parse(input));
    expect(() => run('update_task', { id: 1, status: 'done' })).toThrow(/no project/);
    run('set_project', { brief: 'A questline about the Ring.', tasks: ['Plan quest one', 'Build the cave', 'Plan quest two'] });
    expect(s.project!.tasks.map((t) => [t.id, t.status])).toEqual([[1, 'todo'], [2, 'todo'], [3, 'todo']]);
    run('update_task', { id: 1, status: 'done', note: 'Built RingQuest1' });
    run('update_task', { id: 2, status: 'doing' });
    run('add_tasks', { tasks: ['Light the cave'], after: 2 });
    run('update_brief', { brief: 'A questline about the Ring. The thief is Eirik.' });
    expect(s.project!.tasks.map((t) => t.title)).toEqual(['Plan quest one', 'Build the cave', 'Light the cave', 'Plan quest two']);
    expect(() => run('update_task', { id: 9, status: 'done' })).toThrow(/no task 9/);
    expect(projectSummary(s.project)).toBe('Project brief: A questline about the Ring. The thief is Eirik.\nTo-do:\n[x] 1. Plan quest one — Built RingQuest1\n[>] 2. Build the cave\n[ ] 4. Light the cave\n[ ] 3. Plan quest two');
    expect(projectSummary(undefined)).toBe('');
  });
});

describe('counting tokens and cost', () => {
  it('adds up what each request used, and prices Claude', async () => {
    const { usageCost } = await import('../src');
    const model = scripted([
      { text: '', calls: [call('look', { what: 'x' })], stop: 'tools', usage: { input: 1000, output: 200, cacheRead: 9000, cacheWrite: 3000 } },
      { text: 'Done.', calls: [], stop: 'end', usage: { input: 500, output: 100, cacheRead: 12000, cacheWrite: 0 } },
    ]);
    const r = await runAgentTurn(model, newAgentSession(), { text: 'x' }, tools);
    expect(r.usage).toEqual({ input: 1500, output: 300, cacheRead: 21000, cacheWrite: 3000 });
    // $4 / $20 / $0.20 / $5 per million.
    expect(usageCost(r.usage, 'claude')).toBeCloseTo((1500 * 4 + 300 * 20 + 21000 * 0.2 + 3000 * 5) / 1e6, 9);
    expect(usageCost(r.usage, 'ollama')).toBe(0);
  });

  it('reads the token counts free services report', async () => {
    const openai = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hi.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 321, completion_tokens: 12 } }), text: async () => '' };
    const o = new ChatAgentModel({ kind: 'openai', url: 'https://x.test/v1', model: 'm' }, async () => openai);
    expect((await o.reply({ system: 's', messages: [{ role: 'user', text: 'hi' }], tools })).usage).toEqual({ input: 321, output: 12, cacheRead: 0, cacheWrite: 0 });
    const ollama = async (url: string) => (url.endsWith('/api/show') ? { ok: true, status: 200, json: async () => ({ model_info: {} }), text: async () => '' } : { ok: true, status: 200, json: async () => ({ message: { content: 'Hi.' }, done_reason: 'stop', prompt_eval_count: 900, eval_count: 40 }), text: async () => '' });
    const l = new ChatAgentModel({ kind: 'ollama', model: 'q' }, ollama);
    expect((await l.reply({ system: 's', messages: [{ role: 'user', text: 'hi' }], tools })).usage).toEqual({ input: 900, output: 40, cacheRead: 0, cacheWrite: 0 });
  });
});
