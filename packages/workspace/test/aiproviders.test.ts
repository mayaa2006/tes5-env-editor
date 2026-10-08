import { describe, expect, it } from 'vitest';
import { OPENAI_PRESETS, QuestPlanner, aiName, aiReady, chatSend, cleanJson, exampleQuestPlan, ollamaModels, pickModel, serviceModels } from '../src';

type Call = { url: string; body: any; headers: Record<string, string> };

/** A fake server: records requests and answers with the given replies in turn. */
function server(...replies: { status?: number; json?: unknown; text?: string }[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json, text: async () => r.text ?? JSON.stringify(r.json ?? '') };
  };
  return { calls, fetch };
}

/** The example plan with every empty list and "none" left out, as smaller models answer. */
function sparsePlan(): Record<string, unknown> {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && !(Array.isArray(x) && !x.length)).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  return strip(exampleQuestPlan()) as Record<string, unknown>;
}

describe('free AI providers', () => {
  it('plans with Ollama on this computer: schema-constrained JSON, big context, gaps filled in', async () => {
    const { calls, fetch } = server({ json: { message: { content: `<think>Let me plan.</think>\n\`\`\`json\n${JSON.stringify(sparsePlan())}\n\`\`\`` }, done_reason: 'stop' } });
    const planner = new QuestPlanner({ send: chatSend({ kind: 'ollama', model: 'qwen3:14b' }, fetch) });
    const plan = await planner.plan('Brynja lost her ring.', 'conversation', 'catalog here');
    expect(plan.title).toBe("The Innkeeper's Ring");
    expect(plan.events).toEqual([]);
    expect(plan.startsWhen).toBeNull();
    const c = calls[0]!;
    expect(c.url).toBe('http://localhost:11434/api/chat');
    expect(c.body.model).toBe('qwen3:14b');
    expect(c.body.stream).toBe(false);
    expect(c.body.format.type).toBe('object');
    expect(c.body.format.properties.stages).toBeDefined();
    expect(c.body.options.num_ctx).toBeGreaterThanOrEqual(32768);
    expect(c.body.messages[0].role).toBe('system');
    expect(c.body.messages[0].content).toContain('catalog here');
    expect(c.body.messages[0].content).toContain('matches this JSON schema');
    expect(c.body.messages[1]).toEqual({ role: 'user', content: expect.stringContaining('Brynja lost her ring.') });
  });

  it('plans with an OpenAI-style service, falling back to plain JSON mode when a schema is refused', async () => {
    const { calls, fetch } = server({ status: 400, text: 'response_format json_schema not supported' }, { json: { choices: [{ message: { content: JSON.stringify(exampleQuestPlan()) }, finish_reason: 'stop' }] } });
    const ai = { kind: 'openai' as const, url: 'https://api.groq.com/openai/v1/', apiKey: 'gsk_test', model: 'llama-3.3-70b-versatile' };
    const plan = await new QuestPlanner({ send: chatSend(ai, fetch) }).plan('Brynja lost her ring.', 'document', '');
    expect(plan.editorId).toBe(exampleQuestPlan().editorId);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer gsk_test');
    expect(calls[0]!.body.response_format.type).toBe('json_schema');
    expect(calls[1]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('says what went wrong in plain words', async () => {
    const plan = (ai: Parameters<typeof chatSend>[0], fetch: Parameters<typeof chatSend>[1]) => new QuestPlanner({ ai, send: chatSend(ai, fetch) }).plan('x', 'document', '');
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(plan({ kind: 'ollama', model: 'qwen3' }, down)).rejects.toThrow(/Couldn't reach Ollama .*running/);
    await expect(plan({ kind: 'ollama', model: 'nope' }, server({ status: 404, text: 'model not found' }).fetch)).rejects.toThrow(/ollama pull nope/);
    await expect(plan({ kind: 'openai', url: 'https://x.test/v1', apiKey: 'k', model: 'm' }, server({ status: 401 }).fetch)).rejects.toThrow(/rejected the API key/);
    await expect(plan({ kind: 'openai', url: 'https://x.test/v1', model: 'm' }, server({ status: 429 }).fetch)).rejects.toThrow(/free tiers have limits/);
    // A model too small to follow the format: one retry, then a hint to use a bigger one.
    const junk = server({ json: { message: { content: '{"title": 3}' } } });
    await expect(plan({ kind: 'ollama', model: 'tiny' }, junk.fetch)).rejects.toThrow(/tiny \(Ollama\)'s plan was incomplete.*bigger model/);
    expect(junk.calls).toHaveLength(2);
  });

  it('lists the models installed in Ollama', async () => {
    const { calls, fetch } = server({ json: { models: [{ name: 'qwen3:14b' }, { name: 'llama3.1:8b' }] } });
    expect(await ollamaModels('http://localhost:11434/', fetch)).toEqual(['qwen3:14b', 'llama3.1:8b']);
    expect(calls[0]!.url).toBe('http://localhost:11434/api/tags');
  });

  it('names the AI and knows when it is set up', () => {
    expect(aiName({ kind: 'claude', apiKey: 'k' })).toBe('Claude');
    expect(aiName({ kind: 'ollama', model: 'qwen3' })).toBe('qwen3 (Ollama)');
    expect(aiReady({ kind: 'ollama', model: '' })).toBe(false);
    expect(aiReady({ kind: 'openai', url: 'https://a/v1', model: 'm' })).toBe(true);
    expect(aiReady({ kind: 'claude', apiKey: ' ' })).toBe(false);
    expect(cleanJson('Sure! Here it is:\n{"a":1}\nHope that helps')).toBe('{"a":1}');
  });

  it("asks an online service for its current models, so stale names aren't used", async () => {
    // OpenRouter: only free models, structured-output ones first; no key needed to list.
    const or = server({ json: { data: [{ id: 'paid/model' }, { id: 'a/plain:free', supported_parameters: [] }, { id: 'b/json:free', supported_parameters: ['response_format', 'structured_outputs'] }, { id: 'c/guard:free' }] } });
    expect(await serviceModels({ url: 'https://openrouter.ai/api/v1/' }, or.fetch)).toEqual(['b/json:free', 'a/plain:free']);
    expect(or.calls[0]!.url).toBe('https://openrouter.ai/api/v1/models');
    // Gemini: "models/" prefixes dropped, embedding/speech models left out, the newest stable flash first.
    const g = server({ json: { data: [{ id: 'models/gemini-2.5-pro' }, { id: 'models/text-embedding-004' }, { id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.8-flash-lite' }, { id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-3.8-flash-tts' }] } });
    const gem = await serviceModels({ url: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k' }, g.fetch);
    expect(gem[0]).toBe('gemini-3.8-flash');
    expect(gem).not.toContain('text-embedding-004');
    expect(gem).not.toContain('gemini-3.8-flash-tts');
    expect(g.calls[0]!.headers.authorization).toBe('Bearer k');
    // A model the service no longer offers is swapped for one it does.
    expect(pickModel(['x', 'y'], 'gone')).toBe('x');
    expect(pickModel(['x', 'y'], 'y')).toBe('y');
    await expect(serviceModels({ url: 'https://api.groq.com/openai/v1', apiKey: 'bad' }, server({ status: 401 }).fetch)).rejects.toThrow(/rejected the API key/);
    // Every preset has a key or download page (a web page), separate from its API address.
    for (const p of OPENAI_PRESETS) {
      expect(p.keyUrl).toMatch(/^https:\/\//);
      expect(p.keyUrl).not.toBe(p.url);
    }
  });
});
