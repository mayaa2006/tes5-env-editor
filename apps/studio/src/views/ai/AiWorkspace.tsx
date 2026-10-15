/**
 * The AI workspace: talk to an AI that reads (and, with change tools, edits)
 * your plugin through the editor itself. Conversations are listed on the
 * left; each tool the AI uses shows as a card saying what it did, with a link
 * to open the result in its own tab.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent, AgentLink, AgentMessage, AgentSession, AgentToolResult, AgentTurn } from '@tes5/workspace';
import type { FormKey } from '@tes5/esp';
import type { AiSessionInfo } from '../../engine/host';
import { Checkbox, EmptyState, Icon, Modal, useDraft, useSummaries } from '../../components/ui';
import { AiPicker, useAi } from '../../components/AiPicker';
import { engine, useStore, type WorkspaceTab } from '../../state/store';

/** Things to ask, for an empty conversation. */
const STARTERS: { label: string; text: string; title: string }[] = [
  { label: 'Make a quest from my idea', text: 'Make a quest: ', title: 'Describe the quest after the colon; the AI plans it, tells you the plan, and builds it when you agree' },
  { label: 'Add to the open quest', text: 'In the quest I have open, add ', title: 'Open a quest in the Quests tab first, then say what to add (a stage, an objective, dialogue…)' },
  { label: 'Make a character', text: 'Make a character: ', title: 'Describe who they are, where they stand, what they wear, carry and do; the AI copies a fitting character and places them' },
  { label: 'Make an item or spell', text: 'Make a new ', title: 'Say what it is and what it does; the AI copies a similar one and changes it' },
  { label: "What's in my plugin?", text: 'What does my plugin contain so far? Group it by kind and point out anything unfinished.', title: 'The AI lists your records and points out loose ends' },
  { label: 'Explain a quest', text: 'Explain how the quest I have open works: how it starts, what moves it from stage to stage, and how it ends.', title: 'Open a quest in the Quests tab first, or name it' },
  { label: 'Find problems before release', text: 'Run the release check and the conflict report, and tell me what to fix first and how.', title: 'The AI runs the release check and conflict report and sorts what to fix' },
  { label: 'Where is something used?', text: 'Where is Lydia used? List the quests, packages and lists that refer to her.', title: 'Change the name to anything in your load order' },
];

type Live = { text: string; calls: { id: string; summary: string; writes: boolean; status: 'running' | 'waiting' | AgentToolResult['status']; result?: AgentToolResult }[] };

export default function AiWorkspace() {
  const [list, setList] = useState<AiSessionInfo[]>([]);
  const [current, setCurrent] = useState<string>();
  const [session, setSession] = useState<AgentSession | null>(null);
  const [live, setLive] = useState<Live>();
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState<AiSessionInfo>();
  const client = useStore((s) => s.client);

  const reloadList = async () => {
    const l = (await engine((c) => c.call('aiSessionList'), { refreshSession: false })) ?? [];
    setList(l);
    return l;
  };
  const open = async (id: string) => {
    setCurrent(id);
    setSession((await engine((c) => c.call('aiSession', id), { refreshSession: false })) ?? null);
  };
  useEffect(() => {
    void reloadList().then((l) => (l[0] ? open(l[0].id) : undefined));
  }, []);

  // Progress of the running turn, streamed by the engine.
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    if (!client) return;
    return client.onEvent((e) => {
      if (e.type !== 'ai') return;
      const ev: AgentEvent = e.event;
      if (ev.session !== currentRef.current) return;
      setLive((l) => reduceLive(l ?? { text: '', calls: [] }, ev));
    });
  }, [client]);

  const newSession = async () => {
    const s = await engine((c) => c.call('aiNewSession'), { refreshSession: false });
    if (!s) return;
    setList((l) => [{ id: s.id, title: s.title, updated: s.updated, running: false }, ...l]);
    setCurrent(s.id);
    setSession(s);
    setLive(undefined);
  };

  const send = async (text: string, ctx: string | undefined, ai: unknown, ask: boolean) => {
    let id = current;
    if (!id) {
      const s = await engine((c) => c.call('aiNewSession'), { refreshSession: false });
      if (!s) return false;
      id = s.id;
      setCurrent(id);
      setSession(s);
    }
    // Show the message straight away; the engine's copy replaces it when the turn ends.
    setSession((s) => (s ? { ...s, messages: [...s.messages, { role: 'user', text }] } : s));
    setLive({ text: '', calls: [] });
    setRunning(true);
    const sid = id;
    const r = await engine((c) => c.call('aiSend', sid, text, ai as never, { context: ctx, ask }), { refreshSession: true });
    setRunning(false);
    setLive(undefined);
    if (currentRef.current === sid) setSession((await engine((c) => c.call('aiSession', sid), { refreshSession: false })) ?? null);
    void reloadList();
    if (r?.error && r.error !== 'Stopped.') useStore.getState().toast('error', r.error);
    return !!r;
  };

  return (
    <div className="ai-workspace" data-testid="ai-workspace">
      <aside className="ai-sessions">
        <div className="ai-sessions-head">
          <button className="btn small primary" onClick={() => void newSession()} disabled={running} title="Start a new conversation with the AI. Earlier ones stay in this list." data-testid="ai-new">
            <Icon name="plus" size={13} /> New conversation
          </button>
        </div>
        <div className="scroll grow">
          {list.length === 0 && <div className="empty small">No conversations yet. Write to the AI on the right to start one.</div>}
          {list.map((s) => (
            <div key={s.id} className={`ai-session ${s.id === current ? 'active' : ''}`} onClick={() => !running && void open(s.id)} title={running ? 'Wait for the AI to finish, or press Stop' : `Open “${s.title}”`} data-testid="ai-session">
              <div className="grow ellipsis">{s.title}</div>
              <span className="dim small nowrap">{ago(s.updated)}</span>
              <button
                className="btn icon ghost small"
                title="Delete this conversation (your plugin's changes stay; only the conversation goes)"
                disabled={running}
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleting(s);
                }}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
        </div>
      </aside>
      <Conversation
        session={session}
        live={live}
        running={running}
        onSend={send}
        onStop={() => current && void engine((c) => c.call('aiStop', current), { refreshSession: false })}
        onApprove={(callId, ok) => current && void engine((c) => c.call('aiApprove', current, callId, ok), { refreshSession: false })}
        onUndoTurn={async (n) => {
          if (!current) return;
          const s = await engine((c) => c.call('aiUndoTurn', current, n), { success: 'The changes of that turn were undone' });
          if (s) setSession(s);
        }}
      />
      {deleting && (
        <Modal
          title="Delete this conversation?"
          onClose={() => setDeleting(undefined)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(undefined)}>
                Keep it
              </button>
              <button
                className="btn danger"
                data-testid="ai-delete-confirm"
                onClick={async () => {
                  const id = deleting.id;
                  setDeleting(undefined);
                  const l = (await engine((c) => c.call('aiDeleteSession', id), { refreshSession: false })) ?? [];
                  setList(l);
                  if (id === current) {
                    setCurrent(undefined);
                    setSession(null);
                    if (l[0]) void open(l[0].id);
                  }
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            “{deleting.title}” will be removed from the list. Anything the AI changed in your plugin stays (use Undo for that).
          </p>
        </Modal>
      )}
    </div>
  );
}

function reduceLive(l: Live, ev: AgentEvent): Live {
  switch (ev.type) {
    case 'text':
      return { ...l, text: l.text + ev.delta };
    case 'call': {
      const calls = l.calls.filter((c) => c.id !== ev.id);
      // Text before a tool call belongs with it; start a fresh paragraph after.
      return { text: l.text ? `${l.text}\n\n` : l.text, calls: [...calls, { id: ev.id, summary: ev.summary, writes: ev.writes, status: ev.status }] };
    }
    case 'result': {
      const has = l.calls.some((c) => c.id === ev.result.id);
      const calls = has ? l.calls.map((c) => (c.id === ev.result.id ? { ...c, status: ev.result.status, result: ev.result } : c)) : [...l.calls, { id: ev.result.id, summary: ev.result.summary, writes: ev.result.writes, status: ev.result.status, result: ev.result }];
      return { ...l, calls };
    }
    default:
      return l;
  }
}

function Conversation({
  session,
  live,
  running,
  onSend,
  onStop,
  onApprove,
  onUndoTurn,
}: {
  session: AgentSession | null;
  live?: Live;
  running: boolean;
  onSend: (text: string, ctx: string | undefined, ai: unknown, ask: boolean) => Promise<boolean>;
  onStop: () => void;
  onApprove: (callId: string, ok: boolean) => void;
  onUndoTurn: (turn: number) => void;
}) {
  const { ai, ready, name } = useAi();
  const askFirst = useStore((s) => s.settings.aiAskFirst);
  const update = useStore((s) => s.updateSettings);
  const plugin = useStore((s) => s.session.activePlugin);
  const [text, setText] = useDraft('ai:message', '');
  const [withContext, setWithContext] = useState(true);
  const context = useEditorContext();
  const end = useRef<HTMLDivElement>(null);
  const messages = session?.messages ?? [];
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [messages.length, live?.text, live?.calls.length]);

  const turnEnds = useTurnEnds(session);
  // Tool results by call id, to show each call with its outcome.
  const results = useMemo(() => {
    const m = new Map<string, AgentToolResult>();
    for (const msg of messages) if (msg.role === 'tool') for (const r of msg.results) m.set(r.id, r);
    return m;
  }, [messages]);

  const submit = async (t = text) => {
    if (!t.trim() || running || !ready) return;
    const ok = await onSend(t.trim(), withContext && context.text ? context.text : undefined, ai, askFirst);
    if (ok) setText('');
  };

  return (
    <section className="ai-chat">
      <div className="ai-chat-head">
        <AiPicker verb="Talking to" help="Your messages, what you have open (if ticked) and what the AI reads with its tools are sent to this AI. It reads your load order through the editor; nothing is saved to disk until you save." />
      </div>
      <div className="scroll grow ai-messages" data-testid="ai-messages">
        {!messages.length && !live && (
          <EmptyState icon="ai" title="Ask the AI about your mod" testId="ai-empty">
            It can look through your load order and your plugin, explain how things are set up, find problems before release, and make quests and dialogue for you. Each change it makes shows here and can be undone. Pick a starting point or write your own below.
            <div className="row wrap" style={{ gap: 6, marginTop: 10, justifyContent: 'center' }}>
              {STARTERS.map((s) => (
                <button key={s.label} className="btn small" title={s.title} onClick={() => setText(s.text)} data-testid="ai-starter">
                  {s.label}
                </button>
              ))}
            </div>
          </EmptyState>
        )}
        {messages.map((m, i) => (
          <Fragment key={i}>
            <MessageView m={m} results={results} />
            {turnEnds.has(i) && <TurnSummary turn={turnEnds.get(i)!.turn} last={turnEnds.get(i)!.index === (session?.turns.length ?? 0) - 1} onUndo={() => onUndoTurn(turnEnds.get(i)!.index)} running={running} />}
          </Fragment>
        ))}
        {live && (
          <div className="ai-msg assistant" data-testid="ai-live">
            {live.text && <Markdown text={live.text} />}
            {live.calls.map((c) => (
              <ToolCard key={c.id} summary={c.summary} writes={c.writes} status={c.status} result={c.result} onApprove={c.status === 'waiting' ? (ok) => onApprove(c.id, ok) : undefined} />
            ))}
            {!live.calls.some((c) => c.status === 'waiting') && <div className="dim small ai-thinking">{name} is working…</div>}
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="ai-compose">
        {!plugin && (
          <div className="row small ai-hint" data-testid="ai-no-plugin">
            <Icon name="warn" size={12} />
            <span className="grow">Changes go into a plugin, and none is chosen yet. The AI can still look around and answer questions.</span>
            <button className="btn small" onClick={() => useStore.getState().setPluginPrompt({})} title="Choose the plugin the AI's changes (and yours) go into, or make a new one">
              Choose or create a plugin
            </button>
          </div>
        )}
        <div className="row small wrap" style={{ gap: 12 }}>
          {context.text && (
            <Checkbox checked={withContext} onChange={setWithContext} label={<span className="ellipsis">Include what I have open: {context.label}</span>} help="Tells the AI which tab you're on and what's selected there (names and FormKeys only), so you can say “this quest” or “her”." />
          )}
          <Checkbox
            checked={askFirst}
            onChange={(v) => update({ aiAskFirst: v })}
            label="Ask before each change"
            help="On: the AI stops before each change to your plugin and waits for Allow or Skip. Off: it makes the changes and you check them afterwards. Either way, a turn's changes can be undone together."
          />
        </div>
        <div className="row" style={{ gap: 6, alignItems: 'stretch' }}>
          <textarea
            className="ai-input"
            value={text}
            placeholder={ready ? `Ask ${name} about your mod… (Enter to send, Shift+Enter for a new line)` : 'Choose an AI above first'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={3}
            disabled={!ready}
            data-testid="ai-input"
          />
          {running ? (
            <button className="btn danger" onClick={onStop} title="Stop the AI. What it has already done stays (and can be undone)." data-testid="ai-stop">
              <Icon name="stop" size={13} /> Stop
            </button>
          ) : (
            <button className="btn primary" onClick={() => void submit()} disabled={!ready || !text.trim()} title={!ready ? 'Choose an AI and fill in its settings first' : !text.trim() ? 'Write a message first' : `Send to ${name}`} data-testid="ai-send">
              <Icon name="send" size={13} /> Send
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Where each turn ends in the message list, to show what it changed there. */
function useTurnEnds(session: AgentSession | null) {
  return useMemo(() => {
    const m = new Map<number, { turn: AgentTurn; index: number }>();
    const turns = session?.turns ?? [];
    turns.forEach((t, n) => {
      const end = (turns[n + 1]?.at ?? session!.messages.length) - 1;
      if (t.changes.length || t.error) m.set(end, { turn: t, index: n });
    });
    return m;
  }, [session]);
}

function TurnSummary({ turn, last, onUndo, running }: { turn: AgentTurn; last: boolean; onUndo: () => void; running: boolean }) {
  if (!turn.changes.length)
    return turn.error && turn.error !== 'Stopped.' ? (
      <div className="ai-turn error small" data-testid="ai-turn-error">
        <Icon name="warn" size={12} /> {turn.error}
      </div>
    ) : null;
  return (
    <div className={`ai-turn ${turn.undone ? 'undone' : ''}`} data-testid="ai-turn">
      <div className="row" style={{ gap: 6 }}>
        <Icon name="wand" size={12} />
        <strong className="grow">{turn.undone ? 'Undone: ' : ''}Changes in this turn ({turn.changes.length})</strong>
        {!turn.undone && turn.undoLabel && (
          <button
            className="btn small"
            onClick={onUndo}
            disabled={running || !last}
            title={last ? 'Take back every change from this turn in one step (same as Undo, Ctrl+Z, right after it)' : 'Only the latest turn can be undone from here; use Undo (Ctrl+Z) to step back further'}
            data-testid="ai-undo-turn"
          >
            <Icon name="undo" size={12} /> Undo these changes
          </button>
        )}
      </div>
      <ul>
        {turn.changes.map((c, n) => (
          <li key={n}>{c}</li>
        ))}
      </ul>
      {turn.error && turn.error !== 'Stopped.' && <div className="small dim">Stopped early: {turn.error}</div>}
    </div>
  );
}

function MessageView({ m, results }: { m: AgentMessage; results: Map<string, AgentToolResult> }) {
  if (m.role === 'tool') return null;
  if (m.role === 'user') {
    // Messages the editor adds (its checks) read differently from the author's own.
    const fromEditor = m.text.startsWith("The editor's checks found");
    return (
      <div className={`ai-msg ${fromEditor ? 'system' : 'user'}`} data-testid={fromEditor ? 'ai-msg-checks' : 'ai-msg-user'}>
        {fromEditor ? (
          <>
            <div className="small" style={{ fontWeight: 600 }}>
              The editor checked the changes and sent these problems back to the AI:
            </div>
            <Markdown text={m.text.split('\n').filter((l) => l.startsWith('- ')).join('\n')} />
          </>
        ) : (
          <div className="ai-user-text">{m.text}</div>
        )}
      </div>
    );
  }
  if (!m.text && !m.calls.length) return null;
  return (
    <div className="ai-msg assistant" data-testid="ai-msg-assistant">
      {m.text && <Markdown text={m.text} />}
      {m.calls.map((c) => {
        const r = results.get(c.id);
        return <ToolCard key={c.id} summary={r?.summary ?? c.name} writes={!!r?.writes} status={r?.status ?? 'stopped'} result={r} />;
      })}
    </div>
  );
}

const STATUS: Record<string, { label: string; cls: string; title: string }> = {
  running: { label: 'Working…', cls: 'accent', title: 'The AI is using this tool now' },
  waiting: { label: 'Waiting for you', cls: 'warn', title: 'The AI asks before making this change' },
  done: { label: 'Done', cls: 'ok', title: 'Finished' },
  error: { label: 'Failed', cls: 'err', title: 'This tool call failed; the AI was told why' },
  declined: { label: 'Skipped', cls: '', title: 'You chose not to make this change' },
  stopped: { label: 'Stopped', cls: '', title: 'Not run: the turn was stopped' },
};

function ToolCard({ summary, writes, status, result, onApprove }: { summary: string; writes: boolean; status: string; result?: AgentToolResult; onApprove?: (ok: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[status] ?? STATUS.done!;
  const go = useOpenLink();
  return (
    <div className={`ai-tool ${writes ? 'writes' : ''}`} data-testid="ai-tool">
      <div className="row" style={{ gap: 6 }}>
        <Icon name={writes ? 'wand' : 'search'} size={12} />
        <span className="grow ellipsis" title={summary}>
          {summary}
        </span>
        {result?.link && (
          <button className="btn small ghost" onClick={() => go(result.link!)} title={`Open ${result.link.label}`} data-testid="ai-tool-open">
            Open
          </button>
        )}
        {result && (
          <button className="btn small ghost" onClick={() => setOpen(!open)} title={open ? 'Hide what the tool returned' : 'Show what the tool returned to the AI'}>
            {open ? 'Hide' : 'Details'}
          </button>
        )}
        {onApprove ? (
          <>
            <button className="btn small primary" onClick={() => onApprove(true)} title="Let the AI make this change (it can be undone)" data-testid="ai-allow">
              Allow
            </button>
            <button className="btn small" onClick={() => onApprove(false)} title="Don't make this change; the AI is told and carries on without it" data-testid="ai-skip">
              Skip
            </button>
          </>
        ) : (
          <span className={`chip ${st.cls}`} title={st.title}>
            {st.label}
          </span>
        )}
      </div>
      {result?.note && status !== 'done' && <div className="small dim">{result.note}</div>}
      {open && result && <pre className="ai-tool-details mono small">{readable(result.content)}</pre>}
    </div>
  );
}

/** A tool's result for reading: JSON indented, long results cut. */
function readable(content: string): string {
  let t = content;
  try {
    t = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    // Not JSON (a message, or cut short): shown as it is.
  }
  return t.length > 6000 ? `${t.slice(0, 6000)}\n…` : t;
}

/** Open a tool result's link in its own tab. */
function useOpenLink() {
  return (l: AgentLink) => {
    const s = useStore.getState();
    const key = l.key as FormKey | undefined;
    if (l.tab === 'quest' && key) s.setQuest(key);
    else if (l.tab === 'npc' && key) s.setNpc(key);
    else if (l.tab === 'scene' && key) s.setCell(key);
    else if (l.tab === 'script' && l.key) s.setScript(l.key);
    else if (key) s.select(key);
    s.setTab(l.tab as WorkspaceTab);
  };
}

/** What the author has open, for "this quest" and "her": the tab and what's selected, by name and FormKey. */
function useEditorContext(): { text: string; label: string } {
  const tab = useStore((s) => s.tab);
  const quest = useStore((s) => s.quest);
  const npc = useStore((s) => s.npc);
  const cell = useStore((s) => s.cell);
  const selected = useStore((s) => s.selected);
  const script = useStore((s) => s.script);
  const plugin = useStore((s) => s.session.activePlugin);
  const sums = useSummaries([quest, npc, cell, selected]);
  const name = (k?: FormKey) => (k ? `${sums[k]?.name || sums[k]?.editorId || k} (${k})` : undefined);
  const parts: string[] = [];
  const short: string[] = [];
  if (plugin) parts.push(`Editing ${plugin}`);
  if (quest) (parts.push(`Quest open in the Quests tab: ${name(quest)}`), short.push(`quest ${sums[quest]?.editorId ?? quest}`));
  if (npc) (parts.push(`Character open in the Characters tab: ${name(npc)}`), short.push(`character ${sums[npc]?.editorId ?? npc}`));
  if (cell) (parts.push(`Cell open in the World tab: ${name(cell)}`), short.push(`cell ${sums[cell]?.editorId ?? cell}`));
  if (selected && selected !== quest && selected !== npc && selected !== cell) (parts.push(`Selected record: ${name(selected)}`), short.push(sums[selected]?.editorId ?? selected));
  if (script) (parts.push(`Script open: ${script}`), short.push(`script ${script}`));
  void tab;
  return { text: parts.join('\n'), label: short.join(', ') || (plugin ? plugin : 'nothing yet') };
}

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return new Date(t).toLocaleDateString();
}

/** A small, safe Markdown subset: paragraphs, lists, headings, **bold**, *italic* and `code` (no HTML). */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (/^```/.test(l)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={blocks.length} className="mono small ai-code">{code.join('\n')}</pre>);
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={blocks.length}>
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)/.exec(l);
    if (h) {
      blocks.push(<div key={blocks.length} className="ai-heading">{inline(h[2]!)}</div>);
      i++;
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(\s*([-*•]|\d+[.)])\s+|#{1,4}\s|```)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={blocks.length}>{para.map((p, n) => <Fragment key={n}>{n > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return <div className="ai-md">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={out.length}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={out.length}>{t.slice(1, -1)}</code>);
    else out.push(<em key={out.length}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

