/**
 * The built-in free AI's settings and a message through it. The real one needs
 * the desktop app (it downloads and runs llama.cpp); here a stand-in plays its
 * part, and its "server" is a mocked OpenAI-style address.
 */
import { expect, test } from '@playwright/test';

const API = 'http://127.0.0.1:47123/v1';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`download a built-in AI, talk to it, remove it (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.addInitScript((api) => {
      (window as any).__tes5TestLocalAi = (emit: (s: unknown) => void) => {
        const st: any = { supported: true, folder: 'C:\\Users\\me\\AppData\\Roaming\\TES5 Env Editor\\local-ai', runtimeInstalled: false, installed: [], server: { state: 'stopped' } };
        const copy = () => JSON.parse(JSON.stringify(st));
        const send = () => emit(copy());
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        // What the real one does when the graphics card fails under it.
        (window as any).__simulateGpuLost = () => {
          st.movedOffGpu = true;
          st.server = { state: 'error', error: 'The graphics card stopped responding while the AI was using it.' };
          send();
        };
        return {
          status: copy,
          async install(id: string) {
            for (const [what, total] of [['runtime', 40e6], ['model', 1.3e9]] as const) {
              if (what === 'runtime' && st.runtimeInstalled) continue;
              for (let done = 0; done <= total; done += total / 4) {
                st.download = { model: id, what, done, total };
                send();
                await wait(150);
              }
            }
            st.runtimeInstalled = true;
            st.installed.push(id);
            delete st.download;
            send();
            return copy();
          },
          cancel() {},
          async remove(id: string) {
            st.installed = st.installed.filter((x: string) => x !== id);
            st.server = { state: 'stopped' };
            send();
            return copy();
          },
          async ensure(id: string) {
            st.server = { state: 'starting', model: id };
            send();
            await wait(200);
            st.server = { state: 'running', model: id, device: 'processor' };
            send();
            return api;
          },
          async stop() {
            st.server = { state: 'stopped' };
            send();
          },
          async setDevice(d: string) {
            st.prefer = d;
            if (d === 'auto') delete st.movedOffGpu;
            send();
            return copy();
          },
          async gpuLost() {
            (window as any).__simulateGpuLost();
          },
        };
      };
    }, API);
    const chats: any[] = [];
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    await page.route(`${API}/**`, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      chats.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ choices: [{ message: { content: 'The Bannered Mare is run by Hulda.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7000, completion_tokens: 12 } }) });
    });

    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'AI' }).click();
    await page.getByTestId('ai-kind-local').click();
    await expect(page.getByTestId('local-kind-builtin')).toHaveAttribute('aria-pressed', 'true');

    // Each model says what it's for, how big it is and what it needs; one is recommended.
    const rows = page.locator('[data-testid^="local-model-"]');
    expect(await rows.count()).toBeGreaterThan(1);
    await expect(page.getByTestId('local-ai')).toContainText('Recommended');
    await expect(rows.first()).toContainText('needs about');
    await expect(rows.first().getByTestId('local-download')).toHaveAttribute('title', /program that runs it \(llama\.cpp/);
    const first = rows.first();

    // Download: the runner, then the model, with progress; the first model downloaded is the one used.
    await first.getByTestId('local-download').click();
    await expect(first.getByTestId('local-progress')).toBeVisible();
    await expect(first.getByTestId('local-progress')).toContainText(/AI runner|Model/);
    await expect(first.getByTestId('local-in-use')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('local-server')).toContainText('starts when the AI is first needed');
    if (process.env.SCREENSHOT_DIR) await page.getByTestId('ai-settings').screenshot({ path: `${process.env.SCREENSHOT_DIR}/local-ai-${size.width}.png` });
    await page.getByTestId('ai-done').click();
    await expect(page.getByTestId('ai-summary')).toContainText('(on this PC)');

    // A message goes to the built-in AI, started on demand, with only the tools the message needs.
    await page.getByTestId('ai-input').fill('Who works at the Bannered Mare?');
    await page.getByTestId('ai-send').click();
    await expect(page.getByTestId('ai-messages')).toContainText('The Bannered Mare is run by Hulda.');
    const names = (chats[0].tools as any[]).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['search_records', 'place_contents', 'more_tools']));
    expect(names).not.toContain('create_character');
    expect(names.length).toBeLessThan(30);

    // Running on the processor, with a way to stop it; then remove the download.
    await page.getByTestId('ai-change').click();
    await expect(page.getByTestId('local-server')).toContainText('running on the processor');
    await page.getByTestId('local-stop').click();
    await expect(page.getByTestId('local-server')).toContainText('starts when the AI is first needed');
    await first.getByTestId('local-remove').click();
    await expect(first.getByTestId('local-download')).toBeVisible();

    // Where it runs: a graphics card when there is one, unless it failed (then the processor, and it says so) or the processor is chosen.
    const device = page.getByTestId('local-device').locator('select');
    await expect(device).toHaveValue('auto');
    await expect(page.getByTestId('local-moved-off-gpu')).toHaveCount(0);
    await page.evaluate(() => (window as any).__simulateGpuLost());
    await expect(page.getByTestId('local-moved-off-gpu')).toContainText('runs on the processor for now');
    await device.selectOption('processor');
    await expect(page.getByTestId('local-moved-off-gpu')).toHaveCount(0);
    await expect(device).toHaveValue('processor');
    await device.selectOption('auto');
    await expect(page.getByTestId('local-moved-off-gpu')).toHaveCount(0);
    if (process.env.SCREENSHOT_DIR) await page.getByTestId('ai-settings').screenshot({ path: `${process.env.SCREENSHOT_DIR}/local-ai-device-${size.width}.png` });
    expect(errors).toEqual([]);
  });
}
