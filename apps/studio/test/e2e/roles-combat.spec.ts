/** Roles and fighting: make a character a follower, merchant and trainer, add enemies, build. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`roles, fighting and enemy groups (${size.width}×${size.height})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
    await page.getByTestId('quest-from-writing').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('use-example').click();

    // Eirik: follower, sells general goods, trains Sneak.
    await dlg.getByTestId('plan-tab-cast').click();
    const eirik = dlg.locator('.list-item', { hasText: 'Eirik' });
    await eirik.locator('summary', { hasText: 'Roles and fighting' }).click();
    await eirik.getByTestId('role-follower').check();
    await expect(eirik).toContainText('can follow the player');
    await eirik.getByTestId('role-sells').fill('general goods');
    await eirik.getByTestId('role-sells').press('Enter');
    await expect(eirik).toContainText('sells general goods');
    await eirik.locator('label', { hasText: 'Trains' }).locator('select').selectOption('Sneak');
    await expect(eirik).toContainText('trains Sneak up to 50');

    // Three guards turn up in the tavern; beating them moves the quest to 100.
    const enemies = dlg.getByTestId('plan-encounters');
    await expect(enemies).toContainText('No enemy groups');
    await enemies.getByTestId('add-encounter').click();
    await enemies.getByTestId('encounter-what').fill('Town Guard');
    await enemies.getByTestId('encounter-what').press('Enter');
    await enemies.locator('label', { hasText: 'When all are dead' }).locator('select').selectOption('100');
    await dlg.getByTestId('plan-tab-story').click();
    await expect(dlg.getByTestId('plan-steps')).toContainText('Defeat');
    if (process.env.SCREENSHOT_DIR) {
      await eirik.screenshot({ path: `${process.env.SCREENSHOT_DIR}/roles-${size.width}.png` });
      await dlg.getByTestId('plan-tab-cast').click();
      await enemies.screenshot({ path: `${process.env.SCREENSHOT_DIR}/enemies-${size.width}.png` });
    }

    await dlg.getByTestId('build-quest').click();
    const result = dlg.getByTestId('build-result');
    await expect(result).toContainText('sells general goods');
    await expect(result).toContainText('trains Sneak up to 50');
    await expect(result).toContainText('3 × Town Guard (DemoGuard) in The Demo Tavern');
    await expect(result).not.toContainText('22:00can follow');
    expect(errors).toEqual([]);
  });
}
