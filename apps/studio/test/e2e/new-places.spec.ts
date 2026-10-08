/** New places from a plan: laid out like an existing interior, with a door in from another place. */
import { expect, test } from '@playwright/test';
import { exampleQuestPlan } from '../../../../packages/workspace/src/demo/example-plan';

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

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`a new place comes furnished, with a door (${size.width}×${size.height})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const plan = exampleQuestPlan();
    plan.locations.push({ key: 'backroom', name: 'Back Room', existing: null, description: 'A room behind the bar', layoutLike: null, doorFrom: null });
    plan.characters[1]!.locationKey = 'backroom';
    plan.characters[1]!.spot = null;
    await page.route('https://api.anthropic.com/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(JSON.stringify(plan)) }));
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
    await page.getByTestId('quest-from-writing').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('plan-source').fill('Eirik waits in a back room behind the tavern.');
    await dlg.getByTestId('api-key').fill('sk-ant-test');
    await dlg.getByTestId('api-key').blur();
    await dlg.getByTestId('plan-quest').click();

    const review = dlg.getByTestId('plan-review');
    await review.getByTestId('plan-tab-cast').click();
    await expect(review).toContainText('New empty interior');
    await review.getByTestId('place-layoutLike').fill('DemoTavern');
    await review.getByTestId('place-layoutLike').press('Enter');
    await expect(review).toContainText('laid out like');
    await expect(review).toContainText('with no door in yet');
    await review.getByTestId('place-doorFrom').fill('tavern');
    await review.getByTestId('place-doorFrom').press('Enter');
    await expect(review).toContainText('with a door from The Demo Tavern');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/new-place-${size.width}.png` });

    await review.getByTestId('build-quest').click();
    const result = dlg.getByTestId('build-result');
    await expect(result).toContainText('A door to Back Room in');
    await expect(result).toContainText('Back Room got a navmesh');
    expect(errors).toEqual([]);
  });
}
