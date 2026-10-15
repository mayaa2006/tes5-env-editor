/** The AI tab: ask about the mod, the AI uses the editor's tools (Claude's API mocked), results link to their tabs. */
import { expect, test } from '@playwright/test';

/** A streamed Messages API answer: optional text, then optional tool calls. */
function sse(text: string, calls: { id: string; name: string; input: object }[] = []): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })];
  let i = 0;
  if (text) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } }), ev('content_block_stop', { index: i }));
    i++;
  }
  for (const c of calls) {
    out.push(
      ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }),
      ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }),
      ev('content_block_stop', { index: i }),
    );
    i++;
  }
  out.push(ev('message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }), ev('message_stop', {}));
  return out.join('');
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`ask the AI about the mod (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const bodies: any[] = [];
    await page.route('https://api.anthropic.com/**', async (route) => {
      const body = route.request().postDataJSON();
      bodies.push(body);
      const answer =
        bodies.length === 1
          ? sse('Let me look her up.', [{ id: 'tu_1', name: 'read_record', input: { form: 'DemoInnkeeper' } }])
          : sse('**Brynja** is the innkeeper of the Demo Tavern.\n\n- She stands behind the bar\n- She has no quests yet');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: answer });
    });
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'AI' }).click();

    // Nothing yet: what it can do, and places to start.
    await expect(page.getByTestId('ai-empty')).toContainText('Ask the AI about your mod');
    await expect(page.getByTestId('ai-starter')).toHaveCount(4);
    // No key yet: the AI's settings are open and sending waits.
    await expect(page.getByTestId('ai-input')).toBeDisabled();
    await page.getByTestId('api-key').fill('sk-ant-test');
    await page.getByTestId('api-key').blur();
    await expect(page.getByTestId('ai-input')).toBeEnabled();

    await page.getByTestId('ai-starter').first().click();
    await expect(page.getByTestId('ai-input')).toHaveValue(/What does my plugin contain/);
    await page.getByTestId('ai-input').fill('Who is the innkeeper?');
    await page.getByTestId('ai-input').press('Enter');

    // The tool the AI used, and its answer.
    const tool = page.getByTestId('ai-tool').first();
    await expect(tool).toContainText('Read DemoInnkeeper');
    await expect(tool).toContainText('Done');
    await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('is the innkeeper of the Demo Tavern');
    await expect(page.getByTestId('ai-msg-assistant').last().locator('strong')).toHaveText('Brynja');
    await expect(page.getByTestId('ai-msg-assistant').last().locator('li')).toHaveCount(2);
    await expect(page.getByTestId('ai-input')).toHaveValue('');
    await expect(page.getByTestId('ai-session').first()).toContainText('Who is the innkeeper?');

    // What was sent: the tools, the question, then the tool's result.
    expect(bodies[0].model).toBe('claude-opus-5-5');
    expect(bodies[0].tools.map((t: any) => t.name)).toContain('search_records');
    expect(bodies[0].messages[0].content).toContain('Who is the innkeeper?');
    expect(bodies[1].messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(bodies[1].messages[2].content[0].content).toContain('DemoInnkeeper');

    // Details show what the tool returned; Open goes to the record.
    await tool.getByRole('button', { name: 'Details' }).click();
    await expect(tool.locator('pre')).toContainText('DemoInnkeeper');
    await tool.getByTestId('ai-tool-open').click();
    await expect(page.locator('.workspace-tab.active')).toContainText('Records');

    // Back on the AI tab the conversation is still there; a new one starts empty, and can be deleted.
    await page.locator('.workspace-tab', { hasText: 'AI' }).click();
    await expect(page.getByTestId('ai-msg-user')).toContainText('Who is the innkeeper?');
    await page.getByTestId('ai-new').click();
    await expect(page.getByTestId('ai-empty')).toBeVisible();
    await expect(page.getByTestId('ai-session')).toHaveCount(2);
    await page.getByTestId('ai-session').nth(1).getByRole('button').click();
    await page.getByTestId('ai-delete-confirm').click();
    await expect(page.getByTestId('ai-session')).toHaveCount(1);

    // The AI settings are in Settings too.
    await page.getByTitle(/Menu: save, settings/).click();
    await page.getByText('Settings…').click();
    await expect(page.getByTestId('settings-ai')).toContainText('Used by the AI tab');
    expect(errors).toEqual([]);
  });
}
