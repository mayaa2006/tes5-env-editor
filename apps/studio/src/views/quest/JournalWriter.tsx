/**
 * Journal & objective writer: drafts for the stages and objectives that
 * have none (or all of them), in Skyrim's style, from what moves the quest
 * on. Edit or untick any, optionally let Claude word them, then apply.
 */
import { useEffect, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import type { JournalContext, JournalDraft, JournalLint } from '@tes5/workspace';
import { Checkbox, Help, Icon, Modal, TextInput } from '../../components/ui';
import { engine } from '../../state/store';
import { useAi } from '../../components/AiPicker';

type Row<T> = T & { use: boolean };

export default function JournalWriter({ quest, onClose }: { quest: FormKey; onClose: () => void }) {
  const { ai, ready, name } = useAi();
  const [overwrite, setOverwrite] = useState(false);
  const [ctx, setCtx] = useState<JournalContext>();
  const [lint, setLint] = useState<JournalLint[]>([]);
  const [stages, setStages] = useState<Row<JournalDraft['stages'][number]>[]>([]);
  const [objectives, setObjectives] = useState<Row<JournalDraft['objectives'][number]>[]>([]);

  const take = (d: JournalDraft) => {
    setStages(d.stages.map((s) => ({ ...s, use: true })));
    setObjectives(d.objectives.map((o) => ({ ...o, use: true })));
  };
  useEffect(() => {
    void engine((c) => c.call('journalDraft', quest, overwrite), { refreshSession: false }).then((r) => {
      if (!r) return;
      setCtx(r.context);
      setLint(r.lint);
      take(r.draft);
    });
  }, [quest, overwrite]);

  const askClaude = async () => {
    const d = await engine((c) => c.call('journalDraftWithClaude', quest, ai, overwrite), { busy: `${name} is writing the journal…`, refreshSession: false });
    if (d) take(d);
  };
  const apply = async () => {
    const draft: JournalDraft = { stages: stages.filter((s) => s.use).map(({ use: _, ...s }) => s), objectives: objectives.filter((o) => o.use).map(({ use: _, ...o }) => o) };
    const ok = await engine(async (c) => (await c.call('applyJournal', quest, draft), true), { success: 'Journal and objectives written' });
    if (ok) onClose();
  };
  const current = (i: number) => ctx?.stages.find((s) => s.index === i)?.journal ?? '';
  const chosen = stages.filter((s) => s.use).length + objectives.filter((o) => o.use).length;

  return (
    <Modal
      className="wide"
      title={
        <span className="row" style={{ gap: 6 }}>
          <Icon name="file" /> Write journal & objectives
          <Help text="Drafts come from what moves the quest on (the arrows on the map): “I spoke with Brynja. I should find her ring.” and “Find Brynja's Ring”. Edit them freely; nothing changes until you apply." />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Checkbox checked={overwrite} onChange={setOverwrite} label="Rewrite the ones already written too" />
          <span className="grow" />
          <button className="btn" onClick={() => void askClaude()} disabled={!ready} title={ready ? `${name} words the drafts in the style of the game’s quests` : 'Choose an AI first: Quests → From writing (Claude, or a free one)'} data-testid="journal-claude">
            <Icon name="wand" size={13} /> Ask {ai.kind === 'claude' ? 'Claude' : 'the AI'} to word them
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!chosen} onClick={() => void apply()} data-testid="journal-apply">
            Apply {chosen || ''}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }} data-testid="journal-writer">
        {lint.length > 0 && (
          <div className="card">
            <div className="card-title">Wording to check</div>
            {lint.map((l) => (
              <div key={l.message} className="small warn">
                ⚠ {l.message}
              </div>
            ))}
          </div>
        )}
        <div className="card">
          <div className="card-title">Journal</div>
          {stages.length ? (
            <div className="col" style={{ gap: 8 }}>
              {stages.map((s, n) => (
                <div key={s.index} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={s.use} onChange={(e) => setStages(stages.map((x, i) => (i === n ? { ...x, use: e.target.checked } : x)))} aria-label={`Use the draft for stage ${s.index}`} />
                  <span className="chip" style={{ flex: 'none' }}>
                    {s.index}
                  </span>
                  <div className="grow col" style={{ gap: 2 }}>
                    <TextInput multiline value={s.journal} onCommit={(v) => setStages(stages.map((x, i) => (i === n ? { ...x, journal: v } : x)))} />
                    {current(s.index) && <span className="dim small">Now: {current(s.index)}</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <span className="dim small">Every stage that needs one has a journal entry.</span>
          )}
        </div>
        <div className="card">
          <div className="card-title">Objectives</div>
          {objectives.length ? (
            <div className="col" style={{ gap: 6 }}>
              {objectives.map((o, n) => (
                <div key={`${o.index}-${o.shownAtStage}`} className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={o.use} onChange={(e) => setObjectives(objectives.map((x, i) => (i === n ? { ...x, use: e.target.checked } : x)))} aria-label={`Use objective ${o.index}`} />
                  <div className="grow">
                    <TextInput value={o.text} onCommit={(v) => setObjectives(objectives.map((x, i) => (i === n ? { ...x, text: v } : x)))} />
                  </div>
                  <span className="dim small nowrap">
                    shown at {o.shownAtStage}
                    {o.completedAtStage !== null && `, done at ${o.completedAtStage}`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="dim small">Every step already has an objective.</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
