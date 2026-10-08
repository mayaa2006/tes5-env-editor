/**
 * World editing: the cell in a Blender-style 3D viewport, an outliner, drag &
 * drop placement from the object/asset browsers, and navmesh generation/editing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormKey, Navmesh } from '@tes5/esp';
import { addTriangle, buildGrid, deleteTriangles, setTriangleFlags } from '@tes5/navmesh';
import type { PlacedRef } from '@tes5/workspace';
import { Checkbox, Field, Icon, Menu, MenuItem, Modal, Select, useQuery } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { EnvTools, type ToolHandlers } from './EnvTools';
import { NewCellDialog, cellLabel, type NewCellKind } from './NewCellDialog';
import { SnapSettings } from './SnapSettings';
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
  const [newCell, setNewCell] = useState<NewCellKind | null>(null);
  const [ortho, setOrtho] = useState(false);
  const [dock, setDock] = useState<'outliner' | 'tools' | null>('outliner');
  const [generate, setGenerate] = useState(false);
  const [help, setHelp] = useState(false);
  const [snapOpen, setSnapOpen] = useState(false);
  const toolHandlers = useRef<ToolHandlers>({});
  const framedCell = useRef<string | undefined>(undefined);

  const { data: cells } = useQuery(() => client?.call('cells', {}), [client]);
  const info = cells?.find((c) => c.formKey === cell);
  // Tagged with their cell: while a new cell loads, the previous cell's list must not be framed as the new one.
  // Outdoors, the cells around the current one load too (like the CK), with their terrain.
  const radius = info && !info.interior ? (settings.surroundingCells ?? 1) : 0;
  const outdoorArea = !!info && !info.interior && radius > 0;
  const { data: areaFor } = useQuery(() => (cell && outdoorArea ? client?.call('area', cell, radius).then((a) => ({ cell, area: a })) : undefined), [cell, outdoorArea, radius]);
  const area = areaFor && areaFor.cell === cell ? areaFor.area : undefined;
  const { data: refsFor } = useQuery(() => (cell && info && !outdoorArea ? client?.call('references', cell).then((list) => ({ cell, list })) : undefined), [cell, !!info, outdoorArea]);
  const refs = outdoorArea ? area?.refs : refsFor && refsFor.cell === cell ? refsFor.list : undefined;
  const { data: lighting } = useQuery(() => (cell ? client?.call('cellLighting', cell) : undefined), [cell]);
  const { data: singleTerrain } = useQuery(() => (cell && info && !info.interior && !outdoorArea ? client?.call('terrain', cell) : undefined), [cell, info?.interior, outdoorArea]);
  const terrain = outdoorArea ? area?.terrain : singleTerrain ? [{ cell, ...singleTerrain }] : undefined;
  /** The loaded cell at a world position (objects dropped there go into it). */
  const cellAtPoint = (p: { x: number; y: number }) => {
    const gx = Math.floor(p.x / 4096);
    const gy = Math.floor(p.y / 4096);
    return area?.cells.find((c) => c.grid.x === gx && c.grid.y === gy)?.formKey;
  };
  const neighbour = (dx: number, dy: number) => (area && info?.grid ? area.cells.find((c) => c.grid.x === info.grid!.x + dx && c.grid.y === info.grid!.y + dy) : undefined);
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
  }, [client, !!cell]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === '?' && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) setHelp(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  // Terrain first: framing a cell with nothing placed in it yet uses its ground.
  useEffect(() => vpRef.current?.setTerrain(terrain ?? []), [terrain]);
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    vp.setRefs(refs ?? []);
    if (refs && cell && framedCell.current !== cell) {
      framedCell.current = cell;
      if (outdoorArea) vp.frame((refs as { formKey: FormKey; cell?: FormKey }[]).filter((r) => r.cell === cell).map((r) => r.formKey), { cell });
      else vp.frame();
    }
  }, [refs, cell]);
  useEffect(() => {
    if (info) vpRef.current?.setCellContext(info);
  }, [info?.formKey]);
  useEffect(() => vpRef.current?.setNavmeshes((navmeshes ?? []).map((n) => ({ key: n.formKey, nav: n.geometry, mine: n.source === session.activePlugin }))), [navmeshes, session.activePlugin]);
  useEffect(() => vpRef.current?.setSelection(sceneSelection), [sceneSelection, refs]);
  useEffect(() => vpRef.current?.setTool(tool), [tool]);
  useEffect(() => vpRef.current?.setSnapping(snap), [snap]);
  useEffect(() => vpRef.current?.setKitSnap(settings.kitSnap), [settings.kitSnap]);
  useEffect(() => vpRef.current?.setNavVisible(showNav), [showNav]);
  useEffect(() => vpRef.current?.setShowActors(settings.actorModels ?? true), [settings.actorModels]);
  useEffect(() => {
    vpRef.current?.setOptions({
      showMarkers: settings.showMarkers,
      showMarkerShapes: settings.showMarkerShapes ?? false,
      cellLighting,
      ambient: lighting?.ambient ? [lighting.ambient.r, lighting.ambient.g, lighting.ambient.b] : null,
      snap: { move: settings.snapMove, rotateDeg: settings.snapRotateDeg, scale: settings.snapScale },
    });
  }, [settings.showMarkers, settings.showMarkerShapes, settings.snapMove, settings.snapRotateDeg, settings.snapScale, cellLighting, lighting]);
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
        return c.call('placeReference', cellAtPoint(position) ?? cell, base, { position });
      },
      { busy: mesh ? 'Creating base object…' : undefined },
    );
    if (key) {
      useStore.getState().setSceneSelection([key]);
      useStore.getState().addLog('success', `Placed ${form ? form : mesh}`);
    }
  };

  if (!cell) return <NoCell onNew={setNewCell} newCell={newCell} closeNew={() => setNewCell(null)} />;

  const toolBtn = (t: Tool, icon: string, label: string, key: string) => (
    <button className={`btn small ${tool === t ? 'active' : 'ghost'}`} title={`${label} tool: drag the handles in the view. Or press ${key} for a quick ${label.toLowerCase()} without switching tools.`} onClick={() => setTool(t)} aria-pressed={tool === t}>
      <Icon name={icon} size={13} />
      <span className="hide-narrow tb-label">{label}</span>
    </button>
  );
  const openDock = (d: 'outliner' | 'tools') => setDock(dock === d ? null : d);
  const loadingCell = !refs;

  return (
    <div className="col scene-main" style={{ flex: 1, minHeight: 0 }}>
      <div className="viewport-toolbar">
        <strong className="ellipsis" style={{ maxWidth: 180 }} title={`${info ? cellLabel(info) : cell}${info?.name ? ` “${info.name}”` : ''} · ${cell}`}>
          {info ? cellLabel(info) : cell}
        </strong>
        {info && !info.interior && info.grid && <span className="chip" title="Grid position of the current cell (new objects are placed in the cell under the cursor)">{`${info.grid.x}, ${info.grid.y}`}</span>}
        {outdoorArea && (
          <span className="row" style={{ gap: 0 }} data-testid="cell-steps">
            {(
              [
                ['W', -1, 0, 'west'],
                ['N', 0, 1, 'north'],
                ['S', 0, -1, 'south'],
                ['E', 1, 0, 'east'],
              ] as const
            ).map(([l, dx, dy, dir]) => {
              const n = neighbour(dx, dy);
              if (!n && area && info?.grid && info.worldspace) {
                const at = { x: info.grid.x + dx, y: info.grid.y + dy };
                return (
                  <button
                    key={l}
                    className="btn small ghost"
                    style={{ borderStyle: 'dashed' }}
                    data-testid={`cell-step-${dir}`}
                    title={`No cell to the ${dir} yet: click to make one at ${at.x}, ${at.y} and go there. Its ground meets this one. Undo removes it.`}
                    onClick={async () => {
                      const key = await engine((c) => c.call('createExteriorCell', info.worldspace!, at, {}), { success: `Made a new cell at ${at.x}, ${at.y}` });
                      if (key) useStore.getState().setCell(key);
                    }}
                  >
                    {l}+
                  </button>
                );
              }
              return (
                <button key={l} className="btn small ghost" disabled={!n} data-testid={`cell-step-${dir}`} title={n ? `Make the cell to the ${dir} (${n.editorId ?? `${n.grid.x}, ${n.grid.y}`}) the current one` : `No cell to the ${dir} in this worldspace`} onClick={() => n && useStore.getState().setCell(n.formKey)}>
                  {l}
                </button>
              );
            })}
          </span>
        )}
        <span className="sep" />
        {toolBtn('select', 'cube', 'Select', 'click')}
        {toolBtn('move', 'route', 'Move', 'G')}
        {toolBtn('rotate', 'redo', 'Rotate', 'R')}
        {toolBtn('scale', 'frame', 'Scale', 'S')}
        <span className="sep" />
        <button className={`btn small ${snap ? 'active' : 'ghost'}`} aria-pressed={snap} title={`Grid snapping is ${snap ? 'on' : 'off'}: moves in steps of ${settings.snapMove} units, turns in ${settings.snapRotateDeg}° steps. Hold Ctrl while transforming to flip it. Step sizes: View → Snapping settings.`} onClick={() => setSnap(!snap)}>
          <Icon name="magnet" size={13} /> <span className="tb-label">Grid</span>
        </button>
        <button
          className={`btn small ${settings.kitSnap ? 'active' : 'ghost'}`}
          title={`Kit snapping is ${settings.kitSnap ? 'on' : 'off'}: while moving (G), edges snap flush to nearby pieces such as walls and floors. Hold Alt while moving to skip it once.`}
          aria-pressed={settings.kitSnap}
          onClick={() => useStore.getState().updateSettings({ kitSnap: !settings.kitSnap })}
          data-testid="kit-snap"
        >
          <Icon name="grid" size={13} /> <span className="tb-label">Kit</span>
        </button>
        <span className="sep" />
        <Menu label={<><Icon name="eye" size={13} /> <span className="tb-label">View</span></>} title="Camera angles and what's shown" testId="view-menu">
          {(close) => (
            <>
              <div className="menu-label">Camera</div>
              <MenuItem hint="Num 7" onClick={() => (vpRef.current?.view('top'), setOrtho(true), close())}>
                Top
              </MenuItem>
              <MenuItem hint="Num 1" onClick={() => (vpRef.current?.view('front'), setOrtho(true), close())}>
                Front
              </MenuItem>
              <MenuItem hint="Num 3" onClick={() => (vpRef.current?.view('right'), setOrtho(true), close())}>
                Right
              </MenuItem>
              <MenuItem hint="Num 5" checked={ortho} onClick={() => (setOrtho(vpRef.current?.toggleOrtho() ?? false), close())}>
                Orthographic (no perspective)
              </MenuItem>
              <MenuItem hint="Home" onClick={() => (vpRef.current?.frame(), close())}>
                Frame everything
              </MenuItem>
              <MenuItem hint="F" disabled={!sceneSelection.length} onClick={() => (vpRef.current?.frame(sceneSelection), close())}>
                Frame the selection
              </MenuItem>
              <div className="menu-sep" />
              <div className="menu-label">Show</div>
              <MenuItem checked={settings.showMarkers} onClick={() => useStore.getState().updateSettings({ showMarkers: !settings.showMarkers })}>
                Editor markers
              </MenuItem>
              <MenuItem
                checked={settings.showMarkerShapes ?? false}
                disabled={!settings.showMarkers}
                title="The outlines some furniture, perches and props carry for the editor (where to lean, sit or land). The game never shows them."
                onClick={() => useStore.getState().updateSettings({ showMarkerShapes: !(settings.showMarkerShapes ?? false) })}
              >
                Marker shapes on furniture
              </MenuItem>
              <MenuItem checked={cellLighting} onClick={() => setCellLighting(!cellLighting)} title="Preview the cell's own ambient light and light sources">
                Cell lighting preview
              </MenuItem>
              <MenuItem checked={showNav} onClick={() => setShowNav(!showNav)}>
                Navmesh
              </MenuItem>
              <MenuItem checked={settings.actorModels ?? true} title="Draw characters with their body, clothes and head in their rest pose. Off: simple capsules (faster with many characters)." onClick={() => useStore.getState().updateSettings({ actorModels: !(settings.actorModels ?? true) })}>
                Characters as people
              </MenuItem>
              <div className="menu-sep" />
              <div className="menu-label">Outdoors, also load</div>
              {[
                [0, 'Just this cell'],
                [1, 'The cells around it (3×3)'],
                [2, 'Two rings around it (5×5)'],
              ].map(([n, label]) => (
                <MenuItem key={n} checked={(settings.surroundingCells ?? 1) === n} title="Surrounding cells show their objects and terrain and can be edited too; more cells take longer to load." onClick={() => useStore.getState().updateSettings({ surroundingCells: n as number })}>
                  {label as string}
                </MenuItem>
              ))}
              <div className="menu-sep" />
              <MenuItem onClick={() => (setSnapOpen(true), close())}>Snapping settings…</MenuItem>
              <MenuItem hint="?" onClick={() => (setHelp(true), close())}>
                Keyboard and mouse shortcuts
              </MenuItem>
            </>
          )}
        </Menu>
        <Menu label={<><Icon name="navmesh" size={13} /> <span className="tb-label">Navmesh</span></>} title="Generate or edit this cell's navmesh" active={!!navEdit} testId="navmesh-menu">
          {(close) => (
            <>
              <MenuItem onClick={() => (setGenerate(true), close())}>Generate navmesh…</MenuItem>
              <MenuItem hint="Tab" checked={!!navEdit} onClick={() => (toggleNavEdit(), close())}>
                Edit triangles by hand
              </MenuItem>
              <MenuItem checked={showNav} onClick={() => setShowNav(!showNav)}>
                Show navmesh
              </MenuItem>
            </>
          )}
        </Menu>
        {navStatus === 'stale' && (
          <button className="btn small warn" title="Objects that shape the navmesh moved, appeared or disappeared since it was generated. Click to generate it again." onClick={() => setGenerate(true)} data-testid="nav-stale">
            <Icon name="warn" size={12} /> Navmesh out of date
          </button>
        )}
        <span className="spacer" />
        <button className={`btn small ${dock === 'tools' ? 'active' : 'ghost'}`} title="World tools: paint plants and clutter, lay paths, light candles, dress rooms, build rooms, link doors" onClick={() => openDock('tools')} aria-pressed={dock === 'tools'} data-testid="env-tools-toggle">
          <Icon name="wand" size={13} /> <span className="tb-label">Tools</span>
        </button>
        <button className={`btn small ${dock === 'outliner' ? 'active' : 'ghost'}`} title="Outliner: everything placed in this cell" onClick={() => openDock('outliner')} aria-pressed={dock === 'outliner'} data-testid="outliner-toggle">
          <Icon name="records" size={13} />
          <span className="hide-narrow tb-label">Outliner</span>
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
          {loadingCell && <div className="viewport-loading">Loading {info?.editorId ?? 'cell'}…</div>}
          <div className="viewport-overlay viewport-hint">
            {navEdit ? (
              <>
                Click/drag to select triangles · <span className="kbd">G</span> move · <span className="kbd">D</span> draw · <span className="kbd">X</span> delete · <span className="kbd">Tab</span> done
              </>
            ) : (
              <>
                <span className="kbd">G</span> move · <span className="kbd">R</span> rotate · <span className="kbd">S</span> scale · <span className="kbd">MMB</span> orbit · <span className="kbd">Shift</span>+<span className="kbd">MMB</span> pan · <span className="kbd">F</span> frame
              </>
            )}
            <button className="btn small ghost hint-more" onClick={() => setHelp(true)} title="All keyboard and mouse shortcuts (?)">
              All shortcuts
            </button>
          </div>
          {dropping && <div className="drop-hint">Drop to place it here</div>}
          {navEdit && <NavEditPanel count={navmeshes?.find((n) => n.formKey === navEdit)?.geometry.triangles.length ?? 0} selected={navSel} drawing={navDrawing} onDraw={() => vpRef.current?.setNavDraw(!vpRef.current.isNavDrawing)} onFlag={(flag, on) => void editNav((nav, sel) => setTriangleFlags(nav, sel, flag, on), 'Set navmesh flags')} onDelete={() => void editNav((nav, sel) => deleteTriangles(nav, sel), 'Delete navmesh triangles')} onDone={toggleNavEdit} />}
        </div>
        {dock && (
          <div className="dock" data-testid="dock">
            <div className="dock-tabs" role="tablist">
              <button role="tab" aria-selected={dock === 'outliner'} className={`dock-tab ${dock === 'outliner' ? 'active' : ''}`} onClick={() => setDock('outliner')}>
                Outliner
              </button>
              <button role="tab" aria-selected={dock === 'tools'} className={`dock-tab ${dock === 'tools' ? 'active' : ''}`} onClick={() => setDock('tools')}>
                World tools
              </button>
              <span className="spacer" />
              <button className="btn icon ghost" title="Hide this panel" onClick={() => setDock(null)}>
                <Icon name="close" size={12} />
              </button>
            </div>
            {dock === 'outliner' ? (
              <Outliner refs={refs ?? []} hiddenTick={hiddenTick} viewport={vpRef} area={area ? { cells: area.cells.length, current: cell } : undefined} />
            ) : navEdit ? (
              <div className="empty">Leave navmesh edit mode (Tab) to use the world tools.</div>
            ) : (
              <EnvTools cell={cell} interior={info?.interior ?? true} viewport={vpRef} handlers={toolHandlers} refs={refs ?? []} />
            )}
          </div>
        )}
      </div>
      {generate && <GenerateNavmeshDialog cell={cell} interior={info?.interior ?? true} onClose={() => setGenerate(false)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {snapOpen && (
        <Modal title="Snapping" onClose={() => setSnapOpen(false)} width={460} footer={<button className="btn primary" onClick={() => setSnapOpen(false)}>Done</button>}>
          <SnapSettings />
        </Modal>
      )}
      {newCell && <NewCellDialog kind={newCell} onClose={() => setNewCell(null)} />}
    </div>
  );
}

function NoCell({ onNew, newCell, closeNew }: { onNew: (k: NewCellKind) => void; newCell: NewCellKind | null; closeNew: () => void }) {
  return (
    <div className="empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <Icon name="scene" size={36} />
      <div>Pick a cell in the Cells list on the left to open it here.</div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" onClick={() => onNew('interior')} title="A cell on its own, like a house, cave or dungeon">
          <Icon name="plus" /> New interior cell
        </button>
        <button className="btn" onClick={() => onNew('world')} title="A new outdoor world with a square of flat ground to start from" data-testid="no-cell-new-worldspace">
          <Icon name="plus" /> New worldspace
        </button>
      </div>
      {newCell && <NewCellDialog kind={newCell} onClose={closeNew} />}
    </div>
  );
}

function GenerateNavmeshDialog({ cell, interior, onClose }: { cell: FormKey; interior: boolean; onClose: () => void }) {
  const [preset, setPreset] = useState<'auto' | 'interior' | 'exterior' | 'detailed'>('auto');
  const run = async () => {
    onClose();
    const res = await engine((c) => c.call('generateNavmesh', cell, { preset: preset === 'auto' ? undefined : preset }), { busy: 'Generating navmesh…' });
    if (!res) return;
    const s = useStore.getState();
    s.toast('success', `Navmesh: ${res.triangles} triangles, ${res.doors} door(s) linked${res.portals ? `, ${res.portals} edge(s) linked to neighbours` : ''}${res.usedRecast ? '' : ' (simple mode)'}`);
    for (const i of res.issues.slice(0, 4)) s.toast(i.severity === 'error' ? 'error' : 'warning', i.message);
  };
  return (
    <Modal
      title="Generate navmesh"
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={run} data-testid="generate-navmesh">
            <Icon name="wand" size={12} /> Generate
          </button>
        </>
      }
    >
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
      <p className="dim small">Builds the walkable area from everything placed in the cell (and the terrain outdoors), links doors and neighbouring cells, and replaces this plugin's navmesh here. Undo puts the old one back.</p>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Click / Shift+click', 'Select / add to selection'],
  ['B, or drag on empty space', 'Box select'],
  ['A / Alt+A', 'Select all / none'],
  ['G, R, S', 'Move, rotate, scale (then X/Y/Z to lock an axis, type a number, Enter to confirm, Esc or right-click to cancel)'],
  ['Ctrl (while transforming)', 'Flip grid snapping'],
  ['Alt (while moving)', 'Skip kit snapping'],
  ['Shift+D', 'Duplicate and move'],
  ['X / Delete', 'Delete (master objects are disabled instead, which is safe)'],
  ['H / Shift+H / Alt+H', 'Hide selected / hide others / show all (view only)'],
  ['F / Home', 'Frame selection / everything'],
  ['Middle mouse, or Alt+left mouse', 'Orbit'],
  ['Shift+middle mouse', 'Pan'],
  ['Wheel', 'Zoom'],
  ['Right mouse + W A S D Q E', 'Fly (wheel changes speed)'],
  ['Numpad 1 / 3 / 7 / 5', 'Front / right / top view, perspective on/off (Ctrl for the opposite side)'],
  ['Tab', 'Navmesh edit mode'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+S', 'Save'],
];

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="3D view shortcuts" onClose={onClose} width={620} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <table className="grid">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k}>
              <td className="nowrap">
                <span className="kbd">{k}</span>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim small">The controls follow Blender, so Blender habits work here.</p>
    </Modal>
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

function Outliner({ refs, hiddenTick, viewport, area }: { refs: (PlacedRef & { cell?: FormKey })[]; hiddenTick: number; viewport: React.RefObject<Viewport | null>; area?: { cells: number; current: FormKey } }) {
  const [onlyCurrent, setOnlyCurrent] = useState(true);
  const sel = useStore((s) => s.sceneSelection);
  const setSel = useStore((s) => s.setSceneSelection);
  const [q, setQ] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const activePlugin = useStore((s) => s.session.activePlugin);
  const list = useMemo(() => {
    const ql = q.toLowerCase();
    return refs
      .filter((r) => !r.deleted)
      .filter((r) => !area || !onlyCurrent || r.cell === area.current)
      .filter((r) => !onlyMine || r.source === activePlugin)
      .filter((r) => !ql || (r.editorId ?? '').toLowerCase().includes(ql) || (r.baseEditorId ?? '').toLowerCase().includes(ql) || (r.baseName ?? '').toLowerCase().includes(ql))
      .sort((a, b) => (a.baseEditorId ?? '').localeCompare(b.baseEditorId ?? '') || (a.editorId ?? '').localeCompare(b.editorId ?? ''));
  }, [refs, q, onlyMine, activePlugin, onlyCurrent, area?.current]);
  const hidden = viewport.current?.hidden;
  void hiddenTick;
  return (
    <div className="panel" data-testid="outliner">
      <div className="panel-header">
        <span className="grow">{area && !onlyCurrent ? `In view (${area.cells} cells)` : 'In this cell'}</span>
        <span className="faint small">{list.length}</span>
      </div>
      <div className="searchbox col" style={{ gap: 4 }}>
        <input className="input" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Checkbox checked={onlyMine} onChange={setOnlyMine} label="Only my changes" />
        {area && <Checkbox checked={onlyCurrent} onChange={setOnlyCurrent} label="Only the current cell" help="Untick to list everything loaded around it too (persistent objects such as doors and characters count where they stand)." />}
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
              <span className="name grow">{r.editorId ?? r.baseEditorId ?? r.formKey}</span>
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
