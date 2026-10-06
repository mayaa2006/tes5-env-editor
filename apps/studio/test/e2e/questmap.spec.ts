/** Building a quest visually: connect stages on the map and check what was created. */
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.SCREENSHOT_DIR;

async function dragHandle(page: Page, fromStage: number, to: { stage: number } | { x: number; y: number }) {
  const src = page.getByTestId(`stage-node-${fromStage}`).locator('.react-flow__handle-right');
  const a = (await src.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  let tx: number;
  let ty: number;
  if ('stage' in to) {
    const b = (await page.getByTestId(`stage-node-${to.stage}`).locator('.react-flow__handle-left').boundingBox())!;
    tx = b.x + b.width / 2;
    ty = b.y + b.height / 2;
  } else ({ x: tx, y: ty } = to);
  await page.mouse.move(tx, ty, { steps: 12 });
  await page.mouse.up();
}

async function pickForm(page: Page, label: RegExp, query: string, pick: string) {
  const field = page.getByRole('dialog').locator('.field', { hasText: label });
  await field.locator('button.input').click();
  await field.locator('.searchbox input').fill(query);
  await field.locator('.list-item', { hasText: pick }).first().click();
}

test('build a quest on the map', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await page.getByTestId('new-quest').click();
  await page.getByRole('dialog').getByLabel(/Running from game start/).check().catch(() => undefined);
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('quest-map')).toBeVisible();
  await expect(page.getByTestId('stage-node-10')).toBeVisible();

  // Stage 0 → 10 by talking to the innkeeper.
  await dragHandle(page, 0, { stage: 10 });
  await page.getByTestId('connection-kinds').getByText('Talk to someone').click();
  await pickForm(page, /Who/, 'Innkeeper', 'DemoInnkeeper');
  await page.getByRole('dialog').getByPlaceholder('The line in the dialogue menu').fill('Got any work?');
  await page.getByRole('dialog').getByPlaceholder('The line in the dialogue menu').blur();
  await page.getByRole('dialog').getByPlaceholder('One line per row').fill('A crate went missing.\nFind it.');
  await page.getByRole('dialog').getByPlaceholder('One line per row').blur();
  await page.getByTestId('create-connection').click();
  await expect(page.locator('.qedge-label', { hasText: 'Got any work?' })).toBeVisible();

  // Stage 10 → a new stage, dropped on empty canvas: picking up the chest's key… (any placed object).
  const map = (await page.locator('.react-flow').boundingBox())!;
  await dragHandle(page, 10, { x: map.x + map.width * 0.75, y: map.y + map.height * 0.75 });
  await page.getByTestId('connection-kinds').getByText('Pick up an object').click();
  await pickForm(page, /Which object/, 'Barrel', 'Demo');
  await page.getByTestId('create-connection').click();
  await expect(page.locator('.qedge-label', { hasText: /Pick up/ })).toBeVisible();
  await expect(page.getByTestId('stage-node-110')).toBeVisible();

  // An objective shown at stage 10.
  await page.getByTestId('stage-node-10').click();
  await page.getByPlaceholder('New objective…').fill('Find the missing crate');
  await page.getByPlaceholder('New objective…').blur();
  await page.getByRole('button', { name: 'Add & show here' }).click();
  await expect(page.getByTestId('stage-node-10')).toContainText('Find the missing crate');

  // The quest check notices stage 100 can't be reached.
  await page.getByTestId('map-problems').click();
  await expect(page.locator('.card', { hasText: 'Quest check' })).toContainText('Nothing leads to stage 100');
  if (shots) await page.screenshot({ path: `${shots}/07-quest-map.png` });

  // Remove the pick-up connection, then undo it.
  await page.locator('.qedge-label', { hasText: /Pick up/ }).click();
  await page.getByTestId('remove-connection').click();
  await expect(page.locator('.qedge-label', { hasText: /Pick up/ })).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.qedge-label', { hasText: /Pick up/ })).toBeVisible();

  // Dialogue: write a conversation as a script, then add a choice by dragging.
  await page.getByRole('tab', { name: /Dialogue/ }).click();
  await expect(page.getByTestId('dialogue-graph')).toBeVisible();
  await page.getByTestId('dlg-script').click();
  await page.getByTestId('dlg-script-text').fill(
    ['PLAYER: Seen anything odd?', 'Brynja: Someone has been in the cellar.', '    PLAYER: Who?', '      Brynja: No idea. [goodbye]', '    PLAYER: Thanks.', '      Brynja: Mind the rats. [goodbye] [stage 100]'].join('\n'),
  );
  await expect(page.getByRole('dialog')).toContainText('Will add 3 player line(s) and 3 response(s)');
  await page.getByTestId('dlg-import').click();
  await expect(page.getByTestId('dlg-info').filter({ hasText: 'Mind the rats.' })).toBeVisible();
  const answer = page.getByTestId('dlg-info').filter({ hasText: 'Someone has been in the cellar.' });
  // Wait for the graph to finish fitting itself to the new lines before grabbing a handle.
  const viewport = page.locator('[data-testid=dialogue-graph] .react-flow__viewport');
  let last: string | null = null;
  await expect
    .poll(async () => {
      const t = await viewport.getAttribute('style');
      const settled = t === last;
      last = t;
      return settled;
    }, { intervals: [200] })
    .toBe(true);
  // The handle must have stopped moving (the fit animation can start after the viewport looked still).
  const handle = answer.locator('.react-flow__handle-right');
  let lastBox = '';
  await expect
    .poll(async () => {
      const b = JSON.stringify(await handle.boundingBox());
      const still = b === lastBox;
      lastBox = b;
      return still;
    }, { intervals: [250] })
    .toBe(true);
  const h = (await handle.boundingBox())!;
  // Drop on a spot that really is empty canvas (not a node, edge label or control), whatever the layout.
  const target = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid=dialogue-graph] .react-flow')!.getBoundingClientRect();
    for (let fy = 0.9; fy >= 0.1; fy -= 0.1)
      for (let fx = 0.9; fx >= 0.1; fx -= 0.1) {
        const x = pane.left + pane.width * fx;
        const y = pane.top + pane.height * fy;
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
      }
    return null;
  });
  expect(target).not.toBeNull();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x, target!.y, { steps: 10 });
  await page.mouse.up();
  await page.getByRole('dialog').getByPlaceholder('What the player can say next').fill('Can I help?');
  await page.getByRole('dialog').getByPlaceholder('What the player can say next').blur();
  await page.getByTestId('dlg-create-choice').click();
  await expect(page.getByTestId('dlg-topic').filter({ hasText: 'Can I help?' })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/08-dialogue-graph.png` });

  // The [stage 100] line now shows up on the quest map as a talk connection.
  await page.getByRole('tab', { name: 'Map' }).click();
  await expect(page.locator('.qedge-label', { hasText: 'Thanks.' })).toBeVisible();
  expect(errors).toEqual([]);
});
