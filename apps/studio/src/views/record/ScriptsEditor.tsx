/** Attached scripts and their property values (VMAD), with type-aware editors. */
import { VmadPropertyType, VMAD_TYPE_NAMES, type Vmad, type VmadProperty } from '@tes5/esp';
import { useState } from 'react';
import { Checkbox, DragNumber, FormPicker, Icon, TextInput } from '../../components/ui';
import { engine, useStore } from '../../state/store';

function PropValue({ p, onChange }: { p: VmadProperty; onChange: (p: VmadProperty) => void }) {
  switch (p.type) {
    case VmadPropertyType.Object: {
      const o = (p.value ?? { form: null, alias: -1 }) as { form: string | null; alias: number };
      return (
        <div className="row">
          <div className="grow">
            <FormPicker value={o.form} onChange={(form) => onChange({ ...p, value: { ...o, form } })} />
          </div>
          {o.alias >= 0 && <span className="chip">alias {o.alias}</span>}
        </div>
      );
    }
    case VmadPropertyType.Int:
      return <DragNumber value={Number(p.value ?? 0)} precision={0} onCommit={(v) => onChange({ ...p, value: Math.round(v) })} />;
    case VmadPropertyType.Float:
      return <DragNumber value={Number(p.value ?? 0)} step={0.1} precision={3} onCommit={(v) => onChange({ ...p, value: v })} />;
    case VmadPropertyType.Bool:
      return <Checkbox checked={!!p.value} onChange={(v) => onChange({ ...p, value: v })} label="" />;
    case VmadPropertyType.String:
      return <TextInput value={String(p.value ?? '')} onCommit={(v) => onChange({ ...p, value: v })} />;
    default:
      return <span className="dim small">{Array.isArray(p.value) ? `${p.value.length} item(s)` : '—'}</span>;
  }
}

export function ScriptsEditor({ value, onChange }: { value: Vmad | undefined; onChange: (v: Vmad) => void }) {
  const vm: Vmad = value ?? { version: 5, objectFormat: 2, scripts: [] };
  const selected = useStore((s) => s.selected);
  const [adding, setAdding] = useState(false);
  const fragments = vm.fragments;
  return (
    <div className="col" style={{ gap: 6 }}>
      {vm.scripts.map((s, si) => (
        <div key={s.name} className="card" style={{ padding: 8 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <Icon name="script" size={13} />
            <a
              href="#"
              className="grow"
              onClick={(e) => {
                e.preventDefault();
                useStore.getState().setScript(s.name);
                useStore.getState().setTab('script');
              }}
            >
              {s.name}
            </a>
            <button className="btn icon ghost" title="Detach script" onClick={() => onChange({ ...vm, scripts: vm.scripts.filter((_, i) => i !== si) })}>
              <Icon name="close" size={12} />
            </button>
          </div>
          {s.properties.map((p, pi) => (
            <div key={p.name} className="field stack">
              <label title={`${VMAD_TYPE_NAMES[p.type]} ${p.name}`}>
                {p.name} <span className="faint">{VMAD_TYPE_NAMES[p.type]}</span>
              </label>
              <PropValue
                p={p}
                onChange={(np) =>
                  onChange({
                    ...vm,
                    scripts: vm.scripts.map((x, i) => (i === si ? { ...x, properties: x.properties.map((y, j) => (j === pi ? np : y)) } : x)),
                  })
                }
              />
            </div>
          ))}
          {!s.properties.length && <div className="faint small">No properties set</div>}
        </div>
      ))}
      {fragments && (
        <div className="dim small">
          Fragments: {fragments.fileName || '(unnamed)'} — {'fragments' in fragments ? fragments.fragments.length : 0} bound
        </div>
      )}
      <div className="row">
        {adding ? (
          <ScriptAdder
            onPick={async (name) => {
              setAdding(false);
              if (selected) await engine((c) => c.call('attachScript', selected, name), { success: `Attached ${name}` });
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <>
            <button className="btn small" onClick={() => setAdding(true)}>
              <Icon name="plus" size={12} /> Attach script
            </button>
            <button
              className="btn small"
              title="Fill empty object properties whose names match an EditorID"
              onClick={async () => {
                if (!selected) return;
                const r = await engine((c) => c.call('autofill', selected));
                if (r) useStore.getState().toast(r.length ? 'success' : 'info', r.length ? `Auto-filled ${r.map((x) => x.property).join(', ')}` : 'Nothing to auto-fill');
              }}
            >
              <Icon name="wand" size={12} /> Auto-fill
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ScriptAdder({ onPick, onCancel }: { onPick: (name: string) => void; onCancel: () => void }) {
  const client = useStore((s) => s.client);
  const [q, setQ] = useState('');
  const [list, setList] = useState<{ name: string }[]>([]);
  if (!list.length) void client?.call('scriptList').then((l) => setList(l));
  const shown = list.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  return (
    <div className="card grow" style={{ padding: 0 }}>
      <div className="searchbox row">
        <input className="input" autoFocus placeholder="Script name…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && q && onPick(q))} />
        <button className="btn small ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ul className="list" style={{ maxHeight: 180, overflow: 'auto' }}>
        {shown.map((s) => (
          <li key={s.name} className="list-item" onClick={() => onPick(s.name)}>
            {s.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
