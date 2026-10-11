/**
 * The quest map: the whole quest as a flow chart. Stages are nodes; every
 * arrow is something that moves the quest on (talking, picking up, killing,
 * arriving, using, or a script). Drag from a stage to another — or into
 * empty space to make a new stage — and choose what makes it happen; the
 * dialogue, aliases and scripts behind it are created for you.
 */
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnConnectEnd,
} from '@xyflow/react';
import { useMeasured } from './measured';
import '@xyflow/react/dist/style.css';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormKey } from '@tes5/esp';
import type { NewQuestEdge, QuestEdge, QuestEdgeKind, QuestGraph, QuestStageNode } from '@tes5/workspace';
import { Checkbox, Field, FormLink, FormPicker, Icon, Modal, TextInput, useQuery } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { patchRecord } from './QuestDesigner';
import { GesturePicker } from './GesturePicker';
const JournalWriter = lazy(() => import('./JournalWriter'));

export const EDGE_KINDS: Record<QuestEdgeKind, { icon: string; color: string; title: string; needs?: string; sigs?: string[]; help: string }> = {
  talk: { icon: '💬', color: '#4f9cf7', title: 'Talk to someone', help: 'The player picks a line in a conversation.' },
  pickup: { icon: '🤚', color: '#e8b647', title: 'Pick up an object', needs: 'Which object (placed in the world)', sigs: ['REFR'], help: 'The object goes into the player’s inventory.' },
  activate: { icon: '🖐', color: '#a78bfa', title: 'Use / activate something', needs: 'Which object or character', sigs: ['REFR', 'ACHR'], help: 'The player presses Activate on it.' },
  death: { icon: '💀', color: '#ef6b6b', title: 'Kill someone', needs: 'Who (a character or a placed actor)', sigs: ['NPC_', 'ACHR'], help: 'They die, whoever kills them.' },
  arrive: { icon: '📍', color: '#4cc38a', title: 'Arrive somewhere', needs: 'Which cell', sigs: ['CELL'], help: 'The player enters (or gets close to) this place.' },
  hit: { icon: '⚔️', color: '#f08a4b', title: 'Hit something', needs: 'Which object or character', sigs: ['REFR', 'ACHR'], help: 'The player hits it with a weapon or spell.' },
  read: { icon: '📖', color: '#c9a26b', title: 'Read a book or note', needs: 'Which book (placed in the world)', sigs: ['REFR'], help: 'The player opens it to read.' },
  equip: { icon: '🛡️', color: '#8fb3c9', title: 'Equip an item', needs: 'Which item (placed in the world)', sigs: ['REFR'], help: 'The player equips it.' },
  drop: { icon: '📦', color: '#b38f6b', title: 'Hand over / drop an item', needs: 'Which item (placed in the world)', sigs: ['REFR'], help: 'It leaves the player’s inventory.' },
  load: { icon: '👁', color: '#999', title: 'Something comes into view', needs: 'Which object', sigs: ['REFR', 'ACHR'], help: 'Its 3D loads near the player.' },
  script: { icon: '⚡', color: '#9aa0a6', title: 'Right away', help: 'As soon as the earlier stage is reached (stage script).' },
};
const PICKABLE: QuestEdgeKind[] = ['talk', 'pickup', 'activate', 'death', 'arrive', 'read', 'hit', 'equip', 'drop', 'script'];

type StageData = { node: QuestStageNode; objectives: QuestGraph['objectives'] };

function StageNodeView({ data, selected }: NodeProps<Node<StageData>>) {
  const n = data.node;
  const obj = (i: number) => data.objectives.find((o) => o.index === i)?.text ?? `Objective ${i}`;
  return (
    <div className={`qnode ${selected ? 'selected' : ''} ${n.completesQuest ? 'done' : ''} ${n.failsQuest ? 'failed' : ''}`} data-testid={`stage-node-${n.stage}`}>
      <Handle type="target" position={Position.Left} />
      <div className="qnode-head">
        <span className="qnode-index">{n.stage}</span>
        {n.startUp && <span className="chip accent">start</span>}
        {n.completesQuest && <span className="chip ok">completes</span>}
        {n.failsQuest && <span className="chip err">fails</span>}
        {n.shutDown && <span className="chip">ends</span>}
        {n.hasScript && <span title="Has a stage script">⚡</span>}
      </div>
      <div className="qnode-text">{n.text || <span className="faint">No journal entry</span>}</div>
      {n.shows.map((i) => (
        <div key={`s${i}`} className="qnode-obj">
          📍 {obj(i)}
        </div>
      ))}
      {n.completes.map((i) => (
        <div key={`c${i}`} className="qnode-obj done">
          ✔ {obj(i)}
        </div>
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function AnyTimeNode() {
  return (
    <div className="qnode any" title="Things that can happen at any stage">
      <div className="qnode-head">Any time</div>
      <div className="qnode-text faint">Drag from here for events that don’t depend on the current stage.</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function QuestEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<Edge<{ edge: QuestEdge }>>) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const e = data!.edge;
  const k = EDGE_KINDS[e.kind];
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: k.color, strokeWidth: selected ? 3 : 2 }} />
      <EdgeLabelRenderer>
        <div className={`qedge-label ${selected ? 'selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px,${ly}px)`, borderColor: k.color }} title={e.label}>
          {k.icon} {e.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { stage: StageNodeView, any: AnyTimeNode };
const edgeTypes = { quest: QuestEdgeView };

/** Left-to-right layout by distance from the start stages. */
function autoLayout(g: QuestGraph): Record<string, { x: number; y: number }> {
  const rank = new Map<number, number>();
  const starts = g.nodes.filter((n) => n.startUp).map((n) => n.stage);
  if (!starts.length && g.nodes[0]) starts.push(g.nodes[0].stage);
  const queue = starts.map((s) => [s, 0] as [number, number]);
  while (queue.length) {
    const [s, r] = queue.shift()!;
    if (rank.has(s) && rank.get(s)! >= r) continue;
    if (r > g.nodes.length) continue;
    rank.set(s, r);
    for (const e of g.edges) if (e.from === s) queue.push([e.to, r + 1]);
  }
  let maxRank = Math.max(0, ...rank.values());
  for (const n of g.nodes) if (!rank.has(n.stage)) rank.set(n.stage, ++maxRank);
  const perRank = new Map<number, number>();
  const out: Record<string, { x: number; y: number }> = { any: { x: -300, y: -40 } };
  for (const n of [...g.nodes].sort((a, b) => a.stage - b.stage)) {
    const r = rank.get(n.stage)!;
    const i = perRank.get(r) ?? 0;
    perRank.set(r, i + 1);
    out[`stage:${n.stage}`] = { x: r * 300, y: i * 190 };
  }
  return out;
}

export default function QuestMap({ quest, onOpenDialogue, onOpenStages, focusStage }: { quest: FormKey; onOpenDialogue: (topic: FormKey) => void; onOpenStages: () => void; focusStage?: { stage: number; n: number } | null }) {
  return (
    <ReactFlowProvider>
      <QuestMapInner quest={quest} onOpenDialogue={onOpenDialogue} onOpenStages={onOpenStages} focusStage={focusStage} />
    </ReactFlowProvider>
  );
}

function QuestMapInner({ quest, onOpenDialogue, onOpenStages, focusStage }: { quest: FormKey; onOpenDialogue: (topic: FormKey) => void; onOpenStages: () => void; focusStage?: { stage: number; n: number } | null }) {
  const client = useStore((s) => s.client);
  const { data: g } = useQuery(() => client?.call('questGraph', quest), [quest]);
  const flow = useReactFlow();
  const [pending, setPending] = useState<{ from: number | null; to: number } | null>(null);
  const [selected, setSelected] = useState<{ kind: 'stage'; stage: number } | { kind: 'edge'; edge: QuestEdge } | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  // Jumping here from a stage chip in the dialogue: select that stage so its panel opens.
  useEffect(() => {
    if (focusStage) setSelected({ kind: 'stage', stage: focusStage.stage });
  }, [focusStage]);
  const [showProblems, setShowProblems] = useState(false);
  const [writing, setWriting] = useState(false);
  const { onChanges, withSize } = useMeasured();
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wrap = useRef<HTMLDivElement>(null);
  const shownFor = useRef<FormKey | null>(null);
  // When the whole quest doesn't fit at a readable zoom, start at its left end (where it begins) instead of the middle.
  const measured = useNodesInitialized();
  useEffect(() => {
    if (!g || !measured || shownFor.current === quest) return;
    shownFor.current = quest;
    void (async () => {
      await flow.fitView({ padding: 0.25, maxZoom: 1.1, minZoom: 0.55 });
      const nodes = flow.getNodes();
      if (!nodes.length || !wrap.current) return;
      const b = flow.getNodesBounds(nodes);
      const v = flow.getViewport();
      if (b.width * v.zoom + 48 > wrap.current.clientWidth) await flow.setViewport({ x: 24 - b.x * v.zoom, y: v.y, zoom: v.zoom });
    })();
  }, [g, quest, flow, measured]);

  useEffect(() => {
    if (!g) return;
    setPositions((cur) => ({ ...autoLayout(g), ...g.layout, ...cur }));
  }, [g]);

  const persist = useCallback(
    (next: Record<string, { x: number; y: number }>) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void client?.call('saveQuestLayout', quest, next), 400);
    },
    [client, quest],
  );

  const nodes = useMemo<Node[]>(() => {
    if (!g) return [];
    const list: Node[] = g.nodes.map((n) => ({
      id: `stage:${n.stage}`,
      type: 'stage',
      position: positions[`stage:${n.stage}`] ?? { x: 0, y: 0 },
      data: { node: n, objectives: g.objectives },
      selected: selected?.kind === 'stage' && selected.stage === n.stage,
    }));
    list.push({ id: 'any', type: 'any', position: positions.any ?? { x: -300, y: -40 }, data: {}, deletable: false });
    return list.map(withSize);
  }, [g, positions, selected, withSize]);

  const edges = useMemo<Edge[]>(
    () =>
      (g?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.from === null ? 'any' : `stage:${e.from}`,
        target: `stage:${e.to}`,
        type: 'quest',
        data: { edge: e },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_KINDS[e.kind].color },
        selected: selected?.kind === 'edge' && selected.edge.id === e.id,
      })),
    [g, selected],
  );

  const stageOf = (id: string | null | undefined) => (id === 'any' ? null : id ? Number(id.slice(6)) : undefined);
  const nextStage = () => (g ? Math.max(0, ...g.nodes.map((n) => n.stage)) + 10 : 10);

  const onConnect = (c: Connection) => {
    const from = stageOf(c.source);
    const to = stageOf(c.target);
    if (from === undefined || to === undefined || to === null) return;
    setPending({ from, to });
  };
  const onConnectEnd: OnConnectEnd = (event, state) => {
    if (state.isValid || !state.fromNode) return;
    // Dropped on empty canvas: make a new stage there.
    const from = stageOf(state.fromNode.id);
    if (from === undefined) return;
    const pt = 'changedTouches' in event ? event.changedTouches[0]! : (event as MouseEvent);
    const pos = flow.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
    const to = nextStage();
    const next = { ...positions, [`stage:${to}`]: { x: pos.x, y: pos.y - 40 } };
    setPositions(next);
    persist(next);
    setPending({ from, to });
  };

  if (!g) return <div className="empty">Loading…</div>;

  return (
    <div className="qmap" data-testid="quest-map">
      {writing && (
        <Suspense fallback={null}>
          <JournalWriter quest={quest} onClose={() => setWriting(false)} />
        </Suspense>
      )}
      <div className="viewport-toolbar">
        <button
          className="btn small"
          onClick={async () => {
            const to = nextStage();
            await engine((c) => c.call('addStage', quest, to, ''));
            setSelected({ kind: 'stage', stage: to });
          }}
          data-testid="map-add-stage"
        >
          <Icon name="plus" size={12} /> Stage
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            const next = autoLayout(g);
            setPositions(next);
            persist(next);
            setTimeout(() => flow.fitView({ padding: 0.2, minZoom: 0.55 }), 50);
          }}
        >
          Tidy up
        </button>
        <button className="btn small ghost" onClick={() => setWriting(true)} data-testid="map-write-journal" title="Draft journal entries and objectives from the arrows on the map, in Skyrim's style">
          <Icon name="file" size={12} /> Write journal
        </button>
        <span className="sep" />
        <Checkbox checked={g.startGameEnabled} onChange={(on) => engine((c) => c.call('setQuestStartGameEnabled', quest, on))} label="Running from game start" help="The quest runs from the moment the game loads. Dialogue-only quests usually need this, or their lines never appear." />
        {g.starts.some((x) => x.kind !== 'game') && (
          <span className="chip accent" title={`Also started by:\n${g.starts.filter((x) => x.kind !== 'game').map((x) => `• ${x.label}`).join('\n')}\n\nChange this with “Change with a plan”, or edit the trigger on the object.`} data-testid="map-starts">
            ▶ Starts: {g.starts.filter((x) => x.kind !== 'game').map((x) => x.label).join('; ')}
          </span>
        )}
        <span className="spacer" />
        <span className="dim small">Drag from a stage’s right edge to another stage, or into empty space for a new one.</span>
        <button className={`btn small ${g.problems.length ? 'warn' : 'ghost'}`} onClick={() => setShowProblems(!showProblems)} data-testid="map-problems">
          {g.problems.length ? `⚠ ${g.problems.length} problem${g.problems.length > 1 ? 's' : ''}` : '✓ No problems'}
        </button>
      </div>
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
        <div ref={wrap} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode="dark"
            minZoom={0.2}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onNodesChange={(changes) => {
              onChanges(changes);
              let moved = false;
              const next = { ...positions };
              for (const ch of changes) if (ch.type === 'position' && ch.position) ((next[ch.id] = ch.position), (moved = true));
              if (moved) {
                setPositions(next);
                if (changes.some((ch) => ch.type === 'position' && !ch.dragging)) persist(next);
              }
            }}
            onNodeClick={(_, n) => setSelected(n.id === 'any' ? null : { kind: 'stage', stage: Number(n.id.slice(6)) })}
            onEdgeClick={(_, e) => setSelected({ kind: 'edge', edge: (e.data as { edge: QuestEdge }).edge })}
            onEdgeDoubleClick={(_, e) => {
              const qe = (e.data as { edge: QuestEdge }).edge;
              if (qe.source.type === 'info') onOpenDialogue(qe.source.topic);
            }}
            onPaneClick={() => setSelected(null)}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            {g.nodes.length > 6 && <MiniMap pannable zoomable style={{ width: 160, height: 100, background: 'var(--panel)' }} maskColor="rgba(0,0,0,0.45)" nodeColor="#4f9cf7" />}
            <Controls showInteractive={false} />
          </ReactFlow>
          {showProblems && (
            <div className="card" style={{ position: 'absolute', right: 12, top: 12, width: 340, zIndex: 5 }}>
              <div className="card-title">Quest check</div>
              {g.problems.length ? g.problems.map((p) => <div key={p} className="small warn" style={{ marginBottom: 4 }}>⚠ {p}</div>) : <div className="ok small">Every stage can be reached and the quest can end.</div>}
            </div>
          )}
        </div>
        <div className="panel" style={{ width: 320, flex: 'none', borderLeft: '1px solid var(--border)', background: 'var(--panel)' }}>
          {selected?.kind === 'stage' ? (
            <StagePanel key={selected.stage} quest={quest} g={g} stage={selected.stage} onOpenStages={onOpenStages} />
          ) : selected?.kind === 'edge' ? (
            <EdgePanel quest={quest} edge={selected.edge} onOpenDialogue={onOpenDialogue} onRemoved={() => setSelected(null)} />
          ) : (
            <CastPanel g={g} />
          )}
        </div>
      </div>
      {pending && <ConnectionDialog quest={quest} from={pending.from} to={pending.to} onClose={() => setPending(null)} />}
    </div>
  );
}

function CastPanel({ g }: { g: QuestGraph }) {
  return (
    <>
      <div className="panel-header">Cast & places</div>
      <div className="scroll pad" style={{ flex: 1 }}>
        <p className="dim small" style={{ marginTop: 0 }}>
          The people, objects and places this quest uses (aliases). They’re added automatically when you connect stages; click a stage or an arrow to edit it.
        </p>
        {g.aliases.map((a) => {
          const target = (a.fill as Record<string, FormKey | undefined>).reference ?? (a.fill as Record<string, FormKey | undefined>).actor ?? (a.fill as Record<string, FormKey | undefined>).location;
          return (
            <div key={`${a.kind}${a.id}`} className="card" style={{ padding: 8, marginBottom: 6 }}>
              <div>
                {a.kind === 'loc' ? '📍' : '👤'} <strong>{a.name}</strong>
              </div>
              <div className="small">{target ? <FormLink value={target} /> : <span className="faint">{a.fillType}</span>}</div>
            </div>
          );
        })}
        {!g.aliases.length && <div className="faint small">Nobody yet.</div>}
      </div>
    </>
  );
}

function StagePanel({ quest, g, stage, onOpenStages }: { quest: FormKey; g: QuestGraph; stage: number; onOpenStages: () => void }) {
  const n = g.nodes.find((x) => x.stage === stage);
  const [newObj, setNewObj] = useState('');
  if (!n) return <div className="empty">Stage removed.</div>;
  const toggle = (list: number[], i: number, on: boolean) => (on ? [...new Set([...list, i])] : list.filter((x) => x !== i));
  const setFlag = (bit: number, on: boolean, where: 'stage' | 'log') =>
    patchRecord(quest, `Stage ${stage} flags`, (d) => {
      const st = d.stages.find((s: any) => s.index.index === stage);
      if (where === 'stage') st.index.flags = on ? st.index.flags | bit : st.index.flags & ~bit;
      else {
        st.logEntries ??= [];
        if (!st.logEntries[0]) st.logEntries.push({ flags: 0, text: '' });
        st.logEntries[0].flags = on ? st.logEntries[0].flags | bit : st.logEntries[0].flags & ~bit;
      }
    });
  return (
    <>
      <div className="panel-header">
        <span className="grow">Stage {stage}</span>
        <button
          className="btn icon ghost"
          title="Delete stage"
          onClick={() => {
            if (g.edges.some((e) => e.from === stage || e.to === stage)) {
              useStore.getState().toast('warning', 'Remove the arrows into and out of this stage first.');
              return;
            }
            void engine((c) => c.call('removeStage', quest, stage));
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
      <div className="scroll pad col" style={{ flex: 1, gap: 8 }}>
        <Field label="Journal" stack>
          <TextInput multiline value={n.text} placeholder="What the player's journal says at this point" onCommit={(t) => engine((c) => c.call('setStageLog', quest, stage, 0, t))} />
        </Field>
        <div className="col" style={{ gap: 3 }}>
          <Checkbox checked={n.startUp} onChange={(v) => setFlag(0x02, v, 'stage')} label="Quest starts here" />
          <Checkbox checked={n.completesQuest} onChange={(v) => setFlag(1, v, 'log')} label="Completes the quest" />
          <Checkbox checked={n.failsQuest} onChange={(v) => setFlag(2, v, 'log')} label="Fails the quest" />
          <Checkbox checked={n.shutDown} onChange={(v) => setFlag(0x04, v, 'stage')} label="Stops the quest" />
        </div>
        <div>
          <h3 style={{ margin: '6px 0' }}>Objectives at this stage</h3>
          {g.objectives.map((o) => (
            <div key={o.index} className="row" style={{ gap: 6, marginBottom: 2 }}>
              <span className="grow small ellipsis" title={o.text}>
                {o.index}. {o.text}
              </span>
              <Checkbox checked={n.shows.includes(o.index)} onChange={(v) => engine((c) => c.call('setStageObjectives', quest, stage, toggle(n.shows, o.index, v), n.completes))} label="show" />
              <Checkbox checked={n.completes.includes(o.index)} onChange={(v) => engine((c) => c.call('setStageObjectives', quest, stage, n.shows, toggle(n.completes, o.index, v)))} label="done" />
            </div>
          ))}
          <div className="row" style={{ gap: 4, marginTop: 4 }}>
            <div className="grow">
              <TextInput value={newObj} onCommit={setNewObj} placeholder="New objective…" />
            </div>
            <button
              className="btn small"
              disabled={!newObj}
              onClick={async () => {
                const idx = Math.max(0, ...g.objectives.map((o) => o.index)) + 10;
                await engine(async (c) => {
                  await c.call('addObjective', quest, idx, newObj);
                  await c.call('setStageObjectives', quest, stage, [...n.shows, idx], n.completes);
                });
                setNewObj('');
              }}
            >
              Add & show here
            </button>
          </div>
        </div>
        <StageGestures quest={quest} n={n} />
        <button className="btn small ghost" onClick={onOpenStages} title="The Stages tab has the full stage script editor">
          <Icon name="script" size={12} /> {n.hasScript ? 'Edit stage script (Stages tab)' : 'Add a stage script (Stages tab)'}
        </button>
      </div>
    </>
  );
}

function StageGestures({ quest, n }: { quest: FormKey; n: QuestStageNode }) {
  const [who, setWho] = useState<FormKey | null>(null);
  const [gesture, setGesture] = useState<string | null>(null);
  return (
    <div data-testid="stage-gestures">
      <h3 style={{ margin: '6px 0' }}>
        Animations at this stage
      </h3>
      {n.gestures.map((g) => (
        <div key={g.line} className="row small" style={{ gap: 4 }}>
          <span className="grow">
            {g.actor}: {g.label}
          </span>
          <button className="btn icon ghost" title="Remove this animation" onClick={() => engine((c) => c.call('removeStageLine', quest, n.stage, g.line))}>
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
      <div className="col" style={{ gap: 4, marginTop: 4 }}>
        <FormPicker value={who} sigs={['NPC_', 'ACHR']} onChange={setWho} placeholder="Who…" />
        <div className="row" style={{ gap: 4 }}>
          <div className="grow">
            <GesturePicker value={gesture} onChange={setGesture} none="Which animation…" testId="stage-gesture" />
          </div>
          <button
            className="btn small"
            disabled={!who || !gesture}
            title="When the quest reaches this stage, they play it (they must be loaded nearby to be seen)"
            onClick={async () => {
              const ok = await engine(async (c) => (await c.call('addStageGesture', quest, n.stage, who!, gesture!), true));
              if (ok) setGesture(null);
            }}
            data-testid="add-stage-gesture"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function EdgePanel({ quest, edge, onOpenDialogue, onRemoved }: { quest: FormKey; edge: QuestEdge; onOpenDialogue: (t: FormKey) => void; onRemoved: () => void }) {
  const k = EDGE_KINDS[edge.kind];
  return (
    <>
      <div className="panel-header">
        <span className="grow">
          {k.icon} {k.title}
        </span>
      </div>
      <div className="scroll pad col" style={{ flex: 1, gap: 8 }}>
        <div>{edge.label}</div>
        <div className="dim small">
          {edge.from === null ? 'At any stage' : `When the quest is at stage ${edge.from}`} → sets stage {edge.to}
        </div>
        {edge.target && (
          <Field label="Involves">
            <FormLink value={edge.target} />
          </Field>
        )}
        <div className="dim small">
          {edge.source.type === 'info' && 'Made of a dialogue topic and response with an end script.'}
          {edge.source.type === 'alias-trigger' && 'Made of a quest alias with a generated trigger script.'}
          {edge.source.type === 'ref-trigger' && 'A trigger on a placed object (edit it in its properties).'}
          {edge.source.type === 'fragment' && 'A SetStage line in the earlier stage’s script.'}
        </div>
        {edge.source.type === 'info' && (
          <button className="btn small" onClick={() => onOpenDialogue((edge.source as { topic: FormKey }).topic)}>
            <Icon name="chat" size={12} /> Open conversation
          </button>
        )}
        <button
          className="btn small"
          data-testid="remove-connection"
          onClick={async () => {
            const ok = await engine((c) => c.call('removeQuestEdge', quest, edge), { success: 'Connection removed' });
            if (ok) onRemoved();
          }}
        >
          <Icon name="trash" size={12} /> Remove connection
        </button>
      </div>
    </>
  );
}

function ConnectionDialog({ quest, from, to, onClose }: { quest: FormKey; from: number | null; to: number; onClose: () => void }) {
  const [kind, setKind] = useState<QuestEdgeKind | null>(null);
  const [target, setTarget] = useState<FormKey | null>(null);
  const [npc, setNpc] = useState<FormKey | null>(null);
  const [playerText, setPlayerText] = useState('');
  const [npcText, setNpcText] = useState('');
  const [goodbye, setGoodbye] = useState(false);
  const k = kind ? EDGE_KINDS[kind] : undefined;
  const ready = kind === 'script' ? from !== null : kind === 'talk' ? !!npc && !!playerText.trim() && !!npcText.trim() : !!kind && !!target;
  const create = async () => {
    if (!kind) return;
    const edge: NewQuestEdge =
      kind === 'talk'
        ? { from, to, kind, npc: npc!, playerText: playerText.trim(), npcText: npcText.split('\n').map((l) => l.trim()).filter(Boolean), goodbye }
        : kind === 'script'
          ? { from, to, kind }
          : { from, to, kind: kind as Exclude<QuestEdgeKind, 'talk' | 'script'>, target: target! };
    const ok = await engine((c) => c.call('addQuestEdge', quest, edge), { busy: 'Creating…', success: `Connected ${from === null ? 'any time' : `stage ${from}`} → stage ${to}` });
    if (ok) onClose();
  };
  return (
    <Modal
      title={`What moves the quest ${from === null ? '' : `from stage ${from} `}to stage ${to}?`}
      onClose={onClose}
      width={620}
      footer={
        <>
          {kind && (
            <button className="btn ghost" onClick={() => setKind(null)}>
              Back
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready} onClick={create} data-testid="create-connection">
            Connect
          </button>
        </>
      }
    >
      {!kind ? (
        <div className="kind-grid" data-testid="connection-kinds">
          {PICKABLE.filter((x) => x !== 'script' || from !== null).map((x) => (
            <button key={x} className="kind-card" onClick={() => setKind(x)} style={{ borderColor: EDGE_KINDS[x].color }}>
              <div style={{ fontSize: 20 }}>{EDGE_KINDS[x].icon}</div>
              <div>{EDGE_KINDS[x].title}</div>
              <div className="dim small">{EDGE_KINDS[x].help}</div>
            </button>
          ))}
        </div>
      ) : kind === 'talk' ? (
        <div className="col" style={{ gap: 8 }}>
          <Field label="Who">
            <FormPicker value={npc} sigs={['NPC_']} onChange={setNpc} placeholder="The character the player talks to" allowNone={false} />
          </Field>
          <Field label="Player says">
            <TextInput value={playerText} onCommit={setPlayerText} placeholder="The line in the dialogue menu" autoFocus />
          </Field>
          <Field label="They answer" stack>
            <TextInput multiline value={npcText} onCommit={setNpcText} placeholder="One line per row" />
          </Field>
          <Checkbox checked={goodbye} onChange={setGoodbye} label="Ends the conversation" />
          <p className="dim small" style={{ margin: 0 }}>
            Creates the topic, the response (only {from === null ? 'while the quest runs' : `at stage ${from}`}, only from this character) and the script that sets stage {to}. You can grow it into a full conversation in the Dialogue view.
          </p>
        </div>
      ) : kind === 'script' ? (
        <p className="dim">Stage {to} will be set as soon as stage {from} is. (A line is added to stage {from}’s script.)</p>
      ) : (
        <div className="col" style={{ gap: 8 }}>
          <div>
            {k!.icon} <strong>{k!.title}</strong> — <span className="dim">{k!.help}</span>
          </div>
          <Field label={k!.needs ?? 'Target'}>
            <FormPicker value={target} sigs={k!.sigs} onChange={setTarget} allowNone={false} placeholder="Search…" />
          </Field>
          <p className="dim small" style={{ margin: 0 }}>
            {kind === 'arrive' ? 'A hidden marker is placed in the cell, given a quest alias, and a script on it sets the stage when the cell loads around the player.' : 'The quest gets an alias for it (or reuses one), with a generated script that sets the stage — only once, and only at the right stage.'}
          </p>
        </div>
      )}
    </Modal>
  );
}
