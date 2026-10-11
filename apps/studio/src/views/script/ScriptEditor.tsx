/**
 * Papyrus editor: Monaco with completion/hover/signature help and live error
 * checking from the built-in language service, plus one-click compile with
 * clickable compiler errors. Files are written atomically, so a crash never
 * leaves a half-saved script.
 */
import { useEffect, useState } from 'react';
import { EmptyState, Help, Icon, Modal, useQuery } from '../../components/ui';
import { CompilerSettings, useBuildStatus } from './CompilerSettings';
import { engine, useStore } from '../../state/store';
import { compileScripts } from '../../state/compile';
import { CodeEditor } from './CodeEditor';

export default function ScriptEditor() {
  const client = useStore((s) => s.client);
  const name = useStore((s) => s.script);
  const { data: list } = useQuery(() => client?.call('scriptList'), [client]);
  const info = list?.find((s) => s.name.toLowerCase() === name?.toLowerCase());
  const { data: compiled } = useQuery(() => (name ? client?.call('scriptCompiled', name) : undefined), [name]);
  const { data: source } = useQuery(() => (name && info ? client?.call('scriptRead', name) : undefined), [name, !!info], { revision: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [diag, setDiag] = useState({ errors: 0, warnings: 0 });
  const compile = useStore((s) => s.compile);
  const setCompile = (report: null) => useStore.setState((s) => ({ compile: { ...s.compile, report: report ?? [] } }));
  const [reveal, setReveal] = useState<number | undefined>();
  const [outline, setOutline] = useState(true);
  const [compilerOpen, setCompilerOpen] = useState(false);
  const build = useBuildStatus();
  const { data: symbols } = useQuery(() => (draft ?? source ? client?.call('scriptOutline', draft ?? source ?? '') : undefined), [draft ?? source], { revision: false });

  useEffect(() => {
    setDraft(null);
  }, [name]);

  if (!name)
    return (
      <EmptyState
        icon="script"
        title="Pick a script to edit"
        testId="script-empty"
        actions={
          <button className="btn primary" onClick={() => useStore.getState().requestNew('script')} title="Start a new Papyrus script with the events it needs already filled in">
            <Icon name="plus" /> New script
          </button>
        }
      >
        Your scripts are listed on the left. Scripts from the game and other mods are under "Game & other mods" if you want to read them. Most things (triggers, quest steps, dialogue results) don't need a script written by hand.
      </EmptyState>
    );
  if (list && !info) return <div className="empty" style={{ flex: 1 }}>Script “{name}” wasn't found in the load order.</div>;
  if (source === undefined) return <div className="empty" style={{ flex: 1 }}>Loading…</div>;

  const dirty = draft !== null && draft !== source;
  const save = async (text = draft ?? source, autoCompile = true) => {
    const ok = await engine((c) => c.call('scriptWrite', name, text), { refreshSession: false });
    if (ok) {
      useStore.getState().toast('success', `Saved ${name}.psc`);
      setDraft(null);
      useStore.getState().bump();
      // Like the Creation Kit: compile in the background on save, so you keep typing.
      if (autoCompile && useStore.getState().settings.autoCompileOnSave && build.ready) void compileScripts([name], { quiet: true });
    }
    return !!ok;
  };
  const runCompile = async () => {
    if (!build.ready) {
      // Not set up yet: show what's missing right here instead of failing.
      setCompilerOpen(true);
      return;
    }
    if (dirty && !(await save(undefined, false))) return;
    await compileScripts([name]);
  };

  return (
    <div className="col" style={{ flex: 1, minHeight: 0 }}>
      {compilerOpen && (
        <Modal title="Compiling scripts" onClose={() => setCompilerOpen(false)} width={560} footer={<button className="btn primary" onClick={() => setCompilerOpen(false)}>Done</button>}>
          {!build.ready && <p className="small" style={{ marginTop: 0 }}>Compiling turns your scripts into the .pex files the game runs. Here's what's still needed:</p>}
          <CompilerSettings />
        </Modal>
      )}
      <div className="viewport-toolbar">
        <strong>{name}</strong>
        <span className="dim small">{info?.path}</span>
        {info?.origin !== 'mod' && <span className="chip warn" title="Saving writes a copy into your output folder">from the game / another mod</span>}
        <span className={`chip ${diag.errors ? 'err' : diag.warnings ? 'warn' : 'ok'}`}>{diag.errors ? `${diag.errors} error(s)` : diag.warnings ? `${diag.warnings} warning(s)` : 'No problems'}</span>
        {compiled === false && (
          <span className="chip warn" title="There's no compiled .pex for this script, so the game won't run it yet. Press Compile." data-testid="not-compiled">
            not compiled
          </span>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={() => void save()} disabled={!dirty} title="Save (Ctrl+S)">
          <Icon name="save" size={12} /> Save
        </button>
        {compile.running && (
          <span className="chip" data-testid="compiling" title="Compiling in the background. You can keep working.">
            Compiling… {compile.done}/{compile.total}
          </span>
        )}
        <button
          className="btn small primary"
          onClick={() => void runCompile()}
          title={build.ready ? 'Save and compile to .pex (what the game runs) in the background, with Caprica unless you chose another compiler' : "Compiling isn't set up yet: shows what's missing"}
          data-testid="compile"
        >
          <Icon name="play" size={12} /> Compile
        </button>
        <Help text="Errors are shown as you type. The game, though, runs compiled .pex files. Caprica, a free compiler that comes with the app, makes them; with “Compile scripts that changed when saving” on, saving compiles too." />
        <button className="btn small ghost" onClick={() => setCompilerOpen(true)} title="Which compiler is used, the game's script sources it needs, and compiling on save" data-testid="compiler-settings">
          <Icon name="sliders" size={12} /> Compiling
        </button>
        <button className={`btn small ${outline ? 'active' : 'ghost'}`} onClick={() => setOutline(!outline)} title="Outline">
          <Icon name="records" size={12} />
        </button>
      </div>
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <CodeEditor key={name} value={source} onChange={setDraft} onSave={(v) => void save(v)} onDiagnostics={setDiag} revealLine={reveal} />
        </div>
        {outline && (
          <div className="panel" style={{ width: 220, flex: 'none', borderLeft: '1px solid var(--border)', background: 'var(--panel)' }}>
            <div className="panel-header">Outline</div>
            <ul className="list scroll" style={{ flex: 1 }}>
              {(symbols ?? []).flatMap((s) => [s, ...(s.children ?? [])]).filter((s) => s.kind !== 'script').map((s, i) => (
                <li key={i} className="list-item" onClick={() => setReveal(s.range.start.line + 1)} title={s.detail}>
                  <span className="sig" style={{ width: 'auto', minWidth: 40 }}>{s.kind === 'property' ? 'prop' : s.kind === 'function' ? 'func' : s.kind}</span>
                  <span className="name">{s.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {compile.report.length > 0 && (
        <div className="scroll mono small" style={{ maxHeight: 180, borderTop: '1px solid var(--border)', background: 'var(--panel)', padding: 8 }}>
          <div className="row">
            <strong className="grow">Compiler output</strong>
            <button className="btn icon ghost" onClick={() => setCompile(null)}>
              <Icon name="close" size={12} />
            </button>
          </div>
          {compile.report.map((r) => (
            <div key={r.script}>
              <div className={r.ok ? 'ok' : 'err'}>
                {r.script}: {r.ok ? 'compiled' : 'failed'}
              </div>
              {r.messages.map((m, i) => (
                <div key={i} className={m.severity === 'error' ? 'err' : 'warn'} style={{ cursor: m.line ? 'pointer' : undefined }} onClick={() => {
                    if (!m.line) return;
                    if (r.script.toLowerCase() !== name.toLowerCase()) useStore.getState().setScript(r.script);
                    setReveal(m.line);
                  }}>
                  {m.line ? `(${m.line},${m.col ?? 0}) ` : ''}
                  {m.message}
                </div>
              ))}
              {!r.messages.length && !r.ok && <pre style={{ whiteSpace: 'pre-wrap' }}>{r.output}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
