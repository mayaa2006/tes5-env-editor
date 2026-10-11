/** The app menu behind the logo: Save and Settings first, then file, edit, create, workspaces and help. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`app menu works (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');

    // Before a game is open: only Settings, shortcuts and About are usable.
    await page.getByTestId('app-menu').click();
    await expect(page.getByRole('menuitem', { name: /Save/ })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: /Settings/ })).toBeEnabled();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();

    // The top bar fits the window (nothing pushed off the right edge).
    expect(await page.evaluate(() => document.querySelector('.topbar')!.scrollWidth <= document.querySelector('.topbar')!.clientWidth)).toBe(true);

    // The brand stays on one line and the logo keeps its shape.
    const logo = await page.locator('.topbar .logo').boundingBox();
    expect(logo!.width).toBeGreaterThanOrEqual(19);
    expect(Math.abs(logo!.width - logo!.height)).toBeLessThan(1);

    // Order: Save, then Settings, then everything else; the menu fits the window.
    await page.getByTestId('app-menu').click();
    const items = page.locator('.menu-pop [role^=menuitem]');
    await expect(items.nth(0)).toContainText('Save');
    await expect(items.nth(1)).toContainText('Settings');
    const pop = await page.locator('.menu-pop').boundingBox();
    expect(pop!.y + pop!.height).toBeLessThanOrEqual(size.height);

    // Settings opens and a save option can be switched.
    await items.nth(1).click();
    await expect(page.getByRole('dialog')).toContainText('Every time you save');
    await page.getByRole('button', { name: 'Done' }).click();

    // Go to a workspace and start something new from the menu.
    await page.getByTestId('app-menu').click();
    await page.getByRole('menuitem', { name: 'New script' }).click();
    await expect(page.locator('.workspace-tab.active')).toContainText('Scripts');
    await expect(page.getByRole('dialog')).toBeVisible(); // the new-script dialog opened
    await page.keyboard.press('Escape');

    // Shortcuts list and About.
    await page.getByTestId('app-menu').click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByTestId('shortcuts-list')).toContainText('Ctrl+S');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByTestId('app-menu').click();
    await page.getByRole('menuitem', { name: 'About' }).click();
    await expect(page.getByText('TES5 Env Editor').last()).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    // Closing with unsaved changes asks first, then goes back to the start screen.
    await page.getByTestId('app-menu').click();
    await page.getByRole('menuitem', { name: 'Close game folder' }).click();
    await expect(page.getByRole('dialog')).toContainText('Close without saving?');
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByTestId('app-menu').click();
    await page.getByRole('menuitem', { name: 'Close game folder' }).click();
    await page.getByRole('button', { name: 'Close and discard changes' }).click();
    await expect(page.getByRole('button', { name: /Explore the demo/ })).toBeVisible();

    expect(errors).toEqual([]);
  });
}
