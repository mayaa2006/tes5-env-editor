/**
 * Papyrus editor: Monaco with completion/hover/signature help and live error
 * checking from the built-in language service, plus one-click compile with
 * clickable compiler errors. Files are written atomically, so a crash never
 * leaves a half-saved script.
 */
import { useEffect, useState } from 'react';
import { Help, Icon, Modal, useQuery } from '../../components/ui';
import { CompilerSettings } from './CompilerSettings';
import { engine, useStore } from '../../state/store';
import { CodeEditor } from './CodeEditor';

interface CompileOutput {
  script: string;
  ok: boolean;
  messages: { file?: string; line?: number; col?: number; severity: string; message: string }[];
  output: string;
}

export default function ScriptEditor() {
  const client = useStore((s) => s.client);
  const name = useStore((s) => s.script);
  const settings = useStore((s) => s.settings);
  const { data: list } = useQuery(() => client?.call('scriptList'), [client]);
  const info = list?.find((s) => s.name.toLowerCase() === name?.toLowerCase());
  const { data: compiled } = useQuery(() => (name ? client?.call('scriptCompiled', name) : undefined), [name]);
  const { data: source } = useQuery(() => (name && info ? client?.call('scriptRead', name) : undefined), [name, !!info], { revision: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [diag, setDiag] = useState({ errors: 0, warnings: 0 });
  const [compile, setCompile] = useState<CompileOutput[] | null>(null);
  const [reveal, setReveal] = useState<number | undefined>();
  const [outline, setOutline] = useState(true);
  const [compilerOpen, setCompilerOpen] = useState(false);
  const { data: symbols } = useQuery(() => (draft ?? source ? client?.call('scriptOutline', draft ?? source ?? '') : undefined), [draft ?? source], { revision: false });

  useEffect(() => {
    setDraft(null);
    setCompile(null);
  }, [name]);

  if (!name) return <div className="empty" style={{ flex: 1 }}>Pick a script on the left, or create a new one.</div>;
  if (list && !info) return <div className="empty" style={{ flex: 1 }}>Script “{name}” wasn't found in the load order.</div>;
  if (source === undefined) return <div className="empty" style={{ flex: 1 }}>Loading…</div>;

  const dirty = draft !== null && draft !== source;
  const save = async (text = draft ?? source) => {
    const ok = await engine((c) => c.call('scriptWrite', name, text), { refreshSession: false });
    if (ok) {
      useStore.getState().toast('success', `Saved ${name}.psc`);
      setDraft(null);
      useStore.getState().bump();
    }
    return !!ok;
  };
  const runCompile = async () => {
    if (!useStore.getState().settings.compilerPath) {
      // Nothing to compile with yet: ask for it right here.
      setCompilerOpen(true);
      return;
    }
    if (dirty && !(await save())) return;
    const res = await engine((c) => c.call('scriptCompile', [name]), { busy: `Compiling ${name}…`, refreshSession: false });
    if (res) {
      setCompile(res);
      useStore.getState().toast(res.every((r) => r.ok) ? 'success' : 'error', res.every((r) => r.ok) ? `Compiled ${name}.pex` : `${name} has compile errors`);
    }
  };

  return (
    <div className="col" style={{ flex: 1, minHeight: 0 }}>
      {compilerOpen && (
        <Modal title="Papyrus compiler" onClose={() => setCompilerOpen(false)} width={520} footer={<button className="btn primary" onClick={() => setCompilerOpen(false)}>Done</button>}>
          {!settings.compilerPath && <p className="warn small" style={{ marginTop: 0 }}>Choose a compiler to turn scripts into the .pex files the game runs.</p>}
          <CompilerSettings />
        </Modal>
      )}
      <div className="viewport-toolbar">
        <strong>{name}</strong>
        <span className="dim small">{info?.path}</span>
        {info?.origin !== 'mod' && <span className="chip warn" title="Saving writes a copy into your output folder">from the game / another mod</span>}
        <span className={`chip ${diag.errors ? 'err' : diag.warnings ? 'warn' : 'ok'}`}>{diag.errors ? `${diag.errors} error(s)` : diag.warnings ? `${diag.warnings} warning(s)` : 'No problems'}</span>
        {compiled === false && (
          <span className="chip warn" title="There's no compiled .pex for this script, so the game won't run it yet. Compile it (needs a compiler, see Compiler)." data-testid="not-compiled">
            not compiled
          </span>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={() => void save()} disabled={!dirty} title="Save (Ctrl+S)">
          <Icon name="save" size={12} /> Save
        </button>
        <button className="btn small primary" onClick={() => void runCompile()} title={settings.compilerPath ? 'Compile to .pex (what the game runs)' : 'Choose a compiler first (opens the compiler settings)'} data-testid="compile">
          <Icon name="play" size={12} /> Compile
        </button>
        <Help text="Errors are shown as you type without a compiler. The game, though, runs compiled .pex files, which need the Creation Kit's PapyrusCompiler.exe or Caprica." />
        <button className="btn small ghost" onClick={() => setCompilerOpen(true)} title="Choose the Papyrus compiler" data-testid="compiler-settings">
          <Icon name="sliders" size={12} /> Compiler
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
      {compile && (
        <div className="scroll mono small" style={{ maxHeight: 180, borderTop: '1px solid var(--border)', background: 'var(--panel)', padding: 8 }}>
          <div className="row">
            <strong className="grow">Compiler output</strong>
            <button className="btn icon ghost" onClick={() => setCompile(null)}>
              <Icon name="close" size={12} />
            </button>
          </div>
          {compile.map((r) => (
            <div key={r.script}>
              <div className={r.ok ? 'ok' : 'err'}>
                {r.script}: {r.ok ? 'compiled' : 'failed'}
              </div>
              {r.messages.map((m, i) => (
                <div key={i} className={m.severity === 'error' ? 'err' : 'warn'} style={{ cursor: m.line ? 'pointer' : undefined }} onClick={() => m.line && setReveal(m.line)}>
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
