/**
 * Scenes: characters talking to each other (or to the air) without the
 * player, one turn after another. Written as a SCEN record in the layout
 * xEdit documents for Skyrim: one phase per turn, the actors as quest
 * aliases, and a dialogue action per turn pointing at a scene topic.
 */
import { makeFormKey, parseFormKey, type FormKey } from '@tes5/esp';
import type { Workspace } from './engine';

export interface SceneSpec {
  editorId: string;
  /** Start as soon as the quest starts ("Begin on Quest Start"). */
  beginOnQuestStart: boolean;
  repeatable: boolean;
  /** Each turn: the speaker's quest alias and the scene topic holding their line. */
  turns: { alias: number; topic: FormKey }[];
}

const SCENE_BEGIN_ON_QUEST_START = 0x1;
const SCENE_INTERRUPTIBLE = 0x10;
/** Default actor behaviour: end on death, pause in combat and during dialogue with the player. */
const ACTOR_BEHAVIOUR = 26;

const enc = new TextEncoder();
const u16 = (n: number) => new Uint8Array(new Uint16Array([n]).buffer);
const u32 = (n: number) => new Uint8Array(new Uint32Array([n >>> 0]).buffer);
const s32 = (n: number) => new Uint8Array(new Int32Array([n]).buffer);
const zstr = (t: string) => {
  const b = enc.encode(t);
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  return out;
};
const empty = () => new Uint8Array(0);

/** Create the scene record; returns its FormKey. */
export function writeScene(ws: Workspace, quest: FormKey, spec: SceneSpec): FormKey {
  return ws.transaction(`Create scene ${spec.editorId}`, () => {
    const key = ws.createRecord('SCEN', { editorId: spec.editorId, flags: 0 });
    const form = (k: FormKey) => u32(ws.localIdForActive(k));
    const subs: { sig: string; data: Uint8Array }[] = [];
    const add = (sig: string, data: Uint8Array) => subs.push({ sig, data });
    add('EDID', zstr(spec.editorId));
    add('FNAM', u32((spec.beginOnQuestStart ? SCENE_BEGIN_ON_QUEST_START : 0) | SCENE_INTERRUPTIBLE));
    // Phases: one per turn.
    spec.turns.forEach(() => {
      add('HNAM', empty());
      add('NAM0', zstr(''));
      add('NEXT', empty());
      add('NEXT', empty());
      add('WNAM', u32(200));
      add('HNAM', empty());
    });
    // Actors: every alias that speaks.
    for (const alias of [...new Set(spec.turns.map((t) => t.alias))]) {
      add('ALID', u32(alias));
      add('LNAM', u32(0));
      add('DNAM', u32(ACTOR_BEHAVIOUR));
    }
    // Actions: turn i is said during phase i.
    spec.turns.forEach((t, i) => {
      add('ANAM', u16(0)); // Dialogue
      add('NAM0', zstr(''));
      add('ALID', s32(t.alias));
      add('INAM', u32(i + 1));
      add('FNAM', u32(0));
      add('SNAM', u32(i));
      add('ENAM', u32(i));
      add('DATA', form(t.topic));
      add('HTID', s32(-1));
      add('ANAM', empty());
    });
    add('NEXT', empty());
    add('PNAM', form(quest));
    add('INAM', u32(spec.turns.length));
    ws.setSubrecords(key, subs, `Write scene ${spec.editorId}`);
    return key;
  });
}

/** Read back a scene written above (or by the CK): its quest, flags and turns. */
export function readScene(ws: Workspace, key: FormKey): { quest: FormKey | null; beginOnQuestStart: boolean; turns: { alias: number; topic: FormKey | null }[] } | undefined {
  const w = ws.winner(key);
  if (!w || w.record.sig !== 'SCEN') return undefined;
  const subs = w.record.subrecords;
  const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
  const toKey = (d: Uint8Array): FormKey | null => {
    if (d.byteLength < 4) return null;
    return ws.keyOf(w.slot, dv(d).getUint32(0, true));
  };
  let quest: FormKey | null = null;
  let flags = 0;
  const turns: { alias: number; topic: FormKey | null }[] = [];
  let inAction = false;
  let cur: { alias: number; topic: FormKey | null } | null = null;
  for (const s of subs) {
    if (s.sig === 'FNAM' && !inAction && s.data.byteLength >= 4) flags = dv(s.data).getUint32(0, true);
    else if (s.sig === 'ANAM' && s.data.byteLength === 2) {
      inAction = true;
      cur = { alias: -1, topic: null };
    } else if (s.sig === 'ANAM' && s.data.byteLength === 0 && cur) {
      turns.push(cur);
      cur = null;
      inAction = false;
    } else if (cur && s.sig === 'ALID') cur.alias = dv(s.data).getInt32(0, true);
    else if (cur && s.sig === 'DATA') cur.topic = toKey(s.data);
    else if (!inAction && s.sig === 'PNAM') quest = toKey(s.data);
  }
  return { quest, beginOnQuestStart: (flags & SCENE_BEGIN_ON_QUEST_START) !== 0, turns };
}

export { makeFormKey, parseFormKey };
