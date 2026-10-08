/**
 * Condition editor: readable rows like "Subject.GetStage(MyQuest) >= 10 AND",
 * with a searchable function list and pickers that know each parameter's type.
 */
import { useMemo, useState } from 'react';
import { ACTOR_VALUES, FORM_PARAM_TYPES, PARAM_REFS, RUN_ON, type Condition, type ConditionFunctionInfo, type ConditionParamType } from '@tes5/esp';
import { Checkbox, DragNumber, FormPicker, Icon, Select, useQuery } from '../../components/ui';
import { useStore } from '../../state/store';

interface Item {
  data: Condition;
  stringParam1?: string;
  stringParam2?: string;
}

const OPS: Condition['op'][] = ['==', '!=', '>', '>=', '<', '<='];

export function useConditionFunctions(): ConditionFunctionInfo[] {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('conditionFunctions'), [client], { revision: false });
  return data ?? [];
}

const AV_RENAME: Record<string, string> = { Marksman: 'Archery', Speechcraft: 'Speech', OneHanded: 'One-handed', TwoHanded: 'Two-handed', HeavyArmor: 'Heavy Armor', LightArmor: 'Light Armor' };
/** "HealRate" → "Heal Rate"; skills get the names the game's menus use. */
export const actorValueLabel = (n: string) => AV_RENAME[n] ?? n.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
const FIRST_AVS = ['OneHanded', 'TwoHanded', 'Marksman', 'Block', 'Smithing', 'HeavyArmor', 'LightArmor', 'Pickpocket', 'Lockpicking', 'Sneak', 'Alchemy', 'Speechcraft', 'Alteration', 'Conjuration', 'Destruction', 'Illusion', 'Restoration', 'Enchanting', 'Health', 'Magicka', 'Stamina'];
const AV_OPTIONS = (() => {
  const entries = Object.entries(ACTOR_VALUES).filter(([i, n]) => Number(i) >= 0 && !/^Unknown/.test(n));
  const rank = (n: string) => (FIRST_AVS.includes(n) ? FIRST_AVS.indexOf(n) : 100);
  return entries.sort((a, b) => rank(a[1]) - rank(b[1]) || actorValueLabel(a[1]).localeCompare(actorValueLabel(b[1]))).map(([i, n]) => ({ value: Number(i), label: actorValueLabel(n) }));
})();

/** Parameters stored as numbers that mean a choice, with the names the Creation Kit shows. */
const NUMBER_CHOICES: Partial<Record<ConditionParamType, { value: number; label: string }[]>> = {
  actorValue: AV_OPTIONS,
  crimeType: ['Steal', 'Pickpocket', 'Trespass', 'Attack', 'Murder', 'Escape jail', 'Werewolf transformation'].map((label, value) => ({ value, label })),
  castingSource: ['Left hand', 'Right hand', 'Voice', 'Instant'].map((label, value) => ({ value, label })),
  alignment: ['Good', 'Neutral', 'Evil', 'Very good', 'Very evil'].map((label, value) => ({ value, label })),
  criticalStage: ['None', 'Goo start', 'Goo end', 'Disintegrate start', 'Disintegrate end'].map((label, value) => ({ value, label })),
  wardState: ['None', 'Absorb', 'Break'].map((label, value) => ({ value, label })),
};

/** A plain-words name for each parameter kind, for tooltips and the function list. */
const PARAM_LABEL: Partial<Record<ConditionParamType, string>> = {
  actorValue: 'skill or stat', actor: 'character', actorBase: 'character', baseObject: 'object', inventoryObject: 'item', crimeType: 'crime',
  castingSource: 'hand', questStage: 'stage', integer: 'number', float: 'number', faction: 'faction', factionNull: 'faction', quest: 'quest',
  reference: 'placed object', keyword: 'keyword', race: 'race', perk: 'perk', magicEffect: 'magic effect', location: 'location', cell: 'cell',
  global: 'global', formList: 'list', sex: 'sex', axis: 'axis', alignment: 'alignment', voiceType: 'voice type', worldspace: 'worldspace',
};
export const paramLabel = (p: ConditionParamType) => PARAM_LABEL[p] ?? p;

function ParamEditor({ type, value, onChange }: { type: ConditionParamType; value: unknown; onChange: (v: unknown) => void }) {
  const choices = NUMBER_CHOICES[type];
  if (choices) {
    const v = Number(value ?? 0);
    const opts = choices.some((c) => c.value === v) ? choices : [{ value: v, label: `#${v}` }, ...choices];
    return <Select value={v} options={opts} onChange={onChange} />;
  }
  if (FORM_PARAM_TYPES.has(type)) return <FormPicker value={typeof value === 'string' ? value : null} sigs={[...(PARAM_REFS[type] ?? [])]} onChange={onChange} />;
  if (type === 'axis')
    return (
      <Select
        value={Number(value ?? 88)}
        options={[
          { value: 88, label: 'X' },
          { value: 89, label: 'Y' },
          { value: 90, label: 'Z' },
        ]}
        onChange={onChange}
      />
    );
  if (type === 'sex')
    return (
      <Select
        value={Number(value ?? 0)}
        options={[
          { value: 0, label: 'Male' },
          { value: 1, label: 'Female' },
        ]}
        onChange={onChange}
      />
    );
  if (type === 'float') return <DragNumber value={Number(value ?? 0)} step={0.1} precision={2} onCommit={onChange} />;
  return <DragNumber value={Number(value ?? 0)} step={1} precision={0} onCommit={onChange} />;
}

function FunctionPicker({ value, fns, onChange }: { value: number; fns: ConditionFunctionInfo[]; onChange: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const cur = fns.find((f) => f.index === value);
  const list = useMemo(() => fns.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase())).slice(0, 80), [fns, q]);
  return (
    <div style={{ position: 'relative' }}>
      <button className="input mono" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        {cur?.name ?? `Function#${value}`}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', zIndex: 60, top: 28, left: 0, width: 280, padding: 0, maxHeight: 300, display: 'flex', flexDirection: 'column' }}>
          <div className="searchbox">
            <input className="input" autoFocus placeholder="Search condition functions…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <ul className="list scroll">
            {list.map((f) => (
              <li
                key={f.index}
                className="list-item"
                onClick={() => {
                  onChange(f.index);
                  setOpen(false);
                }}
              >
                <span className="mono">{f.name}</span>
                <span className="meta">{f.params.filter((p) => p !== 'none').map(paramLabel).join(', ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ConditionRow({ item, fns, onChange, onRemove }: { item: Item; fns: ConditionFunctionInfo[]; onChange: (i: Item) => void; onRemove?: () => void }) {
  const c = item.data;
  const info = fns.find((f) => f.index === c.function);
  const set = (p: Partial<Condition>) => onChange({ ...item, data: { ...c, ...p } });
  return (
    <div className="card" style={{ padding: 6, marginBottom: 4 }}>
      <div className="row wrap" style={{ gap: 4 }}>
        <div style={{ width: 120 }}>
          <Select value={c.runOn} options={RUN_ON.map((r, i) => ({ value: i, label: r }))} onChange={(runOn) => set({ runOn })} />
        </div>
        <div style={{ width: 170 }}>
          <FunctionPicker
            value={c.function}
            fns={fns}
            onChange={(fn) => {
              const nf = fns.find((f) => f.index === fn);
              set({ function: fn, param1: nf && FORM_PARAM_TYPES.has(nf.params[0]!) ? null : 0, param2: nf && FORM_PARAM_TYPES.has(nf.params[1]!) ? null : 0 });
            }}
          />
        </div>
        {info?.params.map((p, i) => (
          <div key={i} style={{ minWidth: 120, flex: 1 }} title={`Parameter ${i + 1}: ${paramLabel(p)}`}>
            <ParamEditor type={p} value={i === 0 ? c.param1 : c.param2} onChange={(v) => set(i === 0 ? { param1: v } : { param2: v })} />
          </div>
        ))}
        <div style={{ width: 58 }}>
          <Select value={c.op} options={OPS.map((o) => ({ value: o, label: o }))} onChange={(op) => set({ op })} />
        </div>
        <div style={{ width: 110 }}>
          {c.useGlobal ? (
            <FormPicker value={typeof c.value === 'string' ? c.value : null} sigs={['GLOB']} onChange={(v) => set({ value: v })} />
          ) : (
            <DragNumber value={Number(c.value ?? 0)} step={1} precision={2} onCommit={(value) => set({ value })} />
          )}
        </div>
        <Checkbox checked={c.useGlobal} onChange={(useGlobal) => set({ useGlobal, value: useGlobal ? null : 1 })} label="global" help="Compare with the value of a global variable instead of a fixed number." />
        <Checkbox checked={c.or} onChange={(or) => set({ or })} label="OR" help="Join this condition to the next one with OR instead of AND. Conditions are read top to bottom; OR binds tighter than AND." />
        {c.runOn === 2 && (
          <div style={{ minWidth: 140 }}>
            <FormPicker value={typeof c.reference === 'string' ? c.reference : null} sigs={['REFR', 'ACHR', 'PLYR']} onChange={(v) => set({ reference: v })} placeholder="Reference" />
          </div>
        )}
        {onRemove && (
          <button className="btn icon ghost" title="Remove condition" onClick={onRemove}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export function ConditionList({ items, onChange, single }: { items: Item[]; onChange: (items: Item[]) => void; single?: boolean }) {
  const fns = useConditionFunctions();
  const client = useStore((s) => s.client);
  return (
    <div>
      {items.map((it, i) => (
        <ConditionRow key={i} item={it} fns={fns} onChange={(n) => onChange(items.map((x, j) => (j === i ? n : x)))} onRemove={single ? undefined : () => onChange(items.filter((_, j) => j !== i))} />
      ))}
      {!single && (
        <button
          className="btn small ghost"
          onClick={async () => {
            const c = (await client?.call('newCondition', 0)) as Condition;
            onChange([...items, { data: c }]);
          }}
        >
          <Icon name="plus" size={12} /> Add condition
        </button>
      )}
    </div>
  );
}
