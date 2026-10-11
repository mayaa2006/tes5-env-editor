/**
 * Script compiling that runs in the background, so you can keep working while
 * it goes (like the Creation Kit). Requests made while a run is in progress are
 * queued and picked up by the next batch; Caprica compiles a batch in one go.
 */
import { useStore, type CompileOutput } from './store';

const pending = new Set<string>();
let running = false;

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
      // Everything waiting goes in one batch (Caprica compiles many scripts per run).
      const batch = [...pending];
      pending.clear();
      try {
        const res = (await useStore.getState().client!.call('scriptCompile', batch)) as CompileOutput[];
        const names = new Set(batch.map((n) => n.toLowerCase()));
        for (const r of res) r.ok ? okCount++ : failed++;
        useStore.setState((s) => ({ compile: { ...s.compile, report: [...s.compile.report.filter((r) => !names.has(r.script.toLowerCase())), ...res] } }));
      } catch (e) {
        fatal = (e as Error).message;
      }
      useStore.setState((s) => ({ compile: { ...s.compile, done: s.compile.done + batch.length } }));
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

/** Compile every script in the mod (the ones you own, not the game's), or only those that changed since their last compile. */
export async function compileAll(opts: { changedOnly?: boolean } = {}): Promise<void> {
  const st = useStore.getState();
  const list = await st.client?.call('scriptList');
  const mine = (list ?? []).filter((s) => s.origin === 'mod').map((s) => s.name);
  const names = opts.changedOnly ? ((await st.client?.call('scriptBuildStatus'))?.outOfDate ?? []) : mine;
  if (!names.length) {
    st.toast('info', mine.length ? 'All your scripts are compiled already.' : 'No scripts to compile yet. Create one with New.');
    return;
  }
  await compileScripts(names, { fresh: true });
}
