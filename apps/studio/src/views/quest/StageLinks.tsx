/**
 * Quest stages and dialogue, in plain words: when a response can be said ("only once
 * stage 20 is reached", "after the quest is completed") and which stage it moves the
 * quest to. The full condition list and end script stay available under "Advanced".
 */
import { useEffect, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import { Checkbox, FormPicker, Help, Select, useQuery } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { InfoConditions, patchRecord } from './QuestDesigner';
import { readSetsStage, readWhen, stageLabel, writeSetsStage, writeWhen, type Item, type When, type WhenKind } from './stageLinks';

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
