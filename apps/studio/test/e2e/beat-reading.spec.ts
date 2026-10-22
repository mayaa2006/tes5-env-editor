/**
 * A questline read beat by beat with a free AI (Ollama, mocked here): the AI answers small questions (who and what,
 * what each passage adds, which written line moves the quest on), the editor puts each quest together, and the review
 * shows the outline of what was read. Changing the outline makes the plan again; Undo puts it back.
 */
import { expect, test } from '@playwright/test';

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

Starts when Quest 1 ends.

- **Player:** "Brynja says you saw who took the ledger."
  - **Sigrun:** "Maybe I did. Come back when you've got coin." *(the quest is done)*
`;

const none = { gold: null, gives: [], takes: [], remembers: null, attacks: [], leaves: [], follows: [], stopsFollowing: [], appears: [], moves: [] };
const person = (name: string, where: string | null, description: string) => ({ name, description, sex: 'female', race: name === 'Sigrun' ? 'Nord' : null, where, spot: null, canDie: 'not said', hostile: false, quote: '' });

/** The free AI's answer to each of the reader's questions, by what the question is about. */
function answer(user: string): unknown {
  const two = user.includes('Earlier quests already have') || user.includes('Brynja says you saw');
  // Which beat ends the quest (its own question, once everything is read).
  if (user.includes('No beat completes the quest')) return { beat: two ? 1 : 3 };
  if (user.includes('List the people'))
    return two
      ? { summary: 'Sigrun wants coin.', start: { how: 'previous quest', what: null }, people: [person('Sigrun', null, 'A traveller')], places: [], items: [], enemies: [] }
      : {
          summary: 'Find Brynja’s ledger.',
          start: { how: 'talking', what: null },
          people: [person('Brynja', 'The Demo Tavern', 'Runs the tavern'), person('Sigrun', 'The Demo Tavern', 'Saw who took the ledger')],
          places: [{ name: 'The Demo Tavern', description: 'Brynja’s tavern', partOf: null, quote: '' }],
          items: [{ name: "Brynja's Ledger", kind: 'book', where: 'The Demo Tavern', carriedBy: null, spot: 'on a table', count: 1, text: null, lockedWith: null, quote: 'The player finds the ledger on a table' }],
          enemies: [],
        };
  if (user.includes('<passage>\nWhen the player comes back')) return { beats: [{ n: 2, does: 'pickup', target: "Brynja's Ledger", count: 1, hours: null, after: [1], quote: 'The player finds the ledger on a table', ends: 'no', then: null }] };
  if (user.includes('<passage>')) return { beats: [] };
  if (user.includes('Can you read?')) return user.includes('For each line with a direction') ? { lines: [] } : { when: null, moves: [{ line: 3, words: 'Then find my', beat: null, ends: 'no' }] };
  if (user.includes("Here's your ledger.")) return user.includes('For each line with a direction') ? { lines: [{ line: 2, words: 'My ledger! Thank', if: [], ...none, takes: [{ item: "Brynja's Ledger", count: 1 }], instead: [] }] } : { when: 2, moves: [{ line: 2, words: 'My ledger! Thank', beat: null, ends: 'complete' }] };
  if (user.includes('Brynja says you saw')) return user.includes('For each line with a direction') ? { lines: [] } : { when: null, moves: [{ line: 2, words: 'Maybe I did.', beat: null, ends: 'complete' }] };
  if (user.includes('their journal entry'))
    return two
      ? { beats: [{ n: 1, objective: 'Ask Sigrun who took the ledger', journal: 'Sigrun wants coin before she says more.' }] }
      : {
          beats: [
            { n: 1, objective: 'Talk to Brynja', journal: 'Brynja asked me to find her ledger.' },
            { n: 2, objective: 'Find Brynja’s ledger', journal: 'I found the ledger.' },
            { n: 3, objective: 'Return the ledger to Brynja', journal: 'I gave Brynja her ledger back.' },
          ],
        };
  throw new Error(`unexpected question: ${user.slice(-300)}`);
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`a questline read beat by beat: an outline of what was read, changed and undone, then built (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const asked: string[] = [];
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    await page.route('http://localhost:11434/**', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (route.request().url().endsWith('/api/tags')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ models: [{ name: 'qwen3:14b' }] }) });
      if (route.request().url().endsWith('/api/show')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ model_info: { 'qwen3.context_length': 40960 } }) });
      const body = route.request().postDataJSON();
      const user = String(body.messages.at(-1).content);
      asked.push(user);
      let content: string;
      try {
        content = JSON.stringify(answer(user));
      } catch (e) {
        errors.push((e as Error).message);
        content = '{}';
      }
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ message: { content }, done_reason: 'stop' }) });
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
    // A free AI reads beat by beat unless told otherwise.
    await expect(dlg.getByTestId('plan-how').locator('select')).toHaveValue('beats');
    await dlg.getByTestId('plan-quest').click();

    const review = dlg.getByTestId('questline-review');
    await expect(review).toBeVisible();
    expect(errors).toEqual([]);
    // Small questions, each about one thing.
    expect(asked.some((q) => q.includes('which of its lines move the quest on'))).toBe(true);
    await expect(review.getByTestId('questline-quests')).toContainText('Starts when The Ledger ends');
    await expect(review.getByTestId('questline-links')).toContainText('Sigrun — made in quest 1, used in 2');

    // Quest 1's review opens on what was read: three beats, in the order they're played.
    await review.getByTestId('questline-tab-0').click();
    const outline = review.getByTestId('beat-outline');
    await expect(outline).toBeVisible();
    await expect(outline.getByTestId('beat-1')).toContainText('“Then find my ledger. It\'s somewhere in this tavern. (the player takes the job)”');
    await expect(outline.getByTestId('beat-2').locator('select').first()).toHaveValue('pickup');
    await expect(outline.getByTestId('beat-3').locator('select').nth(2)).toHaveValue('complete');
    await expect(outline.getByTestId('beat-questions')).toHaveCount(0);
    if (process.env.SCREENSHOT_DIR) await dlg.screenshot({ path: `${process.env.SCREENSHOT_DIR}/beat-outline-${size.width}.png` });

    // Changing the outline makes the plan again: now nothing ends the quest, and the review says so.
    await outline.getByTestId('beat-3').locator('select').nth(2).selectOption('no');
    await expect(outline.getByTestId('beat-questions')).toContainText('No beat completes the quest');
    await outline.getByTestId('beat-undo').click();
    await expect(outline.getByTestId('beat-questions')).toHaveCount(0);
    await expect(outline.getByTestId('beat-3').locator('select').nth(2)).toHaveValue('complete');

    // The plan made from it has the author's lines word for word, tagged from the beats.
    await review.getByTestId('plan-tab-dialogue').click();
    await expect(review.locator('.plan-screenplay textarea').first()).toHaveValue(/BRYNJA: Then find my ledger\. It's somewhere in this tavern\. \[stage 10\]/);

    await review.getByTestId('build-questline').click();
    const result = dlg.getByTestId('questline-result');
    await expect(result).toContainText('The Lost Ledger is built: 2 quests');
    await result.getByTestId('open-built-questline').click();
    const list = page.getByTestId('quest-list');
    await expect(list).toContainText('TheLedger');
    await expect(list).toContainText('SigrunsPrice');
    await page.keyboard.press('Control+z');
    await expect(list).not.toContainText('TheLedger');
    expect(errors).toEqual([]);
  });
}
