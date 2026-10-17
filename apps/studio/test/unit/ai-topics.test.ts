import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createDemoData, newAgentSession, projectTools, toolSchema, type AgentTool } from '@tes5/workspace';
import { DEMO_GAME_DIR } from '../../src/engine/constants';
import { EngineHost } from '../../src/engine/host';
import { aiTools } from '../../src/engine/aitools';
import { TOOL_TOPICS, offerTools } from '../../src/engine/aitools-topics';

function all() {
  const fs = new MemoryFileSystem();
  createDemoData(fs, DEMO_GAME_DIR);
  const host = new EngineHost(fs);
  const session = newAgentSession();
  return { session, tools: [...aiTools(host, { ai: { kind: 'claude', apiKey: '' }, plans: new Map(), touched: new Set() }), ...projectTools(session)] as AgentTool[] };
}
const names = (ts: AgentTool[]) => ts.map((t) => t.name);
const size = (ts: AgentTool[]) => JSON.stringify(ts.map((t) => ({ d: t.description, p: toolSchema(t) }))).length;

describe('the tools a free AI is shown', () => {
  it('covers every tool with a topic', () => {
    const { tools } = all();
    const inTopics = new Set(['search_records', 'read_record', 'list_places', 'place_contents', 'quest_overview', ...Object.values(TOOL_TOPICS).flatMap((t) => t.tools)]);
    expect(names(tools).filter((n) => !inTopics.has(n))).toEqual([]);
    for (const t of Object.values(TOOL_TOPICS)) for (const n of t.tools) expect(names(tools)).toContain(n);
  });

  it('picks the topics a message is about, and offers the rest', () => {
    const { tools, session } = all();
    const o = offerTools(tools, session, 'When the player opens the chest in the Bannered Mare, show a message.');
    expect(names(o.tools)).toEqual(expect.arrayContaining(['search_records', 'place_contents', 'add_trigger', 'list_triggers']));
    expect(names(o.tools)).not.toContain('create_character');
    expect(Object.keys(o.topics)).toContain('characters');
    expect(Object.keys(o.topics)).not.toContain('triggers');
    // A fraction of everything.
    expect(size(o.tools)).toBeLessThan(size(tools) / 2);
    expect(names(offerTools(tools, session, 'Raise a hill west of Whiterun').tools)).toContain('shape_ground');
    expect(names(offerTools(tools, session, 'Make a new war axe with 12 damage').tools)).toContain('copy_record');
    expect(names(offerTools(tools, session, 'Make Hulda\'s lines grumpier').tools)).toContain('edit_dialogue_line');
    expect(names(offerTools(tools, session, 'Make a character: Ingrid, a Redguard blacksmith').tools)).toContain('create_character');
  });

  it('uses what is open, and keeps the conversation’s topics for follow-ups', () => {
    const { tools, session } = all();
    expect(names(offerTools(tools, session, 'What is this?', 'Quests tab: quest LostRing').tools)).toContain('set_stage');
    // Nothing to go on: look around and check things.
    expect(names(offerTools(tools, session, 'Hello').tools)).toEqual(expect.arrayContaining(['search_records', 'release_check', 'who_uses']));
    session.messages.push({ role: 'user', text: 'Put a bottle on the table' }, { role: 'assistant', text: '', calls: [{ id: 'a', name: 'place_object', input: {} }] });
    expect(names(offerTools(tools, session, 'Yes, two more').tools)).toContain('place_object');
  });
});
