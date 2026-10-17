/**
 * Finding the record an AI means. Models name things every way: a FormKey, an
 * Editor ID, the name shown in game ("Iron War Axe", "mead"), or an Editor ID
 * they made up from the name ("WhiterunBanneredMareChest"). The first three
 * are taken as they are; for anything else the error lists the closest
 * records, so the next try can use a real Editor ID instead of guessing again.
 */
import { isFormKey, type FormKey } from '@tes5/esp';
import { WorkspaceError, type RecordSummary, type Workspace } from '@tes5/workspace';

/** Records people mean when they name something, before the placed copies and dialogue parts that share its name. */
const MAIN_SIGS = new Set(['CELL', 'WRLD', 'LCTN', 'NPC_', 'QUST', 'WEAP', 'ARMO', 'MISC', 'BOOK', 'ALCH', 'INGR', 'KEYM', 'AMMO', 'CONT', 'DOOR', 'FURN', 'SPEL', 'PERK', 'FACT', 'RACE', 'CLAS', 'OTFT', 'SHOU', 'ENCH', 'MGEF', 'LVLI', 'LVLN']);
export const MINOR_SIGS = new Set(['REFR', 'ACHR', 'PGRE', 'PHZD', 'INFO', 'DIAL', 'PACK', 'SCEN', 'DLBR', 'DLVW', 'NAVM', 'LAND', 'IDLE']);

/** How well a record matches what was asked for: its exact name first, then the main records, then placed copies and dialogue parts. */
export function rank(s: RecordSummary, query: string): number {
  const q = query.toLowerCase().trim();
  const name = (s.name ?? '').toLowerCase();
  const edid = (s.editorId ?? '').toLowerCase();
  let n = 0;
  if (q && name === q) n += 100;
  else if (q && edid === q.replace(/[^a-z0-9_]/g, '')) n += 90;
  else if (q && (name.startsWith(q) || name.replace(/^the /, '') === q.replace(/^the /, ''))) n += 50;
  if (MAIN_SIGS.has(s.sig)) n += 20;
  if (MINOR_SIGS.has(s.sig)) n -= 30;
  // Shorter Editor IDs are usually the thing itself ("WhiterunBanneredMare", not "WhiterunBanneredMareScene3").
  return n - Math.min(20, edid.length / 4);
}

/** The words in a name or a made-up Editor ID ("WhiterunBanneredMareChest" → whiterun, bannered, mare, chest). */
export function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for'].includes(w));
}

/**
 * A FormKey for what was written: a FormKey, an Editor ID, or a bare form ID
 * ("0095FE", "000095FE") that names one record among the loaded plugins.
 */
export function formKeyOf(ws: Workspace, ref: string): FormKey | undefined {
  const r = ref.trim();
  if (isFormKey(r)) return r as FormKey;
  const byId = ws.byEditorId(r) as FormKey | undefined;
  if (byId) return byId;
  const hex = /^(?:0x)?([0-9a-f]{6,8})$/i.exec(r);
  if (!hex) return undefined;
  const id = hex[1]!.slice(-6).toUpperCase();
  const found = ws
    .loaded()
    .map((p) => `${id}:${p.name}` as FormKey)
    .filter((k) => ws.summary(k));
  return found.length === 1 ? found[0] : undefined;
}

const line = (s: RecordSummary) => `${s.editorId ?? s.formKey}${s.name ? ` "${s.name}"` : ''} (${s.sig}${s.editorId ? `, ${s.formKey}` : ''})`;

/**
 * The record a FormKey, Editor ID or in-game name stands for (of these
 * record types, if given). `what` names it in errors ("weapon", "place").
 */
export function lookup(ws: Workspace, ref: string, opts: { what: string; sigs?: string[] } = { what: 'record' }): FormKey {
  const r = ref.trim().replace(/^["'“”]+|["'“”]+$/g, '');
  const ok = (k: FormKey | undefined) => !!k && !!ws.summary(k) && (!opts.sigs || opts.sigs.includes(ws.summary(k)!.sig));
  if (isFormKey(r)) {
    if (ok(r as FormKey)) return r as FormKey;
    if (!ws.summary(r as FormKey)) throw new WorkspaceError(`Nothing in the load order has the FormKey ${r}.`);
  }
  const byId = formKeyOf(ws, r);
  if (ok(byId)) return byId!;
  const words = wordsOf(r);
  // The name shown in game, exactly (ignoring case).
  const q = r.toLowerCase();
  const pool = words.length ? ws.search({ sigs: opts.sigs, query: words.sort((a, b) => b.length - a.length)[0]!, limit: 5000 }).items.filter((s) => !s.deleted) : [];
  const named = pool.filter((s) => s.name?.toLowerCase() === q).sort((a, b) => rank(b, r) - rank(a, r));
  if (named.length === 1 || (named.length > 1 && rank(named[0]!, r) > rank(named[1]!, r))) return named[0]!.formKey;
  if (named.length > 1) throw new WorkspaceError(`Several ${opts.what === 'record' ? 'records' : `${opts.what}s`} are called "${r}": ${named.slice(0, 8).map(line).join('; ')}. Use one of these Editor IDs.`);
  // Not found: the records sharing the most words with it.
  const close = new Map<FormKey, { s: RecordSummary; n: number }>();
  for (const w of words.slice(0, 6))
    for (const s of ws.search({ sigs: opts.sigs, query: w, limit: 400 }).items) {
      if (s.deleted) continue;
      const e = close.get(s.formKey) ?? { s, n: 0 };
      e.n++;
      close.set(s.formKey, e);
    }
  const best = [...close.values()].sort((a, b) => b.n - a.n || rank(b.s, r) - rank(a.s, r)).slice(0, 6);
  const found = byId && !ok(byId) ? ` ${r} is a ${ws.summary(byId)?.sig} record, not a ${opts.what}.` : '';
  throw new WorkspaceError(`There's no ${opts.what} "${r}".${found}${best.length ? ` Closest: ${best.map((b) => line(b.s)).join('; ')}.` : ''} Use an Editor ID or FormKey (search_records finds them).`);
}
