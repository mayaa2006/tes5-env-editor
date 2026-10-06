/**
 * Visual triggers: "When … If … Do …" blocks on a placed object or quest
 * alias, compiled to a Papyrus script behind the scenes. Templates cover
 * common tasks; every block stays editable.
 */
import { useEffect, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import type { TriggerAction, TriggerCondition, TriggerEventKind, TriggerHost, TriggerSpec } from '@tes5/workspace';
import { Checkbox, DragNumber, FormPicker, Icon, Modal, Select, TextInput, useQuery, useSummaries } from '../../components/ui';
import { engine, useStore } from '../../state/store';

const ITEM_SIGS = ['MISC', 'WEAP', 'ARMO', 'BOOK', 'KEYM', 'ALCH', 'INGR', 'AMMO', 'SLGM', 'SCRL'];
const REF_SIGS = ['REFR', 'ACHR'];

const CONDITIONS: { kind: TriggerCondition['kind']; label: string; make: () => TriggerCondition }[] = [
  { kind: 'questStage', label: 'Quest is at stage', make: () => ({ kind: 'questStage', quest: '' as FormKey, op: '==', stage: 10 }) },
  { kind: 'questStageDone', label: 'Quest stage has (not) happened', make: () => ({ kind: 'questStageDone', quest: '' as FormKey, stage: 10, done: true }) },
  { kind: 'playerHasItem', label: 'Player has an item', make: () => ({ kind: 'playerHasItem', item: '' as FormKey, count: 1 }) },
  { kind: 'chance', label: 'Random chance', make: () => ({ kind: 'chance', percent: 50 }) },
];

const ACTIONS: { kind: TriggerAction['kind']; label: string; make: () => TriggerAction }[] = [
  { kind: 'setStage', label: 'Set quest stage', make: () => ({ kind: 'setStage', quest: '' as FormKey, stage: 10 }) },
  { kind: 'startQuest', label: 'Start a quest', make: () => ({ kind: 'startQuest', quest: '' as FormKey }) },
  { kind: 'showObjective', label: 'Show a quest objective', make: () => ({ kind: 'showObjective', quest: '' as FormKey, objective: 10 }) },
  { kind: 'completeObjective', label: 'Complete a quest objective', make: () => ({ kind: 'completeObjective', quest: '' as FormKey, objective: 10 }) },
  { kind: 'notification', label: 'Show a notification', make: () => ({ kind: 'notification', text: '' }) },
  { kind: 'messageBox', label: 'Show a message box', make: () => ({ kind: 'messageBox', text: '' }) },
  { kind: 'addItem', label: 'Give the player an item', make: () => ({ kind: 'addItem', item: '' as FormKey, count: 1 }) },
  { kind: 'removeItem', label: 'Take an item from the player', make: () => ({ kind: 'removeItem', item: '' as FormKey, count: 1 }) },
  { kind: 'enable', label: 'Show (enable) an object', make: () => ({ kind: 'enable', ref: '' as FormKey }) },
  { kind: 'disable', label: 'Hide (disable) an object', make: () => ({ kind: 'disable', ref: '' as FormKey }) },
  { kind: 'lock', label: 'Lock or unlock', make: () => ({ kind: 'lock', ref: '' as FormKey, locked: false }) },
  { kind: 'movePlayerTo', label: 'Teleport the player to', make: () => ({ kind: 'movePlayerTo', ref: '' as FormKey }) },
  { kind: 'kill', label: 'Kill an actor', make: () => ({ kind: 'kill', ref: '' as FormKey }) },
  { kind: 'addSpell', label: 'Teach the player a spell', make: () => ({ kind: 'addSpell', spell: '' as FormKey }) },
  { kind: 'wait', label: 'Wait', make: () => ({ kind: 'wait', seconds: 1 }) },
  { kind: 'custom', label: 'Papyrus code', make: () => ({ kind: 'custom', code: '' }) },
];

function useEvents() {
  const client = useStore((s) => s.client);
  return useQuery(() => client?.call('triggerEvents'), [client], { revision: false }).data ?? [];
}

/** One-line description of a trigger, for the list. */
function Summary({ spec }: { spec: TriggerSpec }) {
  const events = useEvents();
  const keys = [...spec.conditions, ...spec.actions].flatMap((x) => Object.values(x).filter((v): v is FormKey => typeof v === 'string' && v.includes(':')));
  const sums = useSummaries(keys);
  const n = (k: FormKey) => sums[k]?.editorId ?? sums[k]?.name ?? (k ? k : '?');
  const cond = (c: TriggerCondition) =>
    c.kind === 'questStage' ? `${n(c.quest)} is at stage ${c.op === '==' ? '' : `${c.op} `}${c.stage}` : c.kind === 'questStageDone' ? `${n(c.quest)} stage ${c.stage} ${c.done ? 'done' : 'not done'}` : c.kind === 'playerHasItem' ? `player has ${c.count}× ${n(c.item)}` : `${c.percent}% chance`;
  const act = (a: TriggerAction) => {
    const label = ACTIONS.find((x) => x.kind === a.kind)?.label ?? a.kind;
    if ('text' in a) return `${label}: “${a.text}”`;
    if (a.kind === 'setStage') return `set ${n(a.quest)} stage ${a.stage}`;
    if ('quest' in a) return `${label.toLowerCase()} (${n(a.quest)})`;
    if ('item' in a) return `${label.toLowerCase()}: ${a.count}× ${n(a.item)}`;
    if ('ref' in a) return `${label.toLowerCase()}: ${n(a.ref)}`;
    return label.toLowerCase();
  };
  return (
    <span>
      <strong>When</strong> {(events.find((e) => e.kind === spec.event.kind)?.label ?? spec.event.kind).toLowerCase()}
      {spec.conditions.length > 0 && (
        <>
          , <strong>if</strong> {spec.conditions.map(cond).join(' and ')}
        </>
      )}
      , <strong>then</strong> {spec.actions.length ? spec.actions.map(act).join(', ') : <span className="warn">nothing yet</span>}
      {spec.once && <span className="faint"> (once)</span>}
    </span>
  );
}

export function TriggersSection({ host, actor }: { host: TriggerHost; actor: boolean }) {
  const client = useStore((s) => s.client);
  const hostKey = host.kind === 'ref' ? host.ref : `${host.quest}#${host.alias}`;
  const { data } = useQuery(() => client?.call('triggersOf', host), [hostKey]);
  const { data: templates } = useQuery(() => client?.call('triggerTemplates'), [client], { revision: false });
  const [editing, setEditing] = useState<{ spec: TriggerSpec; index: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const specs = data?.specs ?? [];
  const save = (next: TriggerSpec[]) => engine((c) => c.call('setTriggers', host, next), { busy: 'Writing trigger script…' });
  const add = async (templateId?: string) => {
    setMenu(false);
    const spec: TriggerSpec = templateId
      ? ((await client?.call('makeTrigger', templateId, host.kind === 'ref' ? host.ref : null)) as TriggerSpec)
      : { id: `t${Date.now().toString(36)}`, name: '', event: { kind: actor ? 'death' : 'activate' }, conditions: [], actions: [] };
    setEditing({ spec, index: -1 });
  };
  return (
    <div data-testid="triggers">
      {specs.map((s, i) => (
        <div key={s.id} className="card small" style={{ padding: 8, marginBottom: 6 }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
            <div className="grow">
              {s.name && <div style={{ fontWeight: 600, marginBottom: 2 }}>{s.name}</div>}
              <Summary spec={s} />
            </div>
            <button className="btn icon ghost" title="Edit" onClick={() => setEditing({ spec: structuredClone(s), index: i })}>
              <Icon name="sliders" size={12} />
            </button>
            <button className="btn icon ghost" title="Remove" onClick={() => save(specs.filter((_, j) => j !== i))}>
              <Icon name="close" size={12} />
            </button>
          </div>
        </div>
      ))}
      {!specs.length && <div className="faint small" style={{ marginBottom: 6 }}>No triggers. Add one to make this react to the player — no scripting needed.</div>}
      <div style={{ position: 'relative' }}>
        <button className="btn small" onClick={() => setMenu(!menu)} data-testid="add-trigger">
          <Icon name="plus" size={12} /> Add trigger
        </button>
        {menu && (
          <div className="card" style={{ position: 'absolute', zIndex: 30, top: 30, left: 0, width: 300, padding: 0 }}>
            <ul className="list">
              <li className="list-item" onClick={() => void add()}>
                <strong>Blank trigger</strong>
              </li>
              {templates?.map((t) => (
                <li key={t.id} className="list-item" onClick={() => void add(t.id)} title={t.description} data-testid={`template-${t.id}`}>
                  <span className="grow">
                    {t.label}
                    <div className="faint small">{t.description}</div>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {editing && (
        <TriggerDialog
          host={host}
          actor={actor}
          initial={editing.spec}
          onClose={() => setEditing(null)}
          onSave={async (spec) => {
            const next = editing.index >= 0 ? specs.map((s, j) => (j === editing.index ? spec : s)) : [...specs, spec];
            const ok = await save(next);
            if (ok) setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TriggerDialog({ host, actor, initial, onSave, onClose }: { host: TriggerHost; actor: boolean; initial: TriggerSpec; onSave: (s: TriggerSpec) => void; onClose: () => void }) {
  const [spec, setSpec] = useState<TriggerSpec>(initial);
  const [preview, setPreview] = useState<string | null>(null);
  const events = useEvents().filter((e) => actor || !e.actorOnly);
  const client = useStore((s) => s.client);
  const showing = preview !== null;
  useEffect(() => {
    if (!showing) return;
    void client?.call('previewTriggers', host, [spec]).then(setPreview, () => setPreview('(fill in the blanks to see the script)'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, showing]);
  const setCond = (i: number, c: TriggerCondition | null) => setSpec({ ...spec, conditions: c ? spec.conditions.map((x, j) => (j === i ? c : x)) : spec.conditions.filter((_, j) => j !== i) });
  const setAct = (i: number, a: TriggerAction | null) => setSpec({ ...spec, actions: a ? spec.actions.map((x, j) => (j === i ? a : x)) : spec.actions.filter((_, j) => j !== i) });
  const move = (i: number, d: -1 | 1) => {
    const list = [...spec.actions];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setSpec({ ...spec, actions: list });
  };
  return (
    <Modal
      title="Trigger"
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn ghost" onClick={() => setPreview(preview === null ? '' : null)}>
            {preview === null ? 'Show script' : 'Hide script'}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(spec)} disabled={!spec.actions.length} data-testid="save-trigger">
            Save trigger
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <TextInput value={spec.name ?? ''} onCommit={(name) => setSpec({ ...spec, name })} placeholder="Name (optional), e.g. “Secret lever”" />
        <div className="block when">
          <div className="block-title">When</div>
          <Select value={spec.event.kind} options={events.map((e) => ({ value: e.kind, label: e.label }))} onChange={(kind) => setSpec({ ...spec, event: { kind: kind as TriggerEventKind } })} />
          <div className="dim small">{events.find((e) => e.kind === spec.event.kind)?.hint}</div>
        </div>
        <div className="block if">
          <div className="block-title">If (all of these)</div>
          {spec.conditions.map((c, i) => (
            <div key={i} className="block-row">
              <ConditionFields c={c} onChange={(x) => setCond(i, x)} />
              <button className="btn icon ghost" title="Remove" onClick={() => setCond(i, null)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          <AddMenu label="Add condition" items={CONDITIONS} onPick={(m) => setSpec({ ...spec, conditions: [...spec.conditions, m()] })} />
        </div>
        <div className="block do">
          <div className="block-title">Do (in order)</div>
          {spec.actions.map((a, i) => (
            <div key={i} className="block-row">
              <ActionFields a={a} onChange={(x) => setAct(i, x)} />
              <button className="btn icon ghost" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </button>
              <button className="btn icon ghost" title="Move down" onClick={() => move(i, 1)} disabled={i === spec.actions.length - 1}>
                ↓
              </button>
              <button className="btn icon ghost" title="Remove" onClick={() => setAct(i, null)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          <AddMenu label="Add action" items={ACTIONS} onPick={(m) => setSpec({ ...spec, actions: [...spec.actions, m()] })} testId="add-action" />
        </div>
        <Checkbox checked={!!spec.once} onChange={(once) => setSpec({ ...spec, once })} label="Only the first time" help="After it has run once, the trigger is ignored (the game remembers this in the save)." />
        {preview !== null && <pre className="mono small code-frame" style={{ padding: 8, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{preview || 'Generating…'}</pre>}
      </div>
    </Modal>
  );
}

function AddMenu<T>({ label, items, onPick, testId }: { label: string; items: { kind: string; label: string; make: () => T }[]; onPick: (make: () => T) => void; testId?: string }) {
  return (
    <select className="input" style={{ width: 'auto' }} value="" onChange={(e) => onPick(items.find((x) => x.kind === e.target.value)!.make)} data-testid={testId}>
      <option value="">+ {label}…</option>
      {items.map((x) => (
        <option key={x.kind} value={x.kind}>
          {x.label}
        </option>
      ))}
    </select>
  );
}

const Num = ({ v, on, min = 0, step = 1 }: { v: number; on: (n: number) => void; min?: number; step?: number }) => (
  <div style={{ width: 80 }}>
    <DragNumber value={v} step={step} precision={step < 1 ? 1 : 0} min={min} onCommit={on} />
  </div>
);
const Pick = ({ v, sigs, on, ph }: { v: FormKey; sigs: string[]; on: (k: FormKey) => void; ph: string }) => (
  <div className="grow" style={{ minWidth: 160 }}>
    <FormPicker value={v || null} sigs={sigs} onChange={(k) => on((k ?? '') as FormKey)} allowNone={false} placeholder={ph} />
  </div>
);

function ConditionFields({ c, onChange }: { c: TriggerCondition; onChange: (c: TriggerCondition) => void }) {
  const label = <span className="block-label">{CONDITIONS.find((x) => x.kind === c.kind)?.label}</span>;
  switch (c.kind) {
    case 'questStage':
      return (
        <>
          {label}
          <Pick v={c.quest} sigs={['QUST']} on={(quest) => onChange({ ...c, quest })} ph="Which quest" />
          <div style={{ width: 64 }}>
            <Select value={c.op} options={['==', '!=', '>=', '<=', '>', '<'].map((o) => ({ value: o, label: o }))} onChange={(op) => onChange({ ...c, op: op as typeof c.op })} />
          </div>
          <Num v={c.stage} on={(stage) => onChange({ ...c, stage })} />
        </>
      );
    case 'questStageDone':
      return (
        <>
          {label}
          <Pick v={c.quest} sigs={['QUST']} on={(quest) => onChange({ ...c, quest })} ph="Which quest" />
          <Num v={c.stage} on={(stage) => onChange({ ...c, stage })} />
          <Checkbox checked={c.done} onChange={(done) => onChange({ ...c, done })} label="done" />
        </>
      );
    case 'playerHasItem':
      return (
        <>
          {label}
          <Num v={c.count} min={1} on={(count) => onChange({ ...c, count })} />
          <Pick v={c.item} sigs={ITEM_SIGS} on={(item) => onChange({ ...c, item })} ph="Which item" />
        </>
      );
    case 'chance':
      return (
        <>
          {label}
          <Num v={c.percent} on={(percent) => onChange({ ...c, percent: Math.min(100, percent) })} />
          <span className="dim">%</span>
        </>
      );
  }
}

function ActionFields({ a, onChange }: { a: TriggerAction; onChange: (a: TriggerAction) => void }) {
  const label = <span className="block-label">{ACTIONS.find((x) => x.kind === a.kind)?.label}</span>;
  switch (a.kind) {
    case 'setStage':
      return (
        <>
          {label}
          <Pick v={a.quest} sigs={['QUST']} on={(quest) => onChange({ ...a, quest })} ph="Which quest" />
          <Num v={a.stage} on={(stage) => onChange({ ...a, stage })} />
        </>
      );
    case 'startQuest':
      return (
        <>
          {label}
          <Pick v={a.quest} sigs={['QUST']} on={(quest) => onChange({ ...a, quest })} ph="Which quest" />
        </>
      );
    case 'showObjective':
    case 'completeObjective':
      return (
        <>
          {label}
          <Pick v={a.quest} sigs={['QUST']} on={(quest) => onChange({ ...a, quest })} ph="Which quest" />
          <Num v={a.objective} on={(objective) => onChange({ ...a, objective })} />
        </>
      );
    case 'notification':
    case 'messageBox':
      return (
        <>
          {label}
          <div className="grow">
            <TextInput value={a.text} onCommit={(text) => onChange({ ...a, text })} placeholder="Text to show" />
          </div>
        </>
      );
    case 'addItem':
    case 'removeItem':
      return (
        <>
          {label}
          <Num v={a.count} min={1} on={(count) => onChange({ ...a, count })} />
          <Pick v={a.item} sigs={ITEM_SIGS} on={(item) => onChange({ ...a, item })} ph="Which item" />
        </>
      );
    case 'enable':
    case 'disable':
    case 'movePlayerTo':
    case 'kill':
      return (
        <>
          {label}
          <Pick v={a.ref} sigs={a.kind === 'kill' ? ['ACHR'] : REF_SIGS} on={(ref) => onChange({ ...a, ref })} ph={a.kind === 'movePlayerTo' ? 'Destination (a placed marker or object)' : 'Which placed object'} />
        </>
      );
    case 'lock':
      return (
        <>
          {label}
          <Pick v={a.ref} sigs={REF_SIGS} on={(ref) => onChange({ ...a, ref })} ph="Which door or container" />
          <Checkbox checked={a.locked} onChange={(locked) => onChange({ ...a, locked })} label="locked" />
        </>
      );
    case 'addSpell':
      return (
        <>
          {label}
          <Pick v={a.spell} sigs={['SPEL']} on={(spell) => onChange({ ...a, spell })} ph="Which spell" />
        </>
      );
    case 'wait':
      return (
        <>
          {label}
          <Num v={a.seconds} step={0.5} on={(seconds) => onChange({ ...a, seconds })} />
          <span className="dim">seconds</span>
        </>
      );
    case 'custom':
      return (
        <>
          {label}
          <div className="grow">
            <TextInput multiline mono value={a.code} onCommit={(code) => onChange({ ...a, code })} placeholder="Papyrus statements, e.g. Game.GetPlayer().DamageActorValue(&quot;Health&quot;, 10)" />
          </div>
        </>
      );
  }
}
