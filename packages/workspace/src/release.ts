/**
 * Getting a plugin ready to publish:
 *  - a pre-release check that finds what breaks in game (missing meshes,
 *    empty script properties, aliases that can't fill, unvoiced lines,
 *    floating objects, one-way doors, stale navmeshes, missing FaceGen, …)
 *  - a conflict report: which of your records other plugins also change
 *  - packaging: your plugin's own files into a BSA, or everything into a ZIP
 */
import { parseFormKey, recordTypeName, type FormKey, type Navmesh } from '@tes5/esp';
import { flattenMeshes, normalizePath, parseNif, writeBsa } from '@tes5/assets';
import { validateNavmesh } from '@tes5/navmesh';
import { zipSync } from 'fflate';
import { boundsMismatches, eslReport, existingNavmeshes } from './automations';
import { type Workspace } from './engine';
import { DialogueService } from './dialogue';
import { lintQuestDialogue } from './dialoguelint';
import { EnvironmentService } from './environment';
import { basename, joinPath } from './fs';
import type { NpcService } from './npc';
import type { FaceGenService } from './facegen';
import type { QuestService } from './quest';
import type { QuestGraphService } from './questgraph';
import type { ScriptService } from './scripts';

export type FindingSeverity = 'error' | 'warning' | 'info';
export type FindingCategory = 'assets' | 'scripts' | 'quests' | 'dialogue' | 'world' | 'navmesh' | 'characters' | 'plugin';
/** One-click fixes the UI can offer next to a finding. */
export type FindingFix = { kind: 'autofill'; form: FormKey } | { kind: 'generateFaces'; npcs: FormKey[] } | { kind: 'updateBounds' } | { kind: 'generateNavmesh'; cell: FormKey } | { kind: 'dropToSurface'; refs: FormKey[] } | { kind: 'compileScripts'; scripts: string[] };

export interface Finding {
  severity: FindingSeverity;
  category: FindingCategory;
  /** What's wrong, in plain words. */
  message: string;
  /** Why it matters / what happens in game. */
  detail?: string;
  /** The form to open to fix it. */
  form?: FormKey;
  /** For world findings: the cell to open. */
  cell?: FormKey;
  fix?: FindingFix;
}

export interface ReleaseReport {
  plugin: string;
  findings: Finding[];
  counts: Record<FindingSeverity, number>;
}

export interface ConflictEntry {
  formKey: FormKey;
  editorId?: string;
  sig: string;
  typeName: string;
  /** Every plugin with a version, in load order (the first is the original). */
  plugins: string[];
  winner: string;
  /** Your version is the one the game uses. */
  mineWins: boolean;
  /** Plugins loading after yours that replace your change. */
  overriddenBy: string[];
  /** Other mods (not the original) loading before yours that also change it; your version replaces theirs. */
  replaces: string[];
}

export interface PackageFile {
  /** Path inside Data, e.g. "meshes\\mymod\\chair.nif". */
  path: string;
  /** Why it's needed. */
  reason: string;
  status: 'included' | 'missing' | 'in-archive';
  size?: number;
  /** Loose folder it comes from. */
  root?: string;
}

const SMALL_ITEMS = new Set(['MISC', 'ALCH', 'INGR', 'BOOK', 'WEAP', 'ARMO', 'AMMO', 'KEYM', 'SLGM', 'SCRL']);
const MESH_SUBS = ['MODL', 'MOD2', 'MOD3', 'MOD4', 'MOD5'];
const TEXTURE_SUBS = ['ICON', 'MICO', 'TX00', 'TX01', 'TX02', 'TX03', 'TX04', 'TX05', 'TX06', 'TX07'];

const zstring = (data: Uint8Array) => {
  let end = data.indexOf(0);
  if (end < 0) end = data.byteLength;
  return new TextDecoder('latin1').decode(data.subarray(0, end)).trim();
};

const withPrefix = (prefix: 'meshes' | 'textures', p: string) => {
  const n = normalizePath(p).replace(/^data\\/, '');
  return n.startsWith(`${prefix}\\`) ? n : `${prefix}\\${n}`;
};

/** Same subrecords with the same bytes (flags aside from compression). */
function sameContent(a: { subrecords: { sig: string; data: Uint8Array }[]; flags: number }, b: { subrecords: { sig: string; data: Uint8Array }[]; flags: number }): boolean {
  const sa = a.subrecords;
  const sb = b.subrecords;
  if ((a.flags & ~0x40000) !== (b.flags & ~0x40000) || sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i]!;
    const y = sb[i]!;
    if (x.sig !== y.sig || x.data.byteLength !== y.data.byteLength) return false;
    for (let j = 0; j < x.data.byteLength; j++) if (x.data[j] !== y.data[j]) return false;
  }
  return true;
}

export class ReleaseService {
  readonly env: EnvironmentService;

  constructor(
    readonly ws: Workspace,
    readonly scripts: ScriptService,
    readonly npcs: NpcService,
    readonly quests: QuestService,
    readonly graphs: QuestGraphService,
    env?: EnvironmentService,
    readonly faces?: FaceGenService,
  ) {
    this.env = env ?? new EnvironmentService(ws);
  }

  private own() {
    const a = this.ws.active;
    if (!a?.plugin) return [];
    return [...a.plugin.records()].map((r) => ({ record: r, key: this.ws.keyOf(a, r.formId)! }));
  }

  // ---------------------------------------------------------------- pre-release check

  async check(): Promise<ReleaseReport> {
    const a = this.ws.active;
    if (!a?.plugin) return { plugin: '', findings: [], counts: { error: 0, warning: 0, info: 0 } };
    const findings: Finding[] = [];
    const add = (f: Finding) => findings.push(f);
    const own = this.own();
    const label = (k: FormKey) => this.ws.summary(k)?.editorId ?? this.ws.summary(k)?.name ?? k;

    // Assets: meshes and textures your forms use.
    const nifChecked = new Set<string>();
    for (const { record, key } of own) {
      for (const sub of record.subrecords) {
        const isMesh = MESH_SUBS.includes(sub.sig);
        const isTex = TEXTURE_SUBS.includes(sub.sig) && record.sig !== 'NPC_';
        if (!isMesh && !isTex) continue;
        const raw = zstring(sub.data);
        if (!raw || !/\.(nif|dds|png|tga)$/i.test(raw)) continue;
        const path = withPrefix(isMesh ? 'meshes' : 'textures', raw);
        if (!this.ws.vfs.has(path)) {
          add({ severity: 'error', category: 'assets', message: `${label(key)} uses ${path}, which doesn't exist`, detail: isMesh ? 'The game shows a red "!" error marker (or nothing) instead.' : 'The game shows a purple texture.', form: key });
          continue;
        }
        if (!isMesh || nifChecked.has(path)) continue;
        nifChecked.add(path);
        const e = this.ws.vfs.entry(path);
        if (e?.source.kind !== 'loose') continue; // vanilla / other mods' archives are assumed fine
        try {
          for (const m of flattenMeshes(parseNif(await this.ws.vfs.read(path))))
            for (const t of m.mesh.material.textures) {
              if (!t) continue;
              const tp = withPrefix('textures', t);
              if (!this.ws.vfs.has(tp)) add({ severity: 'warning', category: 'assets', message: `${path} needs ${tp}, which doesn't exist`, detail: 'The game shows a purple texture on that part of the model.', form: key });
            }
        } catch {
          add({ severity: 'warning', category: 'assets', message: `${path} couldn't be read`, detail: 'It may be damaged, or from a newer game version.', form: key });
        }
      }
    }

    // Scripts: compiled, and every property set.
    for (const { record, key } of own) {
      if (!record.has('VMAD')) continue;
      const vm = this.scripts.scriptsOf(key);
      for (const s of vm.scripts) {
        if (!this.ws.vfs.has(`scripts\\${s.name.toLowerCase()}.pex`))
          add({
            severity: 'warning',
            category: 'scripts',
            message: `${s.name} (on ${label(key)}) isn't compiled`,
            detail: 'The game only runs compiled scripts (.pex). Compile it in the Scripts tab.',
            form: key,
            fix: this.scripts.isOwn(s.name) ? { kind: 'compileScripts', scripts: [s.name] } : undefined,
          });
      }
      const frag = (vm as { fragments?: { fileName?: string } }).fragments?.fileName;
      if (frag && !this.ws.vfs.has(`scripts\\${frag.toLowerCase()}.pex`))
        add({
          severity: 'warning',
          category: 'scripts',
          message: `Fragment script ${frag} (on ${label(key)}) isn't compiled`,
          detail: "Stage, dialogue or trigger scripts in it won't run until it is.",
          form: key,
          fix: this.scripts.isOwn(frag) ? { kind: 'compileScripts', scripts: [frag] } : undefined,
        });
      try {
        const empty = await this.scripts.emptyProperties(key);
        if (empty.length)
          add({
            severity: 'warning',
            category: 'scripts',
            message: `${label(key)}: ${empty.length} script propert${empty.length === 1 ? 'y is' : 'ies are'} empty (${empty
              .slice(0, 4)
              .map((e) => `${e.script}.${e.property}`)
              .join(', ')}${empty.length > 4 ? '…' : ''})`,
            detail: 'Empty properties are None in game, so the script errors or does nothing.',
            form: key,
            fix: empty.some((e) => e.canAutofill) ? { kind: 'autofill', form: key } : undefined,
          });
      } catch {
        // unreadable source: reported by the Scripts tab
      }
    }

    // Quests: map problems and aliases that can't fill.
    for (const { record, key } of own) {
      if (record.sig !== 'QUST') continue;
      try {
        const g = await this.graphs.graph(key);
        for (const p of g.problems) add({ severity: 'warning', category: 'quests', message: `${label(key)}: ${p}`, form: key });
      } catch {
        // graph needs a readable quest; the record check below still runs
      }
      const q = this.quests.quest(key);
      for (const al of q?.aliases ?? []) {
        const optional = (al.flags & 0x2) !== 0;
        const targets = Object.values(al.fill).filter((v): v is FormKey => typeof v === 'string' && v.includes(':'));
        if (al.fillType === 'none' && !optional) add({ severity: 'warning', category: 'quests', message: `${label(key)}: alias “${al.name}” has no way to be filled`, detail: 'A required alias that can\'t fill stops the quest from starting.', form: key });
        for (const t of targets) if (!this.ws.exists(t)) add({ severity: 'error', category: 'quests', message: `${label(key)}: alias “${al.name}” points to ${t}, which doesn't exist`, detail: 'The alias can\'t fill, so the quest won\'t start.', form: key });
      }
      // Dialogue problems (lines nobody answers, choices never offered, stages that don't exist, …).
      try {
        for (const l of await lintQuestDialogue(key, { quests: this.quests, dialogue: new DialogueService(this.ws, this.quests), graphs: this.graphs }))
          add({ severity: l.severity, category: 'dialogue', message: `${label(key)}: ${l.message}`, detail: l.detail, form: l.form ?? key });
      } catch {
        // unreadable dialogue is reported by the record checks
      }
      // Lines without a voice type are silent and flash past.
      for (const v of this.quests.voiceFiles(key)) {
        if (!v.voiceTypes.length) {
          add({ severity: 'info', category: 'dialogue', message: `${label(key)}: “${v.text.slice(0, 60)}${v.text.length > 60 ? '…' : ''}” has no voice type`, detail: 'Give the line a speaker (or a voice type condition) so the game knows which voice folder to use; otherwise its subtitle disappears almost at once.', form: v.info });
          break;
        }
      }
    }

    // Characters: FaceGen and voice.
    const needing = this.faces ? await this.faces.needingFaces() : [];
    for (const npc of needing) {
      const missing = this.npcs.faceGenProblems().some((p) => p.npc === npc);
      add({
        severity: 'warning',
        category: 'characters',
        message: missing ? `${label(npc)} has no FaceGen files` : `${label(npc)}'s FaceGen files are out of date`,
        detail: missing ? 'Their face would be dark or mismatched in game (the "dark face bug"). Generate their face files — no Creation Kit needed.' : 'Their face changed since the face files were made, so the game would show the old face. Generate them again.',
        form: npc,
        fix: { kind: 'generateFaces', npcs: needing },
      });
    }
    for (const p of this.npcs.faceGenProblems())
      if (!needing.includes(p.npc))
        add({ severity: 'warning', category: 'characters', message: `${p.editorId ?? p.npc} has no FaceGen files`, detail: this.faces ? "Their face would be dark in game, and it can't be generated because they have no head part with a mesh. Give them a head on the Characters tab." : 'Their face will be dark or mismatched in game (the "dark face bug").', form: p.npc });
    for (const { record, key } of own) {
      if (record.sig !== 'NPC_' || parseFormKey(key).plugin !== a.name) continue;
      const d = this.ws.view(key)?.data as { voice?: FormKey | null; template?: FormKey | null } | undefined;
      if (d && !d.voice && !d.template) add({ severity: 'warning', category: 'characters', message: `${label(key)} has no voice type`, detail: 'They can\'t speak or use generic dialogue, and their lines have no voice folder.', form: key });
    }

    // World: missing bases, deleted references, one-way doors, floating or sunk items.
    const world = this.env.world;
    const cellsTouched = new Set<FormKey>();
    for (const { record, key } of own) {
      if (record.sig !== 'REFR' && record.sig !== 'ACHR') continue;
      const v = this.ws.view(key);
      const cell = v?.parent.cell;
      if (cell) cellsTouched.add(cell);
      if (record.isDeleted) {
        add({ severity: 'error', category: 'world', message: `${label(key)} is a deleted reference`, detail: 'Deleted references crash the game when other mods or saves expect them. Clean the plugin (Clean tab) to turn it into a disabled one.', form: key, cell });
        continue;
      }
      const base = v?.data.base as FormKey | undefined;
      if (base && !this.ws.exists(base)) add({ severity: 'error', category: 'world', message: `${label(key)} places ${base}, which doesn't exist`, detail: 'The game skips it or crashes when loading the cell.', form: key, cell });
      const tel = v?.data.teleport as { door?: FormKey | null } | undefined;
      if (tel?.door) {
        const back = this.ws.view(tel.door)?.data.teleport as { door?: FormKey } | undefined;
        if (!this.ws.exists(tel.door)) add({ severity: 'error', category: 'world', message: `Door ${label(key)} leads to ${tel.door}, which doesn't exist`, detail: 'Using it does nothing or crashes.', form: key, cell });
        else if (back?.door !== key) add({ severity: 'warning', category: 'world', message: `Door ${label(key)} leads to ${label(tel.door)}, but that door doesn't lead back`, detail: 'Players can get in but not out. Link them both ways in World tools → Doors.', form: key, cell });
      }
    }
    for (const cell of cellsTouched) {
      let refs: ReturnType<typeof world.references>;
      try {
        refs = world.references(cell);
      } catch {
        continue;
      }
      const mine = refs.filter((r) => r.source === a.name && r.baseSig && SMALL_ITEMS.has(r.baseSig) && !r.disabled && !r.deleted);
      if (!mine.length) continue;
      try {
        const off = await this.env.restingOffsets(cell, mine.map((r) => r.formKey));
        const floating = off.filter((o) => o.offset > 4);
        const sunk = off.filter((o) => o.offset < -Math.max(4, o.height * 0.5));
        if (floating.length) add({ severity: 'warning', category: 'world', message: `${floating.length} item(s) float above the surface in ${label(cell)}`, detail: 'Loose items drop when the cell loads (Havok) and can roll away or make noise.', cell, form: floating[0]!.ref, fix: { kind: 'dropToSurface', refs: floating.map((o) => o.ref) } });
        if (sunk.length) add({ severity: 'warning', category: 'world', message: `${sunk.length} item(s) are sunk into the surface in ${label(cell)}`, detail: 'They can shoot out or fall through the floor when the cell loads.', cell, form: sunk[0]!.ref, fix: { kind: 'dropToSurface', refs: sunk.map((o) => o.ref) } });
      } catch {
        // no geometry to test against
      }
    }

    // Navmesh: missing, out of date or broken.
    for (const cell of cellsTouched) {
      const info = world.cells().find((c) => c.formKey === cell);
      const navs = existingNavmeshes(this.ws, cell);
      if (!navs.length) {
        if (info?.interior && parseFormKey(cell).plugin === a.name) add({ severity: 'warning', category: 'navmesh', message: `${label(cell)} has no navmesh`, detail: 'NPCs and followers can\'t walk around in it.', cell, fix: { kind: 'generateNavmesh', cell } });
        continue;
      }
      const status = await this.env.navmeshStatus(cell);
      if (status === 'stale') add({ severity: 'warning', category: 'navmesh', message: `The navmesh in ${label(cell)} is older than the objects in it`, detail: 'NPCs may walk through new objects or not reach new areas.', cell, fix: { kind: 'generateNavmesh', cell } });
      for (const n of navs) {
        if (parseFormKey(n).plugin !== a.name && !a.mapper?.toLocal(n)) continue;
        const nav = (this.ws.view(n)?.data as { geometry?: Navmesh } | undefined)?.geometry;
        const errs = nav ? validateNavmesh(nav).filter((i) => i.severity === 'error') : [];
        if (errs.length) add({ severity: 'error', category: 'navmesh', message: `The navmesh in ${label(cell)} has ${errs.length} broken triangle(s)`, detail: errs[0]!.message, cell, fix: { kind: 'generateNavmesh', cell } });
      }
    }

    // Plugin-wide.
    const bounds = await boundsMismatches(this.ws);
    if (bounds.length) add({ severity: 'warning', category: 'plugin', message: `${bounds.length} object(s) have bounds that don't match their mesh`, detail: 'Wrong bounds make objects pop in and out of view, and confuse navmesh and placement.', form: bounds[0]!.key, fix: { kind: 'updateBounds' } });
    const clean = this.ws.clean(a.name, { dryRun: true });
    if (clean.itmsRemoved.length) add({ severity: 'info', category: 'plugin', message: `${clean.itmsRemoved.length} record(s) are identical to their master`, detail: 'These “dirty edits” are removed when you save (if that option is on under Automations) or with the Clean tab.' });
    const esl = eslReport(this.ws);
    if (esl.eligible) add({ severity: 'info', category: 'plugin', message: 'This plugin could be a light plugin (ESL)', detail: 'Light plugins don\'t use one of the 254 regular plugin slots. See the Light plugin card.' });
    if (this.ws.isDirty) add({ severity: 'info', category: 'plugin', message: 'You have unsaved changes', detail: 'The check looks at your current edits; save before packaging.' });

    const order: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };
    findings.sort((x, y) => order[x.severity] - order[y.severity]);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;
    return { plugin: a.name, findings, counts };
  }

  // ---------------------------------------------------------------- conflicts

  /** Records your plugin changes that other plugins also change. */
  conflicts(): ConflictEntry[] {
    const a = this.ws.active;
    if (!a?.plugin) return [];
    const out: ConflictEntry[] = [];
    for (const { record, key } of this.own()) {
      if (record.sig === 'NAVM' || record.sig === 'LAND') continue;
      const versions = this.ws.versions(key);
      // Unchanged copies (e.g. a cell copied only to hold your objects) change nothing, so they can't conflict.
      const original = versions[0]?.record;
      if (original && versions.length > 1 && sameContent(record, original)) continue;
      const plugins = versions.map((v) => v.slot.name);
      const owner = parseFormKey(key).plugin;
      const mineIdx = plugins.indexOf(a.name);
      const others = plugins.filter((p) => p !== a.name && p.toLowerCase() !== owner.toLowerCase());
      if (!others.length) continue;
      const winner = plugins[plugins.length - 1]!;
      out.push({
        formKey: key,
        editorId: record.editorId,
        sig: record.sig,
        typeName: recordTypeName(record.sig),
        plugins,
        winner,
        mineWins: winner === a.name,
        overriddenBy: plugins.slice(mineIdx + 1),
        replaces: plugins.slice(0, mineIdx).filter((p) => p.toLowerCase() !== owner.toLowerCase()),
      });
    }
    return out.sort((x, y) => Number(x.mineWins) - Number(y.mineWins) || (x.editorId ?? '').localeCompare(y.editorId ?? ''));
  }

  // ---------------------------------------------------------------- packaging

  /** Every file your plugin needs, and whether it's yours to ship (loose) or comes from somewhere else. */
  async packageFiles(opts: { scriptSources?: boolean } = {}): Promise<PackageFile[]> {
    const a = this.ws.active;
    if (!a?.plugin) return [];
    const wanted = new Map<string, string>();
    const want = (p: string, reason: string) => {
      const n = normalizePath(p);
      if (!wanted.has(n)) wanted.set(n, reason);
    };
    const own = this.own();
    const nifQueue: string[] = [];
    for (const { record, key } of own) {
      const who = this.ws.summary(key)?.editorId ?? key;
      for (const sub of record.subrecords) {
        const raw = MESH_SUBS.includes(sub.sig) || TEXTURE_SUBS.includes(sub.sig) ? zstring(sub.data) : '';
        if (!raw || !/\.(nif|dds|png|tga)$/i.test(raw)) continue;
        const p = withPrefix(MESH_SUBS.includes(sub.sig) ? 'meshes' : 'textures', raw);
        want(p, `used by ${who}`);
        if (p.endsWith('.nif')) nifQueue.push(p);
      }
      if (record.has('VMAD')) {
        const vm = this.scripts.scriptsOf(key);
        const names = [...vm.scripts.map((s) => s.name), (vm as { fragments?: { fileName?: string } }).fragments?.fileName].filter((n): n is string => !!n);
        for (const n of names) {
          want(`scripts\\${n}.pex`, `script on ${who}`);
          if (opts.scriptSources) want(`${this.scripts.sourceFolder}\\${n}.psc`, `source of ${n}`);
        }
      }
      if (record.sig === 'NPC_') {
        const fg = this.npcs.faceGenPaths(key);
        if (this.ws.vfs.has(fg.mesh) || parseFormKey(key).plugin === a.name) {
          want(fg.mesh, `face of ${who}`);
          want(fg.tint, `face of ${who}`);
        }
      }
    }
    // Textures used inside your own meshes.
    for (const p of nifQueue) {
      const e = this.ws.vfs.entry(p);
      if (e?.source.kind !== 'loose') continue;
      try {
        for (const m of flattenMeshes(parseNif(await this.ws.vfs.read(p)))) for (const t of m.mesh.material.textures) if (t) want(withPrefix('textures', t), `texture of ${p}`);
      } catch {
        // reported by the pre-release check
      }
    }
    // Voice, SEQ and strings files named after the plugin.
    const base = a.name.replace(/\.[^.]+$/, '');
    for (const e of this.ws.vfs.list(`sound\\voice\\${a.name.toLowerCase()}`)) want(e.path, 'dialogue voice');
    if (this.ws.vfs.has(`seq\\${base}.seq`)) want(`seq\\${base}.seq`, 'start-up quest dialogue (SEQ)');
    for (const e of this.ws.vfs.list('strings')) if (basename(e.path).toLowerCase().startsWith(`${base.toLowerCase()}_`)) want(e.path, 'translated text (strings)');

    const out: PackageFile[] = [];
    for (const [path, reason] of wanted) {
      const e = this.ws.vfs.entry(path);
      if (!e) {
        out.push({ path, reason, status: 'missing' });
        continue;
      }
      if (e.source.kind === 'archive') {
        out.push({ path, reason, status: 'in-archive' });
        continue;
      }
      let size: number | undefined;
      try {
        size = (await this.ws.vfs.read(path)).byteLength;
      } catch {
        size = undefined;
      }
      out.push({ path, reason, status: 'included', size, root: e.source.root });
    }
    return out.sort((x, y) => x.path.localeCompare(y.path));
  }

  private async packFiles(opts: { scriptSources?: boolean }): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    for (const f of await this.packageFiles(opts)) if (f.status === 'included') files.set(f.path, await this.ws.vfs.read(f.path));
    return files;
  }

  private archiveName(): string {
    return `${this.ws.active!.name.replace(/\.[^.]+$/, '')}.bsa`;
  }

  /** Pack your plugin's loose files into "<Plugin>.bsa" next to it (the game loads it automatically). */
  async buildBsa(opts: { scriptSources?: boolean } = {}): Promise<{ path: string; files: number; bytes: number }> {
    const a = this.ws.active;
    if (!a?.plugin) throw new Error('No plugin is being edited');
    const files = await this.packFiles({ scriptSources: false, ...opts });
    if (!files.size) throw new Error('Your plugin has no loose files of its own to pack');
    const data = writeBsa(files, { version: this.ws.game === 'SkyrimSE' ? 105 : 104 });
    const path = joinPath(this.ws.options.outputDir, this.archiveName());
    await this.ws.fs.writeFile(path, data);
    return { path, files: files.size, bytes: data.byteLength };
  }

  /** A ready-to-upload ZIP: the plugin plus its files (loose, or packed in a BSA inside the ZIP). */
  async buildZip(opts: { bsa?: boolean; scriptSources?: boolean; returnData?: boolean } = {}): Promise<{ path: string; files: number; bytes: number; data?: Uint8Array }> {
    const a = this.ws.active;
    if (!a?.plugin) throw new Error('No plugin is being edited');
    if (this.ws.isDirty) throw new Error('Save your plugin first, so the ZIP has your latest changes');
    const pluginPath = a.path ?? joinPath(this.ws.options.outputDir, a.name);
    const entries: Record<string, Uint8Array> = { [a.name]: await this.ws.fs.readFile(pluginPath) };
    const files = await this.packFiles(opts);
    if (opts.bsa) {
      const loose = new Map([...files].filter(([p]) => p.endsWith('.psc')));
      const packed = new Map([...files].filter(([p]) => !p.endsWith('.psc')));
      if (packed.size) entries[this.archiveName()] = writeBsa(packed, { version: this.ws.game === 'SkyrimSE' ? 105 : 104 });
      for (const [p, d] of loose) entries[p.replace(/\\/g, '/')] = d;
    } else for (const [p, d] of files) entries[p.replace(/\\/g, '/')] = d;
    const data = zipSync(entries, { level: 6 });
    const dir = joinPath(this.ws.options.outputDir, 'TES5EnvEditor');
    await this.ws.fs.mkdir(dir);
    const path = joinPath(dir, `${a.name.replace(/\.[^.]+$/, '')}.zip`);
    await this.ws.fs.writeFile(path, data);
    return { path, files: Object.keys(entries).length, bytes: data.byteLength, data: opts.returnData ? data : undefined };
  }
}

