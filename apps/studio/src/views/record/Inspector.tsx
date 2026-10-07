/**
 * Right-hand properties panel: whatever is selected anywhere in the app is
 * edited here. Edits apply immediately (each one an undo step) to the active
 * plugin; overrides and masters are created automatically.
 */
import { useEffect, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import type { RecordSummary, RecordView, Transform } from '@tes5/workspace';
import { DragNumber, Field, Icon, Section, useQuery } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { RecordForm } from './RecordForm';
import { TriggersSection } from './TriggersEditor';

const DEG = 180 / Math.PI;
const REF_SIGS = new Set(['REFR', 'ACHR', 'PGRE', 'PMIS', 'PHZD', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA']);

export function Inspector() {
  const selected = useStore((s) => s.selected);
  const client = useStore((s) => s.client);
  const session = useStore((s) => s.session);
  const { data: view } = useQuery(() => (selected ? client?.call('view', selected) : undefined), [selected]);
  const { data: schema } = useQuery(() => (view ? client?.call('uiSchema', view.sig) : undefined), [view?.sig], { revision: false });
  const [draft, setDraft] = useState<Record<string, unknown> | undefined>(view?.data);
  useEffect(() => setDraft(view?.data), [view]);

  if (!selected) return <div className="empty">Select something to see its properties.</div>;
  if (!view) return <div className="empty">Loading…</div>;

  const commit = async (data: Record<string, unknown>) => {
    setDraft(data);
    await engine((c) => c.call('updateRecord', view.formKey, data, { unknown: view.unknown, label: `Edit ${view.editorId ?? view.typeName}` }));
  };
  const isRef = REF_SIGS.has(view.sig);

  return (
    <div className="panel" data-testid="inspector">
      <div className="panel-header">
        <span className="grow ellipsis" title={view.editorId}>
          {view.editorId ?? view.typeName}
        </span>
        <span className="chip">{view.sig}</span>
      </div>
      <div className="scroll" style={{ flex: 1 }}>
        <Header view={view} />
        {!session.activePlugin && (
          <div className="pad small warn" style={{ paddingTop: 0 }}>
            Your first edit will ask you to create a plugin to hold your changes.
          </div>
        )}
        <RecordActions view={view} onSelect={(k) => useStore.getState().select(k)} />
        {view.errors.length > 0 && (
          <div className="pad small warn" style={{ paddingTop: 0 }}>
            {view.errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        )}
        {isRef && <TransformEditor view={view} />}
        {(view.sig === 'REFR' || view.sig === 'ACHR') && (
          <div className="pad" style={{ paddingTop: 0 }}>
            <Section title="Triggers">
              <TriggersSection host={{ kind: 'ref', ref: view.formKey }} actor={view.sig === 'ACHR'} />
            </Section>
          </div>
        )}
        {!view.hasSchema ? (
          <RawView view={view} note="This record type has no form editor yet. Its data is preserved exactly as is." />
        ) : !view.lossless ? (
          <RawView view={view} note="This record uses a layout the editor can't round-trip exactly, so it's read-only here to avoid damaging it." />
        ) : schema && draft ? (
          <RecordForm schema={isRef ? { ...schema, members: schema.members.filter((m) => m.key !== 'placement' && m.key !== 'scale') } : schema} data={draft} onChange={commit} />
        ) : null}
        {view.unknown.length > 0 && view.lossless && (
          <div className="pad faint small">Also keeps {view.unknown.length} unrecognized field(s) unchanged: {view.unknown.map((u) => u.sig).join(', ')}</div>
        )}
      </div>
    </div>
  );
}

async function duplicate(view: RecordView, onSelect: (k: FormKey) => void) {
  const key = await engine((c) => c.call('duplicateRecord', view.formKey), { success: `Duplicated ${view.editorId ?? view.formKey}` });
  if (key) onSelect(key);
}

/** Duplicate, delete/revert, "Used by…" and links to the dedicated editors, for any record. */
export function RecordActions({ view, onSelect }: { view: RecordView; onSelect: (k: FormKey | undefined) => void }) {
  const session = useStore((s) => s.session);
  const [refs, setRefs] = useState<RecordSummary[] | null>(null);
  useEffect(() => setRefs(null), [view.formKey]);
  const isRef = REF_SIGS.has(view.sig);
  const newHere = view.owner === session.activePlugin;
  const category = categoryLink(view);
  return (
    <>
      <div className="row wrap pad" style={{ paddingTop: 0, gap: 4 }}>
        <button className="btn small" title="Make a copy as a new form" onClick={() => duplicate(view, onSelect)}>
          <Icon name="copy" size={12} /> Duplicate
        </button>
        <button
          className="btn small"
          title={newHere ? 'Remove this new form' : isRef ? 'Disable this reference (safe delete)' : 'Remove your override of this form'}
          onClick={async () => {
            const r = await engine((c) => c.call('deleteRecord', view.formKey));
            if (r) useStore.getState().toast('success', r === 'disabled' ? 'Reference disabled (deleting master references crashes the game)' : r === 'reverted' ? 'Override removed' : 'Deleted');
            if (r === 'removed') onSelect(undefined);
          }}
        >
          <Icon name="trash" size={12} /> {newHere ? 'Delete' : isRef ? 'Disable' : 'Revert'}
        </button>
        {view.inActive && !newHere && isRef && (
          <button className="btn small ghost" title="Drop your changes to this reference" onClick={() => engine((c) => c.call('revertRecord', view.formKey), { success: 'Reverted' })}>
            Revert
          </button>
        )}
        <button className="btn small ghost" onClick={async () => setRefs((await engine((c) => c.call('findReferences', view.formKey), { refreshSession: false })) ?? [])}>
          <Icon name="link" size={12} /> Used by…
        </button>
        {view.sig === 'NPC_' && (
          <button className="btn small ghost" onClick={() => (useStore.getState().setNpc(view.formKey), useStore.getState().setTab('npc'))}>
            <Icon name="npc" size={12} /> Character creator
          </button>
        )}
        {view.sig === 'QUST' && (
          <button className="btn small ghost" onClick={() => (useStore.getState().setQuest(view.formKey), useStore.getState().setTab('quest'))}>
            <Icon name="quest" size={12} /> Quest designer
          </button>
        )}
      </div>
      {refs && <References refs={refs} onClose={() => setRefs(null)} onSelect={onSelect} />}
    </>
  );
}

/** Items/Magic workspace that has a dedicated editor for this record, if any. */
function categoryLink(view: RecordView): { tab: 'items' | 'magic'; label: string } | null {
  const items = ['WEAP', 'ARMO', 'ALCH', 'INGR', 'BOOK', 'SCRL', 'AMMO', 'KEYM', 'SLGM', 'MISC', 'APPA', 'LVLI', 'COBJ', 'OTFT'];
  const magic = ['SPEL', 'MGEF', 'ENCH', 'SHOU', 'WOOP', 'PERK', 'LVSP'];
  if (items.includes(view.sig)) return { tab: 'items', label: 'Open in Items' };
  if (magic.includes(view.sig)) return { tab: 'magic', label: 'Open in Magic' };
  return null;
}

async function openInCatalog(key: FormKey) {
  const where = await engine((c) => c.call('categoryOf', key), { refreshSession: false });
  if (!where) return;
  const s = useStore.getState();
  s.openCatalog(where.tab, { category: where.id, record: key });
  s.setTab(where.tab);
}


export function Header({ view }: { view: RecordView }) {
  const client = useStore((s) => s.client);
  const { data: runtime } = useQuery(() => client?.call('runtimeFormId', view.formKey), [view.formKey]);
  return (
    <div className="pad small" style={{ paddingBottom: 6 }}>
      <div className="row wrap" style={{ gap: 4 }}>
        <span className="dim">{view.typeName}</span>
        {view.name && <span>“{view.name}”</span>}
      </div>
      <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
        <span className="mono faint" title="Plugin-independent ID">
          {view.formKey}
        </span>
        {runtime && (
          <span className="mono faint" title="FormID in game with the current load order (use with console commands)">
            · {runtime}
          </span>
        )}
      </div>
      <div className="chips" style={{ marginTop: 6 }}>
        <span className="chip" title="Plugin that defines this form">
          from {view.owner}
        </span>
        {view.overrides.length > 1 && (
          <span className="chip warn" title={`Changed by: ${view.overrides.join(' → ')}. The game uses the version from the plugin that loads last.`}>
            {view.overrides.length - 1} override{view.overrides.length > 2 ? 's' : ''} · winner {view.winner}
          </span>
        )}
        {view.inActive && <ReplacedWarning winner={view.winner} />}
        {view.inActive && <span className="chip accent">in your plugin</span>}
        {view.deleted && <span className="chip err">deleted</span>}
        {(view.flags & 0x800) !== 0 && <span className="chip">initially disabled</span>}
        {(view.flags & 0x400) !== 0 && <span className="chip">persistent</span>}
      </div>
    </div>
  );
}

function TransformEditor({ view }: { view: RecordView }) {
  const d = view.data as { placement?: { position: Transform['position']; rotation: Transform['rotation'] }; scale?: number };
  const p = d.placement ?? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
  const set = (t: Partial<Transform>) => engine((c) => c.call('transformReferences', [{ ref: view.formKey, transform: t }], 'Transform'));
  const axes = ['x', 'y', 'z'] as const;
  return (
    <div className="pad" style={{ paddingTop: 0 }}>
      <Section title="Transform">
        <Field label="Location">
          <div className="row" style={{ gap: 3 }}>
            {axes.map((a) => (
              <DragNumber key={a} value={p.position[a]} step={1} precision={1} onCommit={(v) => set({ position: { ...p.position, [a]: v } })} />
            ))}
          </div>
        </Field>
        <Field label="Rotation °">
          <div className="row" style={{ gap: 3 }}>
            {axes.map((a) => (
              <DragNumber key={a} value={p.rotation[a] * DEG} step={1} precision={1} onCommit={(v) => set({ rotation: { ...p.rotation, [a]: v / DEG } })} />
            ))}
          </div>
        </Field>
        <Field label="Scale">
          <DragNumber value={d.scale ?? 1} step={0.01} precision={3} min={0.01} max={10} onCommit={(scale) => set({ scale })} />
        </Field>
      </Section>
    </div>
  );
}

function RawView({ view, note }: { view: RecordView; note: string }) {
  return (
    <div className="pad">
      <div className="small dim" style={{ marginBottom: 6 }}>
        {note}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Field</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {view.subrecords.map((s, i) => (
            <tr key={i}>
              <td className="mono">{s.sig}</td>
              <td className="mono dim">{s.size} B</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function References({ refs, onClose, onSelect }: { refs: RecordSummary[]; onClose: () => void; onSelect: (k: FormKey) => void }) {
  const select = onSelect;
  return (
    <div className="pad" style={{ paddingTop: 0 }}>
      <div className="card" style={{ padding: 0 }}>
        <div className="panel-header">
          <span className="grow">Used by {refs.length >= 200 ? '200+' : refs.length} form(s)</span>
          <button className="btn icon ghost" onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>
        <ul className="list" style={{ maxHeight: 220, overflow: 'auto' }}>
          {refs.map((r) => (
            <li key={`${r.formKey}@${r.winner}`} className="list-item" onClick={() => select(r.formKey as FormKey)} title={`${r.formKey} in ${r.winner}`}>
              <span className="sig">{r.sig}</span>
              <span className="name">{r.editorId ?? r.formKey}</span>
              <span className="meta">{r.winner}</span>
            </li>
          ))}
          {!refs.length && <li className="empty">Nothing references this form.</li>}
        </ul>
      </div>
    </div>
  );
}

/** Your change exists, but a plugin loading after yours replaces it. */
function ReplacedWarning({ winner }: { winner: string }) {
  const active = useStore((s) => s.session.activePlugin);
  if (!active || winner === active) return null;
  return (
    <div className="small warn" style={{ marginTop: 6, width: '100%' }} data-testid="replaced-warning">
      <Icon name="warn" size={12} /> {winner} loads after your plugin and changes this too, so your change won't show in game with it installed. See Release → Conflicts.
    </div>
  );
}
