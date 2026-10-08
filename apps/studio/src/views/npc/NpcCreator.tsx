/**
 * Character creator: edits an NPC's look the way the in-game RaceMenu does —
 * race, sex, head parts, sliders and colours — with a live 3D preview.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FACE_MORPHS, type FormKey } from '@tes5/esp';
import { CONTROL_HELP, REGION_CONTROLS_FOR, REGION_LABELS, emptySculpt, faceLookFor, type FaceRegion, type FaceSculpt, type HeadPartInfo, type NpcAppearance, type RegionControl } from '@tes5/workspace';
import { Checkbox, clearDraft, EmptyState, Field, FormPicker, Help, Icon, Modal, Select, Slider, Tabs, TextInput, useDebounced, useDraft, useQuery, DragNumber, useUniqueEditorId } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { HeadPreview, type PreviewPart } from './headPreview';

type Tab = 'body' | 'head' | 'face' | 'colors' | 'tints' | 'routine';

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
      {npc ? (
        <Creator key={npc} npc={npc} />
      ) : (
        <EmptyState
          icon="npc"
          title="Pick a character to edit"
          testId="npc-empty"
          actions={
            <button className="btn primary" onClick={() => useStore.getState().requestNew('npc')} title="Make a new character: pick a race and sex, then shape the face and choose what they wear">
              <Icon name="plus" /> New character
            </button>
          }
        >
          Choose someone in the list on the left to change their looks, outfit, items and routine, or make a new character from scratch.
        </EmptyState>
      )}
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
  const newRequest = useStore((s) => s.newRequest);
  useEffect(() => {
    if (newRequest && useStore.getState().takeNew('npc')) setCreating(true);
  }, [newRequest]);
  const [mine, setMine] = useState(false);
  const activePlugin = useStore((s) => s.session.activePlugin);
  const { data } = useQuery(() => client?.call('search', { sigs: ['NPC_'], query: dq, limit: 400, plugin: mine ? activePlugin : undefined }), [dq, mine, activePlugin]);
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
        {activePlugin && (
          <div style={{ marginTop: 4 }}>
            <Checkbox checked={mine} onChange={setMine} label={`Only ones in ${activePlugin}`} help="Show only the characters your plugin adds or changes." />
          </div>
        )}
      </div>
      <ul className="list scroll" style={{ flex: 1 }} data-testid="npc-list">
        {data?.items.map((i) => (
          <li key={i.formKey} className={`list-item ${npc === i.formKey ? 'selected' : ''}`} onClick={() => setNpc(i.formKey)} title={i.formKey}>
            <span className="name">{i.name ?? i.editorId}</span>
            {i.inActive && <span className="chip accent">edited</span>}
            <span className="meta">{i.name ? i.editorId : ''}</span>
          </li>
        ))}
        {data && data.total > data.items.length && <li className="list-item dim small" style={{ cursor: 'default' }}>Showing {data.items.length} of {data.total}. Type a name to find the rest.</li>}
        {data && !data.items.length && <li className="dim small" style={{ padding: '8px 10px', whiteSpace: 'normal' }}>{mine ? 'Your plugin has no characters yet. Click New to make one, or untick the box to see everyone.' : 'No character matches.'}</li>}
      </ul>
      {creating && <NewNpcDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewNpcDialog({ onClose }: { onClose: () => void }) {
  const [template, setTemplate] = useDraft<FormKey | null>('newNpc:template', useStore.getState().npc ?? null);
  const [edid, setEdid] = useUniqueEditorId('MyNewCharacter', 'newNpc:edid');
  const [name, setName] = useDraft('newNpc:name', 'New Character');
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
                clearDraft('newNpc:');
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
  const { data: savedSculpt } = useQuery(() => client?.call('faceSculpt', npc), [npc]);
  const { data: faceStatus } = useQuery(() => client?.call('faceStatus', npc), [npc]);
  const [a, setA] = useState<NpcAppearance | undefined>(saved);
  const [sculpt, setSculpt] = useState<FaceSculpt>(emptySculpt());
  const [shapeInfo, setShapeInfo] = useState<{ regions: string[]; extraMorphs: string[] }>({ regions: [], extraMorphs: [] });
  const [tab, setTab] = useState<Tab>('head');
  // Async loads finish later: they frame the camera for the page showing then, not the one when they started.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const previewEl = useRef<HTMLDivElement>(null);
  const preview = useRef<HeadPreview | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => setA(saved), [saved]);
  useEffect(() => setSculpt(savedSculpt ?? emptySculpt()), [savedSculpt]);

  const commit = async (p: Partial<NpcAppearance>) => {
    setA((cur) => (cur ? { ...cur, ...p } : cur));
    await engine((c) => c.call('setNpcAppearance', npc, p));
  };
  /** Record look and sculpt together, as one undo step. */
  const commitLook = async (p: Partial<NpcAppearance>, next: FaceSculpt) => {
    setA((cur) => (cur ? { ...cur, ...p } : cur));
    setSculpt(next);
    await engine((c) => c.call('setNpcLook', npc, p, next));
  };

  // The race's default head, eyes and mouth are part of the face too (vanilla characters list only what differs).
  const { data: race } = useQuery(() => client?.call('raceHeadData', a?.race ?? null, a?.female ?? false), [a?.race, a?.female]);
  const { data: faceParts } = useQuery(() => client?.call('npcFaceParts', npc), [npc, a?.headParts.join(','), a?.race, a?.female]);
  const previewParts = useMemo<PreviewPart[]>(
    () => (faceParts ?? []).map((p) => ({ key: p.formKey, type: p.type, model: p.model, tris: p.tris.filter((t) => t.file) })),
    [faceParts],
  );

  useEffect(() => {
    if (!previewEl.current || !client) return;
    const p = new HeadPreview(previewEl.current, client);
    p.onShaper = setShapeInfo;
    preview.current = p;
    (window as unknown as { __headPreview?: HeadPreview }).__headPreview = p;
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
      p.view(tabRef.current === 'body' ? 'body' : 'head');
    });
  }, [previewParts]);
  // The body and what they wear by default, so the Body page shows the whole character.
  const { data: actor } = useQuery(() => client?.call('actorModel', npc), [npc]);
  const bodyModels = (actor?.parts ?? []).filter((p) => p.kind !== 'head').map((p) => p.model);
  useEffect(() => {
    void preview.current?.setBody(bodyModels, a?.weight ?? 50).then(() => preview.current?.view(tabRef.current === 'body' ? 'body' : 'head'));
  }, [bodyModels.join('|'), a?.weight]);
  useEffect(() => preview.current?.view(tab === 'body' ? 'body' : 'head'), [tab]);
  const lookKey = a ? JSON.stringify([a.morphs, a.weight, a.faceParts, sculpt, race]) : '';
  useEffect(() => {
    // The same look the face files are baked from: race shape, weight, presets, vampire morph, sliders and sculpt.
    if (a && race) preview.current?.setLook(faceLookFor(a, race, sculpt));
  }, [lookKey, shapeInfo]);
  // The head as the game colours it: its texture times the baked face tint (skin tone and paint).
  const faceTexKey = a ? JSON.stringify([a.tints, a.skinTone, a.race, a.female, faceParts?.map((p) => p.formKey)]) : '';
  const { data: faceTex } = useQuery(() => (a && faceParts ? client?.call('previewFaceTexture', npc, a) : undefined), [faceTexKey], { revision: false });
  useEffect(() => preview.current?.setFaceTexture(faceTex ?? null), [faceTex, previewParts]);
  const hair = colors?.find((c) => c.formKey === a?.hairColor)?.color ?? null;
  useEffect(() => preview.current?.setColors(hair, a?.skinTone ?? null), [hair?.r, hair?.g, hair?.b, a?.skinTone.r, a?.skinTone.g, a?.skinTone.b, previewParts]);

  const generate = async () => {
    const r = await engine((c) => c.call('generateFaces', [npc]), { busy: 'Generating face files…' });
    if (r?.[0]) {
      useStore.getState().toast('success', `Face files written: ${r[0].mesh.split('\\').pop()} and ${r[0].tint.split('\\').pop()}`);
      for (const w of r[0].warnings) useStore.getState().toast('warning', w);
    }
  };
  const hasFace = !faceParts || faceParts.some((p) => p.type === 'Face' && !!p.model);

  return (
    <>
      <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
        <div ref={previewEl} style={{ flex: 1, minHeight: 0 }} data-testid="head-preview" />
        <div className="viewport-overlay viewport-hint">Drag to turn · wheel to zoom · Shift+drag to move up/down</div>
        <div style={{ position: 'absolute', left: 10, top: 10, right: 10 }} className="col">
          {faceStatus?.needed && (
            <div className="card small row" style={{ borderColor: 'var(--warn)', maxWidth: 560, gap: 10 }} data-testid="face-files">
              <div className="grow">
                <div className="warn" style={{ fontWeight: 600 }}>
                  <Icon name="warn" size={13} /> {faceStatus.present ? 'Face files are out of date' : 'This face needs its face files'}
                </div>
                <div className="dim">The game shows a dark or old face until they're made. They're also made when you save (Automations).</div>
              </div>
              <button className="btn primary small" onClick={() => void generate()} title="Bake this look (sliders, shapes and paint) into the head mesh and face tint the game loads, in your mod's Data folder. Undo removes them." data-testid="generate-face">
                <Icon name="wand" size={12} /> Generate face files
              </button>
            </div>
          )}
          {faceStatus?.template && (
            <div className="card small row" style={{ maxWidth: 560, gap: 10 }} data-testid="face-template">
              <div className="grow">
                <div style={{ fontWeight: 600 }}>Looks come from {faceStatus.templateName ?? 'a template'}</div>
                <div className="dim">This character uses its template's traits, so the game shows the template's face and no face files are needed. Change the face on the template instead.</div>
              </div>
              <button className="btn small" onClick={() => useStore.getState().setNpc(faceStatus.template!)} title="Open the template this character takes its looks from">
                Open template
              </button>
            </div>
          )}
          {faceStatus && !faceStatus.template && !faceStatus.needed && faceStatus.present && (
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="chip ok" title={`${faceStatus.paths.mesh}\n${faceStatus.paths.tint}`}>
                <Icon name="check" size={11} /> Face files up to date
              </span>
              {faceStatus.canBake && (
                <button className="btn small ghost" onClick={() => void generate()} title="Write this character's face files again from the current look (like Ctrl+F4 in the Creation Kit). Undo puts the old ones back." data-testid="regenerate-face">
                  Write again
                </button>
              )}
            </div>
          )}
          {!!missing.length && <div className="small faint">Preview: {missing.slice(0, 3).join(' · ')}</div>}
          {a && !hasFace && <div className="small warn">Neither this character nor their race has a head mesh, so there's no face to show or generate.</div>}
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
            { id: 'routine', label: 'Routine' },
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
            <FaceTab a={a} sculpt={sculpt} info={shapeInfo} preview={(next, sc) => (setA(next), setSculpt(sc))} commit={commitLook} />
          ) : tab === 'colors' ? (
            <ColorsTab a={a} colors={colors ?? []} commit={commit} />
          ) : tab === 'routine' ? (
            <RoutineTab npc={npc} />
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
  const client = useStore((s) => s.client);
  const byKey = new Map(parts.map((p) => [p.formKey, p]));
  // Only parts the race allows (its "valid races" list), for this sex — what the game's own creator offers.
  const { data: fitting } = useQuery(() => client?.call('headParts', { race: a.race, female: a.female }), [a.race, a.female]);
  const allowed = new Set((fitting ?? []).map((p) => p.formKey));
  const fits = (p: HeadPartInfo) => allowed.has(p.formKey);
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
              <span className="faint small">{options.length === 1 ? '1 option' : `${options.length} options`}</span>
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
      <h4 style={{ margin: '10px 0 4px' }}>Feature presets</h4>
      <p className="dim small" style={{ margin: '0 0 6px' }}>
        Which of the race's preset nose, eye and mouth shapes to start from (−1 = none). The sliders on the Face tab adjust from there.
      </p>
      {(['nose', 'eyes', 'mouth'] as const).map((k) => (
        <Field key={k} label={k === 'nose' ? 'Nose shape' : k === 'eyes' ? 'Eye shape' : 'Mouth shape'}>
          <DragNumber value={a.faceParts[k]} step={1} precision={0} min={-1} max={40} onCommit={(v) => commit({ faceParts: { ...a.faceParts, [k]: Math.round(v) } })} />
        </Field>
      ))}
    </div>
  );
}

type FacePage = FaceRegion | 'more';
const REGION_GROUP: Partial<Record<FaceRegion, string>> = { nose: 'Nose', eyes: 'Eyes', brows: 'Brows', cheeks: 'Cheeks', mouth: 'Mouth', jaw: 'Jaw', chin: 'Chin', head: 'Other' };
const CONTROL_LABEL: Record<RegionControl, string> = { size: 'Size', width: 'Width', height: 'Height', depth: 'Depth', up: 'Up / down', forward: 'Forward / back', apart: 'Apart / together', tilt: 'Tilt' };

/**
 * RaceMenu-style face page: pick a feature, then use the game's own sliders
 * for it and the extra shape sliders (size, width, move, apart, tilt…), plus
 * every extra morph the head parts carry. "Beyond game limits" lets sliders
 * go further than the game's creator does; it's all baked into the face files.
 */
function FaceTab({ a, sculpt, info, preview, commit }: { a: NpcAppearance; sculpt: FaceSculpt; info: { regions: string[]; extraMorphs: string[] }; preview: (a: NpcAppearance, s: FaceSculpt) => void; commit: (p: Partial<NpcAppearance>, s: FaceSculpt) => void }) {
  const [page, setPage] = useState<FacePage>('nose');
  const [beyond, setBeyond] = useState(() => Object.values(sculpt.extended).some((v) => v !== undefined && Math.abs(v) > 1) || Object.values(sculpt.morphs).some((v) => v > 1));
  const lim = beyond ? 3 : 1;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));

  const vanilla = (k: string, v: number, final: boolean) => {
    const morphs = { ...a.morphs, [k]: clamp(v) };
    const extended = { ...sculpt.extended };
    if (Math.abs(v) > 1) extended[k as keyof typeof extended] = v;
    else delete extended[k as keyof typeof extended];
    const next = { ...sculpt, extended };
    if (final) commit({ morphs }, next);
    else preview({ ...a, morphs }, next);
  };
  const region = (r: FaceRegion, c: RegionControl, v: number, final: boolean) => {
    const next = { ...sculpt, regions: { ...sculpt.regions, [r]: { ...(sculpt.regions[r] ?? {}), [c]: v } } };
    if (final) commit({}, next);
    else preview(a, next);
  };
  const morph = (name: string, v: number, final: boolean) => {
    const next = { ...sculpt, morphs: { ...sculpt.morphs, [name]: v } };
    if (final) commit({}, next);
    else preview(a, next);
  };
  const resetPage = () => {
    if (page === 'more') return commit({}, { ...sculpt, morphs: {} });
    const keys = FACE_GROUPS.find((g) => g.title === REGION_GROUP[page])?.keys ?? [];
    const morphs = { ...a.morphs };
    const extended = { ...sculpt.extended };
    for (const k of keys) {
      if (k === 'vampireMorph') continue;
      morphs[k] = 0;
      delete extended[k];
    }
    const regions = { ...sculpt.regions };
    delete regions[page];
    commit({ morphs }, { ...sculpt, extended, regions });
  };
  const randomize = () => {
    const r = (x: number) => Math.round((Math.random() * 2 - 1) * x * 100) / 100;
    const morphs = Object.fromEntries(Object.keys(a.morphs).map((k) => [k, k === 'vampireMorph' ? a.morphs[k as keyof typeof a.morphs] : r(0.7)])) as NpcAppearance['morphs'];
    const regions: FaceSculpt['regions'] = {};
    for (const reg of info.regions as FaceRegion[]) if (reg !== 'head') regions[reg] = { size: r(0.3), width: r(0.25), up: r(0.15) };
    commit({ morphs }, { ...sculpt, extended: {}, regions });
  };
  const resetAll = () => commit({ morphs: Object.fromEntries(Object.keys(a.morphs).map((k) => [k, 0])) as NpcAppearance['morphs'] }, emptySculpt());

  const pages: { id: FacePage; label: string; enabled: boolean }[] = [
    ...(['head', 'nose', 'eyes', 'brows', 'cheeks', 'mouth', 'jaw', 'chin', 'ears'] as FaceRegion[]).map((r) => ({ id: r as FacePage, label: r === 'head' ? 'Head' : REGION_LABELS[r].replace(' & lips', ''), enabled: info.regions.includes(r) || !info.regions.length })),
    { id: 'more', label: `More shapes${info.extraMorphs.length ? ` (${info.extraMorphs.length})` : ''}`, enabled: true },
  ];
  const changed = (p: FacePage) =>
    p === 'more'
      ? Object.values(sculpt.morphs).some((v) => !!v)
      : Object.values(sculpt.regions[p] ?? {}).some((v) => !!v) || (FACE_GROUPS.find((g) => g.title === REGION_GROUP[p])?.keys ?? []).some((k) => k !== 'vampireMorph' && !!a.morphs[k]);
  const groupKeys = page === 'more' ? [] : (FACE_GROUPS.find((g) => g.title === REGION_GROUP[page])?.keys ?? []);

  return (
    <div className="col" style={{ gap: 10 }} data-testid="face-tab">
      <div className="row wrap" style={{ gap: 4 }}>
        <button className="btn small" onClick={randomize} title="A random face: every game slider and a little of each feature's size, width and height">
          <Icon name="wand" size={12} /> Randomize
        </button>
        <button className="btn small ghost" onClick={resetAll} title="Every slider and shape back to the race's plain face (Undo brings it back)">
          Reset all
        </button>
        <span className="grow" />
        <Checkbox checked={beyond} onChange={setBeyond} label="Beyond game limits" help="Let sliders go further than the game's own character creator allows (up to 3× as far). The plugin keeps the in-game range; the full shape is baked into the face files, so it shows in game without SKSE or RaceMenu." />
      </div>
      <div className="chips" style={{ flexWrap: 'wrap' }} role="tablist">
        {pages.map((p) => (
          <button
            key={p.id}
            className={`chip ${page === p.id ? 'accent' : ''}`}
            style={{ cursor: p.enabled ? 'pointer' : 'not-allowed', opacity: p.enabled ? 1 : 0.5 }}
            disabled={!p.enabled}
            title={p.enabled ? (p.id === 'more' ? 'Extra morphs found in the head parts’ .tri files' : `Shape the ${REGION_LABELS[p.id as FaceRegion].toLowerCase()}`) : "This head's morphs don't say where this feature is"}
            onClick={() => setPage(p.id)}
            data-testid={`face-page-${p.id}`}
          >
            {p.label}
            {changed(p.id) && <span title="Changed"> •</span>}
          </button>
        ))}
      </div>

      {page === 'more' ? (
        info.extraMorphs.length ? (
          <div className="col" style={{ gap: 4 }}>
            <p className="dim small" style={{ margin: 0 }}>
              Extra shapes the head parts carry (from their .tri files), like the ones RaceMenu morph packs add.
            </p>
            {info.extraMorphs.map((m) => (
              <Field key={m} label={m.replace(/([a-z])([A-Z])/g, '$1 $2')} title={`Morph “${m}”: 0 = off, 1 = full${beyond ? ', 2 = exaggerated' : ''}`}>
                <Slider value={sculpt.morphs[m] ?? 0} min={0} max={beyond ? 2 : 1} step={0.01} onChange={(v) => morph(m, v, false)} onCommit={(v) => morph(m, v, true)} />
              </Field>
            ))}
          </div>
        ) : (
          <div className="empty small">These head parts have no extra morphs. Morph packs (such as those made for RaceMenu) add them to the head's .tri files; install one and they appear here.</div>
        )
      ) : (
        <>
          {groupKeys.length > 0 && (
            <div>
              <h4 style={{ margin: '2px 0 4px' }}>
                Game sliders <Help text="The sliders the game's own character creator has. Within −1…1 they're stored in the plugin as usual." />
              </h4>
              {groupKeys.map((k) => (
                <Field key={k} label={MORPH_LABEL[k]!.replace(`${REGION_GROUP[page as FaceRegion]} `, '')} title={MORPH_LABEL[k]}>
                  <Slider value={sculpt.extended[k] ?? a.morphs[k] ?? 0} min={-lim} max={lim} step={0.01} onChange={(v) => vanilla(k, v, false)} onCommit={(v) => vanilla(k, v, true)} />
                </Field>
              ))}
            </div>
          )}
          <div>
            <h4 style={{ margin: '2px 0 4px' }}>
              Shape <Help text="Extra sliders the game doesn't have, like RaceMenu's. They move and resize this feature (both sides together for eyes, brows, cheeks and ears) and are baked into the face files. The neck never moves, so the head still fits the body." />
            </h4>
            {REGION_CONTROLS_FOR[page as FaceRegion].map((c) => (
              <Field key={c} label={CONTROL_LABEL[c]} title={CONTROL_HELP[c]}>
                <Slider value={sculpt.regions[page as FaceRegion]?.[c] ?? 0} min={-lim} max={lim} step={0.01} onChange={(v) => region(page as FaceRegion, c, v, false)} onCommit={(v) => region(page as FaceRegion, c, v, true)} />
              </Field>
            ))}
          </div>
        </>
      )}
      <div className="row">
        <button className="btn small ghost" onClick={resetPage} disabled={!changed(page)} title="Put this page's sliders back to zero (Undo brings them back)">
          Reset {page === 'more' ? 'extra shapes' : REGION_LABELS[page as FaceRegion].toLowerCase()}
        </button>
      </div>
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

/** Face paint: the race's tint masks, by name, each with a colour and strength, and a preview of the baked tint. */
function TintsTab({ a, commit }: { a: NpcAppearance; commit: (p: Partial<NpcAppearance>) => void }) {
  const client = useStore((s) => s.client);
  const { data: masks } = useQuery(() => client?.call('raceTintMasks', a.race, a.female), [a.race, a.female]);
  const tintKey = JSON.stringify([a.tints, a.skinTone, a.race, a.female]);
  const { data: tint } = useQuery(() => client?.call('previewTint', a), [tintKey]);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current?.getContext('2d');
    if (!c || !tint) return;
    c.putImageData(new ImageData(new Uint8ClampedArray(tint.rgba), tint.width, tint.height), 0, 0);
  }, [tint]);
  const set = (i: number, t: Partial<NpcAppearance['tints'][number]>) => commit({ tints: a.tints.map((x, j) => (j === i ? { ...x, ...t } : x)) });
  const nameOf = (index: number) => masks?.find((m) => m.index === index)?.name;
  const unused = (masks ?? []).filter((m) => !a.tints.some((t) => t.index === m.index));
  const [adding, setAdding] = useState<number | ''>('');
  return (
    <div className="col" style={{ gap: 8 }} data-testid="paint-tab">
      <p className="dim small" style={{ margin: 0 }}>
        Face paint, dirt and complexion. Each layer colours one of the race's tint masks; the preview shows the face tint that's baked for the game.
      </p>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <canvas ref={canvas} width={128} height={128} style={{ width: 96, height: 96, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)' }} title="The face tint as it will be baked (the head's texture layout, unwrapped)" data-testid="tint-preview" />
        <div className="dim small grow">This is the head's texture laid flat, so features sit where the head's UVs put them.</div>
      </div>
      {!a.tints.length && <div className="empty small">No paint layers yet: the face is just the skin tone. Add one below.</div>}
      {a.tints.map((t, i) => (
        <div key={i} className="card" style={{ padding: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="grow small" title={`Race tint mask #${t.index}`} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {nameOf(t.index) ?? <span className="warn">#{t.index} (not in this race)</span>}
            </span>
            <input
              type="color"
              title="Layer colour"
              value={toHex({ r: t.color.r / 255, g: t.color.g / 255, b: t.color.b / 255 })}
              onChange={(e) => {
                const c = fromHex(e.target.value);
                void set(i, { color: { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255), a: t.color.a } });
              }}
            />
            <button className="btn icon ghost" title="Remove this layer (Undo brings it back)" onClick={() => commit({ tints: a.tints.filter((_, j) => j !== i) })}>
              <Icon name="close" size={12} />
            </button>
          </div>
          <Field label="Strength" title="0 = none, 100 = full colour where the mask is white">
            <Slider value={t.value} min={0} max={100} step={1} onCommit={(value) => set(i, { value })} />
          </Field>
        </div>
      ))}
      {masks && !masks.length ? (
        <div className="dim small">This race has no tint masks, so there's nothing to paint.</div>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          <div className="grow">
            <Select value={adding === '' ? '' : String(adding)} options={[{ value: '', label: unused.length ? 'Choose a layer…' : 'Every layer is used' }, ...unused.map((m) => ({ value: String(m.index), label: m.name }))]} onChange={(v) => setAdding(v === '' ? '' : Number(v))} />
          </div>
          <button
            className="btn small"
            disabled={adding === ''}
            title="Add this mask as a paint layer"
            onClick={() => {
              if (adding === '') return;
              const skin = masks?.find((m) => m.index === adding)?.type === 6;
              commit({ tints: [...a.tints, { index: adding, color: skin ? { r: Math.round(a.skinTone.r * 255), g: Math.round(a.skinTone.g * 255), b: Math.round(a.skinTone.b * 255), a: 0 } : { r: 120, g: 40, b: 40, a: 0 }, value: skin ? 100 : 50, preset: 0 }] });
              setAdding('');
            }}
            data-testid="add-tint"
          >
            <Icon name="plus" size={12} /> Add layer
          </button>
        </div>
      )}
    </div>
  );
}

const ACTIVITY_LABELS: Record<string, string> = { sandbox: 'Go about their business', stay: 'Stay put', sleep: 'Sleep', eat: 'Eat', travel: 'Travel to' };

/** What the character does with their day: their AI packages, in words, and a quick way to add one. */
function RoutineTab({ npc }: { npc: FormKey }) {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('npcRoutine', npc), [npc]);
  const [activity, setActivity] = useState<'sandbox' | 'stay' | 'sleep' | 'eat' | 'travel'>('sandbox');
  const [cell, setCell] = useState<FormKey | null>(null);
  const [timed, setTimed] = useState(false);
  const [from, setFrom] = useState(8);
  const [to, setTo] = useState(20);
  const available = data?.activities.find((a) => a.activity === activity)?.available ?? false;
  return (
    <div className="col" style={{ gap: 10 }} data-testid="npc-routine">
      <p className="dim small" style={{ margin: 0 }}>
        A character does the first activity whose hours fit; untimed ones fill the rest of the day. Quest behaviour (following the player, walking up to talk) comes from quests and isn't listed here.
      </p>
      {data?.packages.length ? (
        <ul className="list">
          {data.packages.map((p) => (
            <li key={p.formKey} className="list-item" title={p.editorId}>
              <span className="grow" style={{ whiteSpace: 'normal' }}>
                {p.text}
              </span>
              <button className="btn icon ghost" title="Remove from their routine (the package itself is kept)" onClick={() => engine((c) => c.call('removeNpcPackage', npc, p.formKey))}>
                <Icon name="close" size={11} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="dim small">No routine: they stand where they're placed. Add an activity below.</div>
      )}
      <div className="card col" style={{ gap: 6 }}>
        <div className="card-title">Add an activity</div>
        <Field label="Activity">
          <Select
            value={activity}
            options={Object.entries(ACTIVITY_LABELS).map(([value, label]) => ({ value: value as typeof activity, label }))}
            onChange={(a) => {
              setActivity(a);
              // Sensible hours for each activity.
              const [f, t] = a === 'sleep' ? [22, 6] : a === 'eat' ? [12, 13] : [8, 20];
              setFrom(f);
              setTo(t);
              if (a === 'sleep' || a === 'eat') setTimed(true);
            }}
          />
        </Field>
        <Field label="Where" title="Leave empty to do it around where they were placed in the world">
          <FormPicker value={cell} sigs={['CELL']} onChange={setCell} placeholder="Around where they stand" />
        </Field>
        <Checkbox checked={timed} onChange={setTimed} label="Only at certain hours" />
        {timed && (
          <div className="row" style={{ gap: 6 }}>
            <DragNumber value={from} min={0} max={23} step={1} precision={0} onCommit={setFrom} suffix=":00" />
            <span className="dim">to</span>
            <DragNumber value={to} min={0} max={23} step={1} precision={0} onCommit={setTo} suffix=":00" />
          </div>
        )}
        {!available && <div className="small warn">No “{activity}” package template in the load order.</div>}
        <button
          className="btn primary"
          disabled={!available || (activity === 'travel' && !cell)}
          title={activity === 'travel' && !cell ? 'Choose where they travel to' : 'Makes a package from the game’s template and adds it to their routine'}
          onClick={() => engine((c) => c.call('addNpcRoutine', npc, { activity, cell, hours: timed ? { from, to } : null }), { success: 'Added to their routine' })}
          data-testid="add-routine"
        >
          <Icon name="plus" size={12} /> Add
        </button>
      </div>
    </div>
  );
}
