/**
 * Quest stages and dialogue, in plain words: when a response can be said ("only once
 * stage 20 is reached", "after the quest is completed") and which stage it moves the
 * quest to. The full condition list and end script stay available under "Advanced".
 */
import { useEffect, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import { Checkbox, FormPicker, Help, Select, useQuery, useSummaries } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { InfoConditions, patchRecord } from './QuestDesigner';
import { linesByStage, readAvailability, readSetsStage, readWhen, stageLabel, writeAvailability, writeSetsStage, writeWhen, type Availability, type Item, type StageLine, type When, type WhenKind } from './stageConditions';

export interface StageOption {
  index: number;
  /** "20 – Find the ring" */
  label: string;
}

/** The quest's stages with their journal text, for dropdowns and chips. */
export function useStages(quest: FormKey): StageOption[] {
  const client = useStore((s) => s.client);
  const { data: q } = useQuery(() => client?.call('quest', quest), [quest]);
  return (q?.stages ?? []).map((s) => ({ index: s.index, label: stageLabel(s.index, s.logEntries.find((l) => l.text.trim())?.text) }));
}

function StageSelect({ stages, value, onChange, none }: { stages: StageOption[]; value: number | null; onChange: (v: number | null) => void; none?: string }) {
  const opts = stages.map((s) => ({ value: s.index, label: s.label }));
  if (value !== null && !opts.some((o) => o.value === value)) opts.push({ value, label: `${value} – (no such stage)` });
  const all = none ? [{ value: -1, label: none }, ...opts] : opts;
  return <Select<number> value={value ?? -1} options={all} onChange={(v) => onChange(v === -1 ? null : v)} />;
}

const WHEN_LABEL: Record<WhenKind, string> = {
  always: 'At any time',
  at: 'Only while the quest is at stage…',
  from: 'Once the quest has reached stage…',
  before: 'Only before the quest reaches stage…',
  thisDone: 'After this quest is completed',
  otherDone: 'After another quest is completed',
  custom: 'Several rules (see Advanced)',
};

const WHEN_HELP: Record<WhenKind, string> = {
  always: 'This line is not held back by the quest.',
  at: 'Said only while the quest is exactly at this stage. Once the quest moves on, it is no longer said.',
  from: 'Said once this stage has been reached, and from then on (even after the quest moves further).',
  before: 'Said until the quest reaches this stage, then never again.',
  thisDone: 'Said only after this quest has been completed.',
  otherDone: 'Said only after the quest you choose has been completed.',
  custom: 'This line has more than one stage or quest rule. Edit them under Advanced.',
};

/** "When can this be said?" for one response. */
export function InfoWhen({ info, quest }: { info: { formKey: FormKey }; quest: FormKey }) {
  const client = useStore((s) => s.client);
  const stages = useStages(quest);
  const { data: view } = useQuery(() => client?.call('view', info.formKey), [info.formKey]);
  const items = (((view?.data as any)?.conditions ?? []) as Item[]).filter(Boolean);
  const { when, others } = readWhen(items, quest);
  // "Another quest" has no condition until a quest is chosen, so the choice is remembered here meanwhile.
  const [kind, setKind] = useState<WhenKind>(when.kind);
  useEffect(() => setKind(when.kind), [when.kind, info.formKey]);
  const [advanced, setAdvanced] = useState(false);
  if (!view) return null;

  const save = (w: When) => patchRecord(info.formKey, 'Change when this is said', (d) => void (d.conditions = writeWhen(d.conditions ?? [], quest, w)));
  const firstStage = stages.find((s) => s.index > 0)?.index ?? stages[0]?.index ?? 10;
  const pick = (k: WhenKind) => {
    setKind(k);
    if (k === 'at' || k === 'from' || k === 'before') void save({ kind: k, stage: 'stage' in when ? when.stage : firstStage });
    else if (k === 'always' || k === 'thisDone') void save({ kind: k });
    else if (k === 'otherDone') void save(when.kind === 'otherDone' ? when : { kind: 'always' });
  };
  const kinds: WhenKind[] = ['always', 'at', 'from', 'before', 'thisDone', 'otherDone', ...(kind === 'custom' ? (['custom'] as const) : [])];

  return (
    <div className="col" style={{ gap: 6 }} data-testid="info-when">
      <div className="small" style={{ fontWeight: 600 }}>
        When can this be said?
        <Help text="Choose when the game is allowed to say this line, based on the quest. It adds an ordinary condition, so you can refine it under Advanced." />
      </div>
      <Select<WhenKind> value={kind} options={kinds.map((k) => ({ value: k, label: WHEN_LABEL[k] }))} onChange={pick} />
      {(kind === 'at' || kind === 'from' || kind === 'before') && when.kind === kind && <StageSelect stages={stages} value={when.stage} onChange={(stage) => stage !== null && void save({ kind, stage })} />}
      {kind === 'otherDone' && (
        <FormPicker value={when.kind === 'otherDone' ? when.quest : null} sigs={['QUST']} allowNone={false} placeholder="Choose a quest…" onChange={(q) => q && void save({ kind: 'otherDone', quest: q })} />
      )}
      <div className="dim small">{WHEN_HELP[kind]}</div>
      {others > 0 && (
        <div className="dim small">
          Also has {others} other condition{others === 1 ? '' : 's'} (such as gold, items or race).
        </div>
      )}
      <a className="small" href="#" onClick={(e) => (e.preventDefault(), setAdvanced(!advanced))}>
        {advanced ? 'Hide' : 'Advanced:'} all conditions ({items.length})
      </a>
      {advanced && <InfoConditions info={info} />}
    </div>
  );
}

/** "After this line": end the conversation, and move the quest to a stage. */
export function InfoAfter({ info, quest, goodbye }: { info: { formKey: FormKey }; quest: FormKey; goodbye: boolean }) {
  const client = useStore((s) => s.client);
  const stages = useStages(quest);
  const { data: code } = useQuery(() => client?.call('infoFragment', info.formKey, 'end'), [info.formKey]);
  const sets = readSetsStage(code ?? '');
  const choose = (stage: number | null) =>
    void engine(async (c) => {
      const current = (await c.call('infoFragment', info.formKey, 'end')) as string;
      const next = writeSetsStage(current, stage);
      if (next !== current) await c.call('setInfoFragment', info.formKey, 'end', next);
    });
  return (
    <div className="col" style={{ gap: 6 }} data-testid="info-after">
      <div className="small" style={{ fontWeight: 600 }}>
        After this line
        <Help text="What happens once the game has said this line. Moving the quest to a stage is the usual way a conversation advances a quest." />
      </div>
      <StageSelect stages={stages} value={sets} onChange={choose} none="Don’t change the quest" />
      <div className="dim small">{sets === null ? 'Choose a stage to move the quest there when this line is said.' : 'The quest moves to this stage when this line is said. It shows as an arrow on the map.'}</div>
      <Checkbox checked={goodbye} label="Ends the conversation" onChange={(on) => patchRecord(info.formKey, 'Goodbye flag', (d) => (d.data.flags = on ? d.data.flags | 1 : d.data.flags & ~1))} />
    </div>
  );
}

/**
 * Quest-wide dialogue availability: the quest's own dialogue conditions, which apply to every
 * line of the quest. A line's own "When can this be said?" narrows it further; both must be true.
 */
export function DialogueAvailability({ quest }: { quest: FormKey }) {
  const client = useStore((s) => s.client);
  const stages = useStages(quest);
  const { data: view } = useQuery(() => client?.call('view', quest), [quest]);
  if (!view) return null;
  const items = (((view.data as any).dialogueConditions ?? []) as Item[]).filter(Boolean);
  const { availability, others } = readAvailability(items, quest);
  const save = (a: Availability) => patchRecord(quest, 'Change dialogue availability', (d) => void (d.dialogueConditions = writeAvailability(d.dialogueConditions ?? [], quest, a)));
  const firstStage = stages.find((s) => s.index > 0)?.index ?? stages[0]?.index ?? 10;
  return (
    <div className="col" style={{ gap: 6 }} data-testid="dialogue-availability">
      <Select<string>
        value={availability.from === null ? 'running' : 'from'}
        options={[
          { value: 'running', label: 'Whenever the quest is running' },
          { value: 'from', label: 'Once the quest has reached stage…' },
        ]}
        onChange={(v) => void save({ ...availability, from: v === 'from' ? firstStage : null })}
      />
      {availability.from !== null && <StageSelect stages={stages} value={availability.from} onChange={(from) => from !== null && void save({ ...availability, from })} />}
      <Checkbox
        checked={availability.stopAtDone}
        onChange={(stopAtDone) => void save({ ...availability, stopAtDone })}
        label="Stop offering it once the quest is completed"
        help="Adds a rule to the quest's dialogue so none of its lines are said after the quest has been completed."
      />
      <div className="dim small">
        This applies to every line of the quest. A line’s own “When can this be said?” narrows it further (both must be true).
        {others > 0 && ` The quest also has ${others} other dialogue condition${others === 1 ? '' : 's'}, in the properties panel.`}
      </div>
    </div>
  );
}

const RELATION: Record<StageLine['relation'], { label: string; hint: string }> = {
  only: { label: 'Only said at this stage', hint: 'These lines are said only while the quest is at this stage.' },
  from: { label: 'Said from this stage on', hint: 'These lines can be said once the quest has reached this stage.' },
  until: { label: 'Said until this stage', hint: 'These lines stop being said when the quest reaches this stage.' },
  sets: { label: 'Moves the quest here', hint: 'Saying these lines moves the quest to this stage.' },
};

/** The dialogue tied to each stage, for the Stages tab: what is said at it and what moves the quest to it. */
export function useStageDialogue(quest: FormKey) {
  const client = useStore((s) => s.client);
  const { data: g } = useQuery(() => client?.call('dialogueGraph', quest), [quest]);
  const summaries = useSummaries((g?.infos ?? []).map((i) => i.speaker));
  const byStage = linesByStage(g?.infos ?? []);
  const info = (key: FormKey) => {
    const i = g?.infos.find((x) => x.formKey === key);
    const sp = i?.speaker ? summaries[i.speaker] : null;
    return { text: i?.lines.find((l) => l.trim()) ?? '(no text)', speaker: sp?.name ?? sp?.editorId ?? (i?.speaker ? String(i.speaker) : 'Anyone') };
  };
  return { loaded: !!g, byStage, info };
}

/** One stage's linked dialogue; clicking a line opens it in the dialogue graph. */
export function StageDialogue({ stage, dialogue, onOpenLine }: { stage: number; dialogue: ReturnType<typeof useStageDialogue>; onOpenLine: (info: FormKey) => void }) {
  if (!dialogue.loaded) return null;
  const lines = dialogue.byStage.get(stage) ?? [];
  return (
    <div className="col" style={{ gap: 4 }} data-testid={`stage-dialogue-${stage}`}>
      <div className="small" style={{ fontWeight: 600 }}>
        Dialogue
        <Help text="The responses tied to this stage. Click one to open it in the Dialogue tab, where you change when it's said and what it does." />
      </div>
      {lines.length === 0 ? (
        <div className="dim small">No dialogue is tied to this stage yet. In the Dialogue tab, pick a response and set when it is said, or have it move the quest here.</div>
      ) : (
        (Object.keys(RELATION) as StageLine['relation'][]).map((rel) => {
          const mine = lines.filter((l) => l.relation === rel);
          return mine.length ? (
            <div key={rel} className="col" style={{ gap: 2 }}>
              <div className="dim small" title={RELATION[rel].hint}>
                {RELATION[rel].label}
              </div>
              {mine.map((l) => {
                const i = dialogue.info(l.info);
                return (
                  <a key={l.info} href="#" className="small" data-testid="stage-dialogue-line" title="Open this response in the Dialogue tab" onClick={(e) => (e.preventDefault(), onOpenLine(l.info))}>
                    {i.speaker}: “{i.text.length > 70 ? `${i.text.slice(0, 69)}…` : i.text}”
                  </a>
                );
              })}
            </div>
          ) : null;
        })
      )}
    </div>
  );
}
