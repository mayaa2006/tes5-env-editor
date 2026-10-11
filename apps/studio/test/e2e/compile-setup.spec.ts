/** Scripts tab: the compile status card and the "Compiling scripts" setup (Caprica by default, game sources, compile on save). */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`compiling scripts is set up in one place (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'Scripts' }).click();

    // The demo's files are in memory, so it can't compile: the card says so, and Set up explains why.
    const card = page.getByTestId('build-card');
    await expect(card.getByTestId('build-not-ready')).toContainText('No compiling in the demo');
    await card.getByTestId('build-setup').click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByTestId('compile-desktop-only')).toBeVisible();
    await expect(dlg.getByTestId('compile-step-compiler')).toContainText('Caprica comes with the app');
    // The demo has the game's script sources already.
    await expect(dlg.getByTestId('compile-step-sources')).toHaveAttribute('data-ok', 'true');
    if (size.width === 1280) await page.screenshot({ path: 'test-results/compile-setup-1280.png' });

    // Choosing a compiler by hand, then going back to the automatic one.
    await dlg.getByTestId('compiler-choose').click();
    await dlg.locator('input.mono').first().fill('C:\\Tools\\Caprica.exe');
    await dlg.locator('input.mono').first().press('Enter');
    await expect(dlg.getByTestId('compile-step-compiler')).toHaveAttribute('data-ok', 'true');
    await expect(dlg.getByTestId('compile-step-compiler')).toContainText('chosen by you');
    await dlg.getByTestId('compiler-automatic').click();
    await expect(dlg.getByTestId('compile-step-compiler')).toHaveAttribute('data-ok', 'false');
    await expect(dlg.getByTestId('compiler-choose')).toBeVisible();

    // Compile on save is on by default, and the same setting is in Automations.
    await expect(dlg.getByRole('checkbox', { name: /Compile scripts that changed when saving/ })).toBeChecked();
    await dlg.getByRole('button', { name: 'Done' }).click();
    await page.locator('.workspace-tab', { hasText: 'Automations' }).click();
    await expect(page.getByRole('checkbox', { name: /Compile scripts that changed/ })).toBeChecked();
    expect(errors).toEqual([]);
  });
}
