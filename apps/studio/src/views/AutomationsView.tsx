/**
 * The chores the Creation Kit leaves to you, in one place: what runs on every
 * save, ESL conversion, FaceGen checks, bounds, and tool settings.
 */
import { useState } from 'react';
import { Checkbox, DragNumber, Field, Icon, Section, Select, TextInput, useQuery } from '../components/ui';
import { engine, useStore } from '../state/store';

export default function AutomationsView() {
  const session = useStore((s) => s.session);
  return (
    <div className="scroll pad" style={{ flex: 1 }}>
      <h2 style={{ marginTop: 0 }}>Automations</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
        <OnSave />
        {session.activePlugin ? <Esl /> : <div className="card dim">Create or pick a plugin to edit to see ESL and FaceGen checks.</div>}
        {session.activePlugin && <FaceGen />}
        <Bounds />
        <Compiler />
        <Viewport />
      </div>
    </div>
  );
}

function OnSave() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return (
    <div className="card">
      <div className="card-title">Every time you save</div>
      <div className="col" style={{ gap: 6 }}>
        <Checkbox checked={settings.autoCleanOnSave} onChange={(autoCleanOnSave) => update({ autoCleanOnSave })} label="Remove records identical to their master (no dirty edits)" />
        <Checkbox checked={settings.updateBoundsOnSave} onChange={(updateBoundsOnSave) => update({ updateBoundsOnSave })} label="Recalculate object bounds of changed objects from their meshes" />
        <Checkbox checked={settings.generateSeqOnSave} onChange={(generateSeqOnSave) => update({ generateSeqOnSave })} label="Write the SEQ file for start-game-enabled quests with dialogue" />
        <div className="dim small">Always automatic: masters added and sorted, record counts, topic info counts, dialogue ordering, quest alias IDs, fragment script properties, a backup of the previous file, strings files for localized plugins, ESL range checks.</div>
      </div>
    </div>
  );
}

function Esl() {
  const client = useStore((s) => s.client);
  const { data: r } = useQuery(() => client?.call('eslReport'), [client]);
  const [mapping, setMapping] = useState<[string, string][] | null>(null);
  if (!r) return <div className="card">Checking ESL eligibility…</div>;
  return (
    <div className="card" data-testid="esl-card">
      <div className="card-title">
        Light plugin (ESL)
        {r.eligible ? <span className="chip ok">can be flagged ESL</span> : r.eligibleAfterCompaction ? <span className="chip warn">needs compaction</span> : <span className="chip err">too many records</span>}
      </div>
      <div className="dim small">
        {r.newRecords} new record(s) · highest ID {r.maxObjectId.toString(16).toUpperCase()} · {r.outOfRange} outside the ESL range
      </div>
      {r.notes.map((n) => (
        <div key={n} className="small warn">
          {n}
        </div>
      ))}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button
          className="btn small"
          disabled={!r.eligibleAfterCompaction || r.eligible}
          title="Renumber this plugin's new records into the ESL range. Only do this before anything else depends on your FormIDs."
          onClick={async () => {
            const m = await engine((c) => c.call('compactFormIds'), { success: 'FormIDs compacted' });
            if (m) setMapping(m);
          }}
        >
          Compact FormIDs
        </button>
      </div>
      {mapping && (
        <div className="small dim" style={{ marginTop: 6, maxHeight: 120, overflow: 'auto' }}>
          {mapping.length} record(s) renumbered{mapping.length ? `, e.g. ${mapping[0]![0]} → ${mapping[0]![1]}` : ''}. References inside this plugin were updated.
        </div>
      )}
    </div>
  );
}

function FaceGen() {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('faceGenProblems'), [client]);
  return (
    <div className="card">
      <div className="card-title">
        Character faces
        {data && (data.length ? <span className="chip warn">{data.length} need FaceGen</span> : <span className="chip ok">OK</span>)}
      </div>
      {data?.length ? (
        <>
          <div className="dim small" style={{ marginBottom: 6 }}>
            These characters' faces changed but have no FaceGen files, so they'd show the dark-face bug. FaceGen export isn't built in yet — export them from the Creation Kit (select, Ctrl+F4).
          </div>
          <ul className="list">
            {data.map((p) => (
              <li key={p.npc} className="list-item" onClick={() => (useStore.getState().setNpc(p.npc), useStore.getState().setTab('npc'))}>
                <span className="name">{p.editorId ?? p.npc}</span>
                <span className="meta">{p.missing.length} file(s)</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="dim small">No edited faces are missing their FaceGen files.</div>
      )}
    </div>
  );
}

function Bounds() {
  return (
    <div className="card">
      <div className="card-title">Object bounds</div>
      <div className="dim small" style={{ marginBottom: 8 }}>
        Recalculate OBND for every base object in your plugin from its mesh (the CK's “Recalc Bounds”).
      </div>
      <button
        className="btn small"
        onClick={async () => {
          const r = await engine((c) => c.call('updateBounds'), { busy: 'Measuring meshes…' });
          if (r) useStore.getState().toast('success', r.length ? `Updated bounds of ${r.length} object(s)` : 'All bounds already match their meshes');
        }}
      >
        <Icon name="cube" size={12} /> Recalculate bounds
      </button>
    </div>
  );
}

function Compiler() {
  const client = useStore((s) => s.client);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return (
    <div className="card">
      <div className="card-title">Papyrus compiler</div>
      <Field label="Compiler">
        <Select
          value={settings.compilerKind}
          options={[
            { value: 'papyrus-compiler', label: 'PapyrusCompiler.exe (Creation Kit)' },
            { value: 'caprica', label: 'Caprica' },
          ]}
          onChange={(compilerKind) => update({ compilerKind })}
        />
      </Field>
      <Field label="Path">
        <div className="row" style={{ gap: 4 }}>
          <div className="grow">
            <TextInput value={settings.compilerPath} onCommit={(compilerPath) => update({ compilerPath })} placeholder="…\Skyrim Special Edition\Papyrus Compiler\PapyrusCompiler.exe" mono />
          </div>
          {client?.canPickFolders && (
            <button
              className="btn small"
              onClick={async () => {
                const p = await client.openFile('Papyrus compiler', [{ name: 'Executable', extensions: ['exe'] }]);
                if (p) update({ compilerPath: p });
              }}
            >
              Browse…
            </button>
          )}
        </div>
      </Field>
      <div className="dim small">The language service (errors as you type, completion) works without a compiler. Compiling needs the CK's script sources (Scripts.zip) extracted into Data.</div>
    </div>
  );
}

function Viewport() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return (
    <div className="card">
      <div className="card-title">3D view</div>
      <Section>
        <Field label="Move snap">
          <DragNumber value={settings.snapMove} step={1} precision={0} min={1} max={4096} suffix="units" onCommit={(snapMove) => update({ snapMove })} />
        </Field>
        <Field label="Rotate snap">
          <DragNumber value={settings.snapRotateDeg} step={1} precision={0} min={1} max={180} suffix="°" onCommit={(snapRotateDeg) => update({ snapRotateDeg })} />
        </Field>
        <Field label="Scale snap">
          <DragNumber value={settings.snapScale} step={0.01} precision={2} min={0.01} max={1} onCommit={(snapScale) => update({ snapScale })} />
        </Field>
        <Checkbox checked={settings.kitSnap} onChange={(kitSnap) => update({ kitSnap })} label="Kit snapping: moved pieces snap flush to their neighbours (hold Alt to skip)" />
      </Section>
    </div>
  );
}
