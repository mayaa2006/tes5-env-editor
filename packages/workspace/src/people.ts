/**
 * Factions in plain terms: who belongs to one (and at which rank), adding or
 * removing someone, and a faction's crime gold, which the game keeps in a
 * packed block (CRVA) the schema leaves as bytes.
 */
import type { FormKey } from '@tes5/esp';
import type { Workspace } from './engine';

export interface FactionMember {
  formKey: FormKey;
  editorId?: string;
  name?: string;
  rank: number;
  /** The character's winning version is in the plugin being edited. */
  inActive: boolean;
}

type NpcSummary = ReturnType<Workspace['search']>['items'][number];

/** Whether a character is in the faction, and at which rank. Their winning record is checked for the form ID before it's decoded. */
function membership(ws: Workspace, it: NpcSummary, faction: FormKey): FactionMember[] {
  if (it.deleted) return [];
  const w = ws.winner(it.formKey);
  const local = w?.slot.mapper?.toLocal(faction);
  if (!w || local === undefined || !w.record.containsU32(local)) return [];
  const f = ((ws.view(it.formKey)?.data.factions ?? []) as { faction?: FormKey; rank?: number }[]).find((x) => x.faction === faction);
  return f ? [{ formKey: it.formKey, editorId: it.editorId, name: it.name, rank: f.rank ?? 0, inActive: it.inActive }] : [];
}

/** Members whose winning version isn't in the plugin being edited don't change while the load order and active plugin stay the same: found once per faction. */
const stableMembers = new WeakMap<Workspace, Map<string, FactionMember[]>>();

/** Characters in a faction, yours first, then by name. Quick on Skyrim.esm's thousands of characters after the first look. */
export function factionMembers(ws: Workspace, faction: FormKey, limit = 500): { total: number; members: FactionMember[] } {
  const all = ws.search({ sigs: ['NPC_'], limit: 1e9 }).items;
  let cache = stableMembers.get(ws);
  if (!cache) stableMembers.set(ws, (cache = new Map()));
  const key = `${ws.loaded().map((s) => s.name).join(',')}|${ws.activeName ?? ''}|${faction}`;
  let others = cache.get(key);
  if (!others) cache.set(key, (others = all.filter((it) => !it.inActive).flatMap((it) => membership(ws, it, faction))));
  const yours = all.filter((it) => it.inActive);
  const overridden = new Set(yours.map((it) => it.formKey));
  const out = [...others.filter((m) => !overridden.has(m.formKey)), ...yours.flatMap((it) => membership(ws, it, faction))];
  const label = (m: FactionMember) => (m.name || m.editorId || '').toLowerCase();
  out.sort((a, b) => Number(b.inActive) - Number(a.inActive) || (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0));
  return { total: out.length, members: out.slice(0, limit) };
}

/** Put a character in a faction at a rank, change their rank, or (rank null) take them out. One undo step. */
export function setFactionRank(ws: Workspace, npc: FormKey, faction: FormKey, rank: number | null): void {
  const who = ws.summary(npc);
  const what = ws.summary(faction);
  const name = (s: typeof who) => s?.name || s?.editorId || '?';
  const label = rank === null ? `Take ${name(who)} out of ${name(what)}` : `Put ${name(who)} in ${name(what)} at rank ${rank}`;
  ws.editRecord(
    npc,
    (d) => {
      const list = [...((d.factions ?? []) as { faction: FormKey; rank: number; unused?: Uint8Array }[])];
      const at = list.findIndex((x) => x.faction === faction);
      if (rank === null) {
        if (at >= 0) list.splice(at, 1);
      } else if (at >= 0) list[at] = { ...list[at]!, rank };
      else list.push({ faction, rank, unused: new Uint8Array(3) });
      d.factions = list;
    },
    label,
  );
}

/** A faction's crime gold and how its guards react, as stored in CRVA. Fields an older, shorter block lacks are left out. */
export interface CrimeValues {
  arrest: boolean;
  attackOnSight: boolean;
  murder: number;
  assault: number;
  trespass: number;
  pickpocket: number;
  /** Stolen items cost this times their value. */
  stealMult?: number;
  escape?: number;
  werewolf?: number;
}

/** The hold crime factions' values in Skyrim.esm (CrimeFactionWhiterun and the rest). */
export const DEFAULT_CRIME: Required<CrimeValues> = { arrest: true, attackOnSight: true, murder: 1000, assault: 40, trespass: 5, pickpocket: 25, stealMult: 0.5, escape: 100, werewolf: 1000 };

/** Byte offsets in CRVA: arrest u8, attack on sight u8, murder, assault, trespass, pickpocket, (unknown) u16, steal multiplier f32, escape, werewolf u16. */
export function readCrimeValues(bytes: Uint8Array | undefined): CrimeValues | undefined {
  if (!bytes || bytes.byteLength < 10) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: CrimeValues = { arrest: dv.getUint8(0) !== 0, attackOnSight: dv.getUint8(1) !== 0, murder: dv.getUint16(2, true), assault: dv.getUint16(4, true), trespass: dv.getUint16(6, true), pickpocket: dv.getUint16(8, true) };
  if (bytes.byteLength >= 16) out.stealMult = dv.getFloat32(12, true);
  if (bytes.byteLength >= 20) {
    out.escape = dv.getUint16(16, true);
    out.werewolf = dv.getUint16(18, true);
  }
  return out;
}

/** CRVA with these values written over `bytes` (a new 20-byte block when there's none). Bytes it doesn't know are kept. */
export function writeCrimeValues(values: CrimeValues, bytes?: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(bytes?.byteLength ?? 20, 10));
  if (bytes) out.set(bytes);
  // A new block takes the hold factions' values for anything not given.
  const v: CrimeValues = bytes ? values : { ...DEFAULT_CRIME, ...values };
  const dv = new DataView(out.buffer);
  const u16 = (at: number, n: number) => dv.setUint16(at, Math.max(0, Math.min(65535, Math.round(n))), true);
  dv.setUint8(0, v.arrest ? 1 : 0);
  dv.setUint8(1, v.attackOnSight ? 1 : 0);
  u16(2, v.murder);
  u16(4, v.assault);
  u16(6, v.trespass);
  u16(8, v.pickpocket);
  if (out.byteLength >= 16 && v.stealMult !== undefined) dv.setFloat32(12, v.stealMult, true);
  if (out.byteLength >= 20) {
    if (v.escape !== undefined) u16(16, v.escape);
    if (v.werewolf !== undefined) u16(18, v.werewolf);
  }
  return out;
}
