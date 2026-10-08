/**
 * Body tab: BodySlide inside the editor. Pick a slider set (or a preset),
 * shape the body with sliders and see it turn in 3D, then build the 0 and 1
 * weight meshes into your mod.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresetInfo, SliderInfo, SliderSetInfo, SliderValues } from '@tes5/workspace';
import { Checkbox, Field, Help, Icon, Modal, Select, Slider, TextInput, useQuery } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { BodyPreview } from './bodyPreview';

const sameValue = (a?: { small: number; big: number }) => !a || a.small === a.big;

export default function BodyView() {
  const client = useStore((s) => s.client);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<string | undefined>(() => sessionStorage.getItem('tes5.bodySet') ?? undefined);
  const { data: sets, loading, reload } = useQuery(() => client?.call('bodySets'), [client], { revision: false });
  const shown = (sets ?? []).filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  const current = sets?.find((s) => s.name === chosen);
  useEffect(() => {
    if (sets && !current && sets.length) setChosen(sets.find((s) => !s.problem)?.name ?? sets[0]!.name);
  }, [sets, current]);
  const pick = (name: string) => {
    setChosen(name);
    try {
      sessionStorage.setItem('tes5.bodySet', name);
    } catch {
      // storage unavailable
    }
  };

  return (
    <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
      <div className="panel" style={{ width: 230, flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--panel)' }}>
        <div className="panel-header">
          <span className="grow">Body sets</span>
          <button className="btn small" onClick={reload} title="Look again for BodySlide sets in your Data and mod folders (after installing a body mod, for example)" data-testid="body-rescan">
            <Icon name="search" size={12} /> Rescan
          </button>
        </div>
        <div className="searchbox">
          <input className="input" placeholder="Find a set…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="list scroll" style={{ flex: 1 }} data-testid="body-sets">
          {shown.map((s) => (
            <li key={s.name} className={`list-item ${chosen === s.name ? 'selected' : ''}`} onClick={() => pick(s.name)} title={s.problem ?? `${s.sliders} sliders · starts from ${s.source}`}>
              <span className="name">{s.name}</span>
              {s.problem ? <span className="chip warn">can’t use</span> : <span className="meta">{s.sliders} sliders</span>}
            </li>
          ))}
        </ul>
        {sets && !sets.length && !loading && (
          <div className="empty small" style={{ padding: 12 }} data-testid="body-empty">
            No BodySlide sets found.
            <br />
            Install a body mod that comes with BodySlide files (CBBE, UNP, 3BA…). They live in <span className="mono">CalienteTools\BodySlide\SliderSets</span> in your Data or mod folder. Then press Rescan.
          </div>
        )}
      </div>
      {current ? <Shaper key={current.name} set={current} /> : <div className="empty grow">{sets?.length ? 'Choose a body set on the left.' : loading ? 'Looking for body sets…' : ''}</div>}
    </div>
  );
}

function Shaper({ set }: { set: SliderSetInfo }) {
  const client = useStore((s) => s.client);
  const el = useRef<HTMLDivElement>(null);
  const preview = useRef<BodyPreview | null>(null);
  const { data: info } = useQuery(() => client?.call('bodySliders', set.name), [set.name], { revision: false });
  const { data: presets } = useQuery(() => client?.call('bodyPresets', set.name), [set.name]);
  const [values, setValues] = useState<SliderValues>({});
  const [split, setSplit] = useState<Set<string>>(new Set());
  const [weight, setWeight] = useState(100);
  const [find, setFind] = useState('');
  const [preset, setPreset] = useState('');
  const [wide, setWide] = useState(false);
  const [fileName, setFileName] = useState(set.output.file);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!info) return;
    setValues(structuredClone(info.defaults));
    setSplit(new Set(Object.entries(info.defaults).filter(([, v]) => !sameValue(v)).map(([k]) => k)));
  }, [info]);

  useEffect(() => {
    if (!el.current) return;
    const p = new BodyPreview(el.current);
    preview.current = p;
    return () => {
      p.dispose();
      preview.current = null;
    };
  }, []);

  // Draw the body; while one request is out, only the newest later request is sent.
  const busy = useRef(false);
  const latest = useRef<{ values: SliderValues; weight: number } | undefined>(undefined);
  const draw = async () => {
    if (busy.current || !client || !latest.current) return;
    busy.current = true;
    try {
      while (latest.current) {
        const { values: v, weight: w } = latest.current;
        latest.current = undefined;
        try {
          preview.current?.set(await client.call('bodyPreview', set.name, v, w / 100));
          setError(undefined);
        } catch (e) {
          setError((e as Error).message);
        }
      }
    } finally {
      busy.current = false;
    }
  };
  useEffect(() => {
    if (!info) return;
    latest.current = { values, weight };
    void draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, weight, info]);

  const sliders = useMemo(() => (info?.sliders ?? []).filter((s) => s.label.toLowerCase().includes(find.toLowerCase()) || s.name.toLowerCase().includes(find.toLowerCase())), [info, find]);
  const outOfRange = Object.values(values).some((v) => v.small < 0 || v.small > 100 || v.big < 0 || v.big > 100);
  const range = wide || outOfRange ? { min: -100, max: 200 } : { min: 0, max: 100 };

  const setOne = (name: string, p: Partial<{ small: number; big: number }>, both: boolean) =>
    setValues((cur) => {
      const old = cur[name] ?? { small: 0, big: 0 };
      return { ...cur, [name]: both ? { small: p.small ?? p.big ?? old.small, big: p.big ?? p.small ?? old.big } : { ...old, ...p } };
    });

  const applyPreset = (p: PresetInfo | undefined) => {
    if (!info) return;
    const next = structuredClone(info.defaults);
    // A preset names only the sliders it changes; the rest go back to the set's starting values.
    if (p) for (const [k, v] of Object.entries(p.values)) if (k in next) next[k] = { ...v };
    setValues(next);
    setSplit(new Set(Object.entries(next).filter(([, v]) => !sameValue(v)).map(([k]) => k)));
  };

  const build = async () => {
    const r = await engine((c) => c.call('bodyBuild', set.name, values, fileName.trim() && fileName.trim() !== set.output.file ? { file: fileName.trim() } : undefined), { busy: 'Building the body…' });
    if (r) {
      useStore.getState().toast('success', `Built ${r.files.map((f) => f.split('\\').pop()).join(' and ')} in ${set.output.folder}`);
      for (const w of r.warnings.slice(0, 3)) useStore.getState().toast('warning', w);
    }
  };

  return (
    <>
      <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
        <div ref={el} style={{ flex: 1, minHeight: 0 }} data-testid="body-preview" />
        <div className="viewport-overlay viewport-hint">Drag to turn · wheel to zoom · Shift+drag to move up/down</div>
        <div style={{ position: 'absolute', left: 10, top: 10, right: 10 }} className="col">
          <div className="card small row" style={{ maxWidth: 420, gap: 10, alignItems: 'center' }}>
            <span className="nowrap">
              Preview weight <Help text="The game blends between two meshes with a character's weight. At 0 every slider uses its small value, at 100 its big value. This only changes what you see here; Build writes both." />
            </span>
            <div className="grow">
              <Slider value={weight} min={0} max={100} step={1} onCommit={setWeight} onChange={setWeight} />
            </div>
          </div>
          {error && <div className="card small err" style={{ maxWidth: 520, marginTop: 6 }}>{error}</div>}
          {set.problem && (
            <div className="card small warn" style={{ maxWidth: 520, marginTop: 6 }} data-testid="body-problem">
              <Icon name="warn" size={13} /> {set.problem}
            </div>
          )}
          {!!info?.warnings.length && (
            <div className="card small warn" style={{ maxWidth: 520, marginTop: 6 }} title={info.warnings.join('\n')}>
              <Icon name="warn" size={13} /> {info.warnings.length} problem(s) reading this set; some sliders may do nothing. Hover for details.
            </div>
          )}
        </div>
      </div>
      <div className="panel" style={{ width: 340, flex: 'none', borderLeft: '1px solid var(--border)', background: 'var(--panel)' }}>
        <div className="pad col" style={{ gap: 8, borderBottom: '1px solid var(--border)' }}>
          <Field label="Preset" title="A saved set of slider values. Presets from BodySlide's SliderPresets folder show up here.">
            <div className="row" style={{ gap: 4 }}>
              <div className="grow">
                <Select
                  value={preset}
                  options={[{ value: '', label: presets?.length ? 'Choose a preset…' : 'No presets for this set' }, ...(presets ?? []).map((p) => ({ value: p.name, label: p.name }))]}
                  onChange={(n) => {
                    setPreset(n);
                    applyPreset(presets?.find((p) => p.name === n));
                  }}
                />
              </div>
              <button
                className="btn small"
                title="Put every slider back to the values the set starts with"
                onClick={() => {
                  setPreset('');
                  applyPreset(undefined);
                }}
                data-testid="body-reset"
              >
                Reset
              </button>
            </div>
          </Field>
          <div className="row" style={{ gap: 4 }}>
            <input className="input grow" placeholder="Find a slider…" value={find} onChange={(e) => setFind(e.target.value)} />
            <button className="btn small" onClick={() => setSaving(true)} title="Save these slider values as a preset that BodySlide can also use" data-testid="body-save-preset">
              Save preset…
            </button>
          </div>
          <Checkbox checked={wide || outOfRange} onChange={setWide} label="Allow values past 0–100%" help="Sliders normally go from 0 (none of the morph) to 100 (all of it). Past 100 exaggerates it; below 0 does the opposite. Extreme values can tear the mesh." />
        </div>
        <div className="scroll pad col" style={{ flex: 1, gap: 10 }} data-testid="body-sliders">
          {sliders.map((s) => (
            <Row key={s.name} s={s} v={values[s.name] ?? { small: 0, big: 0 }} split={split.has(s.name)} range={range} onChange={(p, both) => setOne(s.name, p, both)} onSplit={(on) => setSplit((cur) => new Set(on ? [...cur, s.name] : [...cur].filter((x) => x !== s.name)))} />
          ))}
          {info && !sliders.length && <div className="empty small">{info.sliders.length ? 'No slider matches.' : 'This set has no sliders.'}</div>}
        </div>
        <div className="pad col" style={{ gap: 6, borderTop: '1px solid var(--border)' }}>
          <Field label="Output name" title={`The meshes are written to ${set.output.folder} in your mod, as <name>_0.nif and <name>_1.nif`}>
            <TextInput value={fileName} onCommit={setFileName} mono />
          </Field>
          <div className="small dim">
            Writes <span className="mono">{fileName || set.output.file}_0.nif</span> and <span className="mono">_1.nif</span> to <span className="mono">{set.output.folder}</span>. Undo removes them.
          </div>
          <button className="btn primary" onClick={() => void build()} disabled={!!set.problem || !fileName.trim()} title="Build the 0 and 1 weight meshes into your mod's Data folder" data-testid="body-build">
            <Icon name="wand" size={13} /> Build body
          </button>
        </div>
      </div>
      {saving && (
        <SavePreset
          onClose={() => setSaving(false)}
          onSave={async (name) => {
            const p = await engine((c) => c.call('bodySavePreset', name, set.name, values), { success: `Saved preset ${name}` });
            if (p) setPreset(p.name);
            return !!p;
          }}
        />
      )}
    </>
  );
}

function Row({ s, v, split, range, onChange, onSplit }: { s: SliderInfo; v: { small: number; big: number }; split: boolean; range: { min: number; max: number }; onChange: (p: Partial<{ small: number; big: number }>, both: boolean) => void; onSplit: (on: boolean) => void }) {
  return (
    <div className="col" style={{ gap: 2, opacity: s.empty ? 0.5 : 1 }} data-testid={`body-slider-${s.name}`}>
      <div className="row" style={{ gap: 4 }}>
        <span className="grow ellipsis" title={s.empty ? `${s.name}: this slider has no morph data, so it does nothing` : s.name}>
          {s.label}
        </span>
        <button className={`btn small ghost ${split ? 'active' : ''}`} aria-pressed={split} onClick={() => onSplit(!split)} title={split ? 'Use one value for both weights' : 'Use different values at weight 0 and weight 100'}>
          <Icon name={split ? 'link' : 'sliders'} size={11} />
        </button>
      </div>
      {split ? (
        <>
          <div className="row small dim" style={{ gap: 6 }}>
            <span style={{ width: 22 }} title="Value at weight 0">0</span>
            <div className="grow">
              <Slider value={v.small} min={range.min} max={range.max} step={1} onChange={(n) => onChange({ small: n }, false)} onCommit={(n) => onChange({ small: n }, false)} />
            </div>
          </div>
          <div className="row small dim" style={{ gap: 6 }}>
            <span style={{ width: 22 }} title="Value at weight 100">100</span>
            <div className="grow">
              <Slider value={v.big} min={range.min} max={range.max} step={1} onChange={(n) => onChange({ big: n }, false)} onCommit={(n) => onChange({ big: n }, false)} />
            </div>
          </div>
        </>
      ) : (
        <Slider value={v.small} min={range.min} max={range.max} step={1} onChange={(n) => onChange({ small: n, big: n }, true)} onCommit={(n) => onChange({ small: n, big: n }, true)} />
      )}
    </div>
  );
}

function SavePreset({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState('My Preset');
  return (
    <Modal
      title="Save preset"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={async () => {
              if (await onSave(name)) onClose();
            }}
            data-testid="body-save-confirm"
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <TextInput value={name} onCommit={setName} autoFocus />
      </Field>
      <p className="dim small">Saved to <span className="mono">CalienteTools\BodySlide\SliderPresets</span> in your mod folder, so BodySlide itself can use it too. Undo removes it.</p>
    </Modal>
  );
}
