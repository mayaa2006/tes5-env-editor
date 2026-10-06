/**
 * Scenes: characters talking to each other (or to the air) without the
 * player, one turn after another. Written as a SCEN record in the layout
 * xEdit documents for Skyrim: one phase per turn, the actors as quest
 * aliases, and a dialogue action per turn pointing at a scene topic.
 */
import type { FormKey } from '@tes5/esp';
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

/** Create the scene record; returns its FormKey. */
export function writeScene(ws: Workspace, quest: FormKey, spec: SceneSpec): FormKey {
  return ws.createRecord('SCEN', {
    editorId: spec.editorId,
    flags: (spec.beginOnQuestStart ? SCENE_BEGIN_ON_QUEST_START : 0) | SCENE_INTERRUPTIBLE,
    // One phase per turn.
    phases: spec.turns.map(() => ({ start: new Uint8Array(0), name: '', next1: new Uint8Array(0), next2: new Uint8Array(0), editorWidth: 200, end: new Uint8Array(0) })),
    // Every alias that speaks.
    actors: [...new Set(spec.turns.map((t) => t.alias))].map((alias) => ({ alias, flags: 0, behaviour: ACTOR_BEHAVIOUR })),
    // Turn i is said during phase i.
    actions: spec.turns.map((t, i) => ({ type: 0, name: '', actor: t.alias, index: i + 1, flags: 0, startPhase: i, endPhase: i, topic: t.topic, headtrack: -1, end: new Uint8Array(0) })),
    next: new Uint8Array(0),
    quest,
    lastActionIndex: spec.turns.length,
  });
}

/** Read back a scene: its quest, flags and turns. */
export function readScene(ws: Workspace, key: FormKey): { quest: FormKey | null; beginOnQuestStart: boolean; turns: { alias: number; topic: FormKey | null }[] } | undefined {
  const v = ws.view(key);
  if (!v || v.sig !== 'SCEN') return undefined;
  const d = v.data as any;
  return {
    quest: d.quest ?? null,
    beginOnQuestStart: ((d.flags ?? 0) & SCENE_BEGIN_ON_QUEST_START) !== 0,
    turns: (d.actions ?? []).filter((a: any) => (a.type ?? 0) === 0).map((a: any) => ({ alias: a.actor ?? -1, topic: a.topic ?? null })),
  };
}
