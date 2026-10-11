/** Plan a quest with a free AI: Ollama on this computer (mocked), picked from the installed models. */
import { expect, test } from '@playwright/test';
import { exampleQuestPlan } from '../../../../packages/workspace/src/demo/example-plan';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`plan with a free AI on this computer (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const chats: any[] = [];
    let running = false;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    await page.route('http://localhost:11434/**', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (!running) return route.abort('connectionrefused');
      if (route.request().url().endsWith('/api/tags')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ models: [{ name: 'qwen3:14b' }, { name: 'llama3.1:8b' }] }) });
      // How much the model can read (the app sizes the window to the prompt).
      if (route.request().url().endsWith('/api/show')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ model_info: { 'qwen3.context_length': 40960 } }) });
      chats.push(route.request().postDataJSON());
      const plan = exampleQuestPlan();
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ message: { content: '```json\n' + JSON.stringify(plan) + '\n```' }, done_reason: 'stop' }) });
    });
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
    await page.getByTestId('quest-from-writing').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('plan-source').fill('Brynja the innkeeper lost her ring. The player finds it in the cellar.');

    // Ollama not running yet: the steps to set it up are shown.
    await dlg.getByTestId('ai-kind-ollama').click();
    await expect(dlg.getByTestId('ollama-help')).toContainText("Couldn't reach Ollama");
    await expect(dlg.getByTestId('ollama-help')).toContainText('ollama pull');
    await expect(dlg.getByTestId('plan-quest')).toBeDisabled();

    // Started: the installed models are found and the first one is picked.
    running = true;
    await dlg.getByTestId('ollama-refresh').click();
    await expect(dlg.getByTestId('ollama-found')).toContainText('qwen3:14b, llama3.1:8b');
    await expect(dlg.getByTestId('ollama-model')).toHaveValue('qwen3:14b');
    if (process.env.SCREENSHOT_DIR) await dlg.screenshot({ path: `${process.env.SCREENSHOT_DIR}/free-ai-${size.width}.png` });
    await dlg.getByTestId('ai-done').click();
    await expect(dlg.getByTestId('ai-summary')).toContainText('Planning with qwen3:14b (Ollama)');
    await dlg.getByTestId('plan-quest').click();

    const review = dlg.getByTestId('plan-review');
    await expect(review).toBeVisible();
    expect(chats[0].model).toBe('qwen3:14b');
    expect(chats[0].format.type).toBe('object');
    expect(chats[0].options.num_ctx).toBeLessThanOrEqual(40960);
    expect(chats[0].messages[1].content).toContain('Brynja the innkeeper lost her ring.');
    await expect(review.getByTestId('plan-feedback')).toHaveAttribute('placeholder', /Ask qwen3:14b \(Ollama\) to change the plan/);

    // The choice is remembered for next time.
    await page.reload();
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
    await page.getByTestId('quest-from-writing').click();
    await expect(page.getByRole('dialog').getByTestId('ai-summary')).toContainText('qwen3:14b');
    expect(errors).toEqual([]);
  });
}

test('plan with a free online service: key link, live model list (1280×800)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'content-type': 'application/json' };
  const chats: any[] = [];
  await page.route('https://api.groq.com/openai/v1/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.headers().authorization !== 'Bearer gsk_good') return route.fulfill({ status: 401, headers: cors, body: '{"error":"bad key"}' });
    if (req.url().endsWith('/models')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }] }) });
    chats.push(req.postDataJSON());
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(exampleQuestPlan()) }, finish_reason: 'stop' }] }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await page.getByTestId('quest-from-writing').click();
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('plan-source').fill('Brynja the innkeeper lost her ring.');
  await dlg.getByTestId('ai-kind-openai').click();
  await dlg.getByTestId('openai-preset').selectOption('groq');
  // The key page is a real link; the API address is explained as not a web page.
  await expect(dlg.getByTestId('openai-key-link')).toHaveAttribute('href', 'https://console.groq.com/keys');
  await expect(dlg.getByTestId('ai-settings')).toContainText('not a web page');
  // A wrong key is caught before planning.
  await dlg.getByTestId('openai-key').fill('gsk_bad');
  await dlg.getByTestId('openai-key').blur();
  await expect(dlg.getByTestId('openai-error')).toContainText('rejected the API key');
  // The right key lists the service's current models (speech models left out).
  await dlg.getByTestId('openai-key').fill('gsk_good');
  await dlg.getByTestId('openai-key').blur();
  await expect(dlg.getByTestId('openai-found')).toContainText('Key works: 2 model(s)');
  await expect(dlg.getByTestId('openai-model')).toHaveValue('llama-3.3-70b-versatile');
  if (process.env.SCREENSHOT_DIR) await dlg.screenshot({ path: `${process.env.SCREENSHOT_DIR}/free-online-1280.png` });
  await dlg.getByTestId('plan-quest').click();
  await expect(dlg.getByTestId('plan-review')).toBeVisible();
  expect(chats[0].model).toBe('llama-3.3-70b-versatile');
  expect(errors).toEqual([]);
});
