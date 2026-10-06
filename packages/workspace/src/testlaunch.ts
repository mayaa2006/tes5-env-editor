/**
 * Test launch: jump straight into the game at the place and quest stage
 * you're working on. Skyrim can't run console commands at start-up, so we
 * write them to a batch file in the game folder; in game, one console
 * command (`bat tes5test`) runs them all.
 */
import type { FormKey } from '@tes5/esp';
import { WorkspaceError, type Workspace } from './engine';
import { joinPath } from './fs';
import type { QuestGraph } from './questgraph';
import { WorldService } from './world';

export interface TestLaunchOptions {
  cell?: FormKey | null;
  quest?: FormKey | null;
  stage?: number | null;
  /** Also set the stages on the way to `stage` (runs their scripts in order). */
  replayStages?: boolean;
  items?: { item: FormKey; count: number }[];
  godMode?: boolean;
  /** Close the console automatically… not possible; kept for clarity of the UI. */
}

export const TEST_BAT_NAME = 'tes5test';

/** Stages from the start of the quest to `target`, following the quest map (shortest path). */
export function stagePath(g: QuestGraph, target: number): number[] {
  const starts = g.nodes.filter((n) => n.startUp).map((n) => n.stage);
  if (!starts.length && g.nodes[0]) starts.push(g.nodes[0].stage);
  const prev = new Map<number, number | null>(starts.map((s) => [s, null]));
  const queue = [...starts];
  while (queue.length) {
    const s = queue.shift()!;
    if (s === target) break;
    for (const e of g.edges) {
      if (e.from !== s || prev.has(e.to)) continue;
      prev.set(e.to, s);
      queue.push(e.to);
    }
  }
  if (!prev.has(target)) return g.nodes.map((n) => n.stage).filter((s) => s <= target);
  const path: number[] = [];
  for (let s: number | null = target; s !== null; s = prev.get(s) ?? null) path.unshift(s);
  return path;
}

export function testCommands(ws: Workspace, opts: TestLaunchOptions, graph?: QuestGraph): string[] {
  const lines: string[] = [];
  if (opts.godMode) lines.push('tgm');
  if (opts.cell) {
    const world = new WorldService(ws);
    const v = ws.view(opts.cell);
    if (!v || v.sig !== 'CELL') throw new WorkspaceError('Pick a cell to start in');
    const info = world.cells().find((c) => c.formKey === opts.cell);
    if (v.editorId) lines.push(`coc ${v.editorId}`);
    else if (info?.grid && info.worldspace) {
      const w = ws.view(info.worldspace)?.editorId;
      if (!w) throw new WorkspaceError('This exterior cell’s worldspace has no Editor ID to travel to');
      lines.push(`cow ${w} ${info.grid.x} ${info.grid.y}`);
    } else throw new WorkspaceError('This cell has no Editor ID; give it one to be able to travel there');
  }
  if (opts.quest && opts.stage !== null && opts.stage !== undefined) {
    const q = ws.view(opts.quest);
    if (!q?.editorId) throw new WorkspaceError('The quest needs an Editor ID');
    const stages = opts.replayStages && graph ? stagePath(graph, opts.stage) : [opts.stage];
    for (const s of stages) lines.push(`setstage ${q.editorId} ${s}`);
  } else if (opts.quest) {
    const q = ws.view(opts.quest);
    if (q?.editorId) lines.push(`startquest ${q.editorId}`);
  }
  for (const it of opts.items ?? []) lines.push(`player.additem ${ws.runtimeFormId(it.item)} ${Math.max(1, Math.round(it.count))}`);
  return lines;
}

export interface LaunchTarget {
  command: string;
  args: string[];
  cwd: string;
  how: string;
}

/** How to start the game: through MO2 (so mods are loaded) or directly via SKSE / the game exe. */
export async function findLauncher(ws: Workspace, ctx: { gameDir?: string; mo2?: { instanceDir: string; profile?: string; exe?: string; executable?: string } }): Promise<LaunchTarget | undefined> {
  if (ctx.mo2) {
    const exe = ctx.mo2.exe ?? joinPath(ctx.mo2.instanceDir, 'ModOrganizer.exe');
    if (await ws.fs.exists(exe)) {
      const args = [...(ctx.mo2.profile ? ['-p', ctx.mo2.profile] : []), `moshortcut://:${ctx.mo2.executable ?? 'SKSE'}`];
      return { command: exe, args, cwd: ctx.mo2.instanceDir, how: `Mod Organizer 2 → ${ctx.mo2.executable ?? 'SKSE'}` };
    }
  }
  if (!ctx.gameDir) return undefined;
  const se = ws.game === 'SkyrimSE';
  for (const name of se ? ['skse64_loader.exe', 'SkyrimSE.exe'] : ['skse_loader.exe', 'TESV.exe']) {
    const p = joinPath(ctx.gameDir, name);
    if (await ws.fs.exists(p)) return { command: p, args: [], cwd: ctx.gameDir, how: name };
  }
  return undefined;
}
