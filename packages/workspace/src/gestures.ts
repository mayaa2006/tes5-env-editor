/**
 * Gestures: animations characters play during dialogue and quest events.
 *
 * A gesture is a friendly name ("wave", "point", "laugh") for one of the
 * game's idle animations. When the load order has the IDLE form, the
 * generated script plays it with PlayIdle (which respects the form's
 * conditions); otherwise it sends the animation event directly with
 * Debug.SendAnimationEvent. Any IDLE Editor ID or animation event name can
 * be used too, for animations from other mods.
 */
import type { FormKey } from '@tes5/esp';
import { formExpression } from './dialogue';
import type { Workspace } from './engine';

export interface Gesture {
  id: string;
  label: string;
  /** Vanilla animation event (and usually the IDLE form's Editor ID). */
  event: string;
  group: 'greet' | 'talk' | 'emotion' | 'action';
  /** Loops until stopped ([gesture stop]). */
  loops?: boolean;
}

/** Common vanilla idles. The event names follow the game's idle forms; check unusual ones in game. */
export const GESTURES: Gesture[] = [
  { id: 'wave', label: 'Wave', event: 'IdleWave', group: 'greet' },
  { id: 'salute', label: 'Salute', event: 'IdleSalute', group: 'greet' },
  { id: 'bow', label: 'Bow', event: 'IdleBow', group: 'greet' },
  { id: 'point', label: 'Point (near)', event: 'IdlePointClose', group: 'talk' },
  { id: 'pointfar', label: 'Point (far)', event: 'IdlePointFar_01', group: 'talk' },
  { id: 'comehere', label: 'Come this way', event: 'IdleComeThisWay', group: 'talk' },
  { id: 'applaud', label: 'Applaud', event: 'IdleApplaud2', group: 'emotion' },
  { id: 'sarcastic', label: 'Sarcastic applause', event: 'IdleApplaudSarcastic', group: 'emotion' },
  { id: 'laugh', label: 'Laugh', event: 'IdleLaugh', group: 'emotion' },
  { id: 'nervous', label: 'Nervous', event: 'IdleNervous', group: 'emotion' },
  { id: 'wipebrow', label: 'Wipe brow', event: 'IdleWipeBrow', group: 'emotion' },
  { id: 'examine', label: 'Examine something', event: 'IdleExamine', group: 'action' },
  { id: 'drink', label: 'Drink', event: 'IdleDrinkPotion', group: 'action' },
  { id: 'warmhands', label: 'Warm hands', event: 'IdleWarmHands', group: 'action' },
  { id: 'pray', label: 'Pray', event: 'IdlePray', group: 'action', loops: true },
  { id: 'read', label: 'Read a book', event: 'IdleBook_Reading', group: 'action', loops: true },
  { id: 'stop', label: 'Stop (back to normal)', event: 'IdleForceDefaultState', group: 'action' },
];

/** A gesture by id, label or event name; unknown names are taken as an animation event / IDLE Editor ID. */
export function findGesture(name: string): Gesture {
  const l = name.trim().toLowerCase();
  return GESTURES.find((g) => g.id === l || g.label.toLowerCase() === l || g.event.toLowerCase() === l) ?? { id: name.trim(), label: name.trim(), event: name.trim(), group: 'action' };
}

/** The IDLE form for a gesture, when the load order has it. */
export function gestureIdle(ws: Workspace, g: Gesture): FormKey | undefined {
  const k = ws.byEditorId(g.event);
  return k && ws.summary(k)?.sig === 'IDLE' ? k : undefined;
}

/** Papyrus that makes `actor` (an Actor expression) play the gesture. */
export function gestureCode(ws: Workspace, name: string, actor: string): string {
  const g = findGesture(name);
  if (!/^[A-Za-z0-9_]+$/.test(g.event)) throw new Error(`“${name}” isn't a gesture or an animation name`);
  const idle = gestureIdle(ws, g);
  return idle ? `${actor}.PlayIdle(${formExpression(idle)} as Idle)` : `Debug.SendAnimationEvent(${actor}, "${g.event}")`;
}

/** Gestures to choose from: the common ones, then other idles in the load order. */
export function listGestures(ws: Workspace, opts: { query?: string; limit?: number } = {}): { id: string; label: string; group: string; loops: boolean }[] {
  const q = opts.query?.trim().toLowerCase() ?? '';
  const out: { id: string; label: string; group: string; loops: boolean }[] = GESTURES.filter((g) => !q || g.label.toLowerCase().includes(q) || g.event.toLowerCase().includes(q)).map((g) => ({ id: g.id, label: g.label, group: g.group, loops: !!g.loops }));
  const known = new Set(GESTURES.map((g) => g.event.toLowerCase()));
  for (const s of ws.search({ sigs: ['IDLE'], query: q || undefined, limit: opts.limit ?? 200 }).items) {
    if (!s.editorId || known.has(s.editorId.toLowerCase())) continue;
    out.push({ id: s.editorId, label: s.editorId, group: 'load order', loops: false });
  }
  return out;
}

const PLAY_LINE = /^\s*(.+?)\.PlayIdle\(\s*Game\.GetFormFromFile\(\s*0x([0-9A-F]+)\s*,\s*"([^"]+)"\s*\)\s+as\s+Idle\s*\)\s*$/i;
const SEND_LINE = /^\s*Debug\.SendAnimationEvent\(\s*(.+?)\s*,\s*"([A-Za-z0-9_]+)"\s*\)\s*$/i;

/** The gesture a generated script line plays, and who plays it (the Papyrus actor expression). */
export function parseGestureLine(ws: Workspace, line: string): { actor: string; gesture: Gesture } | undefined {
  const p = PLAY_LINE.exec(line);
  if (p) {
    const key = `${p[2]!.toUpperCase().padStart(6, '0').slice(-6)}:${p[3]}` as FormKey;
    const edid = ws.summary(key)?.editorId;
    return { actor: p[1]!, gesture: findGesture(edid ?? key) };
  }
  const s = SEND_LINE.exec(line);
  if (s) return { actor: s[1]!, gesture: findGesture(s[2]!) };
  return undefined;
}

/** A readable name for the actor expression in a gesture line ("Alias_Brynja.GetActorReference()" → "Brynja"). */
export function gestureActorName(actor: string): string {
  if (actor === 'akSpeaker') return 'the speaker';
  const m = /^Alias_(\w+)\.GetActorReference\(\)$/.exec(actor);
  return m ? m[1]! : actor;
}
