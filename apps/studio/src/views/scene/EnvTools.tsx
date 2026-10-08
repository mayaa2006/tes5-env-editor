/**
 * Environment tools panel: drop/array, paint (scatter brush), paths, lighting,
 * room clutter, a room builder and linked doors. The 3D-view interactions
 * (brush strokes, path points, point picks) come in through `handlers`.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import type { CellMood, PlacedRef } from '@tes5/workspace';
import { Checkbox, DragNumber, Field, FormPicker, Icon, Select, Slider, useQuery, useSummaries } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import type { Viewport } from './viewport';

type Vec = { x: number; y: number; z: number };
export interface ToolHandlers {
  brushStroke?: (points: Vec[], erase: boolean) => void;
  brushRadius?: (r: number) => void;
  pathDone?: (points: Vec[]) => void;
  cancelled?: () => void;
}

type Tab = 'place' | 'terrain' | 'paint' | 'path' | 'light' | 'clutter' | 'room' | 'doors';
const TABS: { id: Tab; label: string; icon: string; title: string }[] = [
  { id: 'place', label: 'Place', icon: 'cube', title: 'Drop to surface, arrays' },
  { id: 'terrain', label: 'Terrain', icon: 'scene', title: 'Shape the ground outdoors (raise, lower, smooth, flatten) and paint its textures' },
  { id: 'paint', label: 'Paint', icon: 'palette', title: 'Scatter brush for plants, rocks and clutter' },
  { id: 'path', label: 'Path', icon: 'route', title: 'Roads, fences and rows of objects along a line' },
  { id: 'light', label: 'Light', icon: 'light', title: 'Lights for candles and fires, cell mood' },
  { id: 'clutter', label: 'Clutter', icon: 'sliders', title: 'Dress a room with themed items' },
  { id: 'room', label: 'Room', icon: 'grid', title: 'Build a room from kit pieces' },
  { id: 'doors', label: 'Doors', icon: 'link', title: 'Linked load doors' },
];

const PLACEABLE = ['STAT', 'MSTT', 'SCOL', 'TREE', 'FLOR', 'MISC', 'FURN', 'CONT', 'ACTI', 'LIGH', 'BOOK', 'ALCH', 'INGR'];
const KIT = ['STAT', 'SCOL', 'MSTT'];
const DEG = Math.PI / 180;

const select = (keys: FormKey[] | undefined) => keys?.length && useStore.getState().setSceneSelection(keys);
const toast = (kind: 'success' | 'info' | 'warning', text: string) => useStore.getState().toast(kind, text);

export function EnvTools({ cell, interior, viewport, handlers, refs }: { cell: FormKey; interior: boolean; viewport: React.RefObject<Viewport | null>; handlers: React.RefObject<ToolHandlers>; refs: PlacedRef[] }) {
  const [tab, setTab] = useState<Tab>('place');
  // Leaving a tab (or the panel) stops its view mode.
  useEffect(
    () => () => {
      viewport.current?.setBrush(null);
      viewport.current?.setPathDraw(false);
    },
    [tab, viewport],
  );
  return (
    <div className="env-tools" data-testid="env-tools">
      <div className="env-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`btn small ${tab === t.id ? 'active' : 'ghost'}`} title={t.title} onClick={() => setTab(t.id)} data-testid={`env-tab-${t.id}`}>
            <Icon name={t.icon} size={12} /> {t.label}
          </button>
        ))}
      </div>
      <div className="env-body">
        {tab === 'place' && <PlaceTab />}
        {tab === 'terrain' && <TerrainTab cell={cell} interior={interior} viewport={viewport} handlers={handlers} refs={refs} />}
        {tab === 'paint' && <PaintTab cell={cell} viewport={viewport} handlers={handlers} />}
        {tab === 'path' && <PathTab cell={cell} viewport={viewport} handlers={handlers} />}
        {tab === 'light' && <LightTab cell={cell} interior={interior} />}
        {tab === 'clutter' && <ClutterTab cell={cell} />}
        {tab === 'room' && <RoomTab cell={cell} viewport={viewport} handlers={handlers} />}
        {tab === 'doors' && <DoorsTab refs={refs} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ place

function PlaceTab() {
  const sel = useStore((s) => s.sceneSelection);
  const [align, setAlign] = useState(false);
  const [count, setCount] = useState(4);
  const [offset, setOffset] = useState<Vec>({ x: 128, y: 0, z: 0 });
  const [turn, setTurn] = useState(0);
  const [drop, setDrop] = useState(true);
  const none = !sel.length;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="dim small">{none ? 'Select objects in the view first.' : `${sel.length} selected`}</div>
      <div className="row" style={{ gap: 6 }}>
        <button
          className="btn small primary"
          disabled={none}
          data-testid="env-drop"
          onClick={async () => {
            const r = await engine((c) => c.call('envDrop', sel, align));
            if (r) toast(r.missed.length ? 'warning' : 'success', `Dropped ${r.moved.length}${r.missed.length ? `; nothing below ${r.missed.length}` : ''}`);
          }}
        >
          Drop to surface
        </button>
        <Checkbox checked={align} onChange={setAlign} label="Tilt to slope" help="Lean each object to match the surface under it (good for rocks on hills; leave off for furniture)." />
      </div>
      <h4 className="env-h">Array</h4>
      <Field label="Copies">
        <DragNumber value={count} min={1} max={500} precision={0} onCommit={setCount} />
      </Field>
      <Field label="Step X Y Z">
        <div className="row" style={{ gap: 3 }}>
          {(['x', 'y', 'z'] as const).map((a) => (
            <DragNumber key={a} value={offset[a]} precision={1} onCommit={(v) => setOffset({ ...offset, [a]: v })} />
          ))}
        </div>
      </Field>
      <Field label="Turn each °">
        <DragNumber value={turn} precision={1} onCommit={setTurn} />
      </Field>
      <Checkbox checked={drop} onChange={setDrop} label="Rest each copy on the surface" help="Each copy is dropped onto whatever is below it, so a row of fence posts follows a hill." />
      <button
        className="btn small"
        disabled={none}
        data-testid="env-array"
        onClick={async () => {
          const r = await engine((c) => c.call('envArray', sel, { count, offset, rotateZ: turn * DEG, dropToSurface: drop }), { success: `Made ${count} cop${count === 1 ? 'y' : 'ies'}` });
          select(r);
        }}
      >
        <Icon name="copy" size={12} /> Make array
      </button>
      <p className="dim small" style={{ margin: 0 }}>
        Tip: with <b>Kit</b> snapping on (the toolbar button), press G and slide a wall or floor piece next to another: their edges meet exactly. Hold Alt to move freely.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ terrain

type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten';
type TerrainMode = SculptMode | 'paint';
const SCULPT_MODES: { id: TerrainMode; label: string; help: string }[] = [
  { id: 'raise', label: 'Raise', help: 'Push the ground up under the brush (Ctrl+drag lowers).' },
  { id: 'lower', label: 'Lower', help: 'Dig the ground down under the brush (Ctrl+drag raises).' },
  { id: 'smooth', label: 'Smooth', help: 'Even out bumps and sharp edges.' },
  { id: 'flatten', label: 'Flatten', help: 'Level the ground to the height where the stroke starts: for building plots, roads and camps.' },
  { id: 'paint', label: 'Paint', help: 'Paint a ground texture (grass, dirt, rock, snow…), blended in layers like the Creation Kit does.' },
];

const GROUND_HINT = 'Ground: drag to paint the texture · Ctrl+drag to fade it · [ ] brush size · Esc to stop';

/** Landscape textures to paint with, each with a colour swatch. */
/** Landscape textures to pick from, with a colour swatch each. With `noneLabel`, "none" is a choice (and the default). */
export function GroundTexturePicker({ value, onChange, noneLabel }: { value: FormKey | null; onChange: (k: FormKey | null) => void; noneLabel?: string }) {
  const [list, setList] = useState<{ formKey: FormKey; editorId?: string; name?: string }[]>([]);
  const [swatches, setSwatches] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  useEffect(() => {
    void engine((c) => c.call('landscapeTextures'), { refreshSession: false }).then((l) => {
      if (!l) return;
      setList(l);
      if (!value && l[0] && !noneLabel) onChange(l[0].formKey);
    });
  }, []);
  const shown = list.filter((t) => !q || `${t.editorId ?? ''} ${t.name ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  useEffect(() => {
    for (const t of shown.slice(0, 60))
      if (!(t.formKey in swatches))
        void engine((c) => c.call('landscapeSwatch', t.formKey), { refreshSession: false }).then((rgb) => setSwatches((s) => ({ ...s, [t.formKey]: rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : 'transparent' })));
  }, [shown.map((t) => t.formKey).join()]);
  if (!list.length) return <div className="dim small">No landscape textures in your load order{noneLabel ? '; the game\'s default ground is used.' : '.'}</div>;
  return (
    <div className="col" style={{ gap: 4 }}>
      <input className="input" placeholder="Find a ground texture…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="ground-texture-search" />
      <div className="list" style={{ maxHeight: 180, overflow: 'auto' }} data-testid="ground-texture-list">
        {noneLabel && !q && (
          <div className={`list-item ${!value ? 'selected' : ''}`} onClick={() => onChange(null)} data-testid="ground-texture-none">
            <span style={{ width: 14, height: 14, borderRadius: 3, background: 'var(--bg-2)', border: '1px dashed var(--border)', flex: 'none' }} />
            <span className="grow dim">{noneLabel}</span>
          </div>
        )}
        {shown.map((t) => (
          <div key={t.formKey} className={`list-item ${value === t.formKey ? 'selected' : ''}`} onClick={() => onChange(t.formKey)} title={t.formKey} data-testid="ground-texture">
            <span style={{ width: 14, height: 14, borderRadius: 3, background: swatches[t.formKey] ?? 'var(--bg-2)', border: '1px solid var(--border)', flex: 'none' }} />
            <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name ?? t.editorId ?? t.formKey}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TerrainTab({ cell, interior, viewport, handlers, refs }: { cell: FormKey; interior: boolean; viewport: React.RefObject<Viewport | null>; handlers: React.RefObject<ToolHandlers>; refs: PlacedRef[] }) {
  const [mode, setMode] = useState<TerrainMode>('raise');
  const [radius, setRadius] = useState(512);
  const [strength, setStrength] = useState(0.5);
  const [texture, setTexture] = useState<FormKey | null>(null);
  const [on, setOn] = useState(false);
  const [lastStroke, setLastStroke] = useState<{ points: Vec[]; radius: number } | null>(null);
  const live = useRef({ mode, radius, strength, texture });
  live.current = { mode, radius, strength, texture };

  useEffect(() => {
    handlers.current.brushStroke = async (points, erase) => {
      const o = live.current;
      if (o.mode === 'paint') {
        if (!o.texture) return toast('info', 'Pick a ground texture to paint with first.');
        const r = await engine((c) => c.call('paintGroundTexture', cell, points, { texture: o.texture!, radius: o.radius, strength: o.strength, erase }));
        if (r?.cells.length) viewport.current?.refreshGround(r.cells);
        else if (r) toast('info', 'No terrain under the brush (only loaded outdoor cells can be painted).');
        if (r?.full) toast('warning', 'Some of this ground already has six painted textures, the most it can hold. Paint over one of them (or paint its base texture) to make room.');
        return;
      }
      const m: SculptMode = erase && o.mode === 'raise' ? 'lower' : erase && o.mode === 'lower' ? 'raise' : o.mode;
      const changed = await engine((c) => c.call('sculptTerrain', cell, points, { mode: m, radius: o.radius, strength: o.strength }));
      if (changed?.length) setLastStroke({ points, radius: o.radius });
      else if (changed) toast('info', 'No terrain under the brush (only loaded outdoor cells can be sculpted).');
    };
    handlers.current.brushRadius = setRadius;
    handlers.current.cancelled = () => setOn(false);
    return () => {
      handlers.current.brushStroke = undefined;
      handlers.current.brushRadius = undefined;
      handlers.current.cancelled = undefined;
    };
  }, [cell, handlers]);
  useEffect(() => viewport.current?.setBrushRadius(radius), [radius, viewport]);
  useEffect(() => {
    if (mode !== 'paint') viewport.current?.setSculpt({ mode, strength });
  }, [mode, strength, viewport]);
  // Switching between painting and sculpting while the brush is on swaps the brush.
  useEffect(() => {
    if (on) viewport.current?.setBrush(mode === 'paint' ? { radius, hint: GROUND_HINT } : { radius, sculpt: { mode, strength } });
  }, [mode === 'paint']);

  if (interior) return <div className="dim small">Terrain only exists outdoors. Open an outdoor cell to sculpt or paint it.</div>;
  const toggle = () => {
    const next = !on;
    viewport.current?.setBrush(next ? (mode === 'paint' ? { radius, hint: GROUND_HINT } : { radius, sculpt: { mode, strength } }) : null);
    setOn(next);
  };
  // Objects standing in the last stroke's area may now float or be buried.
  const nearStroke = lastStroke
    ? refs.filter((r) => !r.marker && !r.deleted && lastStroke.points.some((p) => Math.hypot(r.transform.position.x - p.x, r.transform.position.y - p.y) < lastStroke.radius)).map((r) => r.formKey)
    : [];
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 4 }}>
        {SCULPT_MODES.map((m) => (
          <button key={m.id} className={`btn small ${mode === m.id ? 'active' : 'ghost'}`} title={m.help} aria-pressed={mode === m.id} onClick={() => setMode(m.id)} data-testid={`sculpt-${m.id}`}>
            {m.label}
          </button>
        ))}
      </div>
      <Field label="Brush size" title="Radius in game units (a cell is 4096 across). [ and ] change it while sculpting.">
        <DragNumber value={radius} min={128} max={8192} precision={0} onCommit={setRadius} suffix="u" />
      </Field>
      {mode === 'paint' && (
        <div className="col" style={{ gap: 4 }} title="The ground texture to paint. Painting a quarter-cell's base texture paints over the layers on top of it.">
          <span className="small dim">Ground texture</span>
          <GroundTexturePicker value={texture} onChange={setTexture} />
        </div>
      )}
      <Field label="Strength" title={mode === 'paint' ? 'How strongly each pass covers what was there (1 = fully at the brush centre).' : 'How much each pass of the brush changes the ground.'}>
        <Slider value={strength} min={0.05} max={1} step={0.05} onCommit={setStrength} />
      </Field>
      <button className={`btn small ${on ? 'active' : 'primary'}`} onClick={toggle} data-testid="sculpt-toggle" title="Then drag over the ground in the view. Each stroke is one undo step.">
        {on ? (mode === 'paint' ? 'Stop painting' : 'Stop sculpting') : mode === 'paint' ? 'Start painting' : 'Start sculpting'}
      </button>
      {mode === 'paint' && <p className="dim small" style={{ margin: 0 }}>Each quarter of a cell holds its base texture plus up to six painted ones, as in the game. Distant terrain (LOD) keeps the old look until LOD is rebuilt.</p>}
      {nearStroke.length > 0 && (
        <div className="card small" style={{ padding: 8 }}>
          {nearStroke.length} object{nearStroke.length === 1 ? '' : 's'} stood where you sculpted and may now float or sink.
          <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
            <button
              className="btn small"
              onClick={async () => {
                const r = await engine((c) => c.call('envDrop', nearStroke, false));
                if (r) toast('success', `Dropped ${r.moved.length} onto the new ground`);
                setLastStroke(null);
              }}
              title="Move each of them straight down (or up) onto the ground. Ctrl+Z undoes it."
            >
              Put them on the ground
            </button>
            <button className="btn small ghost" onClick={() => useStore.getState().setSceneSelection(nearStroke)}>
              Select them
            </button>
          </div>
        </div>
      )}
      <p className="dim small" style={{ margin: 0 }}>
        Edges between cells stay joined. Characters walk on the navmesh, not the ground: after big changes, generate it again (Navmesh menu). Navmeshes made here show as out of date automatically.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ paint

function PaintTab({ cell, viewport, handlers }: { cell: FormKey; viewport: React.RefObject<Viewport | null>; handlers: React.RefObject<ToolHandlers> }) {
  const [items, setItems] = useState<{ base: FormKey; weight: number }[]>([]);
  const [radius, setRadius] = useState(256);
  const [density, setDensity] = useState(12);
  const [scale, setScale] = useState<[number, number]>([0.8, 1.2]);
  const [align, setAlign] = useState(0.6);
  const [maxSlope, setMaxSlope] = useState(40);
  const [sink, setSink] = useState(0);
  const [terrainOnly, setTerrainOnly] = useState(false);
  const [painting, setPainting] = useState(false);
  const names = useSummaries(items.map((i) => i.base));
  const live = useRef({ items, radius, density, scale, align, maxSlope, sink, terrainOnly });
  live.current = { items, radius, density, scale, align, maxSlope, sink, terrainOnly };

  useEffect(() => {
    handlers.current.brushStroke = async (points, erase) => {
      const o = live.current;
      if (!o.items.length) return toast('info', 'Add objects to the palette first');
      if (erase) {
        const n = await engine((c) => c.call('envErase', cell, points, o.radius, o.items.map((i) => i.base)));
        if (n !== undefined) toast('success', n ? `Erased ${n}` : 'Nothing from the palette here');
        return;
      }
      const keys = await engine((c) =>
        c.call('envScatter', cell, { items: o.items, center: points[0]!, centers: points, radius: o.radius, density: o.density, scale: o.scale, alignToSlope: o.align, maxSlope: o.maxSlope, sink: o.sink, terrainOnly: o.terrainOnly, seed: Math.floor(Math.random() * 2 ** 31) }),
      );
      if (keys) toast(keys.length ? 'success' : 'info', keys.length ? `Painted ${keys.length}` : 'Nothing placed (too steep, too crowded or no surface)');
    };
    handlers.current.brushRadius = setRadius;
    handlers.current.cancelled = () => setPainting(false);
    return () => {
      handlers.current.brushStroke = undefined;
      handlers.current.brushRadius = undefined;
      handlers.current.cancelled = undefined;
    };
  }, [cell, handlers]);
  useEffect(() => viewport.current?.setBrushRadius(radius), [radius, viewport]);

  const toggle = () => {
    const on = !painting;
    if (on && !items.length) return toast('info', 'Add objects to the palette first');
    viewport.current?.setBrush(on ? { radius } : null);
    setPainting(on);
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <h4 className="env-h">Palette</h4>
      {items.map((it, i) => (
        <div key={it.base} className="row" style={{ gap: 4 }}>
          <span className="grow ellipsis small" title={it.base}>
            {names[it.base]?.editorId ?? it.base}
          </span>
          <div style={{ width: 54 }} title="How often (relative)">
            <DragNumber value={it.weight} min={0} max={100} precision={1} onCommit={(weight) => setItems(items.map((x, j) => (j === i ? { ...x, weight } : x)))} />
          </div>
          <button className="btn icon ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <FormPicker value={null} sigs={PLACEABLE} onChange={(base) => base && !items.some((i) => i.base === base) && setItems([...items, { base, weight: 1 }])} placeholder="+ Add an object" />
      <Field label="Brush size">
        <DragNumber value={radius} min={16} max={8192} precision={0} onCommit={setRadius} suffix="u" />
      </Field>
      <Field label="Density" title="Objects per 1000×1000 units, per dab">
        <DragNumber value={density} min={0.1} max={500} precision={1} onCommit={setDensity} />
      </Field>
      <Field label="Scale">
        <div className="row" style={{ gap: 3 }}>
          <DragNumber value={scale[0]} min={0.05} max={10} step={0.05} precision={2} onCommit={(v) => setScale([v, Math.max(v, scale[1])])} />
          <DragNumber value={scale[1]} min={0.05} max={10} step={0.05} precision={2} onCommit={(v) => setScale([Math.min(v, scale[0]), v])} />
        </div>
      </Field>
      <Field label="Follow slope">
        <Slider value={align} min={0} max={1} onCommit={setAlign} />
      </Field>
      <Field label="Max slope °">
        <DragNumber value={maxSlope} min={0} max={90} precision={0} onCommit={setMaxSlope} />
      </Field>
      <Field label="Sink" title="Push into the ground by this fraction of the height (rocks, roots)">
        <Slider value={sink} min={0} max={0.5} onCommit={setSink} />
      </Field>
      <Checkbox checked={terrainOnly} onChange={setTerrainOnly} label="Only on terrain" help="Outdoors: paint only on the ground, not on rocks, buildings or other objects." />
      <button className={`btn small ${painting ? 'active' : 'primary'}`} onClick={toggle} data-testid="env-paint">
        <Icon name="palette" size={12} /> {painting ? 'Painting… (Esc to stop)' : 'Paint in the view'}
      </button>
      <p className="dim small" style={{ margin: 0 }}>
        Drag to paint, <span className="kbd">Ctrl</span>+drag to erase palette objects, <span className="kbd">[</span> <span className="kbd">]</span> to resize. Each stroke is one undo step.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ path

function PathTab({ cell, viewport, handlers }: { cell: FormKey; viewport: React.RefObject<Viewport | null>; handlers: React.RefObject<ToolHandlers> }) {
  const [base, setBase] = useState<FormKey | null>(null);
  const [spacing, setSpacing] = useState(0);
  const [side, setSide] = useState(0);
  const [both, setBoth] = useState(false);
  const [follow, setFollow] = useState(true);
  const [align, setAlign] = useState(true);
  const [turn, setTurn] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const live = useRef({ base, spacing, side, both, follow, align, turn });
  live.current = { base, spacing, side, both, follow, align, turn };
  useEffect(() => {
    handlers.current.pathDone = async (points) => {
      setDrawing(false);
      const o = live.current;
      if (!o.base) return;
      const keys = await engine((c) => c.call('envAlongPath', cell, { base: o.base!, points, spacing: o.spacing || undefined, sideOffset: o.side, bothSides: o.both, followSurface: o.follow, alignToSlope: o.align, rotationOffset: o.turn * DEG }));
      if (keys) {
        toast('success', `Placed ${keys.length} piece(s)`);
        select(keys);
      }
    };
    handlers.current.cancelled = () => setDrawing(false);
    return () => {
      handlers.current.pathDone = undefined;
      handlers.current.cancelled = undefined;
    };
  }, [cell, handlers]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <Field label="Piece">
        <FormPicker value={base} sigs={PLACEABLE} onChange={setBase} placeholder="Road, fence, wall, lamp post…" />
      </Field>
      <Field label="Spacing" title="0 = the piece's own length, so pieces join end to end">
        <DragNumber value={spacing} min={0} precision={0} onCommit={setSpacing} suffix={spacing ? 'u' : ' auto'} />
      </Field>
      <Field label="Side offset" title="Distance to the left of the line (negative = right)">
        <DragNumber value={side} precision={0} onCommit={setSide} />
      </Field>
      <Checkbox checked={both} onChange={setBoth} label="Both sides (fences along a road)" />
      <Checkbox checked={follow} onChange={setFollow} label="Follow the ground" />
      <Checkbox checked={align} onChange={setAlign} label="Tilt to slope" />
      <Field label="Extra turn °" title="For pieces whose long side isn't their X axis">
        <DragNumber value={turn} precision={0} onCommit={setTurn} />
      </Field>
      <button
        className={`btn small ${drawing ? 'active' : 'primary'}`}
        disabled={!base}
        data-testid="env-path"
        onClick={() => {
          const on = !drawing;
          viewport.current?.setPathDraw(on);
          setDrawing(on);
        }}
      >
        <Icon name="route" size={12} /> {drawing ? 'Click points… (Enter to finish)' : 'Draw the path'}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ light

function LightTab({ cell, interior }: { cell: FormKey; interior: boolean }) {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('envLighting', cell), [cell]);
  const [mood, setMood] = useState<CellMood | null>(null);
  const chosen = mood ?? data?.suggested ?? 'home';
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="small">
        {data ? (
          <>
            <b>{data.sources}</b> candle, torch or fire object{data.sources === 1 ? '' : 's'} in this cell.
          </>
        ) : (
          '…'
        )}
      </div>
      <button
        className="btn small primary"
        data-testid="env-light"
        onClick={async () => {
          const r = await engine((c) => c.call('envLightingPass', cell));
          if (!r) return;
          toast('success', `Added ${r.placed.length} light(s)${r.alreadyLit ? `, ${r.alreadyLit} already lit` : ''}${r.createdBases.length ? ` (created ${r.createdBases.length} light form(s))` : ''}`);
          select(r.placed);
        }}
      >
        <Icon name="light" size={12} /> Light the candles and fires
      </button>
      <p className="dim small" style={{ margin: 0 }}>
        Adds a light above every candle, torch, brazier or fire that has none nearby. Run it again any time; lit ones are skipped.
      </p>
      {interior && data && (
        <>
          <h4 className="env-h">Mood</h4>
          <Select value={chosen} options={data.moods.map((m) => ({ value: m.id, label: `${m.label}${m.id === data.suggested ? ' (suggested)' : ''}` }))} onChange={setMood} />
          <button className="btn small" data-testid="env-mood" onClick={() => engine((c) => c.call('envSetMood', cell, chosen), { success: 'Lighting mood applied' })}>
            Apply ambient, light and fog colours
          </button>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ clutter

function ClutterTab({ cell }: { cell: FormKey }) {
  const client = useStore((s) => s.client);
  const { data: themes } = useQuery(() => client?.call('envThemes'), [client], { revision: false });
  const [theme, setTheme] = useState<string>('tavern');
  const [amount, setAmount] = useState<'light' | 'medium' | 'heavy'>('medium');
  const { data: items } = useQuery(() => client?.call('envThemeItems', theme as never), [theme]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <Field label="Room">
        <Select value={theme} options={(themes ?? []).map((t) => ({ value: t.id, label: t.label }))} onChange={setTheme} />
      </Field>
      <Field label="Amount">
        <Select
          value={amount}
          options={[
            { value: 'light', label: 'A little' },
            { value: 'medium', label: 'Lived in' },
            { value: 'heavy', label: 'Cluttered' },
          ]}
          onChange={setAmount}
        />
      </Field>
      {items && (
        <div className="small dim">
          On tables: {items.table.length ? items.table.slice(0, 8).map((i) => i.label).join(', ') : 'nothing found'}
          {items.table.length > 8 ? '…' : ''}
          <br />
          Along walls: {items.floor.length ? items.floor.slice(0, 6).map((i) => i.label).join(', ') : 'nothing found'}
          {items.floor.length > 6 ? '…' : ''}
        </div>
      )}
      <button
        className="btn small primary"
        data-testid="env-clutter"
        onClick={async () => {
          const r = await engine((c) => c.call('envClutter', cell, { theme: theme as never, amount }), { busy: 'Dressing the room…' });
          if (!r) return;
          toast(r.table.length + r.floor.length ? 'success' : 'info', r.table.length + r.floor.length ? `Placed ${r.table.length} on tables and shelves, ${r.floor.length} along the walls` : 'Found no free table tops or wall space');
          select([...r.table, ...r.floor]);
        }}
      >
        <Icon name="wand" size={12} /> Clutter this room
      </button>
      <p className="dim small" style={{ margin: 0 }}>
        Items go on static furniture tops (not on chests, beds or chairs) and along walls away from doors. Undo removes them all.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ room builder

const GRID = 8;
type Side = 'n' | 's' | 'e' | 'w';

function RoomTab({ cell, viewport, handlers }: { cell: FormKey; viewport: React.RefObject<Viewport | null>; handlers: React.RefObject<ToolHandlers> }) {
  const [kit, setKit] = useState<{ floor: FormKey | null; wall: FormKey | null; corner: FormKey | null; doorway: FormKey | null; ceiling: FormKey | null }>({ floor: null, wall: null, corner: null, doorway: null, ceiling: null });
  const [tile, setTile] = useState(0);
  const [wallTurn, setWallTurn] = useState(0);
  const [tiles, setTiles] = useState<Set<string>>(new Set(['3,3', '4,3', '3,4', '4,4']));
  const [doors, setDoors] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'floor' | 'doorway'>('floor');
  const [origin, setOrigin] = useState<Vec>({ x: 0, y: 0, z: 0 });
  const [navmesh, setNavmesh] = useState(true);
  useEffect(() => {
    handlers.current.cancelled = undefined;
  }, [handlers]);
  const has = (x: number, y: number) => tiles.has(`${x},${y}`);
  const click = (x: number, y: number, e: React.MouseEvent<HTMLButtonElement>) => {
    if (mode === 'floor') {
      const next = new Set(tiles);
      const k = `${x},${y}`;
      if (next.has(k)) next.delete(k);
      else next.add(k);
      setTiles(next);
      return;
    }
    if (!has(x, y)) return;
    // Nearest edge of the clicked tile (grid rows run north → south on screen).
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width - 0.5;
    const fy = (e.clientY - r.top) / r.height - 0.5;
    const side: Side = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 'e' : 'w') : fy > 0 ? 's' : 'n';
    const k = `${x},${y},${side}`;
    const next = new Set(doors);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setDoors(next);
  };
  const ready = kit.floor && kit.wall && tiles.size;
  const build = async () => {
    const list = [...tiles].map((t) => t.split(',').map(Number) as [number, number]);
    const minX = Math.min(...list.map((t) => t[0]));
    const maxRow = Math.max(...list.map((t) => t[1]));
    // Screen rows go down (south); the plan's y goes north.
    const plan = {
      tiles: list.map(([x, row]) => ({ x: x - minX, y: maxRow - row })),
      doorways: [...doors]
        .map((d) => d.split(','))
        .filter(([x, row]) => has(Number(x), Number(row)))
        .map(([x, row, side]) => ({ x: Number(x) - minX, y: maxRow - Number(row), side: side as Side })),
    };
    const res = await engine(
      async (c) => {
        const keys = await c.call('envBuildRoom', cell, origin, plan, { floor: kit.floor!, wall: kit.wall!, corner: kit.corner ?? undefined, doorway: kit.doorway ?? undefined, ceiling: kit.ceiling ?? undefined, tile: tile || undefined, wallRotationOffset: wallTurn * DEG });
        const nav = navmesh ? await c.call('generateNavmesh', cell, {}) : undefined;
        return { keys, nav };
      },
      { busy: 'Building…' },
    );
    if (!res) return;
    toast('success', `Placed ${res.keys.length} piece(s)${res.nav ? `; navmesh ${res.nav.triangles} triangles` : ''}`);
    select(res.keys);
    viewport.current?.frame(res.keys);
  };
  const piece = (k: keyof typeof kit, label: string, required = false) => (
    <Field label={`${label}${required ? '' : ' (optional)'}`}>
      <FormPicker value={kit[k]} sigs={KIT} onChange={(v) => setKit({ ...kit, [k]: v })} placeholder={required ? 'Pick a piece' : 'None'} />
    </Field>
  );
  return (
    <div className="col" style={{ gap: 6 }}>
      {piece('floor', 'Floor', true)}
      {piece('wall', 'Wall', true)}
      {piece('corner', 'Corner')}
      {piece('doorway', 'Doorway')}
      {piece('ceiling', 'Ceiling')}
      <Field label="Tile size" title="0 = the floor piece's width">
        <DragNumber value={tile} min={0} precision={0} onCommit={setTile} suffix={tile ? 'u' : ' auto'} />
      </Field>
      <Field label="Wall turn °" title="If walls come out sideways, try 90">
        <DragNumber value={wallTurn} precision={0} onCommit={setWallTurn} />
      </Field>
      <div className="row" style={{ gap: 4 }}>
        <button className={`btn small ${mode === 'floor' ? 'active' : 'ghost'}`} onClick={() => setMode('floor')}>
          Paint floor
        </button>
        <button className={`btn small ${mode === 'doorway' ? 'active' : 'ghost'}`} onClick={() => setMode('doorway')} title="Click near a tile's edge to put a doorway there">
          Doorways
        </button>
        <span className="spacer" />
        <span className="faint small">N ↑</span>
      </div>
      <div className="room-grid" data-testid="room-grid">
        {Array.from({ length: GRID * GRID }, (_, i) => {
          const x = i % GRID;
          const y = Math.floor(i / GRID);
          const on = has(x, y);
          const d = (s: Side) => doors.has(`${x},${y},${s}`);
          return (
            <button key={i} className={`room-tile ${on ? 'on' : ''}`} onClick={(e) => click(x, y, e)} data-tile={`${x},${y}`}>
              {on && (['n', 's', 'e', 'w'] as const).filter(d).map((s) => <span key={s} className={`room-door ${s}`} />)}
            </button>
          );
        })}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className="small dim grow">
          At {Math.round(origin.x)}, {Math.round(origin.y)}, {Math.round(origin.z)}
        </span>
        <button
          className="btn small ghost"
          onClick={async () => {
            const p = await viewport.current?.pickPointOnce('Click where the room should go');
            if (p) setOrigin({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
          }}
        >
          Pick spot
        </button>
      </div>
      <Checkbox checked={navmesh} onChange={setNavmesh} label="Then generate the navmesh" help="NPCs need a navmesh to walk around. It's built from the new room's floor and walls straight away." />
      <button className="btn small primary" disabled={!ready} onClick={build} data-testid="env-build-room">
        <Icon name="grid" size={12} /> Build room ({tiles.size} tile{tiles.size === 1 ? '' : 's'})
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ doors

function DoorsTab({ refs }: { refs: PlacedRef[] }) {
  const sel = useStore((s) => s.sceneSelection);
  const door = sel.length === 1 ? refs.find((r) => r.formKey === sel[0] && r.baseSig === 'DOOR') : undefined;
  const [target, setTarget] = useState<FormKey | null>(null);
  const [cell, setCell] = useState<FormKey | null>(null);
  const names = useSummaries([door?.teleport]);
  if (!door) return <div className="dim small">Select one door in the view.</div>;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="small">
        <b>{door.editorId ?? door.baseEditorId}</b>{' '}
        {door.teleport ? (
          <>
            leads to <span className="mono">{names[door.teleport]?.editorId ?? door.teleport}</span>
          </>
        ) : (
          'is not a load door yet.'
        )}
      </div>
      <h4 className="env-h">Link to an existing door</h4>
      <FormPicker value={target} sigs={['REFR']} onChange={setTarget} placeholder="Pick the other door" />
      <button className="btn small" disabled={!target} data-testid="env-link-doors" onClick={() => target && engine((c) => c.call('envLinkDoors', door.formKey, target), { success: 'Doors linked both ways' })}>
        <Icon name="link" size={12} /> Link both ways
      </button>
      <h4 className="env-h">Make a matching door in another cell</h4>
      <FormPicker value={cell} sigs={['CELL']} onChange={setCell} placeholder="Pick a cell" />
      <button
        className="btn small primary"
        disabled={!cell}
        data-testid="env-new-door"
        onClick={async () => {
          const key = await engine((c) => c.call('envCreateLinkedDoor', door.formKey, cell!), { success: 'Door created and linked' });
          if (key) toast('info', 'The new door is at the middle of that cell; move it into place and the arrival point follows.');
        }}
      >
        <Icon name="plus" size={12} /> Create and link
      </button>
      <p className="dim small" style={{ margin: 0 }}>
        The player arrives in front of each door, on the side with floor and open space. Moving a linked door updates where its partner sends the player.
      </p>
    </div>
  );
}
