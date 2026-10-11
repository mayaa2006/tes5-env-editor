import { useEffect, useMemo, useState } from 'react';
import { clearDraft, Field, Icon, Modal, Select, TextInput, useDraft, useQuery } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { compileAll, hasCompiler } from '../../state/compile';
import { CompilerSettings } from './CompilerSettings';

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
  const compilerPath = useStore((s) => s.settings.compilerPath);
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
        <button
          className="btn small"
          disabled={compile.running}
          onClick={() => (hasCompiler() ? void compileAll() : setCompilerOpen(true))}
          title={compilerPath ? 'Compile every script in your mod to .pex files, in the background' : 'Choose a compiler first (opens the compiler settings)'}
          data-testid="compile-all"
        >
          <Icon name="play" size={12} /> {compile.running ? `${compile.done}/${compile.total}` : 'Compile all'}
        </button>
        <button className="btn small primary" onClick={() => setCreating(true)} data-testid="new-script">
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <div className="searchbox">
        <input className="input" placeholder="Find script…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
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
        <Modal title="Papyrus compiler" onClose={() => setCompilerOpen(false)} width={520} footer={<button className="btn primary" onClick={() => setCompilerOpen(false)}>Done</button>}>
          {!compilerPath && <p className="warn small" style={{ marginTop: 0 }}>Choose a compiler to turn scripts into the .pex files the game runs.</p>}
          <CompilerSettings />
        </Modal>
      )}
      {creating && <NewScriptDialog onClose={() => setCreating(false)} />}
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
