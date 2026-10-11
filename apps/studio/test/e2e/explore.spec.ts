/**
 * Exploratory sweep: exercises (nearly) every control in every workspace of
 * the browser demo and fails if anything throws, logs a console error or
 * shows an unexpected error toast. Steps keep going after a failure so one
 * run reports everything.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ actionTimeout: 6000 });

const EXPECTED_ERRORS = [/can't be compiled in the demo/];

test('exploratory sweep of every workspace', async ({ page }) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  let step = 'start';
  page.on('pageerror', (e) => problems.push(`[${step}] page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/\[engine\]|Failed to load resource|WebGL|GPU stall/.test(m.text())) problems.push(`[${step}] console: ${m.text().slice(0, 300)}`);
  });
  const seenToasts = new Set<string>();
  const checkToasts = async () => {
    for (const t of await page.locator('.toast.error').allTextContents()) {
      if (seenToasts.has(t)) continue;
      seenToasts.add(t);
      if (!EXPECTED_ERRORS.some((r) => r.test(t))) problems.push(`[${step}] error toast: ${t}`);
    }
  };
  const run = async (name: string, fn: () => Promise<void>) => {
    step = name;
    try {
      await fn();
    } catch (e) {
      const msg = (e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(0, 5).join(' | ');
      problems.push(`[${name}] step failed: ${msg}`);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/fail-${name.replace(/\W+/g, '_')}.png` });
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    await page.waitForTimeout(150);
    await checkToasts();
  };
  const ws = (name: string) => page.locator('.workspace-tab', { hasText: name }).click();
  const vp = () => page.getByTestId('viewport');
  const center = async () => {
    const b = (await vp().boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const undoCount = async () => {
    // clicking undo until disabled, bounded
    let n = 0;
    while (n < 60 && (await page.locator('button[title^="Undo"]').isEnabled())) {
      await page.locator('button[title^="Undo"]').click();
      n++;
    }
    return n;
  };

  await run('open demo', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await expect(page.getByText('Editing MyMod.esp')).toBeVisible();
  });

  // ---------------------------------------------------------------- world
  await run('world: open interior', async () => {
    await page.getByTestId('cell-list').getByText('DemoTavern', { exact: true }).click();
    await expect(vp().locator('canvas')).toBeVisible();
    await page.waitForTimeout(800);
  });
  await run('world: toolbar views', async () => {
    for (const n of ['Top', 'Front', 'Right', 'Frame everything']) {
      await page.getByTestId('view-menu').click();
      await page.getByRole('menuitem', { name: n }).click();
    }
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('view-menu').click();
      await page.getByRole('menuitemcheckbox', { name: /^Orthographic/ }).click();
    }
    // Show toggles keep the menu open; flip each twice.
    await page.getByTestId('view-menu').click();
    for (const n of ['Editor markers', 'Cell lighting preview', 'Navmesh']) {
      await page.getByRole('menuitemcheckbox', { name: n }).click();
      await page.getByRole('menuitemcheckbox', { name: n }).click();
    }
    await page.keyboard.press('Escape');
  });
  await run('world: viewport navigation', async () => {
    const c = await center();
    await page.mouse.move(c.x, c.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(c.x + 80, c.y + 30, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    await page.keyboard.down('Shift');
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(c.x + 20, c.y - 20, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    await page.keyboard.up('Shift');
    await page.mouse.wheel(0, 300);
    await page.mouse.wheel(0, -300);
    // fly
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(c.x + 30, c.y + 10, { steps: 3 });
    await page.keyboard.down('w');
    await page.waitForTimeout(200);
    await page.keyboard.up('w');
    await page.mouse.up({ button: 'right' });
    for (const k of ['Numpad1', 'Numpad3', 'Numpad7', 'Numpad5', 'Numpad5', 'Home']) await page.keyboard.press(k);
  });
  await run('world: click select, rotate/scale with typed values', async () => {
    await page.getByTestId('outliner').getByText('DemoTableRef').first().click().catch(async () => {
      await page.getByTestId('outliner').locator('.list-item').nth(3).click();
    });
    const c = await center();
    await page.mouse.move(c.x, c.y);
    await page.keyboard.press('r');
    await page.keyboard.press('z');
    await page.keyboard.type('45');
    await page.keyboard.press('Enter');
    await page.keyboard.press('s');
    await page.keyboard.type('1.5');
    await page.keyboard.press('Enter');
    await page.keyboard.press('g');
    await page.mouse.move(c.x + 40, c.y + 10, { steps: 4 });
    await page.mouse.click(c.x + 40, c.y + 10, { button: 'right' }); // cancel
    await page.keyboard.press('g');
    await page.keyboard.press('Shift+Z');
    await page.mouse.move(c.x + 60, c.y + 30, { steps: 4 });
    await page.keyboard.down('Control');
    await page.mouse.move(c.x + 70, c.y + 35, { steps: 2 });
    await page.keyboard.up('Control');
    await page.mouse.click(c.x + 70, c.y + 35);
  });
  await run('world: inspector transform fields', async () => {
    const insp = page.getByTestId('inspector');
    const field = insp.locator('.field', { hasText: 'Location' }).locator('.input').first();
    await field.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('123');
    await page.keyboard.press('Enter');
    await expect(insp.locator('.field', { hasText: 'Location' }).locator('.input').first()).toContainText('123');
  });
  await run('world: duplicate, hide, unhide, delete', async () => {
    const c = await center();
    await page.mouse.move(c.x, c.y);
    await page.keyboard.press('Shift+D');
    await page.waitForTimeout(400);
    await page.mouse.move(c.x + 30, c.y, { steps: 3 });
    await page.keyboard.press('Enter');
    await page.keyboard.press('h');
    await page.keyboard.press('Alt+h');
    await page.keyboard.press('a');
    await page.keyboard.press('Alt+a');
    await page.getByTestId('outliner').locator('.list-item').first().click();
    await page.mouse.move(c.x, c.y);
    await page.keyboard.press('x');
    await page.waitForTimeout(300);
  });
  await run('world: box select', async () => {
    const c = await center();
    await page.mouse.move(c.x - 150, c.y - 100);
    await page.mouse.down();
    await page.mouse.move(c.x + 150, c.y + 100, { steps: 6 });
    await page.mouse.up();
  });
  await run('world: gizmo tools', async () => {
    for (const t of ['Move', 'Rotate', 'Scale', 'Select']) await page.locator('.viewport-toolbar button', { hasText: new RegExp(`^\\s*${t}$`) }).first().click();
    await page.locator('.viewport-toolbar button[title^="Grid snapping"]').click();
    await page.locator('.viewport-toolbar button[title^="Grid snapping"]').click();
  });
  await run('world: drop a mesh file from Assets', async () => {
    await page.getByRole('tab', { name: 'Assets' }).click();
    await page.getByTestId('asset-list').getByText('demo', { exact: true }).click();
    await page.getByTestId('asset-list').getByText('crate.nif').waitFor();
    const c = await center();
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.setData('application/x-tes5-mesh', 'meshes\\demo\\crate.nif');
      return d;
    });
    await vp().dispatchEvent('dragover', { dataTransfer: dt, clientX: c.x, clientY: c.y });
    await vp().dispatchEvent('drop', { dataTransfer: dt, clientX: c.x, clientY: c.y });
    await page.waitForTimeout(500);
  });
  await run('world: exterior cell with terrain + navmesh', async () => {
    await page.getByRole('tab', { name: 'Cells' }).click();
    await page.getByTestId('cell-list').locator('..').getByText('DemoValley1_0').click();
    await page.waitForTimeout(800);
    await page.getByTestId('navmesh-menu').click();
    await page.getByRole('menuitem', { name: 'Generate navmesh…' }).click();
    await page.getByTestId('generate-navmesh').click();
    await expect(page.locator('.toast').filter({ hasText: /Navmesh:/ }).last()).toBeVisible();
    await page.getByTestId('cell-list').locator('..').getByText('DemoValley0_0').click();
    await page.waitForTimeout(500);
  });
  await run('world: new interior cell', async () => {
    await page.getByTestId('new-cell').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.viewport-toolbar strong')).toHaveText('MyNewInterior');
  });
  await run('world: undo everything, redo some', async () => {
    const n = await undoCount();
    if (n === 0) throw new Error('nothing to undo');
    for (let i = 0; i < 3; i++) await page.locator('button[title^="Redo"]').click();
  });

  // ---------------------------------------------------------------- inspector on records
  await run('records: browse, conflict view, edit a form', async () => {
    await ws('Records');
    await page.getByTestId('record-list').getByText('DemoTavernChestRef').click().catch(async () => {
      await page.getByTestId('record-list').locator('.list-item').first().click();
    });
    await expect(page.getByTestId('conflicts')).toBeVisible();
    await page.getByLabel('Only differences').check().catch(() => undefined);
    await page.getByLabel('Raw fields').check().catch(() => undefined);
    await page.locator('select').first().selectOption({ label: /Static/ } as never).catch(async () => {
      const opts = await page.locator('select').first().locator('option').allTextContents();
      await page.locator('select').first().selectOption({ label: opts.find((o) => o.startsWith('Static'))! });
    });
    await page.getByTestId('record-list').getByText('DemoCrate', { exact: true }).click();
    const edid = page.getByTestId('inspector').locator('.field', { hasText: 'Editor ID' }).locator('input').first();
    await edid.fill('DemoCrateRenamed');
    await edid.press('Enter');
    await expect(page.getByTestId('inspector')).toContainText('DemoCrateRenamed');
    // Add a field
    const add = page.getByTestId('inspector').locator('select', { hasText: 'Add field' });
    if (await add.count()) {
      const opts = await add.locator('option').allTextContents();
      if (opts.length > 1) {
        await add.selectOption({ index: 1 });
        await page.getByTestId('inspector').getByRole('button', { name: 'Add', exact: true }).click();
      }
    }
    await page.getByTestId('inspector').getByRole('button', { name: /Used by/ }).click();
    await page.getByTestId('inspector').getByRole('button', { name: /Duplicate/ }).click();
  });

  // ---------------------------------------------------------------- characters
  await run('characters: all tabs', async () => {
    await ws('Characters');
    await page.getByTestId('npc-list').locator('.list-item').first().click();
    await expect(page.getByTestId('head-preview').locator('canvas')).toBeVisible();
    await page.getByRole('tab', { name: 'Body' }).click();
    await page.locator('button', { hasText: /^Female$/ }).click();
    await page.locator('button', { hasText: /^Male$/ }).click();
    const races = page.locator('.field', { hasText: 'Race' }).locator('select');
    const n = await races.locator('option').count();
    if (n > 1) await races.selectOption({ index: n - 1 });
    await page.getByRole('tab', { name: 'Head' }).click();
    const chips = page.locator('button.chip');
    if (await chips.count()) await chips.nth(Math.min(2, (await chips.count()) - 1)).click();
    await page.getByRole('tab', { name: 'Face' }).click();
    await page.getByRole('button', { name: 'Randomize' }).click();
    await page.getByRole('button', { name: 'Reset all', exact: true }).click();
    const slider = page.locator('input[type=range]').first();
    const sb = (await slider.boundingBox())!;
    await page.mouse.click(sb.x + sb.width * 0.8, sb.y + sb.height / 2);
    await page.getByRole('tab', { name: 'Colours' }).click();
    const sw = page.locator('.color-swatch');
    if (await sw.count()) await sw.last().click();
    await page.getByRole('tab', { name: 'Paint' }).click();
    const layer = page.getByTestId('paint-tab').locator('select');
    if ((await layer.locator('option').count()) > 1) {
      await layer.selectOption({ index: 1 });
      await page.getByRole('button', { name: /Add layer/ }).click();
    }
  });
  await run('characters: new NPC', async () => {
    await page.getByTestId('new-npc').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('npc-list')).toContainText('New Character');
  });

  // ---------------------------------------------------------------- quests
  await run('quests: new quest with stages, objective, alias, topic, response', async () => {
    await ws('Quests');
    await page.getByTestId('new-quest').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('quest-map')).toBeVisible();
    await page.getByRole('tab', { name: /Stages/ }).click();
    await expect(page.getByTestId('stages')).toBeVisible();
    await page.getByTestId('add-stage').click();
    await page.locator('.card', { has: page.getByPlaceholder('Journal entry (optional)') }).getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('tab', { name: /Objectives/ }).click();
    await page.getByPlaceholder(/New objective/).fill('Find the cellar key');
    await page.getByPlaceholder(/New objective/).press('Enter');
    await page.locator('main.center').getByRole('button', { name: 'Add objective', exact: true }).click();
    await page.getByRole('tab', { name: /Aliases/ }).click();
    for (const kind of ['actor', 'ref', 'loc']) {
      await page.getByPlaceholder('Alias name').fill(`Alias${kind}`);
      await page.getByPlaceholder('Alias name').press('Enter');
      await page.locator('select').filter({ hasText: 'Unique actor' }).selectOption(kind);
      await page.locator('main.center').getByRole('button', { name: 'Add alias', exact: true }).click();
      await page.waitForTimeout(150);
    }
    await expect(page.locator('table.grid')).toContainText('Aliasloc');
    await page.getByRole('tab', { name: /Dialogue/ }).click();
    await page.getByRole('button', { name: 'List view' }).click();
    await page.getByTestId('add-topic').click();
    await page.getByPlaceholder(/What the player picks/).fill('Any rumors?');
    await page.getByPlaceholder(/What the player picks/).press('Enter');
    await page.locator('main.center').getByRole('button', { name: 'Create topic', exact: true }).click();
    await page.locator('main.center').getByRole('button', { name: /Add response/ }).last().click();
    await page.getByPlaceholder(/One line per row/).fill('Not today.\nCome back later.');
    await page.getByPlaceholder(/One line per row/).blur();
    await page.locator('main.center').getByRole('button', { name: 'Add response', exact: true }).last().click();
    await expect.poll(() => page.getByTestId('dialogue').locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(expect.arrayContaining(['Any rumors?', 'Not today.', 'Come back later.']));
  });
  await run('quests: conditions and begin script on a response', async () => {
    await page.getByTestId('dialogue').getByText(/all conditions \(\d+\)/).last().click();
    await page.getByRole('button', { name: /Add condition/ }).click();
    await page.waitForTimeout(200);
    await page.getByTestId('dialogue').getByText('Begin script').last().click();
    const ed = page.getByTestId('code-editor').last();
    await ed.click();
    await page.keyboard.type('GetOwningQuest().SetStage(10)');
    await page.getByRole('button', { name: 'Save script' }).last().click();
    await expect(page.locator('.toast').filter({ hasText: /Saved begin script/ })).toBeVisible();
  });
  await run('quests: overview, flow, voice', async () => {
    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.getByLabel('Allow repeated stages').check();
    await page.getByRole('tab', { name: 'Map' }).click();
    await expect(page.getByTestId('quest-map')).toBeVisible();
    await page.getByRole('tab', { name: 'Voice files' }).click();
    await page.getByTestId('quest-list').getByText('DemoTavernQuest').click();
    await page.getByRole('tab', { name: 'Map' }).click();
    await page.waitForTimeout(300);
  });

  // ---------------------------------------------------------------- scripts
  await run('scripts: new script, edit, save, compile (expected: not in the demo)', async () => {
    await ws('Scripts');
    await page.getByTestId('new-script').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.viewport-toolbar strong')).toHaveText('MyScript');
    await page.getByTestId('code-editor').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nInt Property Count Auto\n');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.toast').filter({ hasText: 'Saved MyScript.psc' })).toBeVisible();
    await page.getByTestId('compile').click();
    // The demo can't compile (its files are in memory): Compile shows what's needed instead of failing.
    await expect(page.getByRole('dialog')).toContainText("can't be compiled");
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    // The Scripts tab's compile card leads to the same setup, where compiling on save is offered.
    await page.getByTestId('build-setup').click();
    await expect(page.getByRole('dialog')).toContainText("can't be compiled");
    await expect(page.getByRole('dialog')).toContainText('Compile scripts that changed when saving');
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('script-list').getByText('DemoChestScript').click();
    await page.locator('.panel', { hasText: 'Outline' }).locator('.list-item').first().click();
  });
  await run('scripts: completion popup appears', async () => {
    await page.getByTestId('code-editor').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nFunction T()\n  Game.');
    await expect(page.locator('.suggest-widget .monaco-list-row').first()).toBeVisible({ timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  // ---------------------------------------------------------------- clean / automations / plugins
  await run('clean: analyze master, clean dirty patch', async () => {
    await ws('Clean');
    await page.locator('select').first().selectOption('DemoWorld.esm');
    await page.getByTestId('analyze').click();
    await expect(page.getByTestId('clean-report')).toBeVisible();
    await page.locator('select').first().selectOption('DirtyPatch.esp');
    await page.locator('select').nth(1).selectOption('xedit');
    await page.getByTestId('clean').click();
    await page.getByTestId('analyze').click();
    await expect(page.getByTestId('clean-report')).toContainText(/Nothing to clean|Kept/);
  });
  await run('automations', async () => {
    await ws('Automations');
    await expect(page.getByTestId('on-save')).toBeVisible();
    await page.locator('.help').first().hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
  });
  await run('release: check, fixes, light plugin', async () => {
    await ws('Release');
    await expect(page.getByTestId('esl-card')).toBeVisible();
    await page.getByTestId('run-check').click();
    await expect(page.getByTestId('run-check')).toHaveText(/Check again/);
    for (const fix of await page.getByTestId('fix').all()) if (await fix.isVisible()) await fix.click().catch(() => undefined);
    const compact = page.getByRole('button', { name: 'Compact FormIDs' });
    if (await compact.isEnabled()) await compact.click();
    const flag = page.getByRole('button', { name: 'Flag as ESL' });
    if (await flag.isEnabled()) {
      await flag.click();
      await expect(page.getByRole('button', { name: 'Remove ESL flag' })).toBeVisible();
      await page.getByRole('button', { name: 'Remove ESL flag' }).click();
      await expect(page.getByRole('button', { name: 'Flag as ESL' })).toBeVisible();
    }
  });
  await run('plugins: switch active plugin and back, new plugin', async () => {
    await ws('Plugins');
    await page.getByRole('button', { name: 'Edit this plugin' }).first().click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /New plugin/ }).click();
    await page.getByRole('dialog').locator('input').first().fill('Second.esp');
    await page.getByRole('dialog').locator('input').first().press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Editing Second.esp')).toBeVisible();
  });
  await run('save', async () => {
    await page.keyboard.press('Control+s');
    await expect(page.locator('.toast').filter({ hasText: /Saved Second.esp/ })).toBeVisible();
  });

  await checkToasts();
  console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n${problems.join('\n')}` : '\nNo problems found');
  expect(problems).toEqual([]);
});
