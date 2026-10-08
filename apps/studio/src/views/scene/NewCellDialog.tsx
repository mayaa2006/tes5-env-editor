import { useEffect, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import { Checkbox, clearDraft, DragNumber, Field, Modal, TextInput, useDraft, useQuery, useUniqueEditorId } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { GroundTexturePicker } from './EnvTools';

export type NewCellKind = 'interior' | 'exterior' | 'world';

const KINDS: { id: NewCellKind; label: string; title: string }[] = [
  { id: 'interior', label: 'Indoors', title: 'A cell on its own, like a house, cave or dungeon. Reached through a load door.' },
  { id: 'exterior', label: 'Outdoors', title: 'One more outdoor cell in a worldspace, with ground that meets the cells around it.' },
  { id: 'world', label: 'New worldspace', title: 'A whole new outdoor world (like Tamriel or Solstheim), with a square of flat ground to start from.' },
];

const SIZES = [1, 3, 5, 7];

/** What to call a cell in lists: its editor ID, or "Wilderness" and its grid position outdoors. */
export function cellLabel(c: { formKey: FormKey; editorId?: string; grid?: { x: number; y: number }; persistentCell?: boolean }): string {
  if (c.editorId) return c.editorId;
  if (c.persistentCell) return 'Persistent cell';
  return c.grid ? 'Wilderness' : c.formKey;
}

/** Create a cell: indoors, outdoors in a worldspace, or a whole new worldspace. */
export function NewCellDialog({ onClose, kind: kindProp, worldspace: initialWorld }: { onClose: () => void; kind?: NewCellKind; worldspace?: FormKey }) {
  const client = useStore((s) => s.client);
  const current = useStore((s) => s.cell);
  // A dialog opened for a specific kind or world (e.g. from + Cell) starts there; otherwise it picks up where it was left.
  const [kind, setKind] = useDraft<NewCellKind>(kindProp ? undefined : 'newCell:kind', kindProp ?? 'interior');
  const { data: worlds } = useQuery(() => client?.call('worldspaces'), [client]);
  const { data: cells } = useQuery(() => client?.call('cells', {}), [client]);
  const here = cells?.find((c) => c.formKey === current);

  // Indoors
  const [interiorEdid, setInteriorEdid] = useUniqueEditorId('MyNewInterior', 'newCell:interiorEdid');
  const [worldEdid, setWorldEdid] = useUniqueEditorId('MyNewWorld', 'newCell:worldEdid');
  const [edid, setEdid] = kind === 'world' ? [worldEdid, setWorldEdid] : [interiorEdid, setInteriorEdid];
  const [name, setName] = useDraft('newCell:name', '');
  // Outdoors (also the ground of a new worldspace)
  const [world, setWorld] = useDraft<FormKey | ''>(initialWorld ? undefined : 'newCell:world', initialWorld ?? '');
  const [grid, setGrid] = useState<{ x: number; y: number } | null>(null);
  const [cellEdid, setCellEdid] = useDraft('newCell:cellEdid', '');
  const [texture, setTexture] = useDraft<FormKey | null>('newCell:texture', null);
  // New worldspace
  const [size, setSize] = useDraft('newCell:size', 3);
  const [ground, setGround] = useDraft('newCell:ground', 0);
  const [water, setWater] = useDraft('newCell:water', false);
  const [waterHeight, setWaterHeight] = useDraft('newCell:waterHeight', -200);
  const [like, setLike] = useDraft<FormKey | ''>('newCell:like', '');
  const [noFastTravel, setNoFastTravel] = useDraft('newCell:noFastTravel', false);

  // Sensible defaults once the worldspaces are known: the current cell's world, and Tamriel's weather if it's there.
  useEffect(() => {
    if (!worlds?.length) return;
    if (!world) setWorld(initialWorld ?? (here?.worldspace && !here.interior ? here.worldspace : worlds[0]!.formKey));
    if (!like) setLike(worlds.find((w) => w.editorId === 'Tamriel')?.formKey ?? '');
  }, [worlds, here?.formKey]);
  useEffect(() => {
    if (kind !== 'exterior' || !world) return;
    const near = here && !here.interior && here.worldspace === world ? here.grid : undefined;
    void client?.call('freeCellSpot', world, near).then(setGrid);
  }, [kind, world]);

  const create = async () => {
    const s = useStore.getState();
    if (kind === 'interior') {
      const key = await engine((c) => c.call('createInteriorCell', edid, name || undefined), { success: `Created ${edid}` });
      if (key) s.setCell(key);
      return key;
    }
    if (kind === 'exterior') {
      if (!world || !grid) return;
      const key = await engine((c) => c.call('createExteriorCell', world, grid, { editorId: cellEdid || undefined, name: name || undefined, texture: texture ?? undefined }), { success: `Created the cell at ${grid.x}, ${grid.y}` });
      if (key) s.setCell(key);
      return key;
    }
    const r = await engine(
      (c) => c.call('createWorldspace', { editorId: edid, name: name || undefined, size, groundHeight: ground, texture: texture ?? undefined, water, waterHeight: ground + waterHeight, like: like || undefined, noFastTravel }),
      { success: `Created worldspace ${edid} with ${size * size} cell(s)`, busy: 'Making the worldspace…' },
    );
    if (r) s.setCell(r.center);
    return r;
  };

  const worldOptions = (worlds ?? []).map((w) => ({ value: w.formKey, label: w.name ? `${w.editorId} “${w.name}”` : (w.editorId ?? w.formKey) }));
  const title = kind === 'interior' ? 'New interior cell' : kind === 'exterior' ? 'New outdoor cell' : 'New worldspace';
  const canCreate = kind === 'exterior' ? !!world && !!grid : !!edid;
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!canCreate}
            data-testid="create-cell"
            title={kind === 'world' ? `Make the worldspace and ${size * size} outdoor cell(s), then open the middle one. Undo removes it all.` : 'Make the cell and open it. Undo removes it.'}
            onClick={async () => {
              if (await create()) {
                clearDraft('newCell:');
                onClose();
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      <div className="panel-tabs" role="tablist" style={{ marginBottom: 10 }} data-testid="new-cell-kind">
        {KINDS.map((k) => (
          <button key={k.id} role="tab" aria-selected={kind === k.id} className={`panel-tab ${kind === k.id ? 'active' : ''}`} title={k.title} onClick={() => setKind(k.id)} data-testid={`new-cell-kind-${k.id}`}>
            {k.label}
          </button>
        ))}
      </div>

      {kind !== 'exterior' && (
        <Field label="Editor ID" title="The name scripts and the CK use. It must be unique.">
          <TextInput key={kind} value={edid} onCommit={setEdid} autoFocus mono />
        </Field>
      )}

      {kind === 'exterior' && (
        <>
          {!worldOptions.length ? (
            <p className="dim small" data-testid="no-worldspaces">
              There are no worldspaces yet. Pick <strong>New worldspace</strong> above to make one.
            </p>
          ) : (
            <>
              <Field label="Worldspace" title="The outdoor world the cell is added to.">
                <select className="input" value={world} onChange={(e) => setWorld(e.target.value as FormKey)} data-testid="new-cell-world">
                  {worldOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Grid position" title="Where the cell goes, in cells east (X) and north (Y) of the world's centre. Defaults to the nearest free spot next to the cell you're in.">
                <div className="row" style={{ gap: 6 }}>
                  <span className="dim small">X</span>
                  <DragNumber value={grid?.x ?? 0} precision={0} onCommit={(x) => setGrid({ x: Math.round(x), y: grid?.y ?? 0 })} />
                  <span className="dim small">Y</span>
                  <DragNumber value={grid?.y ?? 0} precision={0} onCommit={(y) => setGrid({ x: grid?.x ?? 0, y: Math.round(y) })} />
                </div>
              </Field>
              <Field label="Editor ID" title="Optional. Outdoor wilderness cells usually have none.">
                <TextInput value={cellEdid} onCommit={setCellEdid} placeholder="None (like wilderness cells)" mono />
              </Field>
            </>
          )}
        </>
      )}

      <Field label="Name" title={kind === 'world' ? 'Shown on the map and when the player arrives.' : 'Shown in game when the player enters.'}>
        <TextInput value={name} onCommit={setName} placeholder={kind === 'world' ? 'Shown on the map' : 'Shown in game when entering'} />
      </Field>

      {kind === 'world' && (
        <>
          <Field label="Size" title="How many outdoor cells to start with, in a square around 0, 0. Each cell is 4096 units (about 58 m) across. You can add more cells later.">
            <select className="input" value={size} onChange={(e) => setSize(Number(e.target.value))} data-testid="new-world-size">
              {SIZES.map((n) => (
                <option key={n} value={n}>
                  {`${n} × ${n} cells`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ground height" title="Height of the flat ground, in game units. Sculpt it afterwards with World tools → Terrain.">
            <DragNumber value={ground} precision={0} step={64} onCommit={setGround} />
          </Field>
          <Field label="Water" title="Water across the whole worldspace at a fixed height. Off: no water.">
            <div className="row" style={{ gap: 8 }}>
              <Checkbox checked={water} onChange={setWater} label="Has water" />
              {water && (
                <>
                  <DragNumber value={waterHeight} precision={0} step={32} onCommit={setWaterHeight} />
                  <span className="dim small">from the ground</span>
                </>
              )}
            </div>
          </Field>
          <Field label="Weather and music like" title="Takes the weather (climate), water type and music from another worldspace. None: the game's defaults.">
            <select className="input" value={like} onChange={(e) => setLike(e.target.value as FormKey | '')} data-testid="new-world-like">
              <option value="">None (game defaults)</option>
              {worldOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fast travel">
            <Checkbox checked={noFastTravel} onChange={setNoFastTravel} label="The player can't fast travel here" />
          </Field>
        </>
      )}

      {kind !== 'interior' && (worldOptions.length || kind === 'world') ? (
        <Field label="Ground texture" stack title="The landscape texture the new ground is covered in. Paint others on afterwards with World tools → Terrain → Paint.">
          <GroundTexturePicker value={texture} onChange={setTexture} noneLabel={kind === 'exterior' ? 'Like the cells next to it' : "The game's default ground"} />
        </Field>
      ) : null}

      <p className="dim small" data-testid="new-cell-note">
        {kind === 'interior' && "Lighting, ownership and the rest can be edited in the properties panel once it's created. Drag objects from the Objects or Assets tab to build it."}
        {kind === 'exterior' && 'The ground meets the cells around it and blends smoothly between them. Sculpt and paint it afterwards with World tools → Terrain.'}
        {kind === 'world' &&
          `Makes the worldspace, its persistent cell (for things that must always be loaded, like map markers) and ${size * size} cell(s) of flat ground around 0, 0. Distant terrain (LOD) and the map image are made later with xLODGen.`}
      </p>
    </Modal>
  );
}
