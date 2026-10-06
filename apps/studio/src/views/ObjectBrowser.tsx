import { useMemo, useState } from 'react';
import { Icon, Tabs, useDebounced, useQuery } from '../components/ui';
import { useStore } from '../state/store';
import { NewCellDialog } from './scene/NewCellDialog';

type Tab = 'objects' | 'cells' | 'assets';

/** Base object types that can be placed in the world by drag & drop. */
export const PLACEABLE = ['STAT', 'MSTT', 'FURN', 'ACTI', 'CONT', 'DOOR', 'LIGH', 'TREE', 'FLOR', 'MISC', 'WEAP', 'ARMO', 'BOOK', 'KEYM', 'NPC_', 'SCOL', 'ALCH', 'INGR', 'AMMO', 'SLGM'];

export function ObjectBrowser() {
  const tab = useStore((s) => s.tab);
  const [sub, setSub] = useState<Tab>(tab === 'scene' ? 'cells' : 'objects');
  return (
    <div className="panel">
      <Tabs<Tab>
        tabs={[
          { id: 'cells', label: 'Cells' },
          { id: 'objects', label: 'Objects' },
          { id: 'assets', label: 'Assets' },
        ]}
        value={sub}
        onChange={setSub}
      />
      {sub === 'objects' && <Objects />}
      {sub === 'cells' && <Cells />}
      {sub === 'assets' && <Assets />}
    </div>
  );
}

function Objects() {
  const client = useStore((s) => s.client);
  const select = useStore((s) => s.select);
  const selected = useStore((s) => s.selected);
  const [sig, setSig] = useState<string>('STAT');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data: types } = useQuery(() => client?.call('recordTypes'), [client]);
  const { data: list } = useQuery(() => client?.call('search', { sigs: sig ? [sig] : undefined, query: dq, limit: 400 }), [sig, dq]);
  const grouped = useMemo(() => {
    const m = new Map<string, NonNullable<typeof types>>();
    for (const t of types ?? []) {
      if (!m.has(t.category)) m.set(t.category, []);
      m.get(t.category)!.push(t);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [types]);
  return (
    <div className="panel" style={{ minHeight: 0 }}>
      <div className="searchbox col" style={{ gap: 4 }}>
        <select className="input" value={sig} onChange={(e) => setSig(e.target.value)} title="Kind of object">
          {grouped.map(([cat, ts]) => (
            <optgroup key={cat} label={cat}>
              {ts.map((t) => (
                <option key={t.sig} value={t.sig}>
                  {t.name} ({t.count})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <input className="input" placeholder="Filter by name or Editor ID…" value={q} onChange={(e) => setQ(e.target.value)} />
        {PLACEABLE.includes(sig) && <div className="faint small">Drag one into the 3D view to place it.</div>}
      </div>
      <ul className="list scroll" style={{ flex: 1 }} data-testid="object-list">
        {list?.items.map((i) => (
          <li
            key={i.formKey}
            className={`list-item ${selected === i.formKey ? 'selected' : ''} ${i.deleted ? 'dim' : ''}`}
            draggable={PLACEABLE.includes(i.sig)}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-tes5-form', i.formKey);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => select(i.formKey)}
            title={`${i.formKey}${PLACEABLE.includes(i.sig) ? ' — drag into the viewport to place' : ''}`}
          >
            <span className="name">{i.editorId ?? i.formKey}</span>
            {i.inActive && <span className="chip accent">edited</span>}
            <span className="meta">{i.name ?? ''}</span>
          </li>
        ))}
        {list && list.total > list.items.length && <li className="list-item dim">Showing {list.items.length} of {list.total}. Refine the filter.</li>}
        {list && !list.items.length && <li className="empty">Nothing found</li>}
      </ul>
    </div>
  );
}

function Cells() {
  const client = useStore((s) => s.client);
  const cell = useStore((s) => s.cell);
  const setCell = useStore((s) => s.setCell);
  const setTab = useStore((s) => s.setTab);
  const [q, setQ] = useState('');
  const [newCell, setNewCell] = useState(false);
  const { data: cells } = useQuery(() => client?.call('cells', {}), [client]);
  const { data: worlds } = useQuery(() => client?.call('worldspaces'), [client]);
  const filtered = (cells ?? []).filter((c) => !q || (c.editorId ?? '').toLowerCase().includes(q.toLowerCase()) || (c.name ?? '').toLowerCase().includes(q.toLowerCase()));
  const interiors = filtered.filter((c) => c.interior);
  const byWorld = (worlds ?? []).map((w) => ({ w, cells: filtered.filter((c) => c.worldspace === w.formKey) })).filter((x) => x.cells.length);
  const item = (c: (typeof filtered)[number]) => (
    <li
      key={c.formKey}
      className={`list-item ${cell === c.formKey ? 'selected' : ''}`}
      onClick={() => {
        setCell(c.formKey);
        setTab('scene');
      }}
      title={c.formKey}
    >
      <span className="name">{c.editorId ?? c.formKey}</span>
      {c.grid && <span className="mono faint small">{`${c.grid.x}, ${c.grid.y}`}</span>}
      {c.inActive && <span className="chip accent">edited</span>}
      <span className="meta">{c.name ?? ''}</span>
    </li>
  );
  return (
    <div className="panel" style={{ minHeight: 0 }}>
      <div className="searchbox">
        <input className="input" placeholder="Find cell…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="scroll" style={{ flex: 1 }}>
        <div className="panel-header row">
          <span className="grow">Interiors ({interiors.length})</span>
          <button className="btn small ghost" title="Create a new interior cell" onClick={() => setNewCell(true)} data-testid="new-cell">
            <Icon name="plus" size={12} /> New
          </button>
        </div>
        <ul className="list" data-testid="cell-list">
          {interiors.map(item)}
        </ul>
        {byWorld.map(({ w, cells: cs }) => (
          <div key={w.formKey}>
            <div className="panel-header">
              {w.editorId} ({cs.length})
            </div>
            <ul className="list">{cs.map(item)}</ul>
          </div>
        ))}
      </div>
      {newCell && <NewCellDialog onClose={() => setNewCell(false)} />}
    </div>
  );
}

function Assets() {
  const client = useStore((s) => s.client);
  const [path, setPath] = useState('meshes');
  const { data } = useQuery(() => client?.call('assetChildren', path), [path]);
  const parts = path.split('\\').filter(Boolean);
  return (
    <div className="panel" style={{ minHeight: 0 }}>
      <div className="searchbox row wrap small">
        <a href="#" onClick={(e) => (e.preventDefault(), setPath(''))}>
          Data
        </a>
        {parts.map((p, i) => (
          <span key={i}>
            {' / '}
            <a href="#" onClick={(e) => (e.preventDefault(), setPath(parts.slice(0, i + 1).join('\\')))}>
              {p}
            </a>
          </span>
        ))}
      </div>
      <ul className="list scroll" style={{ flex: 1 }} data-testid="asset-list">
        {data?.folders.map((f) => (
          <li key={f} className="list-item tree-folder" onClick={() => setPath(path ? `${path}\\${f}` : f)}>
            <Icon name="folder" size={13} /> {f}
          </li>
        ))}
        {data?.files.map((f) => {
          const name = f.path.slice(f.path.lastIndexOf('\\') + 1);
          const isMesh = name.endsWith('.nif');
          return (
            <li
              key={f.path}
              className="list-item"
              draggable={isMesh}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-tes5-mesh', f.path);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title={`${f.path}${f.source !== 'loose' ? ` (in ${f.source})` : ''}${isMesh ? ' — drag into the viewport' : ''}`}
            >
              <Icon name={isMesh ? 'cube' : 'file'} size={13} />
              <span className="name">{name}</span>
              <span className="meta">{f.source === 'loose' ? '' : f.source}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
