/**
 * Branching dialogue as a graph: player lines (blue) lead to NPC responses
 * (grey), which offer player choices, and so on. Drag from a response to a
 * player line to offer it as a choice; drag into empty space to write a new
 * one. "Write as script" edits the whole conversation as a screenplay.
 */
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnConnectEnd,
  useReactFlow,
} from '@xyflow/react';
import { useMeasured } from './measured';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import { parseScreenplay, type DialogueGraph as Graph, type DialogueInfoNode, type DialogueTopicNode } from '@tes5/workspace';
import { ExpandableText, Field, FormLink, FormPicker, Icon, Modal, TextInput, useDebounced, useQuery, useSummaries } from '../../components/ui';
import { GesturePicker } from './GesturePicker';
import { engine, useStore } from '../../state/store';
import { InfoFragmentEditor, NewResponse, patchRecord } from './QuestDesigner';
import { DialogueAvailability, InfoAfter, InfoWhen, useStages, type StageOption } from './StageLinks';
import { stageLabel } from './stageConditions';

type TopicData = { t: DialogueTopicNode };
type InfoData = { i: DialogueInfoNode; speaker?: string; stageText?: (n: number) => string; onStage?: (n: number) => void };

const KIND_LABEL = { player: 'Player', greeting: 'Greeting', idle: 'Chatter', scene: 'Scene line' } as const;
const KIND_HINT = { player: '', greeting: 'Said when the player comes up to them', idle: 'Said to nobody in particular', scene: 'Part of a scene between characters' } as const;

function TopicNodeView({ data, selected }: NodeProps<Node<TopicData>>) {
  return (
    <div className={`dnode player ${selected ? 'selected' : ''}`} data-testid="dlg-topic">
      <Handle type="target" position={Position.Left} />
      {data.t.kind === 'player' ? (
        <>
          <div className="who">Player {data.t.topLevel && <span className="chip accent">opens</span>}</div>
          <div>{data.t.text || <span className="faint">(no text)</span>}</div>
        </>
      ) : (
        <>
          <div className="who">{KIND_LABEL[data.t.kind]}</div>
          <div className="faint small">{KIND_HINT[data.t.kind]}</div>
        </>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** A stage rule on a response; click to show that stage on the map. */
function StageChip({ data, n, prefix, accent }: { data: InfoData; n: number; prefix: string; accent?: boolean }) {
  const what = prefix === '→' ? `Moves the quest to stage ${n} when said` : prefix === 'only at' ? `Said only while the quest is at stage ${n}` : prefix === 'from' ? `Said once stage ${n} has been reached` : `Said only until stage ${n} is reached`;
  return (
    <span
      className={`chip ${accent ? 'accent' : ''}`}
      style={{ cursor: 'pointer' }}
      title={`${what}. Click to show it on the map.`}
      data-testid="stage-chip"
      onClick={(e) => {
        e.stopPropagation();
        data.onStage?.(n);
      }}
    >
      {prefix} {data.stageText?.(n) ?? n}
    </span>
  );
}

function shortStage(stages: StageOption[], n: number): string {
  const s = stages.find((x) => x.index === n);
  if (!s) return `${n} (no such stage)`;
  const text = s.label.replace(/^\d+ – /, '');
  return text === s.label ? `${n}` : stageLabel(n, text, 22);
}

function InfoNodeView({ data, selected }: NodeProps<Node<InfoData>>) {
  const i = data.i;
  return (
    <div className={`dnode npc ${selected ? 'selected' : ''}`} data-testid="dlg-info">
      <Handle type="target" position={Position.Left} />
      <div className="who">
        {data.speaker ?? 'Anyone'}
        {i.goodbye && <span className="chip">goodbye</span>}
      </div>
      <div className="row wrap nodrag" style={{ gap: 4, margin: '2px 0' }}>
        {i.needsStage !== null && <StageChip data={data} n={i.needsStage} prefix="only at" />}
        {i.fromStage !== null && i.needsStage === null && <StageChip data={data} n={i.fromStage} prefix="from" />}
        {i.beforeStage !== null && <StageChip data={data} n={i.beforeStage} prefix="until" />}
        {i.afterQuestDone && <span className="chip" title="Said only after the quest is completed">after quest done</span>}
        {i.setsStage !== null && <StageChip data={data} n={i.setsStage} prefix="→" accent />}
      </div>
      {i.lines.map((l, n) => (
        <div key={n}>{l}</div>
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { topic: TopicNodeView, info: InfoNodeView };

function layout(g: Graph): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  let row = 0;
  const placed = new Set<string>();
  const placeTopic = (t: DialogueTopicNode, depth: number) => {
    if (placed.has(t.formKey)) return;
    placed.add(t.formKey);
    const startRow = row;
    const infos = g.infos.filter((i) => i.topic === t.formKey);
    for (const i of infos) {
      placed.add(i.formKey);
      const infoRow = row;
      const kids = i.choices.map((c) => g.topics.find((x) => x.formKey === c)).filter((x): x is DialogueTopicNode => !!x && !placed.has(x.formKey));
      for (const k of kids) placeTopic(k, depth + 2);
      if (!kids.length) row++;
      pos[i.formKey] = { x: (depth + 1) * 280, y: ((infoRow + Math.max(infoRow, row - 1)) / 2) * 110 };
    }
    if (!infos.length) row++;
    pos[t.formKey] = { x: depth * 280, y: ((startRow + Math.max(startRow, row - 1)) / 2) * 110 };
  };
  for (const t of g.topics.filter((x) => x.topLevel)) {
    placeTopic(t, 0);
    row++;
  }
  for (const t of g.topics) if (!placed.has(t.formKey)) (placeTopic(t, 0), row++);
  return pos;
}

export default function DialogueGraphView({ quest, questEditorId, focus, onListView, onOpenStage }: { quest: FormKey; questEditorId?: string; focus?: FormKey | null; onListView: () => void; onOpenStage?: (stage: number) => void }) {
  return (
    <ReactFlowProvider>
      <Inner quest={quest} questEditorId={questEditorId} focus={focus} onListView={onListView} onOpenStage={onOpenStage} />
    </ReactFlowProvider>
  );
}

function Inner({ quest, questEditorId, focus, onListView, onOpenStage }: { quest: FormKey; questEditorId?: string; focus?: FormKey | null; onListView: () => void; onOpenStage?: (stage: number) => void }) {
  const client = useStore((s) => s.client);
  const stages = useStages(quest);
  const { data: g } = useQuery(() => client?.call('dialogueGraph', quest), [quest]);
  const speakers = useSummaries((g?.infos ?? []).map((i) => i.speaker));
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [newChoiceFor, setNewChoiceFor] = useState<FormKey | null>(null);
  const [newResponseFor, setNewResponseFor] = useState<FormKey | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState(false);
  const { data: lint } = useQuery(() => client?.call('lintDialogue', quest), [quest]);
  useEffect(() => setSelected(focus ?? null), [focus]);
  const flow = useReactFlow();
  const { onChanges, withSize } = useMeasured();
  const size = (g?.topics.length ?? 0) + (g?.infos.length ?? 0);
  // Keep everything in view as the conversation grows (or jump to the focused line).
  useEffect(() => {
    if (!size) return;
    const t = setTimeout(() => {
      if (focus) void flow.fitView({ nodes: [{ id: focus }], padding: 1.2, maxZoom: 1.1 });
      else void flow.fitView({ padding: 0.2, maxZoom: 1.1 });
    }, 60);
    return () => clearTimeout(t);
  }, [size, focus, flow]);

  const pos = useMemo(() => (g ? layout(g) : {}), [g]);
  /** "20 – Find the ring", short enough for a chip. */
  const stageText = useMemo(() => (n: number) => shortStage(stages, n), [stages]);
  const nodes = useMemo<Node[]>(() => {
    if (!g) return [];
    return [
      ...g.topics.map((t) => ({ id: t.formKey, type: 'topic', position: pos[t.formKey] ?? { x: 0, y: 0 }, data: { t }, selected: selected === t.formKey })),
      ...g.infos.map((i) => {
        const s = i.speaker ? speakers[i.speaker] : null;
        return { id: i.formKey, type: 'info', position: pos[i.formKey] ?? { x: 0, y: 0 }, data: { i, speaker: i.speaker ? (s?.name ?? s?.editorId ?? i.speaker) : undefined, stageText, onStage: onOpenStage }, selected: selected === i.formKey };
      }),
    ].map(withSize);
  }, [g, pos, selected, speakers, withSize, stageText, onOpenStage]);
  const edges = useMemo<Edge[]>(() => {
    if (!g) return [];
    const out: Edge[] = [];
    for (const i of g.infos) {
      out.push({ id: `${i.topic}>${i.formKey}`, source: i.topic, target: i.formKey, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#8a8f98' } });
      for (const c of i.choices) out.push({ id: `${i.formKey}>${c}`, source: i.formKey, target: c, markerEnd: { type: MarkerType.ArrowClosed, color: '#4f9cf7' }, style: { stroke: '#4f9cf7', strokeDasharray: '5 4' }, data: { choice: true } });
    }
    return out;
  }, [g]);

  const kindOf = (id: string) => (g?.topics.some((t) => t.formKey === id) ? 'topic' : g?.infos.some((i) => i.formKey === id) ? 'info' : undefined);
  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    if (kindOf(c.source) === 'info' && kindOf(c.target) === 'topic') void engine((cl) => cl.call('setDialogueChoice', c.source as FormKey, c.target as FormKey, true));
    else useStore.getState().toast('info', 'Connect a response (grey) to a player line (blue) to offer it as a choice.');
  };
  const onConnectEnd: OnConnectEnd = (_, state) => {
    if (state.isValid || !state.fromNode) return;
    const id = state.fromNode.id as FormKey;
    if (kindOf(id) === 'info') setNewChoiceFor(id);
    else if (kindOf(id) === 'topic') setNewResponseFor(id);
  };

  if (!g) return <div className="empty">Loading…</div>;
  const selTopic = g.topics.find((t) => t.formKey === selected);
  const selInfo = g.infos.find((i) => i.formKey === selected);

  return (
    <div className="qmap" data-testid="dialogue-graph">
      <div className="viewport-toolbar">
        <button className="btn small" onClick={() => setStarting(true)} data-testid="dlg-new">
          <Icon name="plus" size={12} /> New conversation
        </button>
        <button className="btn small primary" onClick={() => setScriptOpen(true)} data-testid="dlg-script">
          <Icon name="script" size={12} /> Write as script
        </button>
        <span className="spacer" />
        <span className="dim small">Drag from a response to a player line to offer it as a choice, or into empty space to write a new choice.</span>
        <button className="btn small ghost" onClick={() => setAvailability(true)} data-testid="dlg-availability" title="Choose when this quest's dialogue can be said at all, for example only once a stage is reached, and not after the quest is completed">
          Availability
        </button>
        <button className="btn small ghost" onClick={onListView}>
          List view
        </button>
        <button
          className={`btn small ${lint?.some((l) => l.severity === 'error') ? 'warn' : 'ghost'}`}
          onClick={() => setChecking(!checking)}
          data-testid="dlg-check"
          title="Checks for lines nobody answers, choices that never appear, lines still offered after the quest moved on, stages that don't exist, over-long lines and placeholders"
        >
          {lint?.length ? `⚠ ${lint.length} to check` : '✓ Dialogue OK'}
        </button>
      </div>
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {checking && (
            <div className="card" style={{ position: 'absolute', right: 12, top: 12, width: 380, maxHeight: '70%', overflow: 'auto', zIndex: 5 }} data-testid="dlg-lint">
              <div className="card-title">Dialogue check</div>
              {lint?.length ? (
                lint.map((l, n) => (
                  <div key={n} className={`small ${l.severity === 'error' ? 'err' : 'warn'}`} style={{ marginBottom: 6, cursor: l.form ? 'pointer' : undefined }} onClick={() => l.form && setSelected(l.form)} title={l.detail}>
                    {l.severity === 'error' ? '✖' : '⚠'} {l.message}
                    {l.detail && <div className="dim">{l.detail}</div>}
                  </div>
                ))
              ) : (
                <div className="ok small">Nothing to fix: every line is answered, every choice can be reached, and stages exist.</div>
              )}
            </div>
          )}
          {g.topics.length ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
              minZoom={0.2}
              nodesDraggable
              onNodesChange={onChanges}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              onNodeClick={(_, n) => setSelected(n.id)}
              onEdgeClick={(_, e) => {
                if ((e.data as { choice?: boolean } | undefined)?.choice && confirm('Stop offering this choice after that response?')) void engine((c) => c.call('setDialogueChoice', e.source as FormKey, e.target as FormKey, false));
              }}
              onPaneClick={() => setSelected(null)}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="empty" style={{ padding: 40 }}>
              No dialogue yet. Start a conversation, or write one as a script.
            </div>
          )}
        </div>
        <div className="panel" style={{ width: 340, flex: 'none', borderLeft: '1px solid var(--border)', background: 'var(--panel)' }}>
          {selTopic ? (
            <TopicPanel t={selTopic} onAddResponse={() => setNewResponseFor(selTopic.formKey)} />
          ) : selInfo ? (
            <InfoPanel i={selInfo} quest={quest} questEditorId={questEditorId} g={g} onAddChoice={() => setNewChoiceFor(selInfo.formKey)} />
          ) : (
            <div className="pad dim small">
              Click a line to edit it. Blue boxes are what the player says; grey boxes are the answers. A response can offer more player lines as choices (dashed arrows).
            </div>
          )}
        </div>
      </div>
      {newChoiceFor && <NewChoiceDialog info={newChoiceFor} onClose={() => setNewChoiceFor(null)} />}
      {newResponseFor && (
        <Modal title="Add a response" onClose={() => setNewResponseFor(null)} width={560}>
          <NewResponse topic={{ formKey: newResponseFor }} onDone={() => setNewResponseFor(null)} />
        </Modal>
      )}
      {availability && (
        <Modal
          title="When is this quest's dialogue available?"
          onClose={() => setAvailability(false)}
          width={460}
          footer={
            <button className="btn primary" onClick={() => setAvailability(false)}>
              Done
            </button>
          }
        >
          <DialogueAvailability quest={quest} />
        </Modal>
      )}
      {starting && <StartConversationDialog quest={quest} onClose={() => setStarting(false)} />}
      {scriptOpen && <ScreenplayDialog quest={quest} onClose={() => setScriptOpen(false)} />}
    </div>
  );
}

function TopicPanel({ t, onAddResponse }: { t: DialogueTopicNode; onAddResponse: () => void }) {
  return (
    <>
      <div className="panel-header">
        <span className="grow">Player line</span>
        <button className="btn icon ghost" title="Delete this line and its responses" onClick={() => engine((c) => c.call('deleteRecord', t.formKey))}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      <div className="scroll pad col" style={{ flex: 1, gap: 8 }}>
        <ExpandableText multiline title="Player line" value={t.text} onCommit={(name) => patchRecord(t.formKey, 'Edit player line', (d) => (d.name = name))} />
        <div className="dim small mono">{t.editorId}</div>
        <div className="dim small">{t.topLevel ? 'Shown when the conversation opens.' : 'Shown only as a choice after a response.'}</div>
        <button className="btn small" onClick={onAddResponse} data-testid="dlg-add-response">
          <Icon name="plus" size={12} /> Add a response
        </button>
      </div>
    </>
  );
}

function InfoPanel({ i, g, quest, questEditorId, onAddChoice }: { i: DialogueInfoNode; g: Graph; quest: FormKey; questEditorId?: string; onAddChoice: () => void }) {
  const [frag, setFrag] = useState<'begin' | 'end' | null>(null);
  return (
    <>
      <div className="panel-header">
        <span className="grow">Response</span>
        <button className="btn icon ghost" title="Delete this response" onClick={() => engine((c) => c.call('deleteRecord', i.formKey))}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      <div className="scroll pad col" style={{ flex: 1, gap: 8 }}>
        <div className="small">
          Said by {i.speaker ? <FormLink value={i.speaker} /> : <span className="faint">anyone matching the conditions</span>}
        </div>
        {i.lines.map((l, n) => (
          <ExpandableText key={n} title="Response" value={l} onCommit={(text) => patchRecord(i.formKey, 'Edit response', (d) => (d.responses[n].text = text))} />
        ))}
        <InfoWhen info={i} quest={quest} />
        <InfoAfter info={i} quest={quest} goodbye={i.goodbye} />
        <ResponseGesture info={i.formKey} />
        <div>
          <h3 style={{ margin: '6px 0' }}>Player choices after this</h3>
          {i.choices.map((c) => {
            const t = g.topics.find((x) => x.formKey === c);
            return (
              <div key={c} className="row small" style={{ gap: 4 }}>
                <span className="grow">“{t?.text ?? c}”</span>
                <button className="btn icon ghost" title="Stop offering this choice" onClick={() => engine((cl) => cl.call('setDialogueChoice', i.formKey, c, false))}>
                  <Icon name="close" size={11} />
                </button>
              </div>
            );
          })}
          <button className="btn small" onClick={onAddChoice} data-testid="dlg-add-choice">
            <Icon name="plus" size={12} /> Add a player choice
          </button>
        </div>
        <div className="row wrap small" style={{ gap: 8 }}>
          <a href="#" onClick={(e) => (e.preventDefault(), setFrag(frag === 'begin' ? null : 'begin'))}>
            Begin script
          </a>
          <a href="#" onClick={(e) => (e.preventDefault(), setFrag(frag === 'end' ? null : 'end'))}>
            End script
          </a>
        </div>
        {frag && <InfoFragmentEditor q={{ editorId: questEditorId }} info={i} which={frag} onClose={() => setFrag(null)} />}
      </div>
    </>
  );
}

function NewChoiceDialog({ info, onClose }: { info: FormKey; onClose: () => void }) {
  const [text, setText] = useState('');
  return (
    <Modal
      title="New player choice"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!text.trim()}
            onClick={async () => {
              const ok = await engine((c) => c.call('addDialogueChoice', info, text.trim()));
              if (ok) onClose();
            }}
            data-testid="dlg-create-choice"
          >
            Add choice
          </button>
        </>
      }
    >
      <TextInput value={text} onCommit={setText} placeholder="What the player can say next" autoFocus />
      <p className="dim small">Then drag from it (or use “Add a response”) to write the answer.</p>
    </Modal>
  );
}

function StartConversationDialog({ quest, onClose }: { quest: FormKey; onClose: () => void }) {
  const [npc, setNpc] = useState<FormKey | null>(null);
  const [player, setPlayer] = useState('');
  const [answer, setAnswer] = useState('');
  return (
    <Modal
      title="New conversation"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!player.trim() || !answer.trim()}
            onClick={async () => {
              const ok = await engine(async (c) => {
                const qv = await c.call('view', quest);
                const id = await c.call('uniqueEditorId', `${qv?.editorId ?? 'Quest'}Topic`);
                const g = await c.call('createTopic', quest, { editorId: id, text: player.trim() });
                const topic = g.topics.find((t) => t.editorId === id)!.formKey;
                await c.call('addResponse', topic, { text: answer.split('\n').map((l) => l.trim()).filter(Boolean), speaker: npc ?? undefined });
                return true;
              });
              if (ok) onClose();
            }}
          >
            Create
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 8 }}>
        <FormPicker value={npc} sigs={['NPC_']} onChange={setNpc} placeholder="Who answers (leave empty for anyone)" />
        <TextInput value={player} onCommit={setPlayer} placeholder="Player says…" autoFocus />
        <TextInput multiline value={answer} onCommit={setAnswer} placeholder="They answer… (one line per row)" />
      </div>
    </Modal>
  );
}

const SCRIPT_HELP = `PLAYER: Got any work?
Brynja: A crate of mead went missing.
Brynja: Find it and I'll pay you.
    PLAYER: I'll look into it. [stage 10]
      Brynja: Thank you! [goodbye]
    PLAYER: Not interested.
      Brynja: Suit yourself. [goodbye]`;

function ResponseGesture({ info }: { info: FormKey }) {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('responseGesture', info), [info]);
  return (
    <Field label="Gesture" title="An animation the speaker plays as they start this line (wave, point, laugh…). It's written into the response's begin script; other lines there are kept.">
      <GesturePicker value={data ?? null} onChange={(g) => engine((c) => c.call('setResponseGesture', info, g), { success: g ? 'Gesture set' : 'Gesture removed' })} testId="dlg-gesture" />
    </Field>
  );
}

function ScreenplayDialog({ quest, onClose }: { quest: FormKey; onClose: () => void }) {
  const client = useStore((s) => s.client);
  const area = useRef<HTMLTextAreaElement>(null);
  // Add a [gesture …] tag to the end of the line the cursor is on.
  const insertGesture = (g: string | null) => {
    if (!g) return;
    const el = area.current;
    const at = el ? el.selectionStart : text.length;
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    const next = `${text.slice(0, end).replace(/\s+$/, '')} [gesture ${g}]${text.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => el?.focus());
  };
  const { data: existing } = useQuery(() => client?.call('dialogueScreenplay', quest), [quest], { revision: false });
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseScreenplay(text), [text]);
  const dtext = useDebounced(text, 300);
  const { data: lint } = useQuery(() => (dtext.trim() ? client?.call('lintScreenplay', quest, dtext) : Promise.resolve([])), [dtext], { revision: false });
  const blocking = (lint ?? []).filter((l) => l.severity === 'error');
  const counts = useMemo(() => {
    let topics = 0;
    let responses = 0;
    const walk = (p: (typeof parsed.topics)[number]) => {
      topics++;
      for (const r of p.responses) {
        responses++;
        r.choices.forEach(walk);
      }
    };
    parsed.topics.forEach(walk);
    return { topics, responses };
  }, [parsed]);
  return (
    <Modal
      title="Write dialogue as a script"
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="dim small grow">{text.trim() && !parsed.errors.length ? `Will add ${counts.topics} player line(s) and ${counts.responses} response(s).` : ''}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!text.trim() || parsed.errors.length > 0 || blocking.length > 0}
            onClick={async () => {
              const r = await engine((c) => c.call('importScreenplay', quest, text), { busy: 'Creating dialogue…' });
              if (r) {
                useStore.getState().toast('success', `Added ${r.topics} player line(s) and ${r.responses} response(s)`);
                onClose();
              }
            }}
            data-testid="dlg-import"
          >
            Create dialogue
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="grow">
          <textarea ref={area} className="input mono" style={{ width: '100%', height: 320, whiteSpace: 'pre' }} value={text} onChange={(e) => setText(e.target.value)} placeholder={SCRIPT_HELP} spellCheck={false} data-testid="dlg-script-text" onKeyDown={(e) => e.stopPropagation()} />
          {text.trim() && (lint ?? []).length > 0 && (
            <div className="small" style={{ marginTop: 6, maxHeight: 110, overflow: 'auto' }} data-testid="dlg-script-lint">
              {lint!.map((e, n) => (
                <div key={n} className={e.severity === 'error' ? 'err' : 'warn'} title={e.detail}>
                  {e.line ? `Line ${e.line}: ` : ''}
                  {e.message}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ width: 230 }} className="small dim">
          <p style={{ marginTop: 0 }}>
            <strong>NAME: line</strong> — use PLAYER for the player and a character’s name or Editor ID for answers (NPC = anyone).
          </p>
          <p>Indent player lines under an answer to make them choices after it.</p>
          <p>
            Tags: <span className="mono">[goodbye]</span> ends the talk, <span className="mono">[stage 20]</span> sets a quest stage after the line, <span className="mono">[if stage 10]</span> only at that stage, <span className="mono">[emotion happy]</span>, <span className="mono">[gives gold x100]</span> / <span className="mono">[takes Ring x1]</span>, <span className="mono">[gesture wave]</span> plays an animation, <span className="mono">[once]</span> says it only once, <span className="mono">[persuade 50]</span> on a player line makes the first answer a Speech check.
          </p>
          <p>
            Conditions: <span className="mono">[if has Ring]</span>, <span className="mono">[if done 20]</span>, <span className="mono">[if gold 100]</span>, <span className="mono">[if speech 50]</span>, <span className="mono">[if level 10]</span>, <span className="mono">[if female]</span>, <span className="mono">[if race Nord]</span>, <span className="mono">[if quest MyQuest done]</span>.
          </p>
          <p>
            Lines nobody prompts: <span className="mono">GREETING:</span> (said as the player comes up), <span className="mono">IDLE:</span> (chatter), and <span className="mono">SCENE: name [at stage 20]</span> for characters talking to each other; put their lines under it.
          </p>
          <GesturePicker value={null} none="Add a gesture to this line…" onChange={insertGesture} testId="dlg-insert-gesture" />
          <p>New lines are added; existing dialogue is kept.</p>
          {existing && existing.trim() && (
            <details>
              <summary style={{ cursor: 'pointer' }}>This quest’s dialogue so far, as a script</summary>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', fontSize: 11 }}>
                {existing}
              </pre>
            </details>
          )}
        </div>
      </div>
    </Modal>
  );
}
