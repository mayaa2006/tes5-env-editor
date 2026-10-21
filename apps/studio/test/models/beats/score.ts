/**
 * How close a beat sheet is to the expected reading of its document (expected.ts): who and what were found, which
 * beats were read right, whether they come in the right order, whether the endings end the quest, and whether the
 * author's lines that do something were linked to the right beat.
 */
import { findDialogue, type BeatSheet } from '@tes5/workspace';
import type { ExpectedQuest } from './expected';

export interface BeatScore {
  people: [number, number];
  places: [number, number];
  items: [number, number];
  /** Expected beats read right (optional ones count only when found), and beats read that aren't expected. */
  beats: [number, number];
  extra: number;
  /** Matched beats that come after the beats they should. */
  order: [number, number];
  endings: [number, number];
  links: [number, number];
  missing: string[];
}

const norm = (t: string) => t.toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/^the\s+/, '').trim();
/** A name matches when either contains the other, or they share their first word ("Hesta" and "Hesta Coldwater"). */
export function sameName(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x) || x.split(' ')[0] === y.split(' ')[0];
}

export function scoreBeats(sheet: BeatSheet, want: ExpectedQuest, text: string): BeatScore {
  const found = (names: string[], have: string[]) => [names.filter((n) => have.some((h) => sameName(h, n))).length, names.length] as [number, number];
  const entities = [...sheet.people, ...sheet.places, ...sheet.items, ...sheet.groups.map((g) => ({ key: g.key, name: g.what }))];
  const nameOf = (key: string | null) => (key ? (entities.find((e) => e.key === key) as { name?: string } | undefined)?.name ?? key : null);
  const missing: string[] = [];

  // Each expected beat to one beat read, in order; a beat read is used once.
  const used = new Set<string>();
  const match: (string | undefined)[] = want.beats.map((w) => {
    const hit = sheet.beats.find((b) => !used.has(b.id) && w.as.some((a) => a.does === b.does && (a.target === null ? true : !!nameOf(b.target) && sameName(nameOf(b.target)!, a.target))));
    if (hit) used.add(hit.id);
    return hit?.id;
  });
  want.beats.forEach((w, i) => {
    if (!match[i] && !w.optional) missing.push(`beat ${i}: ${w.as.map((a) => `${a.does} ${a.target ?? ''}`.trim()).join(' or ')}`);
  });
  const counted = want.beats.map((w, i) => !w.optional || !!match[i]);
  const beats: [number, number] = [match.filter((m, i) => m && counted[i]).length, counted.filter(Boolean).length];

  // Order: a matched beat comes (directly or through others) after a match of each beat it should follow.
  const byId = new Map(sheet.beats.map((b) => [b.id, b]));
  const before = (id: string, seen = new Set<string>()): Set<string> => {
    for (const a of byId.get(id)?.after ?? []) if (!seen.has(a)) (seen.add(a), before(a, seen));
    return seen;
  };
  let orderOk = 0;
  let orderAll = 0;
  want.beats.forEach((w, i) => {
    const id = match[i];
    const needs = w.after.map((j) => match[j]).filter((x): x is string => !!x);
    if (!id || !needs.length) return;
    orderAll++;
    const prior = before(id);
    // With several expected predecessors (branches joining), any one leading here is right.
    if (needs.some((n) => prior.has(n))) orderOk++;
    else missing.push(`order: beat ${i} should come after ${w.after.join(' or ')}`);
  });

  const endings = want.beats.map((w, i) => [w, match[i]] as const).filter(([w, m]) => w.ends && m);
  const endOk = endings.filter(([w, m]) => byId.get(m!)?.ends === w.ends).length;
  for (const [w, m] of endings) if (byId.get(m!)?.ends !== w.ends) missing.push(`ending: ${m} should ${w.ends}`);

  // Links: the author's line (found by its first words) completes the matched beat.
  const blocks = findDialogue(text).blocks;
  let linkOk = 0;
  for (const l of want.links ?? []) {
    const at = blocks.flatMap((b) => b.lines.map((x, n) => ({ block: b.id, line: n + 1, text: x.text }))).find((x) => x.text.startsWith(l.line));
    const beat = match[l.beat];
    const ok = !!at && !!beat && sheet.dialogue.some((d) => d.block === at.block && d.lines.some((x) => x.line === at.line && x.beat === beat));
    if (ok) linkOk++;
    else missing.push(`link: “${l.line}” should complete beat ${l.beat}`);
  }

  return {
    people: found(want.people, sheet.people.map((p) => p.name)),
    places: found(want.places, sheet.places.map((p) => p.name)),
    items: found(want.items, sheet.items.map((p) => p.name)),
    beats,
    extra: sheet.beats.filter((b) => !used.has(b.id)).length,
    order: [orderOk, orderAll],
    endings: [endOk, endings.length],
    links: [linkOk, (want.links ?? []).length],
    missing,
  };
}
