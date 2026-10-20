/**
 * A questline written out in one document: Quests → From writing finds its quests, plans them one after another with a
 * free AI (Ollama, mocked here), shows them together with what links them, keeps the author's dialogue word for word,
 * and builds them as one step that one undo takes back.
 */
import { expect, test } from '@playwright/test';
import { exampleQuestPlan } from '../../../../packages/workspace/src/demo/example-plan';

const DOC = `# The Lost Ledger

## Characters

- **Brynja**: runs the Demo Tavern.
- **Sigrun**: a new traveller, a Nord woman, sharp-tongued.

## Quest 1: The Ledger

Brynja's ledger is missing; Sigrun saw who took it. The player finds the ledger on a table and brings it back.

BRYNJA: You there. Can you read?
  PLAYER: I can.
    BRYNJA: Then find my ledger. It's somewhere in this tavern. (the player takes the job)

When the player comes back with it:

PLAYER: Here's your ledger.
  BRYNJA: My ledger! Thank you. (she takes it; the quest is done)

## Quest 2: Sigrun's Price

Starts when Quest 1 ends. Sigrun waits outside now, in the Demo Valley.

- **Player:** "Brynja says you saw who took the ledger."
  - **Sigrun:** "Maybe I did. Come back when you've got coin." *(the quest is done)*
`;

function plans() {
  const one = exampleQuestPlan();
  one.title = 'The Ledger';
  one.editorId = 'LedgerQuest';
  one.characters[1] = { ...one.characters[1]!, key: 'sigrun', name: 'Sigrun', sex: 'female', role: 'Saw who took the ledger', routine: [], outfit: null, inventory: [], factions: [] };
  one.items[0] = { ...one.items[0]!, key: 'ledger', name: "Brynja's Ledger" };
  one.objectives = [
    { index: 10, text: 'Find Brynja’s ledger', shownAtStage: 10, completedAtStage: 20, targetKey: 'ledger' },
    { index: 20, text: 'Return the ledger to Brynja', shownAtStage: 20, completedAtStage: 100, targetKey: 'brynja' },
  ];
  one.steps[1]!.targetKey = 'ledger';
  one.conversations = [];
  one.animations = [];
  const two = exampleQuestPlan();
  Object.assign(two, { title: "Sigrun's Price", editorId: 'SigrunsPrice', startsWithGame: true, startsWhen: null, items: [], animations: [], conversations: [] });
  two.characters = [{ ...one.characters[1]!, locationKey: 'valley', spot: null }];
  two.locations = [{ key: 'valley', name: 'Demo Valley', existing: 'DemoValley1_0', description: 'Outside the tavern', layoutLike: null, doorFrom: null }];
  two.stages = [
    { index: 0, journal: '', startsQuest: true, completesQuest: false, failsQuest: false },
    { index: 100, journal: 'Sigrun wants coin before she says more.', startsQuest: false, completesQuest: true, failsQuest: false },
  ];
  two.objectives = [{ index: 10, text: 'Ask Sigrun who took the ledger', shownAtStage: 0, completedAtStage: 100, targetKey: 'sigrun' }];
  two.steps = [{ from: 0, to: 100, kind: 'talk', targetKey: null, count: null, hours: null, note: 'The player asks Sigrun' }];
  return [one, two];
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`a written questline: planned quest by quest, reviewed together, built as one step (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const chats: any[] = [];
    const [one, two] = plans();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    await page.route('http://localhost:11434/**', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (route.request().url().endsWith('/api/tags')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ models: [{ name: 'qwen3:14b' }] }) });
      if (route.request().url().endsWith('/api/show')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ model_info: { 'qwen3.context_length': 40960 } }) });
      const body = route.request().postDataJSON();
      chats.push(body);
      const all = JSON.stringify(body.messages);
      const tagging = all.includes('You add tags to dialogue');
      const quest2 = all.includes('This is quest 2 of 2');
      const answer = tagging
        ? quest2
          ? { blocks: [], lines: [{ line: 2, tags: '[stage 100]' }] }
          : { blocks: [{ block: 1, tags: '[if stage 0]' }, { block: 2, tags: '[if stage 20]' }], lines: [{ line: 3, tags: '[stage 10]' }, { line: 5, tags: '[takes ledger x1] [stage 100]' }] }
        : quest2
          ? two
          : one;
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ message: { content: JSON.stringify(answer) }, done_reason: 'stop' }) });
    });
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
    await page.getByTestId('quest-from-writing').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('plan-source').fill(DOC);
    // Seen as a questline as soon as it's pasted.
    await expect(dlg.getByTestId('questline-found')).toContainText('A questline: 2 quests');
    await expect(dlg.getByTestId('questline-found')).toContainText("1. The Ledger · 2. Sigrun's Price");
    await dlg.getByTestId('ai-kind-local').click();
    await dlg.getByTestId('local-kind-ollama').click();
    await expect(dlg.getByTestId('ollama-model')).toHaveValue('qwen3:14b');
    await dlg.getByTestId('ai-done').click();
    await expect(dlg.getByTestId('plan-quest')).toHaveText(/Plan the questline \(2 quests\)/);
    await dlg.getByTestId('plan-quest').click();

    const review = dlg.getByTestId('questline-review');
    await expect(review).toBeVisible();
    // Quest 2 was told about quest 1; each conversation went in with only tags from the AI.
    expect(JSON.stringify(chats.find((c) => JSON.stringify(c.messages).includes('This is quest 2 of 2'))!.messages)).toContain('Editor ID LedgerQuest');
    await expect(review.getByTestId('questline-quests')).toContainText('1. The Ledger');
    await expect(review.getByTestId('questline-quests')).toContainText('Starts when The Ledger ends');
    await expect(review.getByTestId('questline-quests')).toContainText('your dialogue: 5 lines in 1 conversation(s)');
    await expect(review.getByTestId('questline-links')).toContainText('Sigrun — made in quest 1, used in 2');
    if (process.env.SCREENSHOT_DIR) await dlg.screenshot({ path: `${process.env.SCREENSHOT_DIR}/questline-review-${size.width}.png` });

    // A quest's own tab is the usual plan review; the author's lines are there word for word.
    await review.getByTestId('questline-tab-1').click();
    await review.getByTestId('plan-tab-dialogue').click();
    await expect(review.getByTestId('plan-review')).toContainText('✎ Sigrun');
    await expect(review.locator('.plan-screenplay textarea').first()).toHaveValue(/SIGRUN: Maybe I did\. Come back when you've got coin\. \[stage 100\]/);
    await expect(review.getByTestId('build-quest')).toHaveCount(0);
    if (process.env.SCREENSHOT_DIR) await dlg.screenshot({ path: `${process.env.SCREENSHOT_DIR}/questline-quest-${size.width}.png` });

    await review.getByTestId('build-questline').click();
    const result = dlg.getByTestId('questline-result');
    await expect(result).toContainText('The Lost Ledger is built: 2 quests');
    await expect(result).toContainText('Quest 2: Sigrun (made in quest 1) is moved to Demo Valley when it starts');
    if (process.env.SCREENSHOT_DIR) await dlg.screenshot({ path: `${process.env.SCREENSHOT_DIR}/questline-built-${size.width}.png` });
    await result.getByTestId('open-built-questline').click();
    const list = page.getByTestId('quest-list');
    await expect(list).toContainText('LedgerQuest');
    await expect(list).toContainText('SigrunsPrice');
    // One undo takes the whole questline back.
    await page.keyboard.press('Control+z');
    await expect(list).not.toContainText('LedgerQuest');
    await expect(list).not.toContainText('SigrunsPrice');
    expect(errors).toEqual([]);
  });
}

test('Stop calls off a questline that is still being planned, and keeps what was written (1280×800)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  await page.route('http://localhost:11434/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (route.request().url().endsWith('/api/tags')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ models: [{ name: 'qwen3:14b' }] }) });
    if (route.request().url().endsWith('/api/show')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ model_info: { 'qwen3.context_length': 40960 } }) });
    // A plan that takes a long time: it's called off before it comes back.
    await new Promise((r) => setTimeout(r, 15_000));
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ message: { content: '{}' }, done_reason: 'stop' }) }).catch(() => undefined);
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await page.getByTestId('quest-from-writing').click();
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('plan-source').fill(DOC);
  await dlg.getByTestId('ai-kind-local').click();
  await dlg.getByTestId('local-kind-ollama').click();
  await expect(dlg.getByTestId('ollama-model')).toHaveValue('qwen3:14b');
  await dlg.getByTestId('ai-done').click();
  await dlg.getByTestId('plan-quest').click();
  // Which quest and which step it's on, with Stop.
  await expect(page.getByTestId('busy')).toContainText('Quest 1 of 2, Quest 1: The Ledger: planning the stages, characters and places');
  await page.getByTestId('busy-stop').click();
  await expect(page.getByTestId('busy')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Stopped.');
  await expect(dlg.getByTestId('plan-source')).toHaveValue(DOC);
  expect(errors).toEqual([]);
});
