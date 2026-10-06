/**
 * World editing: the cell in a Blender-style 3D viewport, an outliner, drag &
 * drop placement from the object/asset browsers, and navmesh generation/editing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormKey, Navmesh } from '@tes5/esp';
import { addTriangle, buildGrid, deleteTriangles, setTriangleFlags } from '@tes5/navmesh';
import type { PlacedRef } from '@tes5/workspace';
import { Checkbox, Field, Icon, Modal, Select, TextInput, useQuery, useUniqueEditorId } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { EnvTools, type ToolHandlers } from './EnvTools';
import { Viewport, type Tool } from './viewport';

const NAV_FLAGS = { preferred: 0x0040, water: 0x0200, noLarge: 0x0010 } as const;

export default function SceneView() {
  const client = useStore((s) => s.client);
  const cell = useStore((s) => s.cell);
  const session = useStore((s) => s.session);
  const settings = useStore((s) => s.settings);
  const sceneSelection = useStore((s) => s.sceneSelection);
  const host = useRef<HTMLDivElement>(null);
  const vpRef = useRef<Viewport | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [snap, setSnap] = useState(false);
  const [cellLighting, setCellLighting] = useState(false);
  const [showNav, setShowNav] = useState(true);
  const [navEdit, setNavEdit] = useState<FormKey | null>(null);
  const [navSel, setNavSel] = useState<number[]>([]);
  const [navDrawing, setNavDrawing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [hiddenTick, setHiddenTick] = useState(0);
  const [newCell, setNewCell] = useState(false);
  const [outliner, setOutliner] = useState(true);
  const [ortho, setOrtho] = useState(false);
  const [tools, setTools] = useState(false);
  const [kitSnap, setKitSnap] = useState(false);
  const toolHandlers = useRef<ToolHandlers>({});
  const framedCell = useRef<string | undefined>(undefined);

  const { data: cells } = useQuery(() => client?.call('cells', {}), [client]);
  const info = cells?.find((c) => c.formKey === cell);
  // Tagged with their cell: while a new cell loads, the previous cell's list must not be framed as the new one.
  const { data: refsFor } = useQuery(() => (cell ? client?.call('references', cell).then((list) => ({ cell, list })) : undefined), [cell]);
  const refs = refsFor && refsFor.cell === cell ? refsFor.list : undefined;
  const { data: lighting } = useQuery(() => (cell ? client?.call('cellLighting', cell) : undefined), [cell]);
  const { data: terrain } = useQuery(() => (cell && info && !info.interior ? client?.call('terrain', cell) : undefined), [cell, info?.interior]);
  const { data: navmeshes } = useQuery(() => (cell ? client?.call('navmeshes', cell) : undefined), [cell]);
  const { data: navStatus } = useQuery(() => (cell && session.activePlugin ? client?.call('navmeshStatus', cell) : undefined), [cell, session.activePlugin]);

  // Latest values for viewport callbacks (created once).
  const live = useRef({ cell, navEdit, navmeshes, session });
  live.current = { cell, navEdit, navmeshes, session };

  useEffect(() => {
    if (!host.current || !client) return;
    const vp = new Viewport(host.current, client, {
      select: (keys) => useStore.getState().setSceneSelection(keys),
      commitTransforms: (changes, label) => void engine((c) => c.call('transformReferences', changes, label)),
      duplicate: async (keys) => {
        const res = await engine((c) => c.call('duplicateReferences', keys));
        if (res) useStore.getState().setSceneSelection(res);
        return res;
      },
      remove: async (keys) => {
        const res = await engine((c) => c.call('deleteReferences', keys));
        if (!res) return;
        const disabled = res.filter((r) => r.result === 'disabled').length;
        useStore.getState().setSceneSelection([]);
        useStore.getState().toast('success', disabled ? `Deleted ${res.length - disabled}, disabled ${disabled} master reference(s) (safe delete)` : `Deleted ${res.length} reference(s)`);
      },
      status: setStatus,
      hiddenChanged: () => setHiddenTick((t) => t + 1),
      navPick: (tris) => setNavSel(tris),
      navDelete: () => void editNav((nav, sel) => deleteTriangles(nav, sel), 'Delete navmesh triangles'),
      navAddTriangle: (pts) => void editNav((nav) => void addTriangle(nav, pts[0]!, pts[1]!, pts[2]!, 2), 'Add navmesh triangle', { needsSelection: false }),
      navMoveVertices: (moves) =>
        void editNav(
          (nav) => {
            for (const m of moves) nav.vertices[m.index] = { x: m.x, y: m.y, z: m.z };
            buildGrid(nav, nav.grid.divisor);
          },
          'Move navmesh vertices',
          { needsSelection: false },
        ),
      tab: () => toggleNavEdit(),
      navDrawChanged: setNavDrawing,
      brushStroke: (pts, erase) => toolHandlers.current.brushStroke?.(pts, erase),
      brushRadius: (r) => toolHandlers.current.brushRadius?.(r),
      pathDone: (pts) => toolHandlers.current.pathDone?.(pts),
      toolCancelled: () => toolHandlers.current.cancelled?.(),
    });
    vpRef.current = vp;
    (window as unknown as { __viewport?: Viewport }).__viewport = vp;
    return () => {
      vp.dispose();
      vpRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const toggleNavEdit = () => {
    const { navEdit: cur, navmeshes: navs, session: s } = live.current;
    const vp = vpRef.current;
    if (!vp) return;
    if (cur) {
      vp.setNavEdit(null);
      setNavEdit(null);
      setNavSel([]);
      return;
    }
    const target = navs?.find((n) => n.source === s.activePlugin) ?? navs?.[0];
    if (!target) {
      useStore.getState().toast('info', 'This cell has no navmesh yet. Use “Generate navmesh” first.');
      return;
    }
    vp.setNavEdit(target.formKey);
    setNavEdit(target.formKey);
    setShowNav(true);
  };

  const editNav = async (fn: (nav: Navmesh, sel: number[]) => void, label: string, opts: { needsSelection?: boolean } = {}) => {
    const vp = vpRef.current;
    const key = live.current.navEdit;
    const n = live.current.navmeshes?.find((m) => m.formKey === key);
    if (!vp || !key || !n) return;
    const sel = vp.navSelection;
    if (!sel.length && opts.needsSelection !== false) return;
    const nav = structuredClone(n.geometry);
    fn(nav, sel);
    const issues = await engine((c) => c.call('updateNavmesh', key, nav));
    if (issues) {
      useStore.getState().addLog('info', label);
      for (const i of issues.filter((x) => x.severity === 'error').slice(0, 3)) useStore.getState().toast('warning', i.message);
      if (label.startsWith('Delete')) {
        vp.setNavSelection([]);
        setNavSel([]);
      }
    }
  };

  // Feed data into the viewport.
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    vp.setRefs(refs ?? []);
    if (refs && cell && framedCell.current !== cell) {
      framedCell.current = cell;
      vp.frame();
    }
  }, [refs, cell]);
  useEffect(() => {
    if (info) vpRef.current?.setCellContext(info);
  }, [info?.formKey]);
  useEffect(() => vpRef.current?.setTerrain(terrain ? [terrain] : []), [terrain]);
  useEffect(() => vpRef.current?.setNavmeshes((navmeshes ?? []).map((n) => ({ key: n.formKey, nav: n.geometry, mine: n.source === session.activePlugin }))), [navmeshes, session.activePlugin]);
  useEffect(() => vpRef.current?.setSelection(sceneSelection), [sceneSelection, refs]);
  useEffect(() => vpRef.current?.setTool(tool), [tool]);
  useEffect(() => vpRef.current?.setSnapping(snap), [snap]);
  useEffect(() => vpRef.current?.setKitSnap(kitSnap), [kitSnap]);
  useEffect(() => vpRef.current?.setNavVisible(showNav), [showNav]);
  useEffect(() => {
    vpRef.current?.setOptions({
      showMarkers: settings.showMarkers,
      cellLighting,
      ambient: lighting?.ambient ? [lighting.ambient.r, lighting.ambient.g, lighting.ambient.b] : null,
      snap: { move: settings.snapMove, rotateDeg: settings.snapRotateDeg, scale: settings.snapScale },
    });
  }, [settings.showMarkers, settings.snapMove, settings.snapRotateDeg, settings.snapScale, cellLighting, lighting]);
  useEffect(() => {
    if (navEdit) vpRef.current?.setNavEdit(null);
    setNavEdit(null);
    setNavSel([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell]);

  const place = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const vp = vpRef.current;
    if (!vp || !cell) return;
    const form = e.dataTransfer.getData('application/x-tes5-form');
    const mesh = e.dataTransfer.getData('application/x-tes5-mesh');
    if (!form && !mesh) return;
    const p = vp.pickPoint(e.clientX, e.clientY);
    const position = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    const key = await engine(
      async (c) => {
        const base = form || (await c.call('baseForMesh', mesh));
        return c.call('placeReference', cell, base, { position });
      },
      { busy: mesh ? 'Creating base object…' : undefined },
    );
    if (key) {
      useStore.getState().setSceneSelection([key]);
      useStore.getState().addLog('success', `Placed ${form ? form : mesh}`);
    }
  };

  if (!cell) return <NoCell onNew={() => setNewCell(true)} newCell={newCell} closeNew={() => setNewCell(false)} />;

  const toolBtn = (t: Tool, icon: string, label: string, key: string) => (
    <button className={`btn small ${tool === t ? 'active' : 'ghost'}`} title={`${label} tool — or press ${key} for a quick ${label.toLowerCase()}`} onClick={() => setTool(t)} aria-pressed={tool === t}>
      <Icon name={icon} size={13} /> {label}
    </button>
  );

  return (
    <div className="col" style={{ flex: 1, minHeight: 0 }}>
      <div className="viewport-toolbar">
        <strong className="ellipsis" style={{ maxWidth: 220 }} title={cell}>
          {info?.editorId ?? cell}
        </strong>
        {info && !info.interior && info.grid && <span className="chip">{`${info.grid.x}, ${info.grid.y}`}</span>}
        <span className="sep" />
        {toolBtn('select', 'cube', 'Select', 'click')}
        {toolBtn('move', 'route', 'Move', 'G')}
        {toolBtn('rotate', 'redo', 'Rotate', 'R')}
        {toolBtn('scale', 'frame', 'Scale', 'S')}
        <button className={`btn small ${snap ? 'active' : 'ghost'}`} title={`Snap (${settings.snapMove} units, ${settings.snapRotateDeg}°). Hold Ctrl while transforming to toggle.`} onClick={() => setSnap(!snap)}>
          <Icon name="magnet" size={13} />
        </button>
        <button className={`btn small ${kitSnap ? 'active' : 'ghost'}`} title="Kit snapping: while moving (G), edges snap flush to nearby pieces — for walls, floors and other kit pieces" onClick={() => setKitSnap(!kitSnap)} data-testid="kit-snap">
          Kit
        </button>
        <span className="sep" />
        <button className="btn small ghost" title="Top view (Numpad 7)" onClick={() => (vpRef.current?.view('top'), setOrtho(true))}>
          Top
        </button>
        <button className="btn small ghost" title="Front view (Numpad 1)" onClick={() => (vpRef.current?.view('front'), setOrtho(true))}>
          Front
        </button>
        <button className="btn small ghost" title="Right view (Numpad 3)" onClick={() => (vpRef.current?.view('right'), setOrtho(true))}>
          Right
        </button>
        <button className="btn small ghost" title="Perspective / orthographic (Numpad 5)" onClick={() => setOrtho(vpRef.current?.toggleOrtho() ?? false)}>
          {ortho ? 'Ortho' : 'Persp'}
        </button>
        <button className="btn small ghost" title="Frame all (Home) — F frames the selection" onClick={() => vpRef.current?.frame()}>
          <Icon name="frame" size={13} />
        </button>
        <span className="sep" />
        <button className={`btn small ${settings.showMarkers ? 'active' : 'ghost'}`} title="Show editor markers" onClick={() => useStore.getState().updateSettings({ showMarkers: !settings.showMarkers })}>
          Markers
        </button>
        <button className={`btn small ${cellLighting ? 'active' : 'ghost'}`} title="Preview the cell's own lighting and light sources" onClick={() => setCellLighting(!cellLighting)}>
          <Icon name="light" size={13} /> Lighting
        </button>
        <span className="sep" />
        <button className={`btn small ${showNav ? 'active' : 'ghost'}`} title="Show navmesh" onClick={() => setShowNav(!showNav)}>
          <Icon name="navmesh" size={13} /> Navmesh
        </button>
        <GenerateNavmesh cell={cell} interior={info?.interior ?? true} />
        <button className={`btn small ${navEdit ? 'active' : 'ghost'}`} title="Edit navmesh triangles (Tab)" onClick={toggleNavEdit}>
          Edit
        </button>
        {navStatus === 'stale' && (
          <span className="chip warn" title="Objects that shape the navmesh moved, appeared or disappeared since it was generated. Generate again to update it." data-testid="nav-stale">
            ⚠ Navmesh out of date
          </span>
        )}
        <span className="sep" />
        <button className={`btn small ${tools ? 'active' : 'ghost'}`} title="World tools: paint, paths, lighting, clutter, rooms, doors" onClick={() => setTools(!tools)} data-testid="env-tools-toggle">
          <Icon name="wand" size={13} /> Tools
        </button>
        <span className="spacer" />
        <button className="btn small ghost" title="Create a new interior cell" onClick={() => setNewCell(true)}>
          <Icon name="plus" size={13} /> Cell
        </button>
        <button className={`btn small ${outliner ? 'active' : 'ghost'}`} title="Outliner" onClick={() => setOutliner(!outliner)}>
          <Icon name="records" size={13} />
        </button>
      </div>
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
        <div
          className="viewport-wrap"
          ref={host}
          data-testid="viewport"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-tes5-form') || e.dataTransfer.types.includes('application/x-tes5-mesh')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (!dropping) setDropping(true);
            }
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={place}
        >
          <div className="viewport-overlay viewport-mode">
            <div>
              {navEdit ? 'Navmesh edit mode' : 'Object mode'} · {ortho ? 'Orthographic' : 'Perspective'}
            </div>
            {status && <div className="modal-info">{status}</div>}
          </div>
          <div className="viewport-overlay viewport-hint">
            {navEdit ? (
              <>
                Click/drag select triangles · <span className="kbd">G</span> move · <span className="kbd">D</span> draw · <span className="kbd">X</span> delete · <span className="kbd">A</span> all · <span className="kbd">Tab</span> done
              </>
            ) : (
              <>
                <span className="kbd">G</span> move <span className="kbd">R</span> rotate <span className="kbd">S</span> scale (then <span className="kbd">X</span>
                <span className="kbd">Y</span>
                <span className="kbd">Z</span>, type a value) · <span className="kbd">Shift+D</span> duplicate · <span className="kbd">X</span> delete · <span className="kbd">MMB</span>/<span className="kbd">Alt+LMB</span> orbit ·{' '}
                <span className="kbd">Shift</span>+ pan · <span className="kbd">RMB</span>+<span className="kbd">WASD</span> fly · <span className="kbd">F</span> frame
              </>
            )}
          </div>
          {dropping && <div className="drop-hint">Drop to place it here</div>}
          {tools && !navEdit && <EnvTools cell={cell} interior={info?.interior ?? true} viewport={vpRef} handlers={toolHandlers} refs={refs ?? []} onClose={() => setTools(false)} />}
          {navEdit && <NavEditPanel count={navmeshes?.find((n) => n.formKey === navEdit)?.geometry.triangles.length ?? 0} selected={navSel} drawing={navDrawing} onDraw={() => vpRef.current?.setNavDraw(!vpRef.current.isNavDrawing)} onFlag={(flag, on) => void editNav((nav, sel) => setTriangleFlags(nav, sel, flag, on), 'Set navmesh flags')} onDelete={() => void editNav((nav, sel) => deleteTriangles(nav, sel), 'Delete navmesh triangles')} onDone={toggleNavEdit} />}
        </div>
        {outliner && <Outliner refs={refs ?? []} hiddenTick={hiddenTick} viewport={vpRef} />}
      </div>
      {newCell && <NewCellDialog onClose={() => setNewCell(false)} />}
    </div>
  );
}

function NoCell({ onNew, newCell, closeNew }: { onNew: () => void; newCell: boolean; closeNew: () => void }) {
  return (
    <div className="empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <Icon name="scene" size={36} />
      <div>Pick a cell in the Cells list on the left to open it here.</div>
      <button className="btn primary" onClick={onNew}>
        <Icon name="plus" /> New interior cell
      </button>
      {newCell && <NewCellDialog onClose={closeNew} />}
    </div>
  );
}

function NewCellDialog({ onClose }: { onClose: () => void }) {
  const [edid, setEdid] = useUniqueEditorId('MyNewInterior');
  const [name, setName] = useState('');
  return (
    <Modal
      title="New interior cell"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const key = await engine((c) => c.call('createInteriorCell', edid, name || undefined), { success: `Created ${edid}` });
              if (key) {
                useStore.getState().setCell(key);
                onClose();
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Editor ID">
        <TextInput value={edid} onCommit={setEdid} autoFocus mono />
      </Field>
      <Field label="Name">
        <TextInput value={name} onCommit={setName} placeholder="Shown in game when entering" />
      </Field>
      <p className="dim small">Lighting, ownership and the rest can be edited in the properties panel once it's created. Drag objects from the Objects or Assets tab to build it.</p>
    </Modal>
  );
}

function GenerateNavmesh({ cell, interior }: { cell: FormKey; interior: boolean }) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<'auto' | 'interior' | 'exterior' | 'detailed'>('auto');
  const run = async () => {
    setOpen(false);
    const res = await engine((c) => c.call('generateNavmesh', cell, { preset: preset === 'auto' ? undefined : preset }), { busy: 'Generating navmesh…' });
    if (!res) return;
    const s = useStore.getState();
    s.toast('success', `Navmesh: ${res.triangles} triangles, ${res.doors} door(s) linked${res.portals ? `, ${res.portals} edge(s) linked to neighbours` : ''}${res.usedRecast ? '' : ' (simple mode)'}`);
    for (const i of res.issues.slice(0, 4)) s.toast(i.severity === 'error' ? 'error' : 'warning', i.message);
  };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn small primary" title="Build a navmesh from the cell's geometry, link doors and neighbours" onClick={() => setOpen(!open)}>
        <Icon name="wand" size={13} /> Generate
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', top: 30, left: 0, zIndex: 40, width: 260 }}>
          <Field label="Preset">
            <Select
              value={preset}
              options={[
                { value: 'auto', label: interior ? 'Automatic (interior)' : 'Automatic (exterior)' },
                { value: 'interior', label: 'Interior' },
                { value: 'exterior', label: 'Exterior' },
                { value: 'detailed', label: 'Detailed (slower)' },
              ]}
              onChange={setPreset}
            />
          </Field>
          <p className="dim small" style={{ margin: '6px 0' }}>
            Replaces this plugin's navmesh in the cell. Doors are linked automatically.
          </p>
          <button className="btn primary small" onClick={run} data-testid="generate-navmesh">
            Generate navmesh
          </button>
        </div>
      )}
    </div>
  );
}

function NavEditPanel({ count, selected, drawing, onDraw, onFlag, onDelete, onDone }: { count: number; selected: number[]; drawing: boolean; onDraw: () => void; onFlag: (flag: number, on: boolean) => void; onDelete: () => void; onDone: () => void }) {
  return (
    <div className="card" style={{ position: 'absolute', right: 10, top: 40, width: 220, zIndex: 5 }}>
      <div className="card-title">Navmesh</div>
      <div className="dim small" style={{ marginBottom: 8 }}>
        {count} triangles · {selected.length} selected
      </div>
      <div className="col" style={{ gap: 4 }}>
        <button className={`btn small ${drawing ? 'active' : ''}`} onClick={onDraw} title="Click three points to add a triangle; keeps going as a strip. Snaps to existing vertices. (D)" data-testid="nav-draw">
          <Icon name="plus" size={12} /> {drawing ? 'Drawing… (Esc to stop)' : 'Draw triangles'}
        </button>
        <div className="dim small">Select triangles, then press G to move their vertices (X/Y/Z to lock an axis).</div>
        <button className="btn small" disabled={!selected.length} onClick={onDelete}>
          <Icon name="trash" size={12} /> Delete triangles
        </button>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn small grow" disabled={!selected.length} onClick={() => onFlag(NAV_FLAGS.preferred, true)}>
            Preferred
          </button>
          <button className="btn small ghost" disabled={!selected.length} onClick={() => onFlag(NAV_FLAGS.preferred, false)} title="Clear">
            ✕
          </button>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn small grow" disabled={!selected.length} onClick={() => onFlag(NAV_FLAGS.water, true)}>
            Water
          </button>
          <button className="btn small ghost" disabled={!selected.length} onClick={() => onFlag(NAV_FLAGS.water, false)} title="Clear">
            ✕
          </button>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn small grow" disabled={!selected.length} onClick={() => onFlag(NAV_FLAGS.noLarge, true)}>
            No large creatures
          </button>
          <button className="btn small ghost" disabled={!selected.length} onClick={() => onFlag(NAV_FLAGS.noLarge, false)} title="Clear">
            ✕
          </button>
        </div>
        <button className="btn small primary" onClick={onDone}>
          Done (Tab)
        </button>
      </div>
    </div>
  );
}

function Outliner({ refs, hiddenTick, viewport }: { refs: PlacedRef[]; hiddenTick: number; viewport: React.RefObject<Viewport | null> }) {
  const sel = useStore((s) => s.sceneSelection);
  const setSel = useStore((s) => s.setSceneSelection);
  const [q, setQ] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const activePlugin = useStore((s) => s.session.activePlugin);
  const list = useMemo(() => {
    const ql = q.toLowerCase();
    return refs
      .filter((r) => !r.deleted)
      .filter((r) => !onlyMine || r.source === activePlugin)
      .filter((r) => !ql || (r.editorId ?? '').toLowerCase().includes(ql) || (r.baseEditorId ?? '').toLowerCase().includes(ql) || (r.baseName ?? '').toLowerCase().includes(ql))
      .sort((a, b) => (a.baseEditorId ?? '').localeCompare(b.baseEditorId ?? '') || (a.editorId ?? '').localeCompare(b.editorId ?? ''));
  }, [refs, q, onlyMine, activePlugin]);
  const hidden = viewport.current?.hidden;
  void hiddenTick;
  return (
    <div className="panel" style={{ width: 250, flex: 'none', borderLeft: '1px solid var(--border)', background: 'var(--panel)' }} data-testid="outliner">
      <div className="panel-header">
        <span className="grow">Outliner</span>
        <span className="faint small">{list.length}</span>
      </div>
      <div className="searchbox col" style={{ gap: 4 }}>
        <input className="input" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Checkbox checked={onlyMine} onChange={setOnlyMine} label="Only my changes" />
      </div>
      <ul className="list scroll" style={{ flex: 1 }}>
        {list.slice(0, 1500).map((r) => {
          const isHidden = hidden?.has(r.formKey);
          return (
            <li
              key={r.formKey}
              className={`list-item ${sel.includes(r.formKey) ? 'selected' : ''} ${isHidden || r.disabled ? 'dim' : ''}`}
              onClick={(e) => setSel(e.shiftKey ? (sel.includes(r.formKey) ? sel.filter((k) => k !== r.formKey) : [...sel, r.formKey]) : [r.formKey])}
              onDoubleClick={() => viewport.current?.frame([r.formKey])}
              title={`${r.formKey}${r.base ? ` → ${r.base}` : ''} · from ${r.source}${r.disabled ? ' · initially disabled' : ''}`}
            >
              <span className="sig">{r.baseSig ?? r.sig}</span>
              <span className="name">{r.editorId ?? r.baseEditorId ?? r.formKey}</span>
              {r.source === activePlugin && <span className="chip accent">mine</span>}
              <button
                className="btn icon ghost"
                title={isHidden ? 'Show (viewport only)' : 'Hide (viewport only)'}
                onClick={(e) => {
                  e.stopPropagation();
                  viewport.current?.setHidden([r.formKey], !isHidden);
                }}
              >
                <Icon name={isHidden ? 'eyeOff' : 'eye'} size={12} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
