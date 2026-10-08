/**
 * Quest from writing: paste a design document or just a conversation,
 * The AI (Claude, or a free one) plans the whole quest, you check and adjust the plan, and it's
 * built (characters, items, stages, journal, objectives, triggers,
 * dialogue) as one undo step.
 */
import { useEffect, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import type { PlanIssue, PlanResolution, PlannerMode, QuestBuildReport, QuestPlan } from '@tes5/workspace';
import { clearDraft, Field, Help, Icon, Modal, Select, TextInput, useDraft } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { AiPicker, useAi } from '../../components/AiPicker';

type Review = { plan: QuestPlan; issues: PlanIssue[]; resolution: PlanResolution[] };
type PlanSection = 'overview' | 'cast' | 'story' | 'events' | 'dialogue';

const MODES: { id: PlannerMode; title: string; text: string; placeholder: string }[] = [
  {
    id: 'document',
    title: 'A design document',
    text: 'Describe the quest in your own words: who, where, what the player does, how it ends. Or just describe characters to create or change (what they wear, carry, belong to, look like).',
    placeholder: 'Brynja, the innkeeper, has lost her ring. The player asks her for work and she asks them to find it…',
  },
  {
    id: 'conversation',
    title: 'A conversation',
    text: 'Just write the dialogue, no tags needed. The AI works out the quest around it and adds the stages, journal and objectives.',
    placeholder: 'Player: Got any work?\nBrynja: I lost my mother’s ring. Find it and I’ll pay you.\nPlayer: I found your ring!\nBrynja: Thank the gods! Here, take this.',
  },
];

export default function QuestFromText({ onClose, existing }: { onClose: () => void; existing?: FormKey }) {
  const [step, setStep] = useState<'write' | 'review' | 'done'>(existing ? 'review' : 'write');
  const [fromRecord, setFromRecord] = useState(true);
  // What was written is remembered if the box is closed before the quest is built.
  const [mode, setMode] = useDraft<PlannerMode>(existing ? undefined : 'questFromText:mode', 'document');
  const [source, setSource] = useDraft(existing ? undefined : 'questFromText:source', '');
  const [review, setReview] = useState<Review>();
  const [report, setReport] = useState<QuestBuildReport>();
  // Changing an existing quest: start from it as a plan.
  useEffect(() => {
    if (!existing) return;
    void engine((c) => c.call('questPlanFor', existing), { refreshSession: false }).then((r) => {
      if (!r) return onClose();
      setFromRecord(r.fromRecord);
      setReview({ plan: r.plan, issues: r.issues, resolution: r.resolution });
    });
  }, [existing]);

  return (
    <Modal
      className="wide"
      title={
        <span className="row" style={{ gap: 6 }}>
          <Icon name="wand" /> {existing ? 'Change the quest with a plan' : 'Quest from writing'}
          <span className="dim small" style={{ fontWeight: 400 }}>
            {existing ? (step === 'review' ? 'Change the plan, then update' : 'Updated') : step === 'write' ? '1. Write' : step === 'review' ? '2. Check the plan' : '3. Built'}
          </span>
        </span>
      }
      onClose={onClose}
      footer={null}
    >
      {step === 'write' && (
        <Write
          mode={mode}
          setMode={setMode}
          source={source}
          setSource={setSource}
          onPlanned={(r) => {
            setReview(r);
            setStep('review');
          }}
          onClose={onClose}
        />
      )}
      {step === 'review' && existing && !review && <div className="empty">Reading the quest…</div>}
      {step === 'review' && existing && review && !fromRecord && (
        <p className="small warn" style={{ marginTop: 0 }} data-testid="not-from-plan">
          This quest wasn't built from a plan, so this plan was read from it. Updating applies your changes, but its existing dialogue is kept as it is (add new conversations, or change dialogue in the Dialogue tab).
        </p>
      )}
      {step === 'review' && review && (
        <ReviewPlan
          existing={existing}
          review={review}
          setReview={setReview}
          source={source}
          onBack={existing ? onClose : () => setStep('write')}
          onBuilt={(r) => {
            clearDraft('questFromText:');
            setReport(r);
            setStep('done');
          }}
        />
      )}
      {step === 'done' && report && <Result report={report} onClose={onClose} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ 1. write

function Write({ mode, setMode, source, setSource, onPlanned, onClose }: { mode: PlannerMode; setMode: (m: PlannerMode) => void; source: string; setSource: (s: string) => void; onPlanned: (r: Review) => void; onClose: () => void }) {
  const { ai, ready, name } = useAi();
  const m = MODES.find((x) => x.id === mode)!;

  const plan = async () => {
    const r = await engine((c) => c.call('planQuest', source, mode, ai), { busy: `${name} is planning the quest… this can take ${ai.kind === 'claude' ? 'a minute or two' : 'several minutes on a free model'}`, refreshSession: false });
    if (r) onPlanned(r);
  };
  const example = async () => {
    const r = await engine(
      async (c) => {
        const ex = await c.call('questPlanExample');
        setMode('document');
        setSource(ex.document);
        return { plan: ex.plan, ...(await c.call('reviewQuestPlan', ex.plan)) };
      },
      { refreshSession: false },
    );
    if (r) onPlanned(r);
  };

  return (
    <div className="col" style={{ gap: 12 }} data-testid="quest-from-text">
      <div className="kind-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {MODES.map((x) => (
          <button key={x.id} className={`kind-card ${mode === x.id ? 'selected' : ''}`} onClick={() => setMode(x.id)} aria-pressed={mode === x.id} style={{ borderColor: mode === x.id ? 'var(--accent)' : undefined }}>
            <div style={{ fontWeight: 600 }}>{x.title}</div>
            <div className="dim small">{x.text}</div>
          </button>
        ))}
      </div>
      <textarea className="input mono" data-testid="plan-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder={m.placeholder} rows={14} style={{ width: '100%', resize: 'vertical', fontSize: 12 }} autoFocus />
      <div className="card" style={{ padding: 10 }}>
        <AiPicker />
        <p className="dim small" style={{ margin: '6px 0 0' }}>
          Nothing is built yet: you'll see the plan first, with every decision {name} made on its own, and can change it.
        </p>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => void example()} data-testid="use-example" title="Load an example design document and a ready-made plan for it (no AI needed)">
          Use the example
        </button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!source.trim() || !ready} onClick={() => void plan()} title={!ready ? 'Choose an AI first (above)' : !source.trim() ? 'Write something first' : `${name} reads your text and plans the whole quest; you check it before anything is built`} data-testid="plan-quest">
          <Icon name="wand" size={13} /> Plan the quest
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 2. review

function ReviewPlan({ review, setReview, source, onBack, onBuilt, existing }: { review: Review; setReview: (r: Review) => void; source: string; onBack: () => void; onBuilt: (r: QuestBuildReport) => void; existing?: FormKey }) {
  const [preview, setPreview] = useState<string[] | null>(null);
  const { ai, ready: aiOk, name: aiLabel } = useAi();
  const { plan, issues, resolution } = review;
  const [feedback, setFeedback] = useState('');
  const [draft, setDraft] = useState(plan);
  useEffect(() => setDraft({ ...plan, events: plan.events ?? [] }), [plan]);
  const [history, setHistory] = useState<QuestPlan[]>([]);

  // Re-check after hand edits (each one can be undone).
  const check = async (next: QuestPlan) => {
    setDraft(next);
    const r = await engine((c) => c.call('reviewQuestPlan', next), { refreshSession: false });
    if (r) setReview({ plan: next, ...r });
  };
  const edit = async (fn: (p: QuestPlan) => void) => {
    const next = structuredClone(draft);
    fn(next);
    setHistory((h) => [...h.slice(-49), draft]);
    await check(next);
  };
  const undoEdit = async () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    await check(prev);
  };
  const revise = async () => {
    const r = await engine((c) => c.call('reviseQuestPlan', draft, feedback, ai, source), { busy: `${aiLabel} is changing the plan…`, refreshSession: false });
    if (r) {
      setReview(r);
      setFeedback('');
    }
  };
  const journal = async (claude: boolean) => {
    const r = await engine((c) => c.call('planJournal', draft, claude ? ai : undefined), { busy: claude ? `${aiLabel} is writing the journal…` : undefined, refreshSession: false });
    if (r) setReview(r);
  };
  const build = async () => {
    if (existing) {
      // Show what will change first.
      const p = await engine((c) => c.call('previewQuestUpdate', existing, draft), { refreshSession: false });
      if (p) setPreview(p);
      return;
    }
    const r = await engine((c) => c.call('buildQuestPlan', draft), { busy: 'Building the quest…', success: `Built ${draft.title}` });
    if (r) onBuilt(r);
  };
  const update = async () => {
    const r = await engine((c) => c.call('updateQuestFromPlan', existing!, draft), { busy: 'Updating the quest…', success: `Updated ${draft.title}` });
    if (r) onBuilt(r);
  };

  const errors = issues.filter((i) => i.severity === 'error').length + resolution.filter((r) => r.error).length;
  const [section, setSection] = useState<PlanSection>('overview');
  const quest = draft.stages.length > 0;
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const sections: { id: PlanSection; label: string; hint: string; count?: number; summary: string }[] = [
    { id: 'overview', label: 'Overview', hint: `Name, problems to fix, and what ${aiLabel} decided on its own`, count: errors || undefined, summary: '' },
    { id: 'cast', label: 'Cast & places', hint: 'Characters (with roles and fighting), places, items and enemy groups', count: draft.characters.length + draft.locations.length + draft.items.length + (draft.encounters?.length ?? 0), summary: [n(draft.characters.length, 'character'), n(draft.locations.length, 'place'), n(draft.items.length, 'item'), draft.encounters?.length ? n(draft.encounters.length, 'enemy group') : ''].filter(Boolean).join(', ') },
    ...(quest
      ? [
          { id: 'story' as const, label: 'Story', hint: 'How it starts, stages and journal, objectives, what moves it on, how it can fail', count: draft.stages.length, summary: `${n(draft.stages.length, 'stage')}, ${n(draft.objectives.length, 'objective')}, ${n(draft.steps.length, 'step')}${draft.failures?.length ? `, ${n(draft.failures.length, 'way', 'ways')} to fail` : ''}` },
          { id: 'events' as const, label: 'World events', hint: 'What happens in the world when a stage is reached', count: draft.events?.length || undefined, summary: draft.events?.length ? n(draft.events.length, 'event') : 'nothing yet' },
        ]
      : []),
    { id: 'dialogue', label: 'Dialogue', hint: 'The conversations, as scripts you can edit', count: draft.conversations.length || undefined, summary: draft.conversations.length ? n(draft.conversations.length, 'conversation') : 'none yet' },
  ];
  const res = (key: string) => resolution.find((r) => r.key === key);
  const nameOf = (key: string | null) => (key ? (res(key)?.name ?? key) : '');

  return (
    <div className="col" style={{ gap: 12 }} data-testid="plan-review">
      {preview && (
        <Modal title="Update the quest?" onClose={() => setPreview(null)} footer={
          <>
            <button className="btn" onClick={() => setPreview(null)}>Keep editing</button>
            <button className="btn primary" onClick={() => void update()} disabled={preview.length === 1 && preview[0] === 'Nothing needs changing'} data-testid="confirm-update">
              Update the quest
            </button>
          </>
        }>
          <ul className="always-list" data-testid="update-preview">
            {preview.map((p) => (
              <li key={p}>
                <Icon name="chevron" size={12} />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <p className="dim small">Only these parts change; everything else (including edits you made by hand) stays. One undo takes it all back.</p>
        </Modal>
      )}
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="grow col" style={{ gap: 4 }}>
          <Field label={draft.stages.length ? 'Quest name' : 'Name'}>
            <TextInput value={draft.title} onCommit={(v) => void edit((p) => void (p.title = v))} />
          </Field>
          <Field label="Editor ID">
            <TextInput value={draft.editorId} onCommit={(v) => void edit((p) => void (p.editorId = v))} mono />
          </Field>
          <p className="dim small" style={{ margin: 0 }}>
            {draft.summary}
          </p>
        </div>
      </div>

      <div className="panel-tabs plan-tabs" role="tablist" data-testid="plan-tabs">
        {sections.map((t) => (
          <button key={t.id} role="tab" aria-selected={section === t.id} className={`panel-tab ${section === t.id ? 'active' : ''}`} onClick={() => setSection(t.id)} title={t.hint} data-testid={`plan-tab-${t.id}`}>
            {t.label}
            {t.count ? <span className={`chip ${t.id === 'overview' && errors ? 'err' : 'dim'}`} style={{ marginLeft: 6 }}>{t.count}</span> : null}
          </button>
        ))}
      </div>

      {section === 'overview' && (
        <>
      {(issues.length > 0 || resolution.some((r) => r.error)) && (
        <ul className="list release-list" data-testid="plan-issues">
          {[...resolution.filter((r) => r.error).map((r) => ({ severity: 'error' as const, message: r.error! })), ...issues].map((i, n) => (
            <li key={n} className={`release-item ${i.severity}`}>
              <span className={`chip ${i.severity === 'error' ? 'err' : 'warn'}`} style={{ flex: 'none' }}>
                {i.severity === 'error' ? 'Must fix' : 'Check'}
              </span>
              <span className="grow">{i.message}</span>
            </li>
          ))}
        </ul>
      )}

      {(draft.questions.length > 0 || draft.assumptions.length > 0) && (
        <div className="card" data-testid="plan-assumptions">
          <div className="card-title">
            Check these
            <Help text={`${aiLabel} decided these on its own because your text didn't say. If one is wrong, say what you want below (“Ask the AI to change the plan”).`} />
          </div>
          <ul className="always-list">
            {draft.questions.map((q) => (
              <li key={q} className="question">
                <Icon name="warn" size={12} />
                <span>{q}</span>
              </li>
            ))}
            {draft.assumptions.map((a) => (
              <li key={a}>
                <Icon name="check" size={12} />
                <span className="dim">{a}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card" data-testid="plan-contents">
        <div className="card-title">In this plan</div>
        <ul className="always-list">
          {sections.filter((t) => t.id !== 'overview').map((t) => (
            <li key={t.id}>
              <Icon name="chevron" size={12} />
              <button className="link-button" onClick={() => setSection(t.id)}>{t.label}</button>
              <span className="dim">{t.summary}</span>
            </li>
          ))}
        </ul>
      </div>
        </>
      )}

      {section !== 'overview' && errors > 0 && (
        <ul className="list release-list" data-testid="plan-issues">
          {[...resolution.filter((r) => r.error).map((r) => r.error!), ...issues.filter((i) => i.severity === 'error').map((i) => i.message)].map((m, n) => (
            <li key={n} className="release-item error">
              <span className="chip err" style={{ flex: 'none' }}>
                Must fix
              </span>
              <span className="grow">{m}</span>
            </li>
          ))}
        </ul>
      )}

      {section === 'cast' && (
        <>
      <div className="card-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
        {(['character', 'location', 'item'] as const).map((kind) => {
          const list = resolution.filter((r) => r.kind === kind);
          if (!list.length) return null;
          return (
            <div key={kind} className="card">
              <div className="card-title">{kind === 'character' ? 'Characters' : kind === 'location' ? 'Places' : 'Items'}</div>
              <ul className="list">
                {list.map((r) => (
                  <li key={r.key} className="list-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} title={kind === 'character' ? draft.characters.find((c) => c.key === r.key)?.role : undefined}>
                    <span>
                      {r.name} <span className={`chip ${r.error ? 'err' : r.existing ? 'dim' : 'accent'}`}>{r.error ? 'not found' : r.existing ? (r.changes?.length ? 'existing, changed' : 'existing') : 'new'}</span>
                    </span>
                    <span className="dim small" style={{ whiteSpace: 'normal' }}>
                      {r.text}
                    </span>
                    {kind === 'location' && !r.existing && !r.error && <NewPlaceFields plan={draft} placeKey={r.key} edit={edit} />}
                    {kind === 'character' && !r.error && <CharacterRoleFields plan={draft} charKey={r.key} edit={edit} />}
                    {r.changes?.map((c) => (
                      <span key={c} className="small" style={{ whiteSpace: 'normal' }} data-testid="character-change">
                        • {c}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {draft.stages.length === 0 && <div className="card dim small">No quest: only the characters, places and items above are created or changed.</div>}
      <EncountersCard plan={draft} edit={edit} nameOf={nameOf} />
        </>
      )}

      {section === 'story' && draft.stages.length > 0 && (
        <>
      <StartCard plan={draft} edit={edit} />
      <div className="card" data-testid="plan-stages">
        <div className="card-title row" style={{ gap: 6 }}>
          Stages and journal
          <Help text="Each stage is a point in the quest. The journal text appears in the player's quest journal when the stage is reached." />
          <span className="grow" />
          <button className="btn small ghost" onClick={() => void journal(false)} title="Fill in empty journal entries and missing objectives from what moves the quest on" data-testid="plan-draft-journal">
            Draft missing journal
          </button>
          <button className="btn small ghost" disabled={!aiOk} onClick={() => void journal(true)} title={aiOk ? `${aiLabel} writes the missing journal entries and objectives in the style of the game` : 'Choose an AI on the first page'} data-testid="journal-ai">
            <Icon name="wand" size={12} /> Word with {ai.kind === 'claude' ? 'Claude' : 'the AI'}
          </button>
        </div>
        <div className="col" style={{ gap: 6 }}>
          {[...draft.stages]
            .sort((a, b) => a.index - b.index)
            .map((s) => {
              const shown = draft.objectives.filter((o) => o.shownAtStage === s.index);
              return (
                <div key={s.index} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <span className="chip" style={{ flex: 'none', minWidth: 38, justifyContent: 'center' }}>
                    {s.index}
                  </span>
                  <div className="grow col" style={{ gap: 2 }}>
                    <TextInput value={s.journal} placeholder="(no journal entry)" multiline onCommit={(v) => void edit((p) => void (p.stages.find((x) => x.index === s.index)!.journal = v))} />
                    <span className="dim small">
                      {[s.startsQuest && 'Starts the quest', s.completesQuest && 'Completes the quest', s.failsQuest && 'Fails the quest', ...shown.map((o) => `Shows “${o.text}”`), ...draft.animations.filter((a) => a.atStage === s.index).map((a) => `${nameOf(a.characterKey)}: ${a.gesture}`), ...(draft.events ?? []).filter((e) => e.atStage === s.index).map((e) => e.note)].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      <div className="card-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
        <div className="card">
          <div className="card-title">Objectives</div>
          <div className="col" style={{ gap: 6 }}>
            {draft.objectives.map((o) => (
              <div key={o.index} className="col" style={{ gap: 2 }}>
                <TextInput value={o.text} onCommit={(v) => void edit((p) => void (p.objectives.find((x) => x.index === o.index)!.text = v))} />
                <span className="dim small">
                  Shown at stage {o.shownAtStage}
                  {o.completedAtStage !== null && `, done at ${o.completedAtStage}`}
                  {o.targetKey && ` · marker on ${nameOf(o.targetKey)}`}
                </span>
              </div>
            ))}
            {!draft.objectives.length && <span className="dim small">No objectives.</span>}
          </div>
        </div>
        <div className="card" data-testid="plan-steps">
          <div className="card-title">
            What moves it on
            <Help text="What makes the quest go from one stage to the next. These become triggers on the quest's aliases, stage scripts and dialogue, and show up as arrows on the quest map." />
          </div>
          <ul className="always-list">
            {draft.steps.map((s, i) => (
              <li key={i}>
                <Icon name="route" size={12} />
                <span>
                  {s.from === null ? 'Any time' : `Stage ${s.from}`} → {s.to}: {[STEP_VERBS[s.kind], nameOf(s.targetKey)].filter(Boolean).join(' ')} <span className="dim">({s.note})</span>
                </span>
              </li>
            ))}
            {draft.rewards.map((r, i) => (
              <li key={`r${i}`}>
                <Icon name="flag" size={12} />
                <span>
                  At stage {r.atStage} the player gets {[r.gold && `${r.gold} gold`, r.itemKey && nameOf(r.itemKey)].filter(Boolean).join(' and ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <FailuresCard plan={draft} edit={edit} nameOf={nameOf} />
        </>
      )}

      {section === 'events' && draft.stages.length > 0 && <EventsCard plan={draft} edit={edit} nameOf={nameOf} />}

      {section === 'dialogue' && (
        <>
          {!draft.conversations.length && <p className="dim small">No conversations in this plan. Ask the AI below to write some (“Brynja greets the player and asks for help”).</p>}
      {draft.conversations.map((c, i) => (
        <div key={i} className="card">
          <div className="card-title">
            Conversation: {c.title}
            <Help text="Each top-level PLAYER line is something the player can say; indented lines are choices and answers. Tags: [stage N] sets a stage, [if stage N] only offers the line at that stage, [goodbye] ends the conversation, [gives item xN] / [takes item xN] hand items over, [emotion happy] sets the delivery, [remember spared] stores a choice and [if chose spared] only offers a line after it." />
          </div>
          <div className="plan-screenplay">
            <TextInput value={c.screenplay} multiline mono onCommit={(v) => void edit((p) => void (p.conversations[i]!.screenplay = v))} />
          </div>
        </div>
      ))}

        </>
      )}

      <div className="plan-footer col" style={{ gap: 8 }}>
      <div className="card" style={{ padding: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input grow"
            placeholder={`Ask ${aiLabel} to change the plan, e.g. “Make Eirik the thief, and let the player keep the ring for a reward”`}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && feedback.trim() && aiOk && void revise()}
            data-testid="plan-feedback"
          />
          <button className="btn" disabled={!feedback.trim() || !aiOk} onClick={() => void revise()} title={!aiOk ? 'Choose an AI on the first page' : `${aiLabel} changes the plan as you describe; Undo edit puts it back`}>
            Change
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <button className="btn ghost" disabled={!history.length} onClick={() => void undoEdit()} title={history.length ? 'Take back your last change to the plan' : 'Nothing to undo yet'} data-testid="plan-undo">
          <Icon name="undo" size={13} /> Undo edit
        </button>
        <span className="grow" />
        {errors > 0 && (
          <button className="link-button small err" onClick={() => setSection('overview')} title="Show the problems on the Overview tab" data-testid="plan-show-problems">
            Fix {errors} problem(s) first
          </button>
        )}
        <button className="btn primary" disabled={errors > 0} onClick={() => void build()} data-testid="build-quest" title={existing ? 'Shows what will change before anything is changed' : 'Creates everything as one step you can undo'}>
          <Icon name="check" size={13} /> {existing ? 'See what will change' : draft.stages.length ? 'Build the quest' : 'Make the changes'}
        </button>
      </div>
      </div>
    </div>
  );
}

const TRAIN_SKILLS = ['One-handed', 'Two-handed', 'Archery', 'Block', 'Smithing', 'Heavy Armor', 'Light Armor', 'Pickpocket', 'Lockpicking', 'Sneak', 'Alchemy', 'Speech', 'Alteration', 'Conjuration', 'Destruction', 'Illusion', 'Restoration', 'Enchanting'];

/** A character's roles and how they fight, as switches (folded away until opened). */
function CharacterRoleFields({ plan, charKey, edit }: { plan: QuestPlan; charKey: string; edit: (fn: (p: QuestPlan) => void) => Promise<void> }) {
  const c = plan.characters.find((x) => x.key === charKey);
  if (!c) return null;
  const roles = c.roles ?? { follower: false, marriage: false, innkeeper: false, merchant: null, trainer: null };
  const combat = c.combat ?? { hostile: null, levelScaled: null, skills: [], spells: [], perks: [], combatStyle: null };
  const setRoles = (change: Partial<typeof roles>) => void edit((p) => void (p.characters.find((x) => x.key === charKey)!.roles = { ...roles, ...change }));
  const setCombat = (change: Partial<typeof combat>) => void edit((p) => void (p.characters.find((x) => x.key === charKey)!.combat = { ...combat, ...change }));
  const tick = (label: string, title: string, checked: boolean, on: (v: boolean) => void, testId: string) => (
    <label className="row small" style={{ gap: 4 }} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => on(e.target.checked)} data-testid={testId} />
      {label}
    </label>
  );
  return (
    <details className="small" style={{ width: '100%', marginTop: 2 }} data-testid="character-roles">
      <summary className="dim" style={{ cursor: 'pointer' }} title="Follower, merchant, trainer, marriage, and whether they attack the player">
        Roles and fighting
      </summary>
      <div className="col" style={{ gap: 4, marginTop: 4 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          {tick('Follower', 'Can be asked to follow the player (the game’s own follower dialogue)', roles.follower, (v) => setRoles({ follower: v }), 'role-follower')}
          {tick('Marriage', 'Can be married by a player wearing the Amulet of Mara', roles.marriage, (v) => setRoles({ marriage: v }), 'role-marriage')}
          {tick('Innkeeper', 'Runs an inn: sells food and drink', roles.innkeeper, (v) => setRoles({ innkeeper: v }), 'role-innkeeper')}
          {tick('Hostile', 'Attacks the player on sight', combat.hostile === true, (v) => setCombat({ hostile: v ? true : null }), 'combat-hostile')}
          {tick('Levels with the player', 'Stays a match for the player instead of a fixed level', !!combat.levelScaled, (v) => setCombat({ levelScaled: v ? { min: 1, max: 50 } : null }), 'combat-levelled')}
        </div>
        <label className="col" style={{ gap: 2 }} title="What they sell, e.g. general goods, weapons, potions, food. Leave empty if they don't trade.">
          <span className="dim">Sells</span>
          <input className="input" placeholder="Not a merchant" defaultValue={roles.merchant?.sells ?? ''} key={`m-${roles.merchant?.sells}`} onBlur={(e) => e.target.value.trim() !== (roles.merchant?.sells ?? '') && setRoles({ merchant: e.target.value.trim() ? { sells: e.target.value.trim(), hours: roles.merchant?.hours ?? null } : null })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} data-testid="role-sells" />
        </label>
        <div className="row" style={{ gap: 6 }}>
          <label className="col grow" style={{ gap: 2 }} title="A skill they train for gold">
            <span className="dim">Trains</span>
            <Select value={roles.trainer?.skill ?? ''} options={[{ value: '', label: 'Nothing' }, ...TRAIN_SKILLS.map((k) => ({ value: k, label: k }))]} onChange={(v) => setRoles({ trainer: v ? { skill: v, maxLevel: roles.trainer?.maxLevel ?? 50 } : null })} />
          </label>
          {roles.trainer && (
            <label className="col" style={{ gap: 2 }} title="The highest level they train to">
              <span className="dim">Up to</span>
              <Select value={roles.trainer.maxLevel} options={[{ value: 50, label: '50 (apprentice)' }, { value: 75, label: '75 (expert)' }, { value: 90, label: '90 (master)' }]} onChange={(v) => setRoles({ trainer: { ...roles.trainer!, maxLevel: v } })} />
            </label>
          )}
        </div>
      </div>
    </details>
  );
}

/** Groups of enemies waiting somewhere (from the load order's own enemies). */
function EncountersCard({ plan, edit, nameOf }: { plan: QuestPlan; edit: (fn: (p: QuestPlan) => void) => Promise<void>; nameOf: (k: string | null) => string }) {
  const list = plan.encounters ?? [];
  const set = (i: number, change: Partial<NonNullable<QuestPlan['encounters']>[number]>) => void edit((p) => void Object.assign(p.encounters![i]!, change));
  const add = () =>
    void edit((p) => {
      let n = 1;
      while ([...p.characters, ...p.items, ...p.locations, ...(p.encounters ?? [])].some((x) => x.key === `enemies${n}`)) n++;
      (p.encounters ??= []).push({ key: `enemies${n}`, what: 'bandit', count: 3, locationKey: p.locations[0]?.key ?? '', spot: null });
    });
  return (
    <div className="card" data-testid="plan-encounters">
      <div className="card-title row" style={{ gap: 6 }}>
        Enemy groups
        <Help text="Enemies from your load order placed in a place (bandits in a cave, draugr in a tomb). Pick a levelled one (Lvl…) so they match the player. A “Defeat” step moves the quest on when they're all dead." />
        <span className="grow" />
        <button className="btn small ghost" onClick={add} disabled={!plan.locations.length} title={plan.locations.length ? 'Add a group of enemies to a place in the plan' : 'Add a place to the plan first'} data-testid="add-encounter">
          <Icon name="plus" size={12} /> Add enemies
        </button>
      </div>
      {!list.length && <p className="dim small" style={{ margin: 0 }}>No enemy groups. Add some for a cave full of bandits or a tomb of draugr.</p>}
      <div className="col" style={{ gap: 8 }}>
        {list.map((e, i) => (
          <div key={e.key} className="row wrap" style={{ gap: 6, alignItems: 'flex-end' }} data-testid="plan-encounter">
            <label className="col small" style={{ gap: 2, width: 70 }}>
              <span className="dim">How many</span>
              <input className="input" type="number" min={1} max={12} defaultValue={e.count} key={`c-${e.key}-${e.count}`} onBlur={(ev) => Number(ev.target.value) !== e.count && set(i, { count: Math.round(Number(ev.target.value)) || 1 })} data-testid="encounter-count" />
            </label>
            <label className="col small" style={{ gap: 2, flex: '1 1 160px' }} title="An enemy type (bandit, draugr, wolf) or an Editor ID from your load order">
              <span className="dim">Enemy</span>
              <input className="input" defaultValue={e.what} key={`w-${e.key}-${e.what}`} onBlur={(ev) => ev.target.value.trim() && ev.target.value.trim() !== e.what && set(i, { what: ev.target.value.trim() })} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); ev.stopPropagation(); }} data-testid="encounter-what" />
            </label>
            <label className="col small" style={{ gap: 2 }}>
              <span className="dim">In</span>
              <Select value={e.locationKey} options={plan.locations.map((l) => ({ value: l.key, label: l.name }))} onChange={(v) => set(i, { locationKey: v })} />
            </label>
            <label className="col small" style={{ gap: 2 }} title="Move the quest on to this stage once every one of them is dead">
              <span className="dim">When all are dead</span>
              <Select
                value={plan.steps.find((st) => st.kind === 'clear' && st.targetKey === e.key)?.to ?? -1}
                options={[{ value: -1, label: 'Nothing happens' }, ...plan.stages.map((st) => ({ value: st.index, label: `Go to stage ${st.index}` }))]}
                onChange={(v) =>
                  void edit((p) => {
                    p.steps = p.steps.filter((st) => !(st.kind === 'clear' && st.targetKey === e.key));
                    if (v >= 0) p.steps.push({ from: null, to: v, kind: 'clear', targetKey: e.key, note: `Defeat the ${e.what}` });
                  })
                }
              />
            </label>
            <button className="btn small ghost icon" onClick={() => void edit((p) => void (p.encounters!.splice(i, 1), (p.steps = p.steps.filter((st) => !(st.kind === 'clear' && st.targetKey === e.key)))))} title="Remove this group (Undo edit brings it back)" data-testid="remove-encounter">
              <Icon name="trash" size={12} />
            </button>
            <span className="dim small" style={{ flexBasis: '100%' }}>
              {e.count} {e.what} wait in {nameOf(e.locationKey) || 'the place'}.
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** For a new place: which interior to copy the layout of, and where its door is. */
function NewPlaceFields({ plan, placeKey, edit }: { plan: QuestPlan; placeKey: string; edit: (fn: (p: QuestPlan) => void) => Promise<void> }) {
  const l = plan.locations.find((x) => x.key === placeKey);
  const [interiors, setInteriors] = useState<{ editorId?: string; name?: string }[]>([]);
  useEffect(() => {
    void engine((c) => c.call('cells', { interiorOnly: true }), { refreshSession: false }).then((list) => list && setInteriors(list.filter((c) => c.editorId).slice(0, 2000)));
  }, []);
  if (!l) return null;
  const set = (k: 'layoutLike' | 'doorFrom', v: string) => void edit((p) => void (p.locations.find((x) => x.key === placeKey)![k] = v.trim() || null));
  const input = (k: 'layoutLike' | 'doorFrom', label: string, title: string, placeholder: string) => (
    <label className="col small" style={{ gap: 2, width: '100%' }} title={title}>
      <span className="dim">{label}</span>
      <input
        className="input"
        list="plan-interiors"
        placeholder={placeholder}
        defaultValue={l[k] ?? ''}
        key={`${k}-${l[k]}`}
        onBlur={(e) => e.target.value.trim() !== (l[k] ?? '') && set(k, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
        data-testid={`place-${k}`}
      />
    </label>
  );
  return (
    <div className="col" style={{ gap: 4, width: '100%', marginTop: 4 }}>
      <datalist id="plan-interiors">
        {plan.locations.filter((x) => x.key !== placeKey).map((x) => (
          <option key={x.key} value={x.key}>
            {x.name}
          </option>
        ))}
        {interiors.map((c) => (
          <option key={c.editorId} value={c.editorId}>
            {c.name ?? ''}
          </option>
        ))}
      </datalist>
      {input('layoutLike', 'Laid out like', 'An existing interior whose walls, furniture, lights and clutter are copied into this new place. Leave empty for an empty room.', 'Empty room (pick an interior to copy)')}
      {input('doorFrom', 'Door from', 'Where the player walks in from: a linked door is put against a wall there, and the way out of the copied layout leads back.', 'No door (pick a place)')}
    </div>
  );
}

/** Ways the quest can fail: someone dies, or time runs out. */
function FailuresCard({ plan, edit, nameOf }: { plan: QuestPlan; edit: (fn: (p: QuestPlan) => void) => Promise<void>; nameOf: (k: string | null) => string }) {
  const failures = plan.failures ?? [];
  const stages = [...plan.stages].sort((a, b) => a.index - b.index);
  const failStages = stages.filter((s) => s.failsQuest);
  const set = (i: number, change: Partial<NonNullable<QuestPlan['failures']>[number]>) => void edit((p) => void Object.assign(p.failures![i]!, change));
  const add = (kind: 'death' | 'timeLimit') =>
    void edit((p) => {
      // A failing stage to go to: an existing one, or a new one after the last stage.
      let fail = p.stages.find((s) => s.failsQuest)?.index;
      if (fail === undefined) {
        fail = Math.max(0, ...p.stages.map((s) => s.index)) + 100;
        p.stages.push({ index: fail, journal: kind === 'death' ? 'Someone I needed is dead. I have failed.' : 'I took too long, and failed.', startsQuest: false, completesQuest: false, failsQuest: true });
      }
      (p.failures ??= []).push(
        kind === 'death'
          ? { kind, targetKey: p.characters[0]?.key ?? null, days: null, fromStage: null, failStage: fail, note: 'Fails if they die' }
          : { kind, targetKey: null, days: 3, fromStage: p.stages.find((s) => s.startsQuest)?.index ?? null, failStage: fail, note: 'Time limit' },
      );
    });
  return (
    <div className="card" data-testid="plan-failures">
      <div className="card-title row" style={{ gap: 6 }}>
        How the quest can fail
        <Help text="The quest fails (goes to a stage that fails it) if a character dies before it's finished, or if it isn't finished within some in-game days. Leave this empty for a quest that can't fail." />
        <span className="grow" />
        <button className="btn small ghost" onClick={() => add('death')} disabled={!stages.length} title="Fail the quest if a character dies before it's finished. Adds a failing stage if there isn't one." data-testid="add-fail-death">
          <Icon name="plus" size={12} /> If someone dies
        </button>
        <button className="btn small ghost" onClick={() => add('timeLimit')} disabled={!stages.length || failures.some((f) => f.kind === 'timeLimit')} title={failures.some((f) => f.kind === 'timeLimit') ? 'A quest can have one time limit' : 'Fail the quest if it isn’t finished in time. Adds a failing stage if there isn’t one.'} data-testid="add-fail-time">
          <Icon name="plus" size={12} /> Time limit
        </button>
      </div>
      {!failures.length && <p className="dim small" style={{ margin: 0 }}>The quest can't fail. Add a way to fail if someone must stay alive, or the player has to hurry.</p>}
      <div className="col" style={{ gap: 8 }}>
        {failures.map((f, i) => (
          <div key={i} className="row wrap" style={{ gap: 6, alignItems: 'flex-end' }} data-testid="plan-failure">
            {f.kind === 'death' ? (
              <label className="col small" style={{ gap: 2, flex: '1 1 160px' }}>
                <span className="dim">Fails if this character dies</span>
                <Select value={f.targetKey ?? ''} options={[{ value: '', label: '(pick someone)' }, ...plan.characters.map((c) => ({ value: c.key, label: c.name }))]} onChange={(v) => set(i, { targetKey: v || null })} />
              </label>
            ) : (
              <>
                <label className="col small" style={{ gap: 2, width: 110 }} title="In-game days (one in-game day is about 72 real minutes at the default timescale)">
                  <span className="dim">Days allowed</span>
                  <input className="input" type="number" min={0.5} step={0.5} defaultValue={f.days ?? 3} key={`d-${i}-${f.days}`} onBlur={(e) => Number(e.target.value) !== f.days && set(i, { days: Number(e.target.value) || null })} data-testid="fail-days" />
                </label>
                <label className="col small" style={{ gap: 2 }}>
                  <span className="dim">Clock starts at stage</span>
                  <Select value={f.fromStage ?? stages[0]?.index ?? 0} options={stages.map((s) => ({ value: s.index, label: String(s.index) }))} onChange={(v) => set(i, { fromStage: v })} />
                </label>
              </>
            )}
            <label className="col small" style={{ gap: 2 }} title="The stage the quest goes to when it fails; tick “Fails the quest” on it">
              <span className="dim">Goes to stage</span>
              <Select value={f.failStage} options={(failStages.length ? failStages : stages).map((s) => ({ value: s.index, label: `${s.index}${s.failsQuest ? ' (fails)' : ''}` }))} onChange={(v) => set(i, { failStage: v })} />
            </label>
            <button className="btn small ghost icon" onClick={() => void edit((p) => void p.failures!.splice(i, 1))} title="Remove this way to fail (Undo edit brings it back)" data-testid="remove-failure">
              <Icon name="trash" size={12} />
            </button>
            <span className="dim small" style={{ flexBasis: '100%' }}>
              {f.kind === 'death' ? `If ${nameOf(f.targetKey) || 'they'} dies before the quest is finished, it fails.` : `If the quest isn't finished ${f.days ?? '?'} in-game day${f.days === 1 ? '' : 's'} after stage ${f.fromStage ?? stages[0]?.index ?? 0}, it fails.`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type StartKind = 'game' | NonNullable<QuestPlan['startsWhen']>['kind'];
const START_KINDS: { kind: StartKind; label: string; hint: string; target?: string }[] = [
  { kind: 'game', label: 'With the game', hint: 'Running from the moment the game loads. Use this when it begins by talking to someone, so their lines are there.' },
  { kind: 'arrive', label: 'When the player enters a place', hint: 'A hidden marker in the place starts the quest the first time the player arrives.', target: 'Place' },
  { kind: 'read', label: 'When the player reads something', hint: 'Reading the note or book starts the quest. It must lie somewhere in the world, not in a container.', target: 'Note or book' },
  { kind: 'pickup', label: 'When the player picks something up', hint: 'Picking it up starts the quest. It must lie somewhere in the world, not in a container.', target: 'Item' },
  { kind: 'activate', label: 'When the player uses something', hint: 'Using (pressing E on) the object starts the quest.', target: 'Object' },
  { kind: 'afterQuest', label: 'After another quest', hint: 'For questlines: this one starts when another quest of yours reaches a stage (its end, unless you pick one).' },
];

/** How the quest starts: with the game, or when something happens. */
function StartCard({ plan, edit }: { plan: QuestPlan; edit: (fn: (p: QuestPlan) => void) => Promise<void> }) {
  const sw = plan.startsWhen ?? null;
  const kind: StartKind = plan.startsWithGame || !sw ? 'game' : sw.kind;
  const meta = START_KINDS.find((k) => k.kind === kind)!;
  const setKind = (k: StartKind) =>
    void edit((p) => {
      if (k === 'game') {
        p.startsWithGame = true;
        p.startsWhen = null;
      } else {
        p.startsWithGame = false;
        p.startsWhen = { kind: k, targetKey: k === 'afterQuest' ? null : (p.startsWhen?.targetKey ?? null), quest: k === 'afterQuest' ? (p.startsWhen?.quest ?? null) : null, stage: null };
      }
    });
  const setField = (k: 'targetKey' | 'quest', v: string) => void edit((p) => void (p.startsWhen = { ...p.startsWhen!, [k]: v.trim() || null }));
  const keys = [...plan.items.map((i) => ({ key: i.key, name: i.name })), ...plan.locations.map((l) => ({ key: l.key, name: l.name }))];
  return (
    <div className="card" data-testid="plan-start">
      <div className="card-title">
        How the quest starts
        <Help text="A quest only does anything while it's running. It can run from the start of the game, or start when something happens." />
      </div>
      <div className="row wrap" style={{ gap: 6, alignItems: 'flex-end' }}>
        <label className="col small" style={{ gap: 2 }} title={meta.hint}>
          <span className="dim">Starts</span>
          <Select value={kind} options={START_KINDS.map((k) => ({ value: k.kind, label: k.label }))} onChange={setKind} />
        </label>
        {meta.target && (
          <label className="col small" style={{ gap: 2, flex: '1 1 160px' }}>
            <span className="dim">{meta.target}</span>
            <input className="input" list="plan-start-keys" placeholder="A name from the plan, or an Editor ID" defaultValue={sw?.targetKey ?? ''} key={`t-${sw?.targetKey}`} onBlur={(e) => e.target.value !== (sw?.targetKey ?? '') && setField('targetKey', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} data-testid="start-target" />
            <datalist id="plan-start-keys">
              {keys.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.name}
                </option>
              ))}
            </datalist>
          </label>
        )}
        {kind === 'afterQuest' && (
          <>
            <label className="col small" style={{ gap: 2, flex: '1 1 160px' }}>
              <span className="dim">Quest before it (Editor ID)</span>
              <input className="input" placeholder="e.g. MyQuestPartOne" defaultValue={sw?.quest ?? ''} key={`q-${sw?.quest}`} onBlur={(e) => e.target.value !== (sw?.quest ?? '') && setField('quest', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} data-testid="start-quest" />
            </label>
            <label className="col small" style={{ gap: 2, width: 110 }} title="Leave empty for the stage that completes it">
              <span className="dim">At its stage</span>
              <input className="input" type="number" placeholder="its end" defaultValue={sw?.stage ?? ''} key={`s-${sw?.stage}`} onBlur={(e) => { const v = e.target.value === '' ? null : Math.round(Number(e.target.value)); if (v !== (sw?.stage ?? null)) void edit((p) => void (p.startsWhen = { ...p.startsWhen!, stage: v })); }} data-testid="start-stage" />
            </label>
          </>
        )}
      </div>
      <span className="dim small">{meta.hint}</span>
    </div>
  );
}

type PlanEvent = NonNullable<QuestPlan['events']>[number];
type EventKind = PlanEvent['kind'];

/** Each kind of event: what it's called, what it does, and which fields it uses. */
const EVENT_KINDS: { kind: EventKind; label: string; hint: string; target?: string; to?: string; what?: string; count?: string }[] = [
  { kind: 'spawn', label: 'Enemies appear', hint: 'Enemies are placed next to the target (or the player). They fight as they normally would.', target: 'Where (empty = by the player)', what: 'Enemy, e.g. bandit, draugr, wolf', count: 'How many' },
  { kind: 'hostile', label: 'Turns hostile', hint: 'The character attacks the player.', target: 'Who' },
  { kind: 'friendly', label: 'Stops fighting', hint: 'The character stops attacking and calms down.', target: 'Who' },
  { kind: 'unlock', label: 'Unlock', hint: 'Unlocks a door or chest.', target: 'Door or chest' },
  { kind: 'lock', label: 'Lock', hint: 'Locks a door or chest.', target: 'Door or chest' },
  { kind: 'show', label: 'Appears', hint: 'Something appears. It starts hidden until this stage.', target: 'What' },
  { kind: 'hide', label: 'Vanishes', hint: 'Something disappears from the world.', target: 'What' },
  { kind: 'moveTo', label: 'Moves to', hint: 'Moves a character straight to a place or person (do it during a fade so nobody sees).', target: 'Who', to: 'Where to' },
  { kind: 'kill', label: 'Dies', hint: 'The character dies.', target: 'Who' },
  { kind: 'fade', label: 'Fade to black', hint: 'The screen fades to black and back. Other events at the same stage happen while it is dark.', count: 'Seconds of black' },
  { kind: 'sound', label: 'Sound', hint: 'Plays a sound from the load order at the target (or the player).', what: 'Sound name or Editor ID', target: 'Where (empty = player)' },
  { kind: 'weather', label: 'Weather', hint: 'Changes the weather. Type “clear” to go back to normal.', what: 'Weather, e.g. SkyrimStormRain' },
  { kind: 'message', label: 'Message', hint: 'A notification in the top corner of the screen.', what: 'Text' },
  { kind: 'startQuest', label: 'Start a quest', hint: 'Starts another quest, e.g. the next one in a questline.', what: 'Quest Editor ID' },
  { kind: 'movePlayer', label: 'Move the player', hint: 'Moves the player to a place or person.', to: 'Where to' },
];

/** What happens in the world at each stage: enemies, doors, fades… */
function EventsCard({ plan, edit, nameOf }: { plan: QuestPlan; edit: (fn: (p: QuestPlan) => void) => Promise<void>; nameOf: (k: string | null) => string }) {
  const events = plan.events ?? [];
  const stages = [...plan.stages].sort((a, b) => a.index - b.index);
  const keys = [...plan.characters.map((c) => ({ key: c.key, name: c.name })), ...plan.items.map((i) => ({ key: i.key, name: i.name })), ...plan.locations.map((l) => ({ key: l.key, name: l.name }))];
  const set = (i: number, change: Partial<PlanEvent>) => void edit((p) => void Object.assign(p.events![i]!, change));
  const add = () =>
    void edit((p) => {
      const last = [...p.stages].sort((a, b) => a.index - b.index).find((x) => !x.startsQuest) ?? p.stages[0]!;
      (p.events ??= []).push({ atStage: last.index, kind: 'message', targetKey: null, toKey: null, what: 'Something happens…', count: null, note: 'New event' });
    });
  const field = (i: number, label: string, value: string | null, k: 'targetKey' | 'toKey' | 'what', list?: boolean) => (
    <label className="col small" style={{ gap: 2, flex: '1 1 140px', minWidth: 120 }}>
      <span className="dim">{label}</span>
      <input
        className="input"
        defaultValue={value ?? ''}
        key={`${i}-${k}-${value}`}
        list={list ? 'plan-event-keys' : undefined}
        placeholder={list ? 'A name from the plan, or an Editor ID' : undefined}
        onBlur={(e) => {
          const v = e.target.value.trim() || null;
          if (v !== value) set(i, { [k]: v });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
        data-testid={`event-${k}`}
      />
    </label>
  );
  return (
    <div className="card" data-testid="plan-events">
      <div className="card-title row" style={{ gap: 6 }}>
        What happens at stages
        <Help text="Things that happen in the world when the quest reaches a stage: enemies appear, someone turns hostile, a door unlocks, something appears or vanishes, the screen fades to black. They become lines in the stage's script." />
        <span className="grow" />
        <button className="btn small ghost" onClick={add} disabled={!stages.length} title="Add something that happens when the quest reaches a stage" data-testid="add-event">
          <Icon name="plus" size={12} /> Add event
        </button>
      </div>
      <datalist id="plan-event-keys">
        {keys.map((k) => (
          <option key={k.key} value={k.key}>
            {k.name}
          </option>
        ))}
      </datalist>
      {!events.length && <p className="dim small" style={{ margin: 0 }}>Nothing happens in the world yet besides dialogue. Add an event for an ambush, a door that unlocks, or a fade to black.</p>}
      <div className="col" style={{ gap: 8 }}>
        {events.map((e, i) => {
          const meta = EVENT_KINDS.find((k) => k.kind === e.kind) ?? EVENT_KINDS[0]!;
          return (
            <div key={i} className="col plan-event" style={{ gap: 4 }} data-testid="plan-event">
              <div className="row wrap" style={{ gap: 6, alignItems: 'flex-end' }}>
                <label className="col small" style={{ gap: 2 }}>
                  <span className="dim">At stage</span>
                  <Select value={e.atStage} options={stages.map((s) => ({ value: s.index, label: String(s.index) }))} onChange={(v) => set(i, { atStage: v })} />
                </label>
                <label className="col small" style={{ gap: 2 }} title={meta.hint}>
                  <span className="dim">What happens</span>
                  <Select value={e.kind} options={EVENT_KINDS.map((k) => ({ value: k.kind, label: k.label }))} onChange={(v) => set(i, { kind: v })} />
                </label>
                {meta.target && field(i, meta.target, e.targetKey, 'targetKey', true)}
                {meta.to && field(i, meta.to, e.toKey, 'toKey', true)}
                {meta.what && field(i, meta.what, e.what, 'what')}
                {meta.count && (
                  <label className="col small" style={{ gap: 2, width: 90 }}>
                    <span className="dim">{meta.count}</span>
                    <input className="input" type="number" min={1} max={e.kind === 'spawn' ? 10 : 30} defaultValue={e.count ?? (e.kind === 'fade' ? 2 : 1)} key={`${i}-count-${e.count}`} onBlur={(ev) => set(i, { count: Math.round(Number(ev.target.value)) || null })} data-testid="event-count" />
                  </label>
                )}
                <button className="btn small ghost icon" onClick={() => void edit((p) => void p.events!.splice(i, 1))} title="Remove this event (Undo edit brings it back)" data-testid="remove-event">
                  <Icon name="trash" size={12} />
                </button>
              </div>
              <span className="dim small">
                {meta.hint}
                {e.targetKey && ` Target: ${nameOf(e.targetKey)}.`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const STEP_VERBS: Record<QuestPlan['steps'][number]['kind'], string> = {
  talk: 'Talk',
  pickup: 'Pick up',
  activate: 'Use',
  death: 'Kill',
  arrive: 'Arrive at',
  read: 'Read',
  equip: 'Equip',
  drop: 'Drop',
  script: 'Right away',
  clear: 'Defeat',
};

// ------------------------------------------------------------------ 3. result

function Result({ report, onClose }: { report: QuestBuildReport; onClose: () => void }) {
  const open = () => {
    const s = useStore.getState();
    if (report.quest) {
      s.setTab('quest');
      s.setQuest(report.quest);
    } else {
      const npc = report.changed[0]?.formKey ?? report.created.find((c) => c.kind === 'character')?.formKey;
      s.setTab('npc');
      if (npc) s.setNpc(npc);
    }
    onClose();
  };
  return (
    <div className="col" style={{ gap: 12 }} data-testid="build-result">
      <div className="row" style={{ gap: 8 }}>
        <Icon name="check" />
        <span>
          {report.updated.length ? (
            <>
              <b>{report.editorId}</b> is updated:
            </>
          ) : report.quest ? (
            <>
              <b>{report.editorId}</b> is built: {report.created.length} new record(s), {report.dialogue.responses} line(s) of dialogue.
            </>
          ) : (
            <>
              Done: {report.created.length} new record(s), {report.changed.length} character(s) changed.
            </>
          )}{' '}
          Undo takes it all back in one step.
        </span>
      </div>
      {report.problems.length > 0 && (
        <ul className="list release-list">
          {report.problems.map((p) => (
            <li key={p} className="release-item error">
              <span className="chip err" style={{ flex: 'none' }}>
                Problem
              </span>
              <span className="grow">{p}</span>
            </li>
          ))}
        </ul>
      )}
      {report.warnings.length > 0 && (
        <ul className="list release-list" data-testid="build-warnings">
          {report.warnings.map((w) => (
            <li key={w} className="release-item warning">
              <span className="chip warn" style={{ flex: 'none' }}>
                Check
              </span>
              <span className="grow">{w}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="card-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
        <div className="card">
          <div className="card-title">Made</div>
          <ul className="always-list">
            {report.created.map((c) => (
              <li key={c.formKey}>
                <Icon name="plus" size={12} />
                <span>{c.label}</span>
              </li>
            ))}
            {report.updated.map((u) => (
              <li key={u} data-testid="update-line">
                <Icon name="check" size={12} />
                <span>{u}</span>
              </li>
            ))}
            {report.changed.map((c) => (
              <li key={c.formKey} data-testid="changed-character">
                <Icon name="npc" size={12} />
                <span>
                  Changed {c.label}: {c.changes.join('; ')}
                </span>
              </li>
            ))}
            {report.reused.map((c) => (
              <li key={c.formKey}>
                <Icon name="link" size={12} />
                <span className="dim">Uses {c.label}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <div className="card-title">Next steps</div>
          <ul className="always-list">
            {report.notes.map((n) => (
              <li key={n}>
                <Icon name="chevron" size={12} />
                <span className="dim">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn"
          onClick={() => {
            useStore.getState().setTab('release');
            onClose();
          }}
          title="Run the pre-release check on the whole plugin"
        >
          Check for problems
        </button>
        <span className="grow" />
        <button className="btn primary" onClick={open} data-testid="open-built-quest">
          {report.quest ? 'Open the quest' : 'Open in Characters'}
        </button>
      </div>
    </div>
  );
}
