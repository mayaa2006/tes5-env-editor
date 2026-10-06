/**
 * Condition editor: readable rows like "Subject.GetStage(MyQuest) >= 10 AND",
 * with a searchable function list and pickers that know each parameter's type.
 */
import { useMemo, useState } from 'react';
import { FORM_PARAM_TYPES, PARAM_REFS, RUN_ON, type Condition, type ConditionFunctionInfo, type ConditionParamType } from '@tes5/esp';
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

function ParamEditor({ type, value, onChange }: { type: ConditionParamType; value: unknown; onChange: (v: unknown) => void }) {
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
                <span className="meta">{f.params.join(', ')}</span>
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
          <div key={i} style={{ minWidth: 120, flex: 1 }} title={p}>
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
