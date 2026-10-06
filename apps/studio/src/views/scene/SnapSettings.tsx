/** Snap step sizes and kit snapping (shown from the World view's View menu). */
import { Checkbox, DragNumber, Field } from '../../components/ui';
import { useStore } from '../../state/store';

export function SnapSettings() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return (
    <div className="col" style={{ gap: 6 }}>
      <Field label="Move snap" title="With Grid snapping on, moves go in steps of this many units (a floor tile is usually 256 or 512).">
        <DragNumber value={settings.snapMove} step={1} precision={0} min={1} max={4096} suffix="units" onCommit={(snapMove) => update({ snapMove })} />
      </Field>
      <Field label="Rotate snap" title="With Grid snapping on, rotations go in steps of this many degrees.">
        <DragNumber value={settings.snapRotateDeg} step={1} precision={0} min={1} max={180} suffix="°" onCommit={(snapRotateDeg) => update({ snapRotateDeg })} />
      </Field>
      <Field label="Scale snap" title="With Grid snapping on, scaling goes in steps of this size.">
        <DragNumber value={settings.snapScale} step={0.01} precision={2} min={0.01} max={1} onCommit={(snapScale) => update({ snapScale })} />
      </Field>
      <Checkbox checked={settings.kitSnap} onChange={(kitSnap) => update({ kitSnap })} label="Kit snapping: moved pieces snap flush to their neighbours (hold Alt to skip)" />
    </div>
  );
}
