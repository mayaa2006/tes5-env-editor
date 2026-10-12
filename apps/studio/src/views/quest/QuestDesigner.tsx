/**
 * Quest designer: everything about a quest on one screen — stages with their
 * journal text and scripts, objectives, aliases, dialogue as a conversation,
 * a stage flow graph and the voice file list. Bookkeeping (fragment scripts,
 * alias properties, INFO ordering, topic counts, SEQ files) is automatic.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { EMOTIONS, QUEST_TYPES, QuestFlag, type FormKey } from '@tes5/esp';
import type { InfoModel, QuestModel, TopicModel } from '@tes5/workspace';
import { DialogueAvailability, InfoAfter, InfoWhen, StageDialogue, useStageDialogue } from './StageLinks';
import { Checkbox, clearDraft, DragNumber, EmptyState, ExpandableText, Field, FormLink, FormPicker, Icon, Modal, Select, Tabs, TextInput, useDebounced, useDraft, useQuery, useSummaries, useUniqueEditorId } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { ConditionList } from '../record/ConditionEditor';
import { TriggersSection } from '../record/TriggersEditor';
import { CodeEditor } from '../script/CodeEditor';

const QuestMap = lazy(() => import('./QuestMap'));
const QuestFromText = lazy(() => import('./QuestFromText'));
const DialogueGraphView = lazy(() => import('./DialogueGraph'));

type Tab = 'map' | 'overview' | 'stages' | 'objectives' | 'aliases' | 'dialogue' | 'voice';

/** Read-modify-write a record's typed data as one undo step. */
export async function patchRecord(key: FormKey, label: string, fn: (d: Record<string, any>) => void): Promise<boolean> {
  const r = await engine(async (c) => {
    const v = await c.call('view', key);
    if (!v) throw new Error(`${key} not found`);
    const d = structuredClone(v.data) as Record<string, any>;
    fn(d);
    await c.call('updateRecord', key, d, { unknown: v.unknown, label });
    return true;
  });
  return !!r;
}

/** Readable names for how an alias gets filled. */
const FILL_LABELS: Record<string, string> = {
  specific: 'Specific',
  uniqueActor: 'Unique actor',
  locationAlias: 'From a location alias',
  external: 'From another quest',
  create: 'Created at',
  findMatching: 'Found by conditions',
  refAliasLocation: 'Location of a reference alias',
  fromEvent: 'From the starting event',
  none: 'Not set',
};

export default function QuestDesigner() {
  const quest = useStore((s) => s.quest);
  return (
    <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
      <QuestList />
      {quest ? <QuestEditor key={quest} quest={quest} /> : <NoQuest />}
    </div>
  );
}

function NoQuest() {
  const [writing, setWriting] = useState(false);
  return (
    <>
      <EmptyState
      icon="quest"
      title="Pick a quest to work on"
      testId="quest-empty"
      actions={
        <>
          <button className="btn primary" onClick={() => useStore.getState().requestNew('quest')} title="Start an empty quest and add stages, objectives and characters yourself">
            <Icon name="plus" /> New quest
          </button>
          <button className="btn" onClick={() => setWriting(true)} title="Paste a design document or a conversation; an AI (Claude, or a free one on your PC or online) plans the whole quest, you check it, and it's built for you">
            <Icon name="wand" size={13} /> Describe a quest and let AI build it
          </button>
        </>
      }
    >
      Choose a quest in the list on the left to see its map of stages, or start a new one.
    </EmptyState>
      {writing && (
        <Suspense fallback={null}>
          <QuestFromText onClose={() => setWriting(false)} />
        </Suspense>
      )}
    </>
  );
}

function QuestList() {
  const client = useStore((s) => s.client);
  const quest = useStore((s) => s.quest);
  const setQuest = useStore((s) => s.setQuest);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [creating, setCreating] = useState(false);
  const [writing, setWriting] = useState(false);
  const newRequest = useStore((s) => s.newRequest);
  useEffect(() => {
    if (newRequest && useStore.getState().takeNew('quest')) setCreating(true);
  }, [newRequest]);
  const [mine, setMine] = useState(false);
  const activePlugin = useStore((s) => s.session.activePlugin);
  const [namedOnly, setNamedOnly] = useState(true);
  const { data } = useQuery(() => client?.call('search', { sigs: ['QUST'], query: dq, limit: 500, plugin: mine ? activePlugin : undefined, named: namedOnly }), [dq, mine, activePlugin, namedOnly]);
  return (
    <div className="panel" style={{ width: 260, flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--panel)' }}>
      <div className="panel-header">
        <span className="grow">Quests</span>
        <button className="btn small" onClick={() => setWriting(true)} data-testid="quest-from-writing" title="Paste a design document or a conversation; an AI (Claude, or a free one on your PC or online) plans the whole quest, you check it, and it's built for you">
          <Icon name="wand" size={12} /> From text
        </button>
        <button className="btn small primary" onClick={() => setCreating(true)} data-testid="new-quest">
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <div className="searchbox">
        <input className="input" placeholder="Find quest…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ marginTop: 4 }}>
          <Checkbox checked={namedOnly} onChange={setNamedOnly} label="Only quests with names" help="Hide quests that have no display name (mostly hidden internal quests). Untick to see every quest." />
        </div>
        {activePlugin && (
          <div style={{ marginTop: 4 }}>
            <Checkbox checked={mine} onChange={setMine} label={`Only ones in ${activePlugin}`} help="Show only the quests your plugin adds or changes." />
          </div>
        )}
      </div>
      <ul className="list scroll" style={{ flex: 1 }} data-testid="quest-list">
        {data?.items.map((i) => (
          <li key={i.formKey} className={`list-item ${quest === i.formKey ? 'selected' : ''}`} onClick={() => setQuest(i.formKey)} title={i.formKey}>
            <span className="name">{i.editorId}</span>
            {i.inActive && <span className="chip accent">edited</span>}
            <span className="meta">{i.name ?? ''}</span>
          </li>
        ))}
        {data && data.total > data.items.length && <li className="list-item dim small" style={{ cursor: 'default' }}>Showing {data.items.length} of {data.total}. Type a name to find the rest.</li>}
        {data && !data.items.length && <li className="dim small" style={{ padding: '8px 10px', whiteSpace: 'normal' }}>{mine ? 'Your plugin has no quests yet. Click New to start one, or untick the box to see them all.' : namedOnly ? 'No named quest matches. Untick "Only quests with names" to include unnamed ones.' : 'No quest matches.'}</li>}
      </ul>
      {creating && <NewQuestDialog onClose={() => setCreating(false)} />}
      {writing && (
        <Suspense fallback={null}>
          <QuestFromText onClose={() => setWriting(false)} />
        </Suspense>
      )}
    </div>
  );
}

function NewQuestDialog({ onClose }: { onClose: () => void }) {
  const [edid, setEdid] = useUniqueEditorId('MyQuest', 'newQuest:edid');
  const [name, setName] = useDraft('newQuest:name', 'My Quest');
  const [sge, setSge] = useDraft('newQuest:sge', false);
  const [runOnce, setRunOnce] = useDraft('newQuest:runOnce', true);
  return (
    <Modal
      title="New quest"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const key = await engine(
                async (c) => {
                  const k = await c.call('createQuest', edid, name, { startGameEnabled: sge, runOnce, priority: 50 });
                  await c.call('addStage', k, 0, '', { startUp: true });
                  await c.call('addStage', k, 10, 'Describe what the player should do first.');
                  await c.call('addStage', k, 100, 'Quest complete.', { completesQuest: true, shutDown: true });
                  return k;
                },
                { success: `Created ${name}` },
              );
              if (key) {
                clearDraft('newQuest:');
                useStore.getState().setQuest(key);
                onClose();
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Editor ID">
        <TextInput value={edid} onCommit={setEdid} mono autoFocus />
      </Field>
      <Field label="Name">
        <TextInput value={name} onCommit={setName} />
      </Field>
      <Field label="Starts">
        <Checkbox checked={sge} onChange={setSge} label="Running from game start (an SEQ file is generated automatically if it has dialogue)" />
      </Field>
      <Field label="">
        <Checkbox checked={runOnce} onChange={setRunOnce} label="Run once" help="Once it has stopped, the quest can never start again." />
      </Field>
      <p className="dim small">Starts with stages 0 (start-up), 10 and 100 (completes the quest). Change them freely.</p>
    </Modal>
  );
}

function QuestEditor({ quest }: { quest: FormKey }) {
  const client = useStore((s) => s.client);
  const { data: q } = useQuery(() => client?.call('quest', quest), [quest]);
  const [tab, setTab] = useState<Tab>('map');
  const [dialogueView, setDialogueView] = useState<'graph' | 'list'>('graph');
  const [focusTopic, setFocusTopic] = useState<FormKey | null>(null);
  const [focusStage, setFocusStage] = useState<{ stage: number; n: number } | null>(null);
  const [changing, setChanging] = useState(false);
  if (!q) return <div className="empty grow">Loading…</div>;
  return (
    <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <div className="row pad" style={{ paddingBottom: 0 }}>
        <div className="grow">
          <h2 style={{ margin: 0 }}>{q.name || q.editorId}</h2>
          <div className="dim small mono">
            {q.editorId} · {q.formKey}
          </div>
        </div>
        <button className="btn small" onClick={() => setChanging(true)} data-testid="change-with-plan" title="See this quest as a plan (characters, stages, journal, objectives, steps, dialogue), change it by hand or ask Claude, and apply only the differences">
          <Icon name="wand" size={12} /> Change with a plan
        </button>
        {changing && (
          <Suspense fallback={null}>
            <QuestFromText existing={quest} onClose={() => setChanging(false)} />
          </Suspense>
        )}
        <div className="chips">
          {(q.flags & QuestFlag.StartGameEnabled) !== 0 && <span className="chip accent">Start game enabled</span>}
          {(q.flags & QuestFlag.RunOnce) !== 0 && <span className="chip">Run once</span>}
          <span className="chip">{QUEST_TYPES[q.type] ?? 'None'}</span>
        </div>
      </div>
      <Tabs<Tab>
        tabs={[
          { id: 'map', label: 'Map' },
          { id: 'overview', label: 'Overview' },
          { id: 'stages', label: `Stages (${q.stages.length})` },
          { id: 'objectives', label: `Objectives (${q.objectives.length})` },
          { id: 'aliases', label: `Aliases (${q.aliases.length})` },
          { id: 'dialogue', label: `Dialogue (${q.topics.length})` },
          { id: 'voice', label: 'Voice files' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'map' && (
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <QuestMap
            quest={quest}
            onOpenDialogue={(topic) => {
              setFocusTopic(topic);
              setDialogueView('graph');
              setTab('dialogue');
            }}
            onOpenStages={() => setTab('stages')}
            focusStage={focusStage}
          />
        </Suspense>
      )}
      {tab === 'dialogue' && dialogueView === 'graph' && (
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <DialogueGraphView
            quest={quest}
            questEditorId={q.editorId}
            focus={focusTopic}
            onListView={() => setDialogueView('list')}
            onOpenStage={(stage) => {
              setFocusStage({ stage, n: (focusStage?.n ?? 0) + 1 });
              setTab('map');
            }}
          />
        </Suspense>
      )}
      <div className="scroll pad" style={{ flex: 1, display: tab === 'map' || (tab === 'dialogue' && dialogueView === 'graph') ? 'none' : undefined }}>
        {tab === 'overview' && <Overview q={q} />}
        {tab === 'stages' && (
          <Stages
            q={q}
            onOpenLine={(info) => {
              setFocusTopic(info);
              setDialogueView('graph');
              setTab('dialogue');
            }}
          />
        )}
        {tab === 'objectives' && <Objectives q={q} />}
        {tab === 'aliases' && <Aliases q={q} />}
        {tab === 'dialogue' && dialogueView === 'list' && (
          <>
            <button className="btn small ghost" style={{ marginBottom: 10 }} onClick={() => setDialogueView('graph')}>
              ← Graph view
            </button>
            <div className="card" style={{ marginBottom: 12, maxWidth: 460 }}>
              <div className="card-title">Dialogue available</div>
              <DialogueAvailability quest={q.formKey} />
            </div>
            <Dialogue q={q} />
          </>
        )}
        {tab === 'voice' && <Voice q={q} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ q }: { q: QuestModel }) {
  const flag = (bit: number, on: boolean) => patchRecord(q.formKey, 'Quest flags', (d) => (d.general.flags = on ? d.general.flags | bit : d.general.flags & ~bit));
  return (
    <div className="col" style={{ gap: 10, maxWidth: 640 }}>
      <Field label="Name">
        <TextInput value={q.name ?? ''} onCommit={(name) => patchRecord(q.formKey, 'Rename quest', (d) => (d.name = name))} />
      </Field>
      <Field label="Type">
        <Select value={q.type} options={Object.entries(QUEST_TYPES).map(([v, l]) => ({ value: Number(v), label: l }))} onChange={(t) => patchRecord(q.formKey, 'Quest type', (d) => (d.general.type = t))} />
      </Field>
      <Field label="Priority" title="Higher priority quests' dialogue wins when several apply">
        <DragNumber value={q.priority} step={1} precision={0} min={0} max={255} onCommit={(p) => patchRecord(q.formKey, 'Quest priority', (d) => (d.general.priority = Math.round(p)))} />
      </Field>
      <Field label="Flags">
        <div className="col" style={{ gap: 4 }}>
          <Checkbox checked={(q.flags & QuestFlag.StartGameEnabled) !== 0} onChange={(v) => flag(QuestFlag.StartGameEnabled, v)} label="Start game enabled" help="The quest runs from the moment a new game (or a save without your mod) loads. Needed for most dialogue-only quests. An SEQ file is written for it when it has dialogue." />
          <Checkbox checked={(q.flags & QuestFlag.RunOnce) !== 0} onChange={(v) => flag(QuestFlag.RunOnce, v)} label="Run once" help="Once it has stopped, the quest can never start again." />
          <Checkbox checked={(q.flags & QuestFlag.AllowRepeatedStages) !== 0} onChange={(v) => flag(QuestFlag.AllowRepeatedStages, v)} label="Allow repeated stages" help="Setting a stage that's already done runs its script again. Off by default: repeats are ignored." />
          <Checkbox checked={(q.flags & QuestFlag.WarnOnAliasFillFailure) !== 0} onChange={(v) => flag(QuestFlag.WarnOnAliasFillFailure, v)} label="Warn on alias fill failure" help="Writes a warning to the Papyrus log when an alias can't be filled, which helps when a quest silently fails to start." />
        </div>
      </Field>
      <Field label="Dialogue available" title="When this quest's dialogue can be said at all. Each line can narrow it further." stack>
        <DialogueAvailability quest={q.formKey} />
      </Field>
      <Field label="Scripts">
        <div className="col" style={{ gap: 2 }}>
          {q.scripts.map((s) => (
            <a key={s} href="#" onClick={(e) => (e.preventDefault(), useStore.getState().setScript(s), useStore.getState().setTab('script'))}>
              {s}
              {s === q.fragmentScript && <span className="faint"> (stage fragments)</span>}
            </a>
          ))}
          {!q.scripts.length && <span className="faint">None — writing a stage script creates one automatically.</span>}
        </div>
      </Field>
      <div className="card small dim">
        Everything else (dialogue conditions, Story Manager event, text display globals…) is in the properties panel.
        <div style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => useStore.getState().showProperties(q.formKey)}>
            Show all quest fields
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ stages

const STAGE_FLAGS: [number, string, string][] = [
  [0x02, 'Start-up stage', 'Set automatically the moment the quest starts. Usually stage 0 or 10.'],
  [0x04, 'Shut-down stage', 'Set automatically when the quest stops (for clean-up scripts).'],
  [0x08, 'Keep instance data', 'Keeps text replacement data (like <Alias=...> names) from the previous run when the quest restarts.'],
];

function Stages({ q, onOpenLine }: { q: QuestModel; onOpenLine: (info: FormKey) => void }) {
  const [adding, setAdding] = useState<{ index: number; text: string } | null>(null);
  const dialogue = useStageDialogue(q.formKey);
  const next = (q.stages.reduce((m, s) => Math.max(m, s.index), -10) + 10) || 0;
  return (
    <div className="timeline" data-testid="stages">
      {q.stages.map((s, si) => (
        <div key={s.index} className="stage-card">
          <div>
            <div className="stage-index">{s.index}</div>
            <button className="btn small ghost" title="Remove stage" onClick={() => engine((c) => c.call('removeStage', q.formKey, s.index))}>
              <Icon name="trash" size={12} />
            </button>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <div className="row wrap" style={{ gap: 10 }}>
              {STAGE_FLAGS.map(([bit, label, help]) => (
                <Checkbox key={bit} checked={(s.flags & bit) !== 0} label={label} help={help} onChange={(on) => patchRecord(q.formKey, `Stage ${s.index} flags`, (d) => (d.stages[si].index.flags = on ? d.stages[si].index.flags | bit : d.stages[si].index.flags & ~bit))} />
              ))}
            </div>
            {(s.logEntries.length ? s.logEntries : [{ flags: 0, text: '', fragment: undefined }]).map((le, li) => (
              <LogEntry key={li} q={q} stage={s.index} stageIdx={si} logIndex={li} entry={le} exists={li < s.logEntries.length} />
            ))}
            <StageDialogue stage={s.index} dialogue={dialogue} onOpenLine={onOpenLine} />
          </div>
        </div>
      ))}
      {adding ? (
        <div className="card row" style={{ gap: 8 }}>
          <div style={{ width: 90 }}>
            <DragNumber value={adding.index} step={5} precision={0} min={0} max={65535} onCommit={(index) => setAdding({ ...adding, index: Math.round(index) })} />
          </div>
          <div className="grow">
            <TextInput value={adding.text} onCommit={(text) => setAdding({ ...adding, text })} placeholder="Journal entry (optional)" />
          </div>
          <button
            className="btn primary small"
            onClick={async () => {
              if (q.stages.some((s) => s.index === adding.index)) return useStore.getState().toast('warning', `Stage ${adding.index} already exists`);
              await engine((c) => c.call('addStage', q.formKey, adding.index, adding.text || undefined));
              setAdding(null);
            }}
          >
            Add
          </button>
          <button className="btn small ghost" onClick={() => setAdding(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn" onClick={() => setAdding({ index: next, text: '' })} data-testid="add-stage">
          <Icon name="plus" size={13} /> Add stage
        </button>
      )}
    </div>
  );
}

function LogEntry({ q, stage, stageIdx, logIndex, entry, exists }: { q: QuestModel; stage: number; stageIdx: number; logIndex: number; entry: { flags: number; text: string; fragment?: string }; exists: boolean }) {
  const [editing, setEditing] = useState(false);
  const client = useStore((s) => s.client);
  const { data: code } = useQuery(() => (editing ? client?.call('stageFragment', q.formKey, stage, logIndex) : undefined), [editing, stage, logIndex], { revision: false });
  const [draft, setDraft] = useState<string | null>(null);
  const aliases = q.aliases.map((a) => `${a.kind === 'ref' ? 'ReferenceAlias' : 'LocationAlias'} Property Alias_${a.name} Auto\n`).join('');
  return (
    <div className="card" style={{ padding: 8 }}>
      <Field label="Journal" stack>
        <TextInput multiline value={entry.text} placeholder="Shown in the player's journal when this stage is set" onCommit={(text) => engine((c) => c.call('setStageLog', q.formKey, stage, logIndex, text))} />
      </Field>
      <div className="row wrap" style={{ gap: 10, marginTop: 4 }}>
        {exists && (
          <>
            <Checkbox checked={(entry.flags & 1) !== 0} label="Completes quest" onChange={(on) => patchRecord(q.formKey, `Stage ${stage} log flags`, (d) => (d.stages[stageIdx].logEntries[logIndex].flags = on ? d.stages[stageIdx].logEntries[logIndex].flags | 1 : d.stages[stageIdx].logEntries[logIndex].flags & ~1))} />
            <Checkbox checked={(entry.flags & 2) !== 0} label="Fails quest" onChange={(on) => patchRecord(q.formKey, `Stage ${stage} log flags`, (d) => (d.stages[stageIdx].logEntries[logIndex].flags = on ? d.stages[stageIdx].logEntries[logIndex].flags | 2 : d.stages[stageIdx].logEntries[logIndex].flags & ~2))} />
          </>
        )}
        <span className="spacer" />
        <button className={`btn small ${entry.fragment ? '' : 'ghost'}`} onClick={() => setEditing(!editing)} data-testid={`stage-script-${stage}`}>
          <Icon name="script" size={12} /> {entry.fragment ? 'Edit script' : 'Add script'}
        </button>
      </div>
      {editing && code !== undefined && (
        <div style={{ marginTop: 6 }}>
          <CodeEditor
            value={code}
            height={180}
            context={{ prefix: `ScriptName QF_Preview Extends Quest Hidden\n${aliases}\nFunction Fragment_Preview()\n`, suffix: '\nEndFunction\n' }}
            onChange={setDraft}
            onSave={(v) => void saveStageFragment(q, stage, v, logIndex)}
          />
          <div className="row" style={{ marginTop: 4 }}>
            <span className="dim small grow">Runs when stage {stage} is set. Aliases are available as Alias_Name; properties are filled automatically.</span>
            <button className="btn small primary" onClick={() => void saveStageFragment(q, stage, draft ?? code, logIndex).then((ok) => ok && setEditing(false))}>
              Save script
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

async function saveStageFragment(q: QuestModel, stage: number, code: string, logIndex: number): Promise<boolean> {
  const r = await engine((c) => c.call('setStageFragment', q.formKey, stage, code, logIndex), { busy: 'Saving script…' });
  if (r) useStore.getState().toast('success', `Stage ${stage} script saved to ${r.script}.psc — compile it from the Scripts tab`);
  return !!r;
}

// ------------------------------------------------------------------ objectives

function Objectives({ q }: { q: QuestModel }) {
  const [text, setText] = useState('');
  const [alias, setAlias] = useState(-1);
  const next = q.objectives.reduce((m, o) => Math.max(m, o.index), 0) + 10;
  return (
    <div className="col" style={{ gap: 8, maxWidth: 760 }}>
      {q.objectives.map((o, oi) => (
        <div key={o.index} className="card row" style={{ gap: 8 }}>
          <span className="stage-index" style={{ fontSize: 16, width: 50 }}>
            {o.index}
          </span>
          <div className="grow">
            <TextInput value={o.text} onCommit={(t) => patchRecord(q.formKey, 'Objective text', (d) => (d.objectives[oi].text = t))} />
          </div>
          <span className="dim small">{o.targets.map((t) => q.aliases.find((a) => a.id === t.alias)?.name ?? `alias ${t.alias}`).join(', ') || 'no target'}</span>
          <button className="btn icon ghost" title="Remove" onClick={() => patchRecord(q.formKey, 'Remove objective', (d) => d.objectives.splice(oi, 1))}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <div className="card row" style={{ gap: 8 }}>
        <div className="grow">
          <TextInput value={text} onCommit={setText} placeholder="New objective, e.g. “Talk to the innkeeper”" />
        </div>
        <div style={{ width: 180 }}>
          <Select value={alias} options={[{ value: -1, label: 'No map marker' }, ...q.aliases.filter((a) => a.kind === 'ref').map((a) => ({ value: a.id, label: `Marker on ${a.name}` }))]} onChange={setAlias} />
        </div>
        <button
          className="btn primary small"
          disabled={!text}
          onClick={async () => {
            await engine((c) => c.call('addObjective', q.formKey, next, text, alias >= 0 ? alias : undefined));
            setText('');
          }}
        >
          Add objective
        </button>
      </div>
      <p className="dim small">Show objectives from a stage script with SetObjectiveDisplayed({next}) and complete them with SetObjectiveCompleted({next}).</p>
    </div>
  );
}

// ------------------------------------------------------------------ aliases

const ALIAS_FLAGS: [number, string, string][] = [
  [0x2, 'Optional', "The quest can start even if this alias can't be filled. Leave it off for anything the quest really needs."],
  [0x4, 'Quest object', "Items can't be dropped, sold or put away while the quest runs (shown as quest items)."],
  [0x10, 'Allow dead', 'The alias can be filled by a dead actor. Otherwise dead actors are skipped.'],
  [0x40, 'Essential', "The actor can't be killed while in this alias; they're knocked down instead."],
  [0x80, 'Allow disabled', 'The alias can be filled by a disabled (hidden) reference.'],
];

function Aliases({ q }: { q: QuestModel }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'actor' | 'ref' | 'loc'>('actor');
  const [target, setTarget] = useState<FormKey | null>(null);
  const sums = useSummaries(q.aliases.flatMap((a) => Object.values(a.fill).filter((v): v is FormKey => typeof v === 'string' && v.includes(':'))));
  const [triggersFor, setTriggersFor] = useState<number | null>(null);
  return (
    <div className="col" style={{ gap: 8, maxWidth: 860 }}>
      <table className="grid card" style={{ padding: 0 }}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Filled by</th>
            <th>Flags</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.aliases.map((a, ai) => (
            <tr key={`${a.kind}${a.id}`}>
              <td className="mono dim">{a.id}</td>
              <td>
                {a.name} <span className="chip">{a.kind === 'ref' ? 'Reference' : 'Location'}</span>
              </td>
              <td className="small">
                <span className="dim">{FILL_LABELS[a.fillType] ?? a.fillType}</span>{' '}
                {Object.entries(a.fill)
                  .filter(([, v]) => typeof v === 'string' && v.includes(':'))
                  .map(([k, v]) => (
                    <FormLink key={k} value={v as FormKey} summary={sums[v as string]} />
                  ))}
              </td>
              <td>
                {a.kind === 'ref' && (
                  <div className="row wrap" style={{ gap: 8 }}>
                    {ALIAS_FLAGS.map(([bit, label, help]) => (
                      <Checkbox key={bit} checked={(a.flags & bit) !== 0} label={label} help={help} onChange={(on) => patchRecord(q.formKey, `Alias ${a.name} flags`, (d) => (d.aliases[ai].value.flags = on ? (d.aliases[ai].value.flags ?? 0) | bit : (d.aliases[ai].value.flags ?? 0) & ~bit))} />
                    ))}
                  </div>
                )}
              </td>
              <td>
                {a.kind === 'ref' && (
                  <button className="btn small ghost" onClick={() => setTriggersFor(a.id)} title="What happens when the player interacts with whoever fills this alias">
                    <Icon name="auto" size={12} /> Triggers
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!q.aliases.length && (
            <tr>
              <td colSpan={5} className="faint">
                No aliases. Aliases let scripts and dialogue refer to the actors and objects a quest uses.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {triggersFor !== null && (
        <Modal title={`Triggers on alias ${q.aliases.find((a) => a.id === triggersFor)?.name ?? triggersFor}`} onClose={() => setTriggersFor(null)} width={560}>
          <TriggersSection host={{ kind: 'alias', quest: q.formKey, alias: triggersFor }} actor />
        </Modal>
      )}
      <div className="card row wrap" style={{ gap: 8 }}>
        <div style={{ width: 160 }}>
          <TextInput value={name} onCommit={setName} placeholder="Alias name" mono />
        </div>
        <div style={{ width: 170 }}>
          <Select
            value={kind}
            options={[
              { value: 'actor', label: 'Unique actor' },
              { value: 'ref', label: 'Specific reference' },
              { value: 'loc', label: 'Location' },
            ]}
            onChange={(k) => {
              setKind(k);
              setTarget(null);
            }}
          />
        </div>
        <div className="grow" style={{ minWidth: 200 }}>
          <FormPicker value={target} sigs={kind === 'actor' ? ['NPC_'] : kind === 'ref' ? ['REFR', 'ACHR'] : ['LCTN']} onChange={setTarget} placeholder={kind === 'actor' ? 'Which NPC' : kind === 'ref' ? 'Which placed object' : 'Which location'} />
        </div>
        <button
          className="btn primary small"
          disabled={!name}
          onClick={async () => {
            const ok = await engine((c) =>
              kind === 'loc' ? c.call('addLocationAlias', q.formKey, name, target ?? undefined) : c.call('addReferenceAlias', q.formKey, name, kind === 'actor' ? { uniqueActor: target ?? undefined } : { specificReference: target ?? undefined }),
            );
            if (ok) {
              setName('');
              setTarget(null);
            }
          }}
        >
          Add alias
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ dialogue

function Dialogue({ q }: { q: QuestModel }) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="col" style={{ gap: 14, maxWidth: 900 }} data-testid="dialogue">
      {q.topics.map((t) => (
        <Topic key={t.formKey} q={q} t={t} />
      ))}
      {!q.topics.length && <div className="faint">No dialogue yet.</div>}
      {creating ? (
        <NewTopic q={q} onDone={() => setCreating(false)} />
      ) : (
        <button className="btn" onClick={() => setCreating(true)} data-testid="add-topic">
          <Icon name="chat" size={13} /> Add a player topic
        </button>
      )}
    </div>
  );
}

function NewTopic({ q, onDone }: { q: QuestModel; onDone: () => void }) {
  const [edid, setEdid] = useUniqueEditorId(`${q.editorId ?? 'Quest'}Topic${q.topics.length + 1}`);
  const [text, setText] = useState('');
  const [topLevel, setTopLevel] = useState(true);
  return (
    <div className="card col" style={{ gap: 6 }}>
      <Field label="Player says">
        <TextInput value={text} onCommit={setText} placeholder="What the player picks in the dialogue menu" autoFocus />
      </Field>
      <Field label="Editor ID">
        <TextInput value={edid} onCommit={setEdid} mono />
      </Field>
      <Checkbox checked={topLevel} onChange={setTopLevel} label="Show in the NPC's first dialogue menu (top-level branch)" help="Top-level lines appear when you first talk to someone. Turn it off for lines that should only appear as a choice after another line." />
      <div className="row" style={{ gap: 6 }}>
        <button
          className="btn primary small"
          disabled={!text}
          onClick={async () => {
            const ok = await engine((c) => c.call('createTopic', q.formKey, { editorId: edid, text, topLevel }));
            if (ok) onDone();
          }}
        >
          Create topic
        </button>
        <button className="btn small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Topic({ q, t }: { q: QuestModel; t: TopicModel }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row">
        <div className="bubble player grow">
          <div className="who">
            Player · <span className="mono">{t.editorId}</span> · {t.subtype}
          </div>
          <TextInput value={t.text ?? ''} placeholder="(no player line — e.g. a greeting)" onCommit={(name) => patchRecord(t.formKey, 'Edit topic text', (d) => (d.name = name))} />
        </div>
        <button className="btn icon ghost" title="Show topic fields" onClick={() => useStore.getState().showProperties(t.formKey)}>
          <Icon name="link" size={13} />
        </button>
      </div>
      {t.infos.map((info) => (
        <Info key={info.formKey} q={q} info={info} />
      ))}
      {adding ? (
        <NewResponse topic={t} onDone={() => setAdding(false)} />
      ) : (
        <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} /> Add response
        </button>
      )}
    </div>
  );
}

function Info({ q, info }: { q: QuestModel; info: InfoModel }) {
  const [frag, setFrag] = useState<'begin' | 'end' | null>(null);
  const goodbye = (info.flags & 1) !== 0;
  return (
    <div style={{ marginLeft: 28 }} className="col">
      <div className="bubble" onClick={() => useStore.getState().select(info.formKey)}>
        <div className="who row" style={{ gap: 6 }}>
          <span>
            {info.speaker ? <FormLink value={info.speaker} /> : <span className="faint">Any speaker matching the conditions</span>}
          </span>
          {goodbye && <span className="chip">Goodbye</span>}
          {info.hasBeginFragment && <span className="chip accent">begin script</span>}
          {info.hasEndFragment && <span className="chip accent">end script</span>}
          <span className="spacer" />
          <span className="mono faint">{info.editorId ?? info.formKey}</span>
        </div>
        {info.responses.map((r, ri) => (
          <div key={ri} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
            <span className="faint small" style={{ width: 54 }} title="Emotion">
              {EMOTIONS[r.emotion] ?? ''}
            </span>
            <div className="grow" onClick={(e) => e.stopPropagation()}>
              <ExpandableText title="Response" value={r.text} onCommit={(text) => patchRecord(info.formKey, 'Edit response', (d) => (d.responses[ri].text = text))} />
            </div>
          </div>
        ))}
      </div>
      <div className="row wrap small" style={{ gap: 8, margin: '4px 0 0 4px' }}>
        <a href="#" onClick={(e) => (e.preventDefault(), setFrag(frag === 'begin' ? null : 'begin'))}>
          Begin script
        </a>
        <a href="#" onClick={(e) => (e.preventDefault(), setFrag(frag === 'end' ? null : 'end'))}>
          End script
        </a>
      </div>
      <div className="col" style={{ gap: 10, margin: '6px 0 0 4px', maxWidth: 420 }}>
        <InfoWhen info={info} quest={q.formKey} />
        <InfoAfter info={info} quest={q.formKey} goodbye={goodbye} />
      </div>
      {frag && <InfoFragmentEditor q={q} info={info} which={frag} onClose={() => setFrag(null)} />}
    </div>
  );
}

export function InfoConditions({ info }: { info: Pick<InfoModel, 'formKey'> }) {
  const client = useStore((s) => s.client);
  const { data: view } = useQuery(() => client?.call('view', info.formKey), [info.formKey]);
  if (!view) return null;
  const items = ((view.data as any).conditions ?? []) as { data: any }[];
  return (
    <div className="card" style={{ marginTop: 4 }}>
      <ConditionList items={items} onChange={(next) => patchRecord(info.formKey, 'Edit conditions', (d) => (d.conditions = next))} />
    </div>
  );
}

export function InfoFragmentEditor({ q, info, which, onClose }: { q: Pick<QuestModel, 'editorId'>; info: Pick<InfoModel, 'formKey'>; which: 'begin' | 'end'; onClose: () => void }) {
  const client = useStore((s) => s.client);
  const { data: code } = useQuery(() => client?.call('infoFragment', info.formKey, which), [info.formKey, which], { revision: false });
  const [draft, setDraft] = useState<string | null>(null);
  if (code === undefined) return null;
  const save = async (v: string) => {
    const r = await engine((c) => c.call('setInfoFragment', info.formKey, which, v), { busy: 'Saving script…' });
    if (r) {
      useStore.getState().toast('success', `Saved ${which} script to ${r}.psc`);
      onClose();
    }
  };
  return (
    <div style={{ marginTop: 6 }}>
      <CodeEditor
        value={code}
        height={150}
        context={{ prefix: `ScriptName TIF_Preview Extends TopicInfo Hidden\n\nFunction Fragment_Preview(ObjectReference akSpeakerRef)\nActor akSpeaker = akSpeakerRef as Actor\n`, suffix: '\nEndFunction\n' }}
        onChange={setDraft}
        onSave={(v) => void save(v)}
      />
      <div className="row" style={{ marginTop: 4 }}>
        <span className="dim small grow">
          Runs at the {which} of this line. <span className="mono">akSpeaker</span> is the NPC talking; <span className="mono">GetOwningQuest()</span> is {q.editorId}.
        </span>
        <button className="btn small ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn small primary" onClick={() => void save(draft ?? code)}>
          Save script
        </button>
      </div>
    </div>
  );
}

export function NewResponse({ topic, onDone }: { topic: Pick<TopicModel, 'formKey'>; onDone: () => void }) {
  const [text, setText] = useState('');
  const [speaker, setSpeaker] = useState<FormKey | null>(null);
  const [goodbye, setGoodbye] = useState(false);
  const [emotion, setEmotion] = useState(0);
  return (
    <div className="card col" style={{ gap: 6, marginLeft: 28 }}>
      <Field label="NPC says" stack>
        <TextInput multiline value={text} onCommit={setText} placeholder="One line per row; each row becomes a separate voiced line" autoFocus />
      </Field>
      <div className="row wrap" style={{ gap: 8 }}>
        <div style={{ minWidth: 220 }} className="grow">
          <FormPicker value={speaker} sigs={['NPC_']} onChange={setSpeaker} placeholder="Speaker (adds a GetIsID condition)" />
        </div>
        <div style={{ width: 130 }}>
          <Select value={emotion} options={Object.entries(EMOTIONS).map(([v, l]) => ({ value: Number(v), label: l }))} onChange={setEmotion} />
        </div>
        <Checkbox checked={goodbye} onChange={setGoodbye} label="Ends conversation" />
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button
          className="btn primary small"
          disabled={!text.trim()}
          onClick={async () => {
            const ok = await engine((c) => c.call('addResponse', topic.formKey, { text: text.split('\n').filter((l) => l.trim()), speaker: speaker ?? undefined, goodbye, emotion }));
            if (ok) onDone();
          }}
        >
          Add response
        </button>
        <button className="btn small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ voice files

function Voice({ q }: { q: QuestModel }) {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('voiceFiles', q.formKey), [q.formKey]);
  const copy = () => {
    const lines = (data ?? []).flatMap((v) => v.paths.map((p) => `${p}\t${v.text}`));
    void navigator.clipboard?.writeText(lines.join('\n'));
    useStore.getState().toast('success', `Copied ${lines.length} voice file paths`);
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row">
        <p className="dim small grow" style={{ margin: 0 }}>
          Where the game looks for each line's audio (.fuz, or .xwm + .lip). Names follow the game's rules, including the 25-character quest/topic truncation.
        </p>
        <button className="btn small" onClick={copy} disabled={!data?.length}>
          <Icon name="copy" size={12} /> Copy list
        </button>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Line</th>
            <th>File</th>
            <th>Voice types</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((v) => (
            <tr key={`${v.info}:${v.response}`}>
              <td>{v.text}</td>
              <td className="mono small">{v.fileName}</td>
              <td className="small">{v.voiceTypes.join(', ') || <span className="warn">none — add a speaker condition or voice type</span>}</td>
            </tr>
          ))}
          {data && !data.length && (
            <tr>
              <td colSpan={3} className="faint">
                No dialogue lines.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
