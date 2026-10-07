/**
 * Record browser with an xEdit-style conflict view: every plugin's version of
 * a form side by side, differences highlighted, winner on the right.
 */
import { useMemo, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import type { RecordView } from '@tes5/workspace';
import { Checkbox, EmptyState, Icon, useDebounced, useQuery } from '../../components/ui';
import { useStore } from '../../state/store';

export default function RecordsView() {
  const selected = useStore((s) => s.selected);
  return (
    <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
      <Browser />
      <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{selected ? <Conflicts key={selected} formKey={selected} /> : <EmptyState icon="records" title="Pick a record">
            Every form in your load order, the way xEdit shows them. Pick one to compare each plugin's version side by side, with the differences highlighted and the version the game uses on the right. Use the type and plugin filters to narrow the list.
          </EmptyState>}</div>
    </div>
  );
}

function Browser() {
  const client = useStore((s) => s.client);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const session = useStore((s) => s.session);
  const [sig, setSig] = useState('');
  const [plugin, setPlugin] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data: types } = useQuery(() => client?.call('recordTypes'), [client]);
  const { data } = useQuery(() => client?.call('search', { sigs: sig ? [sig] : undefined, query: dq, plugin: plugin || undefined, limit: 500 }), [sig, dq, plugin]);
  return (
    <div className="panel" style={{ width: 300, flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--panel)' }}>
      <div className="searchbox col" style={{ gap: 4 }}>
        <select className="input" value={sig} onChange={(e) => setSig(e.target.value)}>
          <option value="">All record types</option>
          {types?.map((t) => (
            <option key={t.sig} value={t.sig}>
              {t.name} [{t.sig}] ({t.count})
            </option>
          ))}
        </select>
        <select className="input" value={plugin} onChange={(e) => setPlugin(e.target.value)}>
          <option value="">In any plugin</option>
          {session.loadOrder
            .filter((p) => p.loaded)
            .map((p) => (
              <option key={p.name} value={p.name}>
                Changed by {p.name}
              </option>
            ))}
        </select>
        <input className="input" placeholder="Editor ID, name or FormID…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="list scroll" style={{ flex: 1 }} data-testid="record-list">
        {data?.items.map((i) => (
          <li key={i.formKey} className={`list-item ${selected === i.formKey ? 'selected' : ''} ${i.deleted ? 'dim' : ''}`} onClick={() => select(i.formKey)} title={i.formKey}>
            <span className="sig">{i.sig}</span>
            <span className="name">{i.editorId ?? (i.base ? `${i.base} (placed)` : i.formKey)}</span>
            {i.owner !== i.winner && <span className="chip warn" title={`Overridden by ${i.winner}`}>×</span>}
            <span className="meta">{i.name ?? ''}</span>
          </li>
        ))}
        {data && data.total > data.items.length && <li className="list-item dim">Showing {data.items.length} of {data.total}</li>}
      </ul>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Uint8Array) return Array.from(v.subarray(0, 24), (b) => b.toString(16).padStart(2, '0')).join(' ') + (v.length > 24 ? ` … (${v.length} bytes)` : '');
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
  return String(v);
}

function flatten(v: unknown, prefix: string, out: Map<string, string>, depth = 0): void {
  if (v && typeof v === 'object' && !(v instanceof Uint8Array) && depth < 6) {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v).filter(([k]) => !k.startsWith('__'));
    if (!entries.length) out.set(prefix, Array.isArray(v) ? '[]' : '{}');
    for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out.set(prefix, fmt(v));
}

function Conflicts({ formKey }: { formKey: FormKey }) {
  const client = useStore((s) => s.client);
  const { data: versions } = useQuery(() => client?.call('conflicts', formKey), [formKey]);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [raw, setRaw] = useState(false);
  const table = useMemo(() => {
    if (!versions) return null;
    const flat = versions.map((v: RecordView) => {
      const m = new Map<string, string>();
      if (raw) v.subrecords.forEach((s, i) => m.set(`${String(i).padStart(3, '0')} ${s.sig}`, `${s.size} bytes`));
      else {
        flatten(v.data, '', m);
        for (const u of v.unknown) m.set(`(raw) ${u.sig}`, fmt((u as { data?: Uint8Array }).data));
        if (v.deleted) m.set('(deleted)', 'yes');
      }
      return m;
    });
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const m of flat) for (const k of m.keys()) if (!seen.has(k)) (seen.add(k), keys.push(k));
    if (raw) keys.sort();
    const rows = keys.map((k) => {
      const vals = flat.map((m) => m.get(k));
      const differs = new Set(vals.map((x) => x ?? '')).size > 1;
      return { k, vals, differs };
    });
    return rows;
  }, [versions, raw]);
  if (!versions || !table) return <div className="empty">Loading…</div>;
  const rows = onlyDiff ? table.filter((r) => r.differs) : table;
  const diffCount = table.filter((r) => r.differs).length;
  return (
    <>
      <div className="viewport-toolbar">
        <strong>{versions[0]?.editorId ?? formKey}</strong>
        <span className="chip">{versions[0]?.typeName}</span>
        <span className="dim small mono">{formKey}</span>
        <span className={`chip ${diffCount ? 'warn' : 'ok'}`}>{versions.length < 2 ? 'Single version' : diffCount ? `${diffCount} differing field(s)` : 'All versions identical (ITM)'}</span>
        <span className="spacer" />
        <Checkbox checked={onlyDiff} onChange={setOnlyDiff} label="Only differences" help="Hide fields that are the same in every plugin, so you only see what each mod changes." />
        <Checkbox checked={raw} onChange={setRaw} label="Raw fields" help="Show the record's raw subrecords (four-letter codes and sizes), like xEdit, instead of named fields." />
      </div>
      <div className="scroll" style={{ flex: 1 }} data-testid="conflicts">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 220 }}>Field</th>
              {versions.map((v, i) => (
                <th key={v.source}>
                  {v.source}
                  {i === versions.length - 1 && versions.length > 1 && <span className="chip accent" style={{ marginLeft: 6 }}>winner</span>}
                  {v.source === useStore.getState().session.activePlugin && (
                    <span className="chip" style={{ marginLeft: 6 }}>
                      <Icon name="check" size={10} /> yours
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} className={r.differs ? 'diff' : ''}>
                <td className="mono small dim">{r.k}</td>
                {r.vals.map((v, i) => (
                  <td key={i} className="small" style={{ wordBreak: 'break-word' }}>
                    {v === undefined ? <span className="faint">—</span> : v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
