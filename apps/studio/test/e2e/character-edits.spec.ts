/** Quest from writing can change existing characters (outfit saved as an outfit, factions, look) with no quest at all. */
import { expect, test } from '@playwright/test';

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

const PLAN = {
  title: 'Halvar dresses up',
  editorId: 'HalvarDressesUp',
  summary: 'Halvar wears his fine clothes and joins the merchants.',
  startsWithGame: false,
  startsWhen: null,
  characters: [
    {
      key: 'halvar', name: 'Halvar', existing: 'DemoBlacksmith', basedOn: null, sex: null, race: null, role: 'Smith', appearance: 'Fine clothes and a hood, grey hair',
      look: { weight: null, height: null, hair: null, hairColor: 'grey', facialHair: null, eyes: null, scar: null },
      voice: null, locationKey: null, spot: null, essential: null, className: null, level: null,
      outfit: { items: ['Blue Fine Clothes', 'Brown Hood', 'Leather Boots'], saveAs: 'HalvarSundayBest' },
      factions: [{ faction: 'Merchants', rank: 0 }], inventory: [], routine: [], combat: null, roles: null, relationships: [],
    },
  ],
  locations: [], items: [], encounters: [], stages: [], objectives: [], steps: [], conversations: [], rewards: [], animations: [], events: [], failures: [],
  assumptions: ['Halvar keeps his hair style'], questions: [],
};

test('change an existing character from a description', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://api.anthropic.com/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(JSON.stringify(PLAN)) }));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await page.getByTestId('quest-from-writing').click();
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('plan-source').fill('Halvar now wears his blue fine clothes, a brown hood and leather boots; save that as an outfit called HalvarSundayBest. He joins the merchants and his hair has gone grey.');
  await dlg.getByTestId('api-key').fill('sk-ant-test');
  await dlg.getByTestId('api-key').blur();
  await dlg.getByTestId('plan-quest').click();

  const review = dlg.getByTestId('plan-review');
  await review.getByTestId('plan-tab-cast').click();
  await expect(review).toContainText('existing, changed');
  await expect(review.getByTestId('character-change').first()).toContainText('wears Blue Fine Clothes, Brown Hood, Leather Boots (saved as HalvarSundayBest)');
  await expect(review).toContainText('joins Merchants');
  await expect(review).toContainText('No quest: only the characters, places and items above are created or changed.');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/16-character-edits.png` });
  await review.getByTestId('build-quest').click();

  const result = dlg.getByTestId('build-result');
  await expect(result).toContainText('1 character(s) changed');
  await expect(result.getByTestId('changed-character')).toContainText('Changed Halvar the Smith (DemoBlacksmith)');
  await expect(result).toContainText('HalvarSundayBest: Blue Fine Clothes, Brown Hood, Leather Boots (worn by Halvar)');
  await result.getByTestId('open-built-quest').click();
  await expect(page.locator('.workspace-tab.active, .workspace-tab[aria-current]').first()).toContainText('Characters');
  expect(errors).toEqual([]);
});
