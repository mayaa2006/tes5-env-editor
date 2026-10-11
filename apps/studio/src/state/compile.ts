/**
 * Script compiling that runs in the background, so you can keep working while
 * it goes (like the Creation Kit). Requests made while a run is in progress are
 * queued and picked up by the same run; each script is compiled once per run.
 */
import { useStore, type CompileOutput } from './store';

const pending = new Set<string>();
let running = false;

/** Does the Compile button have what it needs? (A compiler must be chosen first.) */
export function hasCompiler(): boolean {
  return !!useStore.getState().settings.compilerPath;
}

/**
 * Compile the named scripts in the background. `quiet` is for the automatic
 * compile on save: it stays silent unless something fails.
 */
export async function compileScripts(names: string[], opts: { quiet?: boolean; fresh?: boolean } = {}): Promise<void> {
  const st = useStore.getState();
  if (!st.client || !names.length) return;
  if (opts.fresh) useStore.setState({ compile: { ...st.compile, report: [] } });
  for (const n of names) pending.add(n);
  useStore.setState((s) => ({ compile: { ...s.compile, total: s.compile.total + names.length } }));
  if (running) return;
  running = true;
  useStore.setState((s) => ({ compile: { ...s.compile, running: true, done: 0, total: pending.size } }));
  let failed = 0;
  let okCount = 0;
  let fatal: string | undefined;
  try {
    while (pending.size && !fatal) {
      const name = [...pending][0];
      pending.delete(name);
      try {
        const [res] = (await useStore.getState().client!.call('scriptCompile', [name])) as CompileOutput[];
        if (res) {
          if (res.ok) okCount++;
          else failed++;
          useStore.setState((s) => ({ compile: { ...s.compile, report: [...s.compile.report.filter((r) => r.script.toLowerCase() !== name.toLowerCase()), res] } }));
        }
      } catch (e) {
        fatal = (e as Error).message;
      }
      useStore.setState((s) => ({ compile: { ...s.compile, done: s.compile.done + 1 } }));
    }
  } finally {
    running = false;
    pending.clear();
    useStore.setState((s) => ({ compile: { ...s.compile, running: false } }));
    useStore.getState().bump();
  }
  const toast = useStore.getState().toast;
  if (fatal) toast('error', fatal);
  else if (failed) toast('error', `${failed} script${failed === 1 ? '' : 's'} failed to compile. Open the Scripts tab for details.`);
  else if (!opts.quiet) toast('success', okCount === 1 ? 'Compiled 1 script' : `Compiled ${okCount} scripts`);
}

/** Compile every script in the mod (the ones you own, not the game's). */
export async function compileAll(): Promise<void> {
  const st = useStore.getState();
  const list = await st.client?.call('scriptList');
  const mine = (list ?? []).filter((s) => s.origin === 'mod').map((s) => s.name);
  if (!mine.length) {
    st.toast('info', 'No scripts to compile yet. Create one with New.');
    return;
  }
  await compileScripts(mine, { fresh: true });
}
