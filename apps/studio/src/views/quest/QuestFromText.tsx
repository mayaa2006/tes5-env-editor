/**
 * Quest from writing: paste a design document or just a conversation,
 * Claude plans the whole quest, you check and adjust the plan, and it's
 * built (characters, items, stages, journal, objectives, triggers,
 * dialogue) as one undo step.
 */
import { useEffect, useState } from 'react';
import type { PlanIssue, PlanResolution, PlannerMode, QuestBuildReport, QuestPlan } from '@tes5/workspace';
import { Field, Help, Icon, Modal, TextInput } from '../../components/ui';
import { engine, useStore } from '../../state/store';

type Review = { plan: QuestPlan; issues: PlanIssue[]; resolution: PlanResolution[] };

const MODES: { id: PlannerMode; title: string; text: string; placeholder: string }[] = [
  {
    id: 'document',
    title: 'A design document',
    text: 'Describe the quest in your own words: who, where, what the player does, how it ends. Any length, any format.',
    placeholder: 'Brynja, the innkeeper, has lost her ring. The player asks her for work and she asks them to find it…',
  },
  {
    id: 'conversation',
    title: 'A conversation',
    text: 'Just write the dialogue, no tags needed. Claude works out the quest around it and adds the stages, journal and objectives.',
    placeholder: 'Player: Got any work?\nBrynja: I lost my mother’s ring. Find it and I’ll pay you.\nPlayer: I found your ring!\nBrynja: Thank the gods! Here, take this.',
  },
];

export default function QuestFromText({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<'write' | 'review' | 'done'>('write');
  const [mode, setMode] = useState<PlannerMode>('document');
  const [source, setSource] = useState('');
  const [review, setReview] = useState<Review>();
  const [report, setReport] = useState<QuestBuildReport>();

  return (
    <Modal
      className="wide"
      title={
        <span className="row" style={{ gap: 6 }}>
          <Icon name="wand" /> Quest from writing
          <span className="dim small" style={{ fontWeight: 400 }}>
            {step === 'write' ? '1. Write' : step === 'review' ? '2. Check the plan' : '3. Built'}
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
      {step === 'review' && review && (
        <ReviewPlan
          review={review}
          setReview={setReview}
          source={source}
          onBack={() => setStep('write')}
          onBuilt={(r) => {
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
  const key = useStore((s) => s.settings.anthropicApiKey);
  const update = useStore((s) => s.updateSettings);
  const [editKey, setEditKey] = useState(!key);
  const m = MODES.find((x) => x.id === mode)!;

  const plan = async () => {
    const r = await engine((c) => c.call('planQuest', source, mode, key), { busy: 'Claude is planning the quest… this can take a minute or two', refreshSession: false });
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
        {editKey ? (
          <Field
            label="Anthropic API key"
            title="Claude plans the quest through Anthropic's API, using your own key (create one at console.anthropic.com). The key is stored on this computer only. Your text and a list of the characters, places, voices and races in your load order are sent to Anthropic to make the plan."
          >
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono grow" type="password" placeholder="sk-ant-…" defaultValue={key} data-testid="api-key" onBlur={(e) => update({ anthropicApiKey: e.target.value.trim() })} />
              {key && (
                <button className="btn small" onClick={() => setEditKey(false)}>
                  Done
                </button>
              )}
            </div>
          </Field>
        ) : (
          <div className="row small dim" style={{ gap: 6 }}>
            <Icon name="check" size={12} /> Using your Anthropic API key
            <Help text="Your text and a list of the characters, places, voices and races in your load order are sent to Anthropic to make the plan. Nothing is built until you've checked it." />
            <span className="grow" />
            <button className="btn small ghost" onClick={() => setEditKey(true)}>
              Change key
            </button>
          </div>
        )}
        <p className="dim small" style={{ margin: '6px 0 0' }}>
          Nothing is built yet: you'll see the plan first, with every decision Claude made on its own, and can change it.
        </p>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => void example()} data-testid="use-example" title="Load an example design document and the plan Claude makes from it (no API key needed)">
          Use the example
        </button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!source.trim() || !key} onClick={() => void plan()} title={!key ? 'Add your API key first' : !source.trim() ? 'Write something first' : undefined} data-testid="plan-quest">
          <Icon name="wand" size={13} /> Plan the quest
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 2. review

function ReviewPlan({ review, setReview, source, onBack, onBuilt }: { review: Review; setReview: (r: Review) => void; source: string; onBack: () => void; onBuilt: (r: QuestBuildReport) => void }) {
  const key = useStore((s) => s.settings.anthropicApiKey);
  const { plan, issues, resolution } = review;
  const [feedback, setFeedback] = useState('');
  const [draft, setDraft] = useState(plan);
  useEffect(() => setDraft(plan), [plan]);

  // Re-check after hand edits.
  const edit = async (fn: (p: QuestPlan) => void) => {
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
    const r = await engine((c) => c.call('reviewQuestPlan', next), { refreshSession: false });
    if (r) setReview({ plan: next, ...r });
  };
  const revise = async () => {
    const r = await engine((c) => c.call('reviseQuestPlan', draft, feedback, key, source), { busy: 'Claude is changing the plan…', refreshSession: false });
    if (r) {
      setReview(r);
      setFeedback('');
    }
  };
  const build = async () => {
    const r = await engine((c) => c.call('buildQuestPlan', draft), { busy: 'Building the quest…', success: `Built ${draft.title}` });
    if (r) onBuilt(r);
  };

  const errors = issues.filter((i) => i.severity === 'error').length + resolution.filter((r) => r.error).length;
  const res = (key: string) => resolution.find((r) => r.key === key);
  const nameOf = (key: string | null) => (key ? (res(key)?.name ?? key) : '');

  return (
    <div className="col" style={{ gap: 12 }} data-testid="plan-review">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="grow col" style={{ gap: 4 }}>
          <Field label="Quest name">
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
            <Help text="Claude decided these on its own because your text didn't say. If one is wrong, say what you want below (“Ask Claude to change the plan”)." />
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
                      {r.name} <span className={`chip ${r.error ? 'err' : r.existing ? 'dim' : 'accent'}`}>{r.error ? 'not found' : r.existing ? 'existing' : 'new'}</span>
                    </span>
                    <span className="dim small" style={{ whiteSpace: 'normal' }}>
                      {r.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="card" data-testid="plan-stages">
        <div className="card-title">
          Stages and journal
          <Help text="Each stage is a point in the quest. The journal text appears in the player's quest journal when the stage is reached." />
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
                      {[s.startsQuest && 'Starts the quest', s.completesQuest && 'Completes the quest', s.failsQuest && 'Fails the quest', ...shown.map((o) => `Shows “${o.text}”`)].filter(Boolean).join(' · ')}
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

      {draft.conversations.map((c, i) => (
        <div key={i} className="card">
          <div className="card-title">
            Conversation: {c.title}
            <Help text="Each top-level PLAYER line is something the player can say; indented lines are choices and answers. Tags: [stage N] sets a stage, [if stage N] only offers the line at that stage, [goodbye] ends the conversation, [gives item xN] / [takes item xN] hand items over, [emotion happy] sets the delivery." />
          </div>
          <div className="plan-screenplay">
            <TextInput value={c.screenplay} multiline mono onCommit={(v) => void edit((p) => void (p.conversations[i]!.screenplay = v))} />
          </div>
        </div>
      ))}

      <div className="card" style={{ padding: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input grow"
            placeholder="Ask Claude to change the plan, e.g. “Make Eirik the thief, and let the player keep the ring for a reward”"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && feedback.trim() && key && void revise()}
            data-testid="plan-feedback"
          />
          <button className="btn" disabled={!feedback.trim() || !key} onClick={() => void revise()} title={!key ? 'Add your API key on the first page' : undefined}>
            Change
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <span className="grow" />
        {errors > 0 && <span className="small err">Fix {errors} problem(s) first</span>}
        <button className="btn primary" disabled={errors > 0} onClick={() => void build()} data-testid="build-quest" title="Creates everything as one step you can undo">
          <Icon name="check" size={13} /> Build the quest
        </button>
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
};

// ------------------------------------------------------------------ 3. result

function Result({ report, onClose }: { report: QuestBuildReport; onClose: () => void }) {
  const open = () => {
    const s = useStore.getState();
    s.setTab('quest');
    s.setQuest(report.quest);
    onClose();
  };
  return (
    <div className="col" style={{ gap: 12 }} data-testid="build-result">
      <div className="row" style={{ gap: 8 }}>
        <Icon name="check" />
        <span>
          <b>{report.editorId}</b> is built: {report.created.length} new record(s), {report.dialogue.responses} line(s) of dialogue. Undo takes it all back in one step.
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
          Open the quest
        </button>
      </div>
    </div>
  );
}
