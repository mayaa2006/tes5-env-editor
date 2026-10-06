/**
 * Character creator: edits an NPC's look the way the in-game RaceMenu does —
 * race, sex, head parts, sliders and colours — with a live 3D preview.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FACE_MORPHS, type FormKey } from '@tes5/esp';
import type { HeadPartInfo, NpcAppearance } from '@tes5/workspace';
import { Field, FormPicker, Icon, Modal, Select, Slider, Tabs, TextInput, useDebounced, useQuery, DragNumber } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { HeadPreview, type PreviewPart } from './headPreview';

type Tab = 'body' | 'head' | 'face' | 'colors' | 'tints';

const FACE_GROUPS: { title: string; keys: (typeof FACE_MORPHS)[number][0][] }[] = [
  { title: 'Nose', keys: ['noseLongShort', 'noseUpDown'] },
  { title: 'Eyes', keys: ['eyesUpDown', 'eyesInOut', 'eyesForwardBack'] },
  { title: 'Brows', keys: ['browsUpDown', 'browsInOut', 'browsForwardBack'] },
  { title: 'Cheeks', keys: ['cheeksUpDown', 'cheeksForwardBack'] },
  { title: 'Mouth', keys: ['lipsUpDown', 'lipsInOut'] },
  { title: 'Jaw', keys: ['jawUpDown', 'jawNarrowWide', 'jawForwardBack'] },
  { title: 'Chin', keys: ['chinNarrowWide', 'chinUpDown', 'chinUnderbiteOverbite'] },
  { title: 'Other', keys: ['vampireMorph'] },
];
const MORPH_LABEL = Object.fromEntries(FACE_MORPHS.map(([k, l]) => [k, l])) as Record<string, string>;
const PART_TYPES: { type: HeadPartInfo['type']; label: string; optional: boolean }[] = [
  { type: 'Hair', label: 'Hair', optional: true },
  { type: 'Eyes', label: 'Eyes', optional: false },
  { type: 'Eyebrows', label: 'Brows', optional: true },
  { type: 'Facial Hair', label: 'Beard', optional: true },
  { type: 'Scar', label: 'Scars', optional: true },
  { type: 'Face', label: 'Head', optional: true },
];

const toHex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (h: string) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });

export default function NpcCreator() {
  const npc = useStore((s) => s.npc);
  return (
    <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
      <NpcList />
      {npc ? <Creator key={npc} npc={npc} /> : <div className="empty grow">Choose a character on the left, or create a new one.</div>}
    </div>
  );
}

function NpcList() {
  const client = useStore((s) => s.client);
  const npc = useStore((s) => s.npc);
  const setNpc = useStore((s) => s.setNpc);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [creating, setCreating] = useState(false);
  const { data } = useQuery(() => client?.call('search', { sigs: ['NPC_'], query: dq, limit: 400 }), [dq]);
  return (
    <div className="panel" style={{ width: 230, flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--panel)' }}>
      <div className="panel-header">
        <span className="grow">Characters</span>
        <button className="btn small primary" onClick={() => setCreating(true)} data-testid="new-npc">
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <div className="searchbox">
        <input className="input" placeholder="Find character…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="list scroll" style={{ flex: 1 }} data-testid="npc-list">
        {data?.items.map((i) => (
          <li key={i.formKey} className={`list-item ${npc === i.formKey ? 'selected' : ''}`} onClick={() => setNpc(i.formKey)} title={i.formKey}>
            <span className="name">{i.name ?? i.editorId}</span>
            {i.inActive && <span className="chip accent">edited</span>}
            <span className="meta">{i.name ? i.editorId : ''}</span>
          </li>
        ))}
      </ul>
      {creating && <NewNpcDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewNpcDialog({ onClose }: { onClose: () => void }) {
  const [template, setTemplate] = useState<FormKey | null>(useStore.getState().npc ?? null);
  const [edid, setEdid] = useState('MyNewCharacter');
  const [name, setName] = useState('New Character');
  return (
    <Modal
      title="New character"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!template}
            onClick={async () => {
              const key = await engine(
                async (c) => {
                  const k = await c.call('duplicateRecord', template!, edid);
                  const v = await c.call('view', k);
                  if (v) await c.call('updateRecord', k, { ...v.data, name }, { unknown: v.unknown, label: 'Name character' });
                  return k;
                },
                { success: `Created ${name}` },
              );
              if (key) {
                useStore.getState().setNpc(key);
                onClose();
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Start from">
        <FormPicker value={template} sigs={['NPC_']} onChange={setTemplate} allowNone={false} placeholder="Pick a character to copy" />
      </Field>
      <Field label="Editor ID">
        <TextInput value={edid} onCommit={setEdid} mono />
      </Field>
      <Field label="Name">
        <TextInput value={name} onCommit={setName} />
      </Field>
      <p className="dim small">Stats, factions, inventory and AI are copied from the template; change anything afterwards in the properties panel.</p>
    </Modal>
  );
}

function Creator({ npc }: { npc: FormKey }) {
  const client = useStore((s) => s.client);
  const { data: saved } = useQuery(() => client?.call('npcAppearance', npc), [npc]);
  const { data: races } = useQuery(() => client?.call('races'), [client], { revision: false });
  const { data: colors } = useQuery(() => client?.call('hairColors'), [client], { revision: false });
  const { data: allParts } = useQuery(() => client?.call('headParts', { includeNonPlayable: true }), [client]);
  const { data: problems } = useQuery(() => client?.call('faceGenProblems'), [client]);
  const [a, setA] = useState<NpcAppearance | undefined>(saved);
  const [tab, setTab] = useState<Tab>('head');
  const previewEl = useRef<HTMLDivElement>(null);
  const preview = useRef<HeadPreview | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => setA(saved), [saved]);

  const commit = async (p: Partial<NpcAppearance>) => {
    setA((cur) => (cur ? { ...cur, ...p } : cur));
    await engine((c) => c.call('setNpcAppearance', npc, p));
  };

  const partsByKey = useMemo(() => new Map((allParts ?? []).map((p) => [p.formKey, p])), [allParts]);
  const previewParts = useMemo(() => {
    if (!a) return [];
    const out: PreviewPart[] = [];
    const seen = new Set<string>();
    const add = (k: FormKey) => {
      const p = partsByKey.get(k);
      if (!p || seen.has(k)) return;
      seen.add(k);
      out.push({ key: k, type: p.type, model: p.model, chargenTri: p.tris.find((t) => t.type === 2)?.file });
      for (const x of p.extraParts) add(x);
    };
    for (const k of a.headParts) add(k);
    return out;
  }, [a?.headParts.join(','), partsByKey]);

  useEffect(() => {
    if (!previewEl.current || !client) return;
    const p = new HeadPreview(previewEl.current, client);
    preview.current = p;
    return () => {
      p.dispose();
      preview.current = null;
    };
  }, [client]);
  useEffect(() => {
    const p = preview.current;
    if (!p) return;
    void p.setParts(previewParts).then((r) => {
      setMissing(r.missing);
      p.frame();
    });
  }, [previewParts]);
  const sliderValues = a ? FACE_MORPHS.map(([k]) => a.morphs[k] ?? 0) : [];
  useEffect(() => preview.current?.setSliders(sliderValues), [sliderValues.join(',')]);
  const hair = colors?.find((c) => c.formKey === a?.hairColor)?.color ?? null;
  useEffect(() => preview.current?.setColors(hair, a?.skinTone ?? null), [hair?.r, hair?.g, hair?.b, a?.skinTone.r, a?.skinTone.g, a?.skinTone.b, previewParts]);

  const problem = problems?.find((p) => p.npc === npc);
  const hasFace = a?.headParts.some((k) => partsByKey.get(k)?.type === 'Face');

  return (
    <>
      <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
        <div ref={previewEl} style={{ flex: 1, minHeight: 0 }} data-testid="head-preview" />
        <div className="viewport-overlay viewport-hint">Drag to turn · wheel to zoom · Shift+drag to move up/down</div>
        <div style={{ position: 'absolute', left: 10, top: 10, right: 10 }} className="col">
          {problem && (
            <div className="card small" style={{ borderColor: 'var(--warn)', maxWidth: 520 }}>
              <div className="warn" style={{ fontWeight: 600 }}>
                <Icon name="warn" size={13} /> FaceGen files missing — this face will look dark in game
              </div>
              <div className="dim">
                The game needs pre-built FaceGen files for edited faces. Automatic export isn't implemented yet: until it is, open the plugin in the Creation Kit, select this NPC and press Ctrl+F4. Missing: {problem.missing.map((m) => m.split('\\').pop()).join(', ')}
              </div>
            </div>
          )}
          {!!missing.length && <div className="small faint">Preview: {missing.slice(0, 3).join(' · ')}</div>}
          {a && !hasFace && <div className="small faint">This character uses the race's default head shape (not shown in the preview).</div>}
        </div>
      </div>
      <div className="panel" style={{ width: 340, flex: 'none', borderLeft: '1px solid var(--border)', background: 'var(--panel)' }}>
        <Tabs<Tab>
          tabs={[
            { id: 'body', label: 'Body' },
            { id: 'head', label: 'Head' },
            { id: 'face', label: 'Face' },
            { id: 'colors', label: 'Colours' },
            { id: 'tints', label: 'Paint' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="scroll pad" style={{ flex: 1 }}>
          {!a ? (
            <div className="empty">Loading…</div>
          ) : tab === 'body' ? (
            <BodyTab a={a} races={races ?? []} commit={commit} />
          ) : tab === 'head' ? (
            <HeadTab a={a} parts={allParts ?? []} commit={commit} />
          ) : tab === 'face' ? (
            <FaceTab a={a} setA={setA} commit={commit} />
          ) : tab === 'colors' ? (
            <ColorsTab a={a} colors={colors ?? []} commit={commit} />
          ) : (
            <TintsTab a={a} commit={commit} />
          )}
        </div>
      </div>
    </>
  );
}

function BodyTab({ a, races, commit }: { a: NpcAppearance; races: { formKey: FormKey; editorId?: string; name?: string }[]; commit: (p: Partial<NpcAppearance>) => void }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <Field label="Race">
        <Select value={a.race ?? ''} options={[{ value: '', label: '—' }, ...races.map((r) => ({ value: r.formKey, label: r.name ?? r.editorId ?? r.formKey }))]} onChange={(v) => v && commit({ race: v as FormKey })} />
      </Field>
      <Field label="Sex">
        <div className="row" style={{ gap: 4 }}>
          <button className={`btn small grow ${!a.female ? 'active' : ''}`} onClick={() => a.female && commit({ female: false })}>
            Male
          </button>
          <button className={`btn small grow ${a.female ? 'active' : ''}`} onClick={() => !a.female && commit({ female: true })}>
            Female
          </button>
        </div>
      </Field>
      <Field label="Weight" title="Thin (0) to muscular (100) body">
        <Slider value={a.weight} min={0} max={100} step={1} onCommit={(weight) => commit({ weight })} />
      </Field>
      <Field label="Height">
        <DragNumber value={a.height} step={0.01} precision={2} min={0.5} max={2} onCommit={(height) => commit({ height })} />
      </Field>
      <p className="dim small">Changing race or sex filters the head parts offered on the Head tab to ones that fit.</p>
    </div>
  );
}

function HeadTab({ a, parts, commit }: { a: NpcAppearance; parts: HeadPartInfo[]; commit: (p: Partial<NpcAppearance>) => void }) {
  const byKey = new Map(parts.map((p) => [p.formKey, p]));
  const fits = (p: HeadPartInfo) => p.playable && (a.female ? p.female : p.male);
  const choose = (type: HeadPartInfo['type'], key: FormKey | null) => {
    const kept = a.headParts.filter((k) => byKey.get(k)?.type !== type || type === 'Scar');
    const next = type === 'Scar' ? (key ? (kept.includes(key) ? kept.filter((k) => k !== key) : [...kept, key]) : kept.filter((k) => byKey.get(k)?.type !== 'Scar')) : key ? [...kept, key] : kept;
    void commit({ headParts: next });
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      {PART_TYPES.map(({ type, label, optional }) => {
        const options = parts.filter((p) => p.type === type && fits(p));
        const current = a.headParts.filter((k) => byKey.get(k)?.type === type);
        return (
          <div key={type}>
            <div className="row" style={{ marginBottom: 4 }}>
              <h3 className="grow" style={{ margin: 0 }}>
                {label}
              </h3>
              <span className="faint small">{options.length} options</span>
            </div>
            <div className="chips" style={{ flexWrap: 'wrap' }}>
              {optional && type !== 'Face' && (
                <button className={`chip ${current.length === 0 ? 'accent' : ''}`} style={{ cursor: 'pointer' }} onClick={() => choose(type, null)}>
                  None
                </button>
              )}
              {options.map((p) => (
                <button key={p.formKey} className={`chip ${current.includes(p.formKey) ? 'accent' : ''}`} style={{ cursor: 'pointer' }} title={`${p.editorId ?? ''} ${p.model ?? ''}`} onClick={() => choose(type, p.formKey)}>
                  {p.name ?? p.editorId}
                </button>
              ))}
              {current
                .filter((k) => !options.some((o) => o.formKey === k))
                .map((k) => (
                  <span key={k} className="chip warn" title="Not normally available for this race/sex">
                    {byKey.get(k)?.editorId ?? k}
                  </span>
                ))}
            </div>
          </div>
        );
      })}
      <Field label="Face presets" title="Nose / eyes / mouth preset indices (NAMA)">
        <div className="row" style={{ gap: 3 }}>
          {(['nose', 'eyes', 'mouth'] as const).map((k) => (
            <DragNumber key={k} value={a.faceParts[k]} step={1} precision={0} min={-1} max={40} onCommit={(v) => commit({ faceParts: { ...a.faceParts, [k]: Math.round(v) } })} />
          ))}
        </div>
      </Field>
    </div>
  );
}

function FaceTab({ a, setA, commit }: { a: NpcAppearance; setA: (a: NpcAppearance) => void; commit: (p: Partial<NpcAppearance>) => void }) {
  const set = (k: string, v: number, final: boolean) => {
    const morphs = { ...a.morphs, [k]: v };
    setA({ ...a, morphs });
    if (final) void commit({ morphs });
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 4 }}>
        <button
          className="btn small"
          onClick={() => {
            const morphs = Object.fromEntries(Object.keys(a.morphs).map((k) => [k, k === 'vampireMorph' ? a.morphs[k as keyof typeof a.morphs] : Math.round((Math.random() * 1.4 - 0.7) * 100) / 100])) as NpcAppearance['morphs'];
            setA({ ...a, morphs });
            void commit({ morphs });
          }}
        >
          <Icon name="wand" size={12} /> Randomize
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            const morphs = Object.fromEntries(Object.keys(a.morphs).map((k) => [k, 0])) as NpcAppearance['morphs'];
            setA({ ...a, morphs });
            void commit({ morphs });
          }}
        >
          Reset
        </button>
      </div>
      {FACE_GROUPS.map((g) => (
        <div key={g.title}>
          <h3 style={{ margin: '4px 0' }}>{g.title}</h3>
          {g.keys.map((k) => (
            <Field key={k} label={MORPH_LABEL[k]!.replace(`${g.title} `, '')} title={MORPH_LABEL[k]}>
              <Slider value={a.morphs[k] ?? 0} min={-1} max={1} step={0.01} onChange={(v) => set(k, v, false)} onCommit={(v) => set(k, v, true)} />
            </Field>
          ))}
        </div>
      ))}
    </div>
  );
}

function ColorsTab({ a, colors, commit }: { a: NpcAppearance; colors: { formKey: FormKey; editorId?: string; name?: string; color: { r: number; g: number; b: number } }[]; commit: (p: Partial<NpcAppearance>) => void }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div>
        <h3 style={{ margin: '0 0 6px' }}>Hair colour</h3>
        <div className="row wrap" style={{ gap: 6 }}>
          {colors.map((c) => (
            <div key={c.formKey} className={`color-swatch ${a.hairColor === c.formKey ? 'selected' : ''}`} style={{ background: toHex(c.color) }} title={c.name ?? c.editorId} onClick={() => commit({ hairColor: c.formKey })} />
          ))}
          {!colors.length && <span className="faint small">No colour forms loaded</span>}
        </div>
      </div>
      <Field label="Skin tone" title="Face texture lighting (QNAM)">
        <input type="color" className="input" value={toHex(a.skinTone)} onChange={(e) => commit({ skinTone: fromHex(e.target.value) })} />
      </Field>
      <Field label="Face texture">
        <FormPicker value={a.headTexture} sigs={['TXST']} onChange={(headTexture) => commit({ headTexture })} placeholder="Race default" />
      </Field>
    </div>
  );
}

function TintsTab({ a, commit }: { a: NpcAppearance; commit: (p: Partial<NpcAppearance>) => void }) {
  const set = (i: number, t: Partial<NpcAppearance['tints'][number]>) => commit({ tints: a.tints.map((x, j) => (j === i ? { ...x, ...t } : x)) });
  return (
    <div className="col" style={{ gap: 8 }}>
      <p className="dim small" style={{ margin: 0 }}>
        Face paint, dirt and complexion layers. The layer index refers to the race's tint masks.
      </p>
      {a.tints.map((t, i) => (
        <div key={i} className="card" style={{ padding: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="mono dim" style={{ width: 30 }}>
              #{t.index}
            </span>
            <input type="color" value={toHex({ r: t.color.r / 255, g: t.color.g / 255, b: t.color.b / 255 })} onChange={(e) => {
              const c = fromHex(e.target.value);
              void set(i, { color: { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255), a: t.color.a } });
            }} />
            <div className="grow">
              <Slider value={t.value} min={0} max={100} step={1} onCommit={(value) => set(i, { value })} />
            </div>
            <button className="btn icon ghost" title="Remove layer" onClick={() => commit({ tints: a.tints.filter((_, j) => j !== i) })}>
              <Icon name="close" size={12} />
            </button>
          </div>
        </div>
      ))}
      <button className="btn small" onClick={() => commit({ tints: [...a.tints, { index: (a.tints.reduce((m, t) => Math.max(m, t.index), 0) || 0) + 1, color: { r: 128, g: 128, b: 128, a: 0 }, value: 50, preset: 0 }] })}>
        <Icon name="plus" size={12} /> Add layer
      </button>
    </div>
  );
}
