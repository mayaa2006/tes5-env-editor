/**
 * A whole quest from the built-in free AI in the AI tab: asked for a quest, it's given the quest planner (not the
 * piece-by-piece quest tools), plans the quest, says what it will make, and builds it when told. The built-in AI is a
 * stand-in here (the real one runs in the desktop app) and its server is a mocked OpenAI-style address.
 */
import { expect, test } from '@playwright/test';
import { exampleQuestPlan } from '../../../../packages/workspace/src/demo/example-plan';

const API = 'http://127.0.0.1:47124/v1';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`the built-in AI plans and builds a whole quest (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((api) => {
      (window as any).__tes5TestLocalAi = (emit: (s: unknown) => void) => {
        const st: any = { supported: true, folder: 'C:\\local-ai', runtimeInstalled: true, installed: ['qwen3.5-4b'], server: { state: 'stopped' } };
        const copy = () => JSON.parse(JSON.stringify(st));
        return {
          status: copy,
          async install() {
            return copy();
          },
          cancel() {},
          async remove() {
            return copy();
          },
          async ensure(id: string) {
            st.server = { state: 'running', model: id, device: 'processor' };
            emit(copy());
            return api;
          },
          async stop() {
            st.server = { state: 'stopped' };
            emit(copy());
          },
          async setDevice() {
            return copy();
          },
          async gpuLost() {},
        };
      };
    }, API);

    const agent: any[] = [];
    const planner: any[] = [];
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    const reply = (content: string, call?: { name: string; args: object }) => ({
      choices: [{ message: { content, ...(call ? { tool_calls: [{ id: `c${agent.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 4000, completion_tokens: 40 },
    });
    await page.route(`${API}/**`, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const body = route.request().postDataJSON();
      // The planner asks for a JSON plan and offers no tools; the conversation offers tools.
      if (!body.tools) {
        planner.push(body);
        return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(reply(JSON.stringify(exampleQuestPlan()))) });
      }
      agent.push(body);
      const last = body.messages[body.messages.length - 1];
      const called = [...body.messages].reverse().find((m: any) => m.tool_calls)?.tool_calls?.[0]?.function?.name;
      const answer =
        last.role === 'tool'
          ? called === 'plan_quest'
            ? reply("Here's the plan: The Innkeeper's Ring, with Brynja and a new character, Eirik, four stages and two conversations. Shall I build it?")
            : reply("Built The Innkeeper's Ring.")
          : /build/i.test(String(last.content))
            ? reply('', { name: 'build_plan', args: { planId: 'plan1' } })
            : reply('', { name: 'plan_quest', args: { text: String(last.content) } });
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(answer) });
    });

    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'AI' }).click();
    await page.getByTestId('ai-kind-local').click();
    await expect(page.locator('[data-testid^="local-model-"]').first().getByTestId('local-in-use')).toBeVisible();
    await page.getByTestId('ai-done').click();
    await page.getByRole('checkbox', { name: 'Ask before each change' }).uncheck();

    // Asked for a quest, it's given the planner, not the tools for building one stage and line at a time.
    await page.getByTestId('ai-input').fill("Make a quest: Brynja at the tavern has lost her mother's ring. Eirik saw where it fell. The player brings it back and Brynja pays 100 gold.");
    await page.getByTestId('ai-send').click();
    await expect(page.getByTestId('ai-msg-assistant').last()).toContainText('Shall I build it?');
    const offered = (agent[0].tools as any[]).map((t) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(['plan_quest', 'revise_plan', 'build_plan', 'check_quest', 'more_tools']));
    expect(offered).not.toContain('create_quest');
    expect(offered).not.toContain('add_dialogue');
    expect(planner.length).toBeGreaterThan(0);
    expect(JSON.stringify(planner[0].messages)).toContain("Brynja at the tavern has lost her mother's ring");
    await expect(page.getByTestId('ai-turn')).toHaveCount(0);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/free-ai-quest-plan-${size.width}.png` });

    // Told to build it, it does, as one undo step that opens in Quests.
    await page.getByTestId('ai-input').fill('Looks good, build it.');
    await page.getByTestId('ai-send').click();
    await expect(page.getByTestId('ai-msg-assistant').last()).toContainText("Built The Innkeeper's Ring.");
    await expect(page.getByTestId('ai-turn')).toContainText('Build the quest from plan1');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/free-ai-quest-built-${size.width}.png` });
    await page.getByTestId('ai-tool').last().getByTestId('ai-tool-open').click();
    await expect(page.locator('.workspace-tab.active')).toContainText('Quests');
    await page.getByRole('tab', { name: /^Stages/ }).click();
    await expect(page.locator('main')).toContainText('Brynja');
    await expect(page.getByTestId('error-panel')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
