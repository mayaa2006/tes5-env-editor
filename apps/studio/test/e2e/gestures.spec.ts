/** Gestures: animations on dialogue lines and at quest stages, chosen by name. */
import { expect, test } from '@playwright/test';

test('characters gesture in dialogue and at quest stages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();

  // The example quest has a laugh at stage 20 and gestures in its dialogue.
  await page.getByTestId('quest-from-writing').click();
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('use-example').click();
  await dlg.getByTestId('plan-tab-story').click();
  await expect(dlg.getByTestId('plan-stages')).toContainText('Eirik: laugh');
  await dlg.getByTestId('build-quest').click();
  await dlg.getByTestId('open-built-quest').click();

  // Stage 20: Eirik laughs; add Brynja waving, then take it away again.
  await page.getByTestId('stage-node-20').click();
  const anim = page.getByTestId('stage-gestures');
  await expect(anim).toContainText('InnkeeperRingQuestEirik: Laugh');
  await anim.getByRole('button', { name: 'Who…' }).click();
  await anim.getByPlaceholder(/Search/).fill('DemoInnkeeper');
  await anim.locator('.list-item', { hasText: 'DemoInnkeeper' }).first().click();
  await anim.getByTestId('stage-gesture').selectOption('wave');
  await anim.getByTestId('add-stage-gesture').click();
  await expect(anim).toContainText('DemoInnkeeper: Wave');
  await anim.locator('.row', { hasText: 'DemoInnkeeper: Wave' }).getByTitle('Remove this animation').click();
  await expect(anim).not.toContainText('DemoInnkeeper: Wave');
  await expect(anim).toContainText('Eirik: Laugh');

  // Dialogue: Brynja applauds when she gets the ring back; change it to a bow.
  await page.getByRole('tab', { name: /Dialogue/ }).click();
  await page.getByTestId('dlg-info').filter({ hasText: 'thank the gods' }).getByText(/thank the gods/).click(); // the line itself (the chips above it jump to the map)
  const gesture = page.getByTestId('dlg-gesture');
  await expect(gesture).toHaveValue('applaud');
  await gesture.selectOption('bow');
  await expect(gesture).toHaveValue('bow');

  // Writing a script: the picker adds a [gesture] tag to the line the cursor is on.
  await page.getByTestId('dlg-script').click();
  const text = page.getByTestId('dlg-script-text');
  await text.fill('PLAYER: Hello\nDemoInnkeeper: Welcome!');
  await text.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(20, 20));
  await page.getByTestId('dlg-insert-gesture').selectOption('wave');
  await expect(text).toHaveValue('PLAYER: Hello\nDemoInnkeeper: Welcome! [gesture wave]');
  await page.getByTestId('dlg-import').click();
  await page.getByTestId('dlg-info').filter({ hasText: 'Welcome!' }).click();
  await expect(page.getByTestId('dlg-gesture')).toHaveValue('wave');
  expect(errors).toEqual([]);
});
