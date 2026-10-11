import { useEffect, useMemo, useState } from 'react';
import { clearDraft, Field, Icon, Modal, Select, TextInput, useDraft, useQuery } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { compileAll } from '../../state/compile';
import { CompilerSettings, useBuildStatus } from './CompilerSettings';

const BASES = ['ObjectReference', 'Actor', 'Quest', 'ReferenceAlias', 'ActiveMagicEffect', 'Form', 'TopicInfo'];

export default function ScriptList() {
  const client = useStore((s) => s.client);
  const script = useStore((s) => s.script);
  const setScript = useStore((s) => s.setScript);
  const [q, setQ] = useState('');
  const [showBase, setShowBase] = useState(false);
  const [creating, setCreating] = useState(false);
  const [compilerOpen, setCompilerOpen] = useState(false);
  const compile = useStore((s) => s.compile);
  const build = useBuildStatus();
  const failed = compile.report.filter((r) => !r.ok).length;
  const newRequest = useStore((s) => s.newRequest);
  useEffect(() => {
    if (newRequest && useStore.getState().takeNew('script')) setCreating(true);
  }, [newRequest]);
  const { data } = useQuery(() => client?.call('scriptList'), [client]);
  const { mine, base } = useMemo(() => {
    const ql = q.toLowerCase();
    const list = (data ?? []).filter((s) => !ql || s.name.toLowerCase().includes(ql)).sort((a, b) => a.name.localeCompare(b.name));
    return { mine: list.filter((s) => s.origin === 'mod'), base: list.filter((s) => s.origin !== 'mod') };
  }, [data, q]);
  const item = (s: { name: string; path: string }) => (
    <li key={s.name} className={`list-item ${script?.toLowerCase() === s.name.toLowerCase() ? 'selected' : ''}`} onClick={() => setScript(s.name)} title={s.path}>
      <Icon name="script" size={12} />
      <span className="name">{s.name}</span>
    </li>
  );
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="grow">Scripts</span>
        <button className="btn small primary" onClick={() => setCreating(true)} data-testid="new-script">
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <div className="searchbox">
        <input className="input" placeholder="Find script…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <BuildCard build={build} compile={compile} hasScripts={(data ?? []).some((x) => x.origin === 'mod')} onSetup={() => setCompilerOpen(true)} />
      <div className="scroll" style={{ flex: 1 }}>
        <div className="panel-header">Your scripts ({mine.length})</div>
        <ul className="list" data-testid="script-list">
          {mine.map(item)}
          {!mine.length && <li className="empty small">None yet</li>}
        </ul>
        <button className="panel-header" style={{ width: '100%', border: 'none', cursor: 'pointer', textAlign: 'left' }} onClick={() => setShowBase(!showBase)}>
          <Icon name={showBase ? 'chevronDown' : 'chevron'} size={12} /> Game & other mods ({base.length})
        </button>
        {(showBase || q) && <ul className="list">{base.slice(0, 2000).map(item)}</ul>}
      </div>
      {failed > 0 && !compile.running && (
        <div className="small err" style={{ padding: '4px 8px' }} data-testid="compile-failed">
          {failed} script{failed === 1 ? '' : 's'} failed to compile. Open one to see why.
        </div>
      )}
      {compilerOpen && (
        <Modal title="Compiling scripts" onClose={() => setCompilerOpen(false)} width={560} footer={<button className="btn primary" onClick={() => setCompilerOpen(false)}>Done</button>}>
          {!build.ready && <p className="small" style={{ marginTop: 0 }}>Compiling turns your scripts into the .pex files the game runs. Here's what's still needed:</p>}
          <CompilerSettings />
        </Modal>
      )}
      {creating && <NewScriptDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Whether your scripts are compiled, with Compile buttons, or what's left to set up. */
function BuildCard({ build, compile, hasScripts, onSetup }: { build: ReturnType<typeof useBuildStatus>; compile: { running: boolean; done: number; total: number }; hasScripts: boolean; onSetup: () => void }) {
  const st = build.data;
  if (!st) return null;
  const n = st.outOfDate.length;
  const with_ = st.compiler?.kind === 'papyrus-compiler' ? 'PapyrusCompiler.exe' : 'Caprica';
  if (!build.ready)
    return (
      <div className="small build-card" data-testid="build-card">
        <span className="grow" style={{ color: 'var(--warn, #e0a040)' }} data-testid="build-not-ready">
          <Icon name="warn" size={12} /> {st.desktop ? "Compiling isn't set up yet" : 'No compiling in the demo'}
        </span>
        <button className="btn small" onClick={onSetup} title="See what compiling needs and set it up" data-testid="build-setup">
          Set up
        </button>
      </div>
    );
  return (
    <div className="small build-card" data-testid="build-card">
      <span className="build-status" data-testid={compile.running ? 'build-running' : n ? 'build-pending' : 'build-done'}>
        {compile.running ? (
          `Compiling… ${compile.done}/${compile.total}`
        ) : n ? (
          `${n} script${n === 1 ? ' needs' : 's need'} compiling`
        ) : (
          <span className="dim">
            <Icon name="check" size={12} /> {hasScripts ? 'All compiled' : 'Ready to compile'}
          </span>
        )}
      </span>
      {n > 0 && (
        <button className="btn small primary" disabled={compile.running} onClick={() => void compileAll({ changedOnly: true })} title={`Compile ${st.outOfDate.join(', ')} (new or changed since their last compile) in the background, with ${with_}`} data-testid="compile-changed">
          <Icon name="play" size={12} /> Compile {n}
        </button>
      )}
      <button className="btn small ghost grow" disabled={compile.running || !hasScripts} onClick={() => void compileAll()} title={`Compile every script in your mod again, in the background, with ${with_}`} data-testid="compile-all">
        Compile all
      </button>
      <button className="btn icon ghost" onClick={onSetup} title="Compiling settings: compiler, game script sources, compile on save" data-testid="build-settings">
        <Icon name="sliders" size={12} />
      </button>
    </div>
  );
}

function NewScriptDialog({ onClose }: { onClose: () => void }) {
  const client = useStore((s) => s.client);
  const { data: existing } = useQuery(() => client?.call('scriptList'), [client]);
  const taken = (n: string) => !!existing?.some((s) => s.name.toLowerCase() === n.toLowerCase());
  const [name, setName] = useDraft('newScript:name', 'MyScript');
  useEffect(() => {
    if (!existing || !taken(name)) return;
    for (let i = 2; ; i++) if (!taken(`MyScript${i}`)) return setName(`MyScript${i}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing]);
  const [ext, setExt] = useDraft('newScript:ext', 'ObjectReference');
  return (
    <Modal
      title="New script"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!/^[A-Za-z_]\w*$/.test(name) || taken(name)}
            onClick={async () => {
              const src = `ScriptName ${name} extends ${ext}\n{Describe what this script does.}\n\n${template(ext)}`;
              const ok = await engine((c) => c.call('scriptWrite', name, src), { success: `Created ${name}.psc` });
              if (ok) {
                clearDraft('newScript:');
                useStore.getState().setScript(name);
                useStore.getState().bump();
                onClose();
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Name">
        <TextInput value={name} onCommit={setName} mono autoFocus />
      </Field>
      {taken(name) && <div className="small warn">A script named {name} already exists (in your mod, the game or another mod). Pick another name.</div>}
      <Field label="Attaches to">
        <Select value={ext} options={BASES.map((b) => ({ value: b, label: b }))} onChange={setExt} />
      </Field>
    </Modal>
  );
}

function template(ext: string): string {
  switch (ext) {
    case 'ObjectReference':
      return 'Event OnActivate(ObjectReference akActionRef)\n\tif akActionRef == Game.GetPlayer()\n\t\tDebug.Notification("Activated")\n\tendif\nEndEvent\n';
    case 'Actor':
      return 'Event OnDeath(Actor akKiller)\n\nEndEvent\n';
    case 'Quest':
      return 'Event OnInit()\n\nEndEvent\n';
    case 'ReferenceAlias':
      return 'Event OnActivate(ObjectReference akActionRef)\n\nEndEvent\n';
    case 'ActiveMagicEffect':
      return 'Event OnEffectStart(Actor akTarget, Actor akCaster)\n\nEndEvent\n';
    default:
      return '';
  }
}
