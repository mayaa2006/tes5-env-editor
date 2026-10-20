/** The AI tab: ask about the mod, the AI uses the editor's tools (Claude's API mocked), results link to their tabs. */
import { expect, test } from '@playwright/test';
import { exampleQuestPlan } from '../../../../packages/workspace/src/demo/example-plan';

/** A streamed Messages API answer: optional text, then optional tool calls. */
function sse(text: string, calls: { id: string; name: string; input: object }[] = []): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })];
  let i = 0;
  if (text) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } }), ev('content_block_stop', { index: i }));
    i++;
  }
  for (const c of calls) {
    out.push(
      ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }),
      ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }),
      ev('content_block_stop', { index: i }),
    );
    i++;
  }
  out.push(ev('message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }), ev('message_stop', {}));
  return out.join('');
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`ask the AI about the mod (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const bodies: any[] = [];
    await page.route('https://api.anthropic.com/**', async (route) => {
      const body = route.request().postDataJSON();
      bodies.push(body);
      const answer =
        bodies.length === 1
          ? sse('Let me look her up.', [{ id: 'tu_1', name: 'read_record', input: { form: 'DemoInnkeeper' } }])
          : sse('**Brynja** is the innkeeper of the Demo Tavern.\n\n- She stands behind the bar\n- She has no quests yet');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: answer });
    });
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'AI' }).click();

    // Nothing yet: what it can do, and places to start.
    await expect(page.getByTestId('ai-empty')).toContainText('Ask the AI about your mod');
    await expect(page.getByTestId('ai-starter')).toHaveCount(13);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/ai-empty-${size.width}.png` });
    // No key yet: the AI's settings are open and sending waits.
    await expect(page.getByTestId('ai-input')).toBeDisabled();
    await page.getByTestId('api-key').fill('sk-ant-test');
    await page.getByTestId('api-key').blur();
    await expect(page.getByTestId('ai-input')).toBeEnabled();

    await page.getByTestId('ai-starter').filter({ hasText: "What's in my plugin?" }).click();
    await expect(page.getByTestId('ai-input')).toHaveValue(/What does my plugin contain/);
    await page.getByTestId('ai-input').fill('Who is the innkeeper?');
    await page.getByTestId('ai-input').press('Enter');

    // The tool the AI used, and its answer.
    const tool = page.getByTestId('ai-tool').first();
    await expect(tool).toContainText('Read DemoInnkeeper');
    await expect(tool).toContainText('Done');
    await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('is the innkeeper of the Demo Tavern');
    await expect(page.getByTestId('ai-msg-assistant').last().locator('strong')).toHaveText('Brynja');
    await expect(page.getByTestId('ai-msg-assistant').last().locator('li')).toHaveCount(2);
    await expect(page.getByTestId('ai-input')).toHaveValue('');
    await expect(page.getByTestId('ai-session').first()).toContainText('Who is the innkeeper?');

    // What was sent: the tools, the question, then the tool's result.
    expect(bodies[0].model).toBe('claude-opus-5-5');
    expect(bodies[0].tools.map((t: any) => t.name)).toContain('search_records');
    expect(bodies[0].messages[0].content).toContain('Who is the innkeeper?');
    expect(bodies[1].messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(bodies[1].messages[2].content[0].content).toContain('DemoInnkeeper');

    // Details show what the tool returned; Open goes to the record.
    await tool.getByRole('button', { name: 'Details' }).click();
    await expect(tool.locator('pre')).toContainText('DemoInnkeeper');
    await tool.getByTestId('ai-tool-open').click();
    await expect(page.locator('.workspace-tab.active')).toContainText('Records');

    // Back on the AI tab the conversation is still there; a new one starts empty, and can be deleted.
    await page.locator('.workspace-tab', { hasText: 'AI' }).click();
    await expect(page.getByTestId('ai-msg-user')).toContainText('Who is the innkeeper?');
    await page.getByTestId('ai-new').click();
    await expect(page.getByTestId('ai-empty')).toBeVisible();
    await expect(page.getByTestId('ai-session')).toHaveCount(2);
    await page.getByTestId('ai-session').nth(1).getByRole('button').click();
    await page.getByTestId('ai-delete-confirm').click();
    await expect(page.getByTestId('ai-session')).toHaveCount(1);

    // The AI settings are in Settings too.
    await page.getByTitle(/Menu: save, settings/).click();
    await page.getByText('Settings…').click();
    await expect(page.getByTestId('settings-ai')).toContainText('Used by the AI tab');
    expect(errors).toEqual([]);
  });
}

test('the AI asks before changing the plugin, and a turn undoes in one step (1280×800)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bodies: any[] = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    bodies.push(route.request().postDataJSON());
    const answer =
      bodies.length === 1
        ? sse("I'll make the quest.", [
            { id: 'tu_q', name: 'create_quest', input: { editorId: 'AiRingQuest', name: 'The Ring', startsWithGame: true } },
            { id: 'tu_s', name: 'set_stage', input: { quest: 'AiRingQuest', stage: 10, journal: 'Brynja asked me to find her ring.' } },
          ])
        : sse('Made **The Ring** with stage 10.');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: answer });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'AI' }).click();
  await page.getByTestId('api-key').fill('sk-ant-test');
  await page.getByTestId('api-key').blur();

  // Asking first is on by default.
  await expect(page.getByRole('checkbox', { name: 'Ask before each change' })).toBeChecked();
  await page.getByTestId('ai-input').fill('Make a ring quest');
  await page.getByTestId('ai-send').click();

  // Each change waits for Allow.
  const live = page.getByTestId('ai-live');
  await expect(live.getByTestId('ai-tool').first()).toContainText('Create the quest The Ring');
  await live.getByTestId('ai-allow').click();
  await expect(live.getByTestId('ai-tool').nth(1)).toContainText('Set stage 10 of AiRingQuest');
  await live.getByTestId('ai-allow').click();

  // What changed, with Undo for the whole turn.
  const turn = page.getByTestId('ai-turn');
  await expect(turn).toContainText('Changes in this turn (2)');
  await expect(turn.locator('li')).toHaveText(['Create the quest The Ring', 'Set stage 10 of AiRingQuest']);
  await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('with stage 10');
  expect(bodies[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['create_quest', 'set_stage', 'plan_quest', 'build_plan', 'add_dialogue']));

  // Open goes to the quest; it's there.
  await page.getByTestId('ai-tool').first().getByTestId('ai-tool-open').click();
  await expect(page.locator('.workspace-tab.active')).toContainText('Quests');
  await expect(page.getByText('AiRingQuest').first()).toBeVisible();
  await page.locator('.workspace-tab', { hasText: 'AI' }).click();
  await page.getByTestId('ai-undo-turn').click();
  await expect(page.getByTestId('ai-turn')).toContainText('Undone: Changes in this turn');
  await expect(page.getByTestId('ai-undo-turn')).toHaveCount(0);
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await expect(page.getByText('AiRingQuest')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('with asking off, the AI dresses and lights a room straight away (1920×1080)', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let n = 0;
  await page.route('https://api.anthropic.com/**', async (route) => {
    n++;
    const answer =
      n === 1
        ? sse('', [
            { id: 'tu_d', name: 'dress_room', input: { place: 'DemoTavern', theme: 'tavern', amount: 'light' } },
            { id: 'tu_l', name: 'light_room', input: { place: 'DemoTavern', mood: 'tavern' } },
          ])
        : sse('The tavern is dressed and lit.');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: answer });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'AI' }).click();
  await page.getByTestId('api-key').fill('sk-ant-test');
  await page.getByTestId('api-key').blur();
  await page.getByRole('checkbox', { name: 'Ask before each change' }).uncheck();
  await page.getByTestId('ai-input').fill('Make the tavern feel lived in');
  await page.getByTestId('ai-send').click();
  const turn = page.getByTestId('ai-turn');
  await expect(turn.locator('li')).toHaveText(['Dress DemoTavern as a tavern', 'Light DemoTavern (tavern)']);
  await expect(page.getByTestId('ai-allow')).toHaveCount(0);
  // Open goes to the cell in the World tab.
  await page.getByTestId('ai-tool').nth(1).getByTestId('ai-tool-open').click();
  await expect(page.locator('.workspace-tab.active')).toContainText('World');
  expect(errors).toEqual([]);
});

test('a bigger job becomes a project worked through a task at a time (1280×800)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bodies: any[] = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    bodies.push(route.request().postDataJSON());
    const n = bodies.length;
    const answer =
      n === 1
        ? sse('', [{ id: 'tu_p', name: 'set_project', input: { brief: 'A two-part questline about a stolen ring.', tasks: ['Make part one', 'Make part two', 'Dress the tavern'] } }])
        : n === 2
          ? sse('Here is the plan: three tasks. Shall I start?')
          : n === 3
            ? sse('', [
                { id: 'tu_a', name: 'update_task', input: { id: 1, status: 'doing' } },
                { id: 'tu_q', name: 'create_quest', input: { editorId: 'RingPartOne', name: 'The Ring, Part One' } },
                { id: 'tu_b', name: 'update_task', input: { id: 1, status: 'done', note: 'Made RingPartOne' } },
              ])
            : sse('Part one is made. Next: part two.');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: answer });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'AI' }).click();
  await page.getByTestId('api-key').fill('sk-ant-test');
  await page.getByTestId('api-key').blur();
  await page.getByRole('checkbox', { name: 'Ask before each change' }).uncheck();
  await page.getByTestId('ai-starter').filter({ hasText: 'Plan a bigger job' }).click();
  await page.getByTestId('ai-input').fill('I want to make a questline about a stolen ring');
  await page.getByTestId('ai-send').click();

  // The project: brief and to-do, nothing done yet.
  const project = page.getByTestId('ai-project');
  await expect(project).toContainText('A two-part questline about a stolen ring.');
  await expect(project.getByTestId('ai-project-task')).toHaveText(['○ Make part one', '○ Make part two', '○ Dress the tavern']);
  await expect(project.getByTestId('ai-project-progress')).toHaveText('0 of 3 done');
  await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('Shall I start?');

  // Go on: one task, then it stops.
  await project.getByTestId('ai-project-next').click();
  await expect(project.getByTestId('ai-project-progress')).toHaveText('1 of 3 done');
  await expect(project.getByTestId('ai-project-task').first()).toContainText('Make part one — Made RingPartOne');
  await expect(page.getByTestId('ai-turn').last()).toContainText('Create the quest The Ring, Part One');
  await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('Next: part two');
  // The second request carried the project's to-do list and the "carry on" message.
  expect(bodies[2].messages.at(-1).content).toContain('Carry on with the next task.');
  expect(bodies[2].messages.at(-1).content).toContain('[ ] 1. Make part one');
  expect(bodies[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['set_project', 'update_task', 'review_mod']));
  expect(errors).toEqual([]);
});

test('ask the AI from another workspace, and see what the conversation cost (1280×800)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bodies: any[] = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse('Brynja runs the Demo Tavern.') });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  // The AI needs a key first.
  await page.locator('.workspace-tab', { hasText: 'AI' }).click();
  await page.getByTestId('api-key').fill('sk-ant-test');
  await page.getByTestId('api-key').blur();

  // From Characters: pick someone and ask.
  await page.locator('.workspace-tab', { hasText: 'Characters' }).click();
  await page.getByTestId('npc-list').getByText('Brynja').first().click();
  await page.getByTestId('ask-ai').click();
  await page.getByRole('menuitem', { name: /Describe this character/ }).click();

  // The AI tab opens with the question ready and the character included.
  await expect(page.locator('.workspace-tab.active')).toContainText('AI');
  await expect(page.getByTestId('ai-input')).toHaveValue(/Describe this character/);
  await expect(page.getByTestId('ai-input')).toBeFocused();
  await expect(page.getByRole('checkbox', { name: /Include what I have open: .*DemoInnkeeper/ })).toBeChecked();
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('Brynja runs the Demo Tavern.');
  expect(bodies[0].messages[0].content).toContain('Character open in the Characters tab: Brynja');

  // What it cost: 10 tokens read and 50 written, at Claude's prices ($0.00104).
  await expect(page.getByTestId('ai-usage')).toHaveText('60 tokens · about $0.001');
  await expect(page.getByTestId('ai-usage')).toHaveAttribute('title', /10 tokens read, 50 written/);
  expect(errors).toEqual([]);
});

test('the AI plans a whole quest, says what it will make, and builds it when asked (1280×800)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let turn = 0;
  const planner: any[] = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const body = route.request().postDataJSON();
    let answer: string;
    // The quest planner's own request (a JSON plan) is told apart from the conversation's.
    if (body.output_config?.format) {
      planner.push(body);
      answer = sse(JSON.stringify(exampleQuestPlan()));
    } else {
      turn++;
      answer =
        turn === 1
          ? sse("I'll plan it.", [{ id: 'tu_p', name: 'plan_quest', input: { text: "Brynja lost her ring; Eirik stole it. The player gets it back and Brynja pays 100 gold." } }])
          : turn === 2
            ? sse('Here is the plan: **The Lost Ring**, with Brynja and Eirik, four stages. Shall I build it?')
            : turn === 3
              ? sse('Building it.', [{ id: 'tu_b', name: 'build_plan', input: { planId: 'plan1' } }])
              : sse('Built **The Lost Ring**: open it in Quests.');
    }
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: answer });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'AI' }).click();
  await page.getByTestId('api-key').fill('sk-ant-test');
  await page.getByTestId('api-key').blur();
  await page.getByRole('checkbox', { name: 'Ask before each change' }).uncheck();

  // First the plan: nothing is built yet.
  await page.getByTestId('ai-input').fill('Make a quest: Brynja lost her ring and Eirik stole it.');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('Shall I build it?');
  await expect(page.getByTestId('ai-tool').first()).toContainText('Plan a quest');
  expect(planner).toHaveLength(1);
  expect(planner[0].messages[0].content).toContain('Brynja lost her ring');
  await expect(page.getByTestId('ai-turn')).toHaveCount(0);

  // Then built, as one undo step, with a link to the quest.
  await page.getByTestId('ai-input').fill('Yes, build it.');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('Built The Lost Ring');
  await expect(page.getByTestId('ai-turn')).toContainText('Changes in this turn (1)');
  await expect(page.getByTestId('ai-turn')).toContainText('Build the quest from plan1');

  // The quest opens with its stages, dialogue and map.
  await page.getByTestId('ai-tool').last().getByTestId('ai-tool-open').click();
  await expect(page.locator('.workspace-tab.active')).toContainText('Quests');
  await page.getByRole('tab', { name: /^Stages/ }).click();
  await expect(page.locator('main')).toContainText('Brynja');
  await page.getByRole('tab', { name: /^Dialogue/ }).click();
  await page.getByRole('tab', { name: /^Map/ }).click();
  await expect(page.getByTestId('error-panel')).toHaveCount(0);

  // One undo takes the whole quest back.
  await page.locator('.workspace-tab', { hasText: 'AI' }).click();
  await page.getByTestId('ai-undo-turn').click();
  await expect(page.getByTestId('ai-turn')).toContainText('Undone: Changes in this turn');
  expect(errors).toEqual([]);
});
