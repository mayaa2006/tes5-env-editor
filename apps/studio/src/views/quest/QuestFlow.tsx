/** Stage flow graph: which stage scripts and dialogue lines advance the quest to which stage. */
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import type { QuestModel } from '@tes5/workspace';
import { useQuery } from '../../components/ui';
import { useStore } from '../../state/store';

export default function QuestFlow({ q, onOpenStage }: { q: QuestModel; onOpenStage: (stage: number) => void }) {
  const client = useStore((s) => s.client);
  const { data: edges } = useQuery(() => client?.call('questFlow', q.formKey), [q.formKey]);
  const graph = useMemo(() => {
    const nodes: Node[] = [];
    const out: Edge[] = [];
    const stages = [...q.stages].sort((a, b) => a.index - b.index);
    stages.forEach((s, i) => {
      const log = s.logEntries[0];
      nodes.push({
        id: `stage:${s.index}`,
        position: { x: i * 230, y: 0 },
        data: {
          label: (
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 700, color: 'var(--accent)' }}>Stage {s.index}</div>
              <div style={{ fontSize: 11, opacity: 0.8 }}>{(log?.text ?? '').slice(0, 80) || (s.flags & 2 ? 'start-up' : s.flags & 4 ? 'shut-down' : '')}</div>
              {log?.fragment && <div style={{ fontSize: 10, opacity: 0.6 }}>has script</div>}
            </div>
          ),
        },
        style: { width: 190, background: 'var(--panel-2)', color: 'var(--text)', border: `1px solid ${log && log.flags & 1 ? 'var(--ok)' : 'var(--border-strong)'}`, borderRadius: 8 },
      });
    });
    const infoNodes = new Map<string, number>();
    for (const e of edges ?? []) {
      if (e.from.startsWith('info:') && !nodes.some((n) => n.id === e.from)) {
        const key = e.from.slice(5);
        const info = q.topics.flatMap((t) => t.infos).find((i) => i.formKey === key);
        const targetIdx = stages.findIndex((s) => s.index === e.to);
        const slot = infoNodes.get(String(targetIdx)) ?? 0;
        infoNodes.set(String(targetIdx), slot + 1);
        nodes.push({
          id: e.from,
          position: { x: Math.max(0, targetIdx - 1) * 230 + 110, y: 150 + slot * 80 },
          data: { label: <div style={{ fontSize: 11, textAlign: 'left' }}>💬 {(info?.responses[0]?.text ?? key).slice(0, 60)}</div> },
          style: { width: 200, background: 'rgba(79,156,247,0.12)', color: 'var(--text)', border: '1px solid rgba(79,156,247,0.4)', borderRadius: 8 },
        });
      }
      out.push({
        id: `${e.from}->${e.to}:${out.length}`,
        source: e.from,
        target: `stage:${e.to}`,
        label: e.via === 'dialogue' ? undefined : 'SetStage',
        animated: e.via === 'dialogue',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: e.via === 'dialogue' ? '#4f9cf7' : '#aaa' },
      });
    }
    return { nodes, edges: out.filter((e) => nodes.some((n) => n.id === e.target)) };
  }, [q, edges]);

  return (
    <div style={{ height: 'calc(100vh - 220px)', minHeight: 320 }} className="card" data-testid="quest-flow">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        fitView
        colorMode="dark"
        nodesConnectable={false}
        onNodeDoubleClick={(_, n) => {
          if (n.id.startsWith('stage:')) onOpenStage(Number(n.id.slice(6)));
          else if (n.id.startsWith('info:')) useStore.getState().select(n.id.slice(5));
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!graph.edges.length && (
        <div className="dim small" style={{ position: 'relative', marginTop: -40, padding: 10 }}>
          No SetStage calls found yet. Arrows appear as stage scripts and dialogue scripts call SetStage().
        </div>
      )}
    </div>
  );
}
