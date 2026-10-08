/** Quest from writing: plan with Claude (API mocked), check and edit the plan, build, open. */
import { expect, test, type Page } from '@playwright/test';
import { exampleQuestPlan } from '../../../../packages/workspace/src/demo/example-plan';

async function openQuests(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
}

/** A streamed Messages API answer whose text is `text`. */
function sse(text: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } }),
    ev('message_stop', {}),
  ].join('');
}

test('write a quest, let Claude plan it, check it and build it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bodies: any[] = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    bodies.push(route.request().postDataJSON());
    const plan = exampleQuestPlan();
    if (bodies.length === 2) plan.title = 'The Stolen Ring';
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(JSON.stringify(plan)) });
  });
  await openQuests(page);

  await page.getByTestId('quest-from-writing').click();
  const dlg = page.getByRole('dialog');
  // No key yet: planning waits for one.
  await dlg.getByText('A conversation', { exact: true }).click();
  await dlg.getByTestId('plan-source').fill('Player: Got any work?\nBrynja: I lost my ring.');
  await expect(dlg.getByTestId('plan-quest')).toBeDisabled();
  await dlg.getByTestId('api-key').fill('sk-ant-test');
  await dlg.getByTestId('api-key').blur();
  await expect(dlg.getByTestId('plan-quest')).toBeEnabled();
  await dlg.getByTestId('plan-quest').click();

  // The plan, ready to check.
  const review = dlg.getByTestId('plan-review');
  await expect(review).toBeVisible();
  expect(bodies[0].model).toBe('claude-opus-5-5');
  expect(bodies[0].output_config.format.type).toBe('json_schema');
  expect(bodies[0].messages[0].content).toContain('There are no tags in it');
  expect(bodies[0].messages[0].content).toContain('Brynja: I lost my ring.');
  await expect(review.getByTestId('plan-assumptions')).toContainText('Should Eirik be suspicious');
  await review.getByTestId('plan-tab-cast').click();
  await expect(review).toContainText('Uses Brynja (DemoInnkeeper)');
  await expect(review).toContainText(/New, copied from/);
  await review.getByTestId('plan-tab-story').click();
  await expect(review.getByTestId('plan-steps')).toContainText('Stage 10 → 20: Pick up Brynja\'s Ring');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/15-quest-plan.png` });

  // Ask for a change.
  await review.getByTestId('plan-feedback').fill('Call it The Stolen Ring');
  await review.getByRole('button', { name: 'Change' }).click();
  await expect(review.locator('input').first()).toHaveValue('The Stolen Ring');
  expect(bodies[1].messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);

  // Hand edits are checked straight away.
  const stage10 = review.getByTestId('plan-stages').locator('textarea').nth(1);
  await stage10.fill('Brynja asked me to find her ring.');
  await stage10.blur();
  await review.locator('input').nth(1).fill('Bad ID!');
  await review.locator('input').nth(1).blur();
  await review.getByTestId('plan-show-problems').click();
  await expect(review.getByTestId('plan-issues')).toContainText('Editor ID');
  await expect(review.getByTestId('build-quest')).toBeDisabled();
  await review.locator('input').nth(1).fill('StolenRingQuest');
  await review.locator('input').nth(1).blur();
  await expect(review.getByTestId('build-quest')).toBeEnabled();
  await review.getByTestId('build-quest').click();

  // Built.
  const result = dlg.getByTestId('build-result');
  await expect(result).toContainText('StolenRingQuest is built');
  await expect(result).toContainText('Eirik (StolenRingQuestEirik)');
  await expect(result).toContainText('face files');
  await result.getByTestId('open-built-quest').click();
  await expect(page.getByTestId('quest-map')).toBeVisible();
  await expect(page.getByTestId('quest-map')).toContainText('Brynja asked me to find her ring.');
  await expect(page.getByTestId('quest-list')).toContainText('StolenRingQuest');
  expect(errors).toEqual([]);
});

test('try it with the example, no API key needed', async ({ page }) => {
  await openQuests(page);
  await page.getByRole('button', { name: /Describe a quest and let AI build it/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('use-example').click();
  await expect(dlg.getByTestId('plan-review').locator('input').first()).toHaveValue("The Innkeeper's Ring");
  await dlg.getByTestId('build-quest').click();
  await expect(dlg.getByTestId('build-result')).toContainText('InnkeeperRingQuest is built');
  // One undo takes it all back.
  await dlg.getByTestId('open-built-quest').click();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('quest-list')).not.toContainText('InnkeeperRingQuest');
});
