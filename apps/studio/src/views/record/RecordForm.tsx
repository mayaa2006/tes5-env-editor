/**
 * Generic record editor rendered from the engine's UI schema. Every typed
 * record type gets a proper form for free: numbers scrub like Blender fields,
 * flags are checkboxes, enums are dropdowns, FormIDs are searchable pickers.
 */
import { useState, type ReactNode } from 'react';
import type { UiMember, UiRecordSchema, UiValue } from '@tes5/workspace';
import { Checkbox, DragNumber, FormPicker, Help, Icon, Select, TextInput } from '../../components/ui';
import { ConditionList } from './ConditionEditor';
import { ScriptsEditor } from './ScriptsEditor';

type Data = Record<string, any>;

export function defaultFor(v: UiValue): unknown {
  switch (v.kind) {
    case 'int':
    case 'float':
      return 0;
    case 'formid':
      return null;
    case 'string':
      return '';
    case 'bytes':
      return new Uint8Array(v.size ?? 0);
    case 'flag':
      return true;
    case 'struct':
      return Object.fromEntries(v.fields.map((f) => [f.key, defaultFor(f.value)]));
    case 'array':
      return v.fixed ? new Array(v.fixed).fill(0).map(() => defaultFor(v.of)) : [];
    case 'union':
      return defaultFor(v.options[0]!);
    case 'custom':
      return v.name === 'VMAD' ? { version: 5, objectFormat: 2, scripts: [] } : undefined;
  }
}

export function defaultMember(m: UiMember): unknown {
  switch (m.kind) {
    case 'sub':
      return defaultFor(m.value);
    case 'list':
      return [];
    case 'group':
      return Object.fromEntries(m.members.filter((x) => x.kind === 'sub' && (x as any).required).map((x) => [x.key, defaultMember(x)]));
    case 'choice':
      return { option: 0, value: defaultMember(m.options[0]!) };
  }
}

function isHidden(v: UiValue): boolean {
  return 'hidden' in v && !!v.hidden;
}

// ------------------------------------------------------------------ values

function FlagsEditor({ value, flags, onChange }: { value: number; flags: Record<number, string>; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const set = Object.entries(flags).filter(([b]) => value & (1 << Number(b)));
  return (
    <div>
      <button className="input" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        {set.length ? set.map(([, n]) => n).join(', ') : <span className="faint">none</span>}
      </button>
      {open && (
        <div className="col" style={{ padding: '6px 2px', gap: 2 }}>
          {Object.entries(flags).map(([bit, name]) => (
            <Checkbox key={bit} checked={(value & (1 << Number(bit))) !== 0} label={name} onChange={(on) => onChange((on ? value | (1 << Number(bit)) : value & ~(1 << Number(bit))) >>> 0)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ValueEditor({ def, value, onChange, label }: { def: UiValue; value: any; onChange: (v: any) => void; label?: string }): ReactNode {
  switch (def.kind) {
    case 'int':
      if (def.flags) return <FlagsEditor value={Number(value ?? 0)} flags={def.flags} onChange={onChange} />;
      if (def.enum)
        return (
          <Select
            value={Number(value ?? 0)}
            options={[...Object.entries(def.enum).map(([v, l]) => ({ value: Number(v), label: l })), ...(def.enum[Number(value ?? 0)] === undefined ? [{ value: Number(value ?? 0), label: `Unknown (${value})` }] : [])]}
            onChange={onChange}
          />
        );
      return <DragNumber value={Number(value ?? 0)} step={1} precision={0} onCommit={onChange} />;
    case 'float':
      if (value && typeof value === 'object') return <span className="mono faint">NaN</span>;
      return <DragNumber value={Number(value ?? 0)} step={def.hint === 'radians' ? 0.01 : def.hint === 'position' ? 1 : 0.05} precision={def.hint === 'radians' ? 3 : 3} onCommit={onChange} suffix={def.hint === 'radians' ? 'rad' : undefined} />;
    case 'formid':
      return <FormPicker value={typeof value === 'string' ? value : null} sigs={def.refs} onChange={onChange} />;
    case 'string':
      if (value && typeof value === 'object') return <span className="faint">localized string #{value.lstringId}</span>;
      return <TextInput value={String(value ?? '')} onCommit={onChange} multiline={def.hint === 'text' || (label ?? '').toLowerCase().includes('text')} />;
    case 'bytes':
      return (
        <span className="mono faint small" title="Raw bytes (preserved as-is)">
          {value instanceof Uint8Array ? `${value.byteLength} bytes` : '—'}
        </span>
      );
    case 'flag':
      return <Checkbox checked={!!value} onChange={onChange} label="" />;
    case 'struct':
      if (def.hint === 'color' || def.hint === 'rgb') return <ColorField value={value ?? {}} float={def.hint === 'rgb'} onChange={onChange} />;
      return (
        <div className="col" style={{ gap: 2, paddingLeft: 6, borderLeft: '1px solid var(--border)' }}>
          {def.fields
            .filter((f) => !isHidden(f.value))
            .map((f) => (
              <Row key={f.key} label={f.label} help={valueHelp(f.value)}>
                <ValueEditor def={f.value} value={value?.[f.key]} label={f.label} onChange={(v) => onChange({ ...(value ?? {}), [f.key]: v })} />
              </Row>
            ))}
        </div>
      );
    case 'array': {
      const arr: any[] = Array.isArray(value) ? value : [];
      return (
        <div className="col" style={{ gap: 3 }}>
          {arr.map((item, i) => (
            <div key={i} className="row">
              <div className="grow">
                <ValueEditor def={def.of} value={item} onChange={(v) => onChange(arr.map((x, j) => (j === i ? v : x)))} />
              </div>
              {!def.fixed && (
                <button className="btn icon ghost" title="Remove" onClick={() => onChange(arr.filter((_, j) => j !== i))}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          ))}
          {!def.fixed && (
            <button className="btn small ghost" onClick={() => onChange([...arr, defaultFor(def.of)])}>
              <Icon name="plus" size={12} /> Add
            </button>
          )}
        </div>
      );
    }
    case 'union':
      return <span className="faint small">(variant value — edit in raw view)</span>;
    case 'custom':
      if (def.name === 'VMAD') return <ScriptsEditor value={value} onChange={onChange} />;
      if (def.name === 'Navmesh') return <span className="dim small">{value ? `${value.vertices?.length ?? 0} vertices, ${value.triangles?.length ?? 0} triangles — edit in the World view` : '—'}</span>;
      return <span className="faint small">{def.name}</span>;
  }
}

function ColorField({ value, float, onChange }: { value: any; float: boolean; onChange: (v: any) => void }) {
  const to255 = (n: number) => Math.round(float ? n * 255 : n);
  const hex = `#${[value.r ?? 0, value.g ?? 0, value.b ?? 0].map((n: number) => Math.max(0, Math.min(255, to255(n))).toString(16).padStart(2, '0')).join('')}`;
  return (
    <input
      type="color"
      value={hex}
      onChange={(e) => {
        const h = e.target.value;
        const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        onChange({ ...value, r: float ? c[0]! / 255 : c[0], g: float ? c[1]! / 255 : c[1], b: float ? c[2]! / 255 : c[2] });
      }}
      style={{ width: 60, height: 24, background: 'none', border: 'none' }}
    />
  );
}

function valueHelp(v: UiValue): string | undefined {
  return 'help' in v ? v.help : undefined;
}

function Row({ label, children, stack, help }: { label: string; children: ReactNode; stack?: boolean; help?: string }) {
  return (
    <div className={`field ${stack ? 'stack' : ''}`}>
      <label title={label}>
        {label}
        {help && (
          <>
            {' '}
            <Help text={help} />
          </>
        )}
      </label>
      <div>{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ members

function MemberEditor({ m, value, onChange, onRemove }: { m: UiMember; value: any; onChange: (v: any) => void; onRemove?: () => void }): ReactNode {
  const [open, setOpen] = useState(true);
  switch (m.kind) {
    case 'sub':
      if (isHidden(m.value)) return null;
      if (m.value.kind === 'custom' && m.value.name === 'Condition') return <ConditionList items={[{ data: value }]} onChange={(items) => onChange(items[0]?.data)} single />;
      return (
        // Wide editors (attached scripts, structs) get the full panel width.
        <Row label={m.label} stack={m.value.kind === 'custom' || m.value.kind === 'struct'} help={m.help ?? valueHelp(m.value)}>
          <div className="row">
            <div className="grow">
              <ValueEditor def={m.value} value={value} label={m.label} onChange={onChange} />
            </div>
            {onRemove && !m.required && (
              <button className="btn icon ghost" title={`Remove ${m.label}`} onClick={onRemove}>
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        </Row>
      );
    case 'list': {
      const arr: any[] = Array.isArray(value) ? value : [];
      // Conditions get a dedicated editor.
      if (m.of.kind === 'group' && m.of.members[0]?.kind === 'sub' && (m.of.members[0] as any).sig === 'CTDA') {
        return (
          <Collapsible label={`${m.label} (${arr.length})`} open={open} setOpen={setOpen}>
            <ConditionList items={arr} onChange={onChange} />
          </Collapsible>
        );
      }
      return (
        <Collapsible label={`${m.label} (${arr.length})`} open={open} setOpen={setOpen} help={m.help}>
          {arr.map((item, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start', marginBottom: 4 }}>
              <div className="grow">
                {m.of.kind === 'sub' ? (
                  <ValueEditor def={m.of.value} value={item} onChange={(v) => onChange(arr.map((x, j) => (j === i ? v : x)))} />
                ) : (
                  <MemberEditor m={m.of} value={item} onChange={(v) => onChange(arr.map((x, j) => (j === i ? v : x)))} />
                )}
              </div>
              <button className="btn icon ghost" title="Remove" onClick={() => onChange(arr.filter((_, j) => j !== i))}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          <button className="btn small ghost" onClick={() => onChange([...arr, defaultMember(m.of)])}>
            <Icon name="plus" size={12} /> Add {m.of.label}
          </button>
        </Collapsible>
      );
    }
    case 'group':
      return (
        <Collapsible label={m.label} open={open} setOpen={setOpen}>
          <Members members={m.members} data={value ?? {}} onChange={onChange} />
        </Collapsible>
      );
    case 'choice': {
      const v = value ?? { option: 0, value: {} };
      return (
        <Collapsible label={m.label} open={open} setOpen={setOpen}>
          <Row label="Kind">
            <Select value={v.option} options={m.options.map((o, i) => ({ value: i, label: o.label }))} onChange={(i) => onChange({ option: i, value: defaultMember(m.options[i]!) })} />
          </Row>
          {m.options[v.option] && <MemberEditor m={m.options[v.option]!} value={v.value} onChange={(nv) => onChange({ ...v, value: nv })} />}
        </Collapsible>
      );
    }
  }
}

function Collapsible({ label, open, setOpen, children, help }: { label: string; open: boolean; setOpen: (o: boolean) => void; children: ReactNode; help?: string }) {
  return (
    <div style={{ margin: '4px 0' }}>
      <div className="row" style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12 }} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevron'} size={12} />
        {label}
        {help && (
          <span onClick={(e) => e.stopPropagation()}>
            <Help text={help} />
          </span>
        )}
      </div>
      {open && <div style={{ paddingLeft: 12, borderLeft: '1px solid var(--border)', marginLeft: 5 }}>{children}</div>}
    </div>
  );
}

export function Members({ members, data, onChange }: { members: UiMember[]; data: Data; onChange: (d: Data) => void }) {
  const prominent = (m: UiMember) => m.kind === 'list' && !!m.prominent;
  const absent = members.filter((m) => data[m.key] === undefined && !prominent(m) && !(m.kind === 'sub' && isHidden(m.value)));
  const [adding, setAdding] = useState('');
  return (
    <>
      {members
        .filter((m) => data[m.key] !== undefined || prominent(m))
        .map((m) => (
          <MemberEditor
            key={m.key}
            m={m}
            value={data[m.key] ?? []}
            onChange={(v) => onChange({ ...data, [m.key]: v })}
            onRemove={() => {
              const copy = { ...data };
              delete copy[m.key];
              onChange(copy);
            }}
          />
        ))}
      {absent.length > 0 && (
        <div className="row" style={{ marginTop: 6 }}>
          <select className="input" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add field…</option>
            {absent.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            className="btn small"
            disabled={!adding}
            onClick={() => {
              const m = members.find((x) => x.key === adding)!;
              onChange({ ...data, [m.key]: defaultMember(m) });
              setAdding('');
            }}
          >
            Add
          </button>
        </div>
      )}
    </>
  );
}

export function RecordForm({ schema, data, onChange }: { schema: UiRecordSchema; data: Data; onChange: (d: Data) => void }) {
  return (
    <div className="pad" style={{ paddingTop: 6 }}>
      <Members members={schema.members} data={data} onChange={onChange} />
    </div>
  );
}
