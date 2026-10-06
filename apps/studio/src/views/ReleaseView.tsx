/**
 * Release: everything to do before sharing a plugin. A pre-release check that
 * finds what would break in game (with one-click fixes), the FaceGen and
 * light-plugin checks, a conflict report, and packing into a BSA or a ZIP.
 */
import { useState } from 'react';
import type { ConflictEntry, Finding, FindingSeverity, PackageFile, ReleaseReport } from '@tes5/workspace';
import { Checkbox, Help, Icon, useQuery } from '../components/ui';
import { engine, useStore } from '../state/store';

const SEVERITY: Record<FindingSeverity, { label: string; plural: string; chip: string }> = {
  error: { label: 'problem', plural: 'problems', chip: 'err' },
  warning: { label: 'warning', plural: 'warnings', chip: 'warn' },
  info: { label: 'note', plural: 'notes', chip: '' },
};
const CATEGORY: Record<Finding['category'], string> = {
  assets: 'Meshes and textures',
  scripts: 'Scripts',
  quests: 'Quests',
  dialogue: 'Dialogue',
  world: 'World',
  navmesh: 'Navmesh',
  characters: 'Characters',
  plugin: 'Plugin',
};
const FIX_LABEL: Record<NonNullable<Finding['fix']>['kind'], string> = {
  autofill: 'Fill properties',
  updateBounds: 'Recalculate bounds',
  generateNavmesh: 'Generate navmesh',
  dropToSurface: 'Drop onto surface',
};

/** Take the user to the thing a finding is about. */
async function openFinding(f: Finding) {
  const s = useStore.getState();
  const client = s.client;
  if (f.cell) {
    s.setCell(f.cell);
    s.setTab('scene');
    const sum = f.form ? (await client?.call('summaries', [f.form]))?.[f.form] : undefined;
    if (f.form && sum && ['REFR', 'ACHR'].includes(sum.sig)) s.setSceneSelection([f.form]);
    return;
  }
  if (!f.form) return;
  const sum = (await client?.call('summaries', [f.form]))?.[f.form];
  if (sum?.sig === 'QUST') {
    s.setQuest(f.form);
    s.setTab('quest');
  } else if (sum?.sig === 'NPC_') {
    s.setNpc(f.form);
    s.setTab('npc');
  } else {
    s.setTab('records');
    s.showProperties(f.form);
  }
}

export default function ReleaseView() {
  const session = useStore((s) => s.session);
  if (!session.activePlugin)
    return (
      <div className="empty" style={{ flex: 1 }}>
        Pick the plugin you're editing (Plugins tab) to check and pack it.
      </div>
    );
  return (
    <div className="scroll pad" style={{ flex: 1 }} data-testid="release">
      <h2 style={{ margin: '0 0 2px' }}>Release {session.activePlugin}</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Check your plugin for things that break in game, then pack it to share. Work top to bottom: fix the problems, look over the warnings, then pack.
      </p>
      <Check />
      <div className="card-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12, marginTop: 12 }}>
        <FaceGen />
        <Esl />
      </div>
      <Conflicts />
      <Package />
    </div>
  );
}

// ------------------------------------------------------------------ pre-release check

function Check() {
  const client = useStore((s) => s.client);
  const [report, setReport] = useState<ReleaseReport | null>(null);
  const [running, setRunning] = useState(false);
  const [show, setShow] = useState<Record<FindingSeverity, boolean>>({ error: true, warning: true, info: true });
  const run = async () => {
    setRunning(true);
    const r = await engine((c) => c.call('releaseCheck'), { refreshSession: false });
    setRunning(false);
    if (r) setReport(r);
  };
  // Run once when the tab opens.
  useQuery(
    async () => {
      if (!report && client) await run();
      return true;
    },
    [client],
    { revision: false },
  );
  const fix = async (f: Finding) => {
    if (!f.fix) return;
    const n = await engine((c) => c.call('releaseFix', f.fix!), { busy: `${FIX_LABEL[f.fix.kind]}…` });
    if (n !== undefined) {
      useStore.getState().toast('success', `${FIX_LABEL[f.fix.kind]}: done`);
      await run();
    }
  };
  const groups = new Map<string, Finding[]>();
  for (const f of report?.findings ?? []) {
    if (!show[f.severity]) continue;
    const g = CATEGORY[f.category];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  return (
    <div className="card" data-testid="release-check">
      <div className="card-title">
        Pre-release check
        <Help text="Looks through everything your plugin adds or changes for things that break in game: missing meshes and textures, scripts that aren't compiled or have empty properties, quests that can't start, doors that only go one way, items floating in the air, out-of-date navmeshes, faces without FaceGen, and more. Click a result to go to it; many have a one-click fix." />
        <span className="spacer" />
        {report && (
          <span className="row" style={{ gap: 4 }}>
            {(['error', 'warning', 'info'] as const).map((sv) => (
              <button
                key={sv}
                className={`chip ${SEVERITY[sv].chip} ${show[sv] ? '' : 'dim'}`}
                style={{ border: 'none', cursor: 'pointer' }}
                title={show[sv] ? `Hide ${SEVERITY[sv].plural}` : `Show ${SEVERITY[sv].plural}`}
                onClick={() => setShow({ ...show, [sv]: !show[sv] })}
                data-testid={`count-${sv}`}
              >
                {report.counts[sv]} {report.counts[sv] === 1 ? SEVERITY[sv].label : SEVERITY[sv].plural}
              </button>
            ))}
          </span>
        )}
        <button className="btn small primary" onClick={run} disabled={running} data-testid="run-check">
          <Icon name="check" size={12} /> {running ? 'Checking…' : report ? 'Check again' : 'Check now'}
        </button>
      </div>
      {!report && <div className="dim small">{running ? 'Checking your plugin…' : 'Not checked yet.'}</div>}
      {report && !report.findings.length && (
        <div className="ok small">
          <Icon name="check" size={12} /> Nothing found. Your plugin looks ready to pack.
        </div>
      )}
      {[...groups].map(([g, list]) => (
        <div key={g} style={{ marginTop: 8 }}>
          <div className="release-group">{g}</div>
          <ul className="list release-list">
            {list.map((f, i) => (
              <li key={i} className={`release-item ${f.severity}`}>
                <span className={`chip ${SEVERITY[f.severity].chip}`} style={{ flex: 'none' }}>
                  {SEVERITY[f.severity].label}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div>{f.message}</div>
                  {f.detail && <div className="dim small">{f.detail}</div>}
                </div>
                {(f.form || f.cell) && (
                  <button className="btn small ghost" onClick={() => void openFinding(f)} title="Go to it">
                    Show
                  </button>
                )}
                {f.fix && (
                  <button className="btn small" onClick={() => void fix(f)} data-testid="fix">
                    <Icon name="wand" size={12} /> {FIX_LABEL[f.fix.kind]}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ faces and light plugins

function Esl() {
  const client = useStore((s) => s.client);
  const { data: r } = useQuery(() => client?.call('eslReport'), [client]);
  const [mapping, setMapping] = useState<[string, string][] | null>(null);
  if (!r) return <div className="card">Checking ESL eligibility…</div>;
  return (
    <div className="card" data-testid="esl-card">
      <div className="card-title">
        Light plugin (ESL)
        <Help text="Light plugins (ESL) don't use up one of the 254 regular plugin slots, so players can run more mods. A plugin can be light if it adds at most 2048 new records with FormIDs in the range 0x800–0xFFF." />
        {r.eligible ? <span className="chip ok">can be flagged ESL</span> : r.eligibleAfterCompaction ? <span className="chip warn">needs compaction</span> : <span className="chip err">too many records</span>}
      </div>
      <div className="dim small">
        {r.newRecords} new record(s) · highest ID {r.maxObjectId.toString(16).toUpperCase()} · {r.outOfRange} outside the ESL range
      </div>
      {r.notes.map((n) => (
        <div key={n} className="small warn">
          {n}
        </div>
      ))}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button
          className="btn small"
          disabled={!r.eligibleAfterCompaction || r.eligible}
          title="Renumber this plugin's new records into the ESL range. Only do this before anything else depends on your FormIDs."
          onClick={async () => {
            const m = await engine((c) => c.call('compactFormIds'), { success: 'FormIDs compacted' });
            if (m) setMapping(m);
          }}
        >
          Compact FormIDs
        </button>
      </div>
      {mapping && (
        <div className="small dim" style={{ marginTop: 6, maxHeight: 120, overflow: 'auto' }}>
          {mapping.length} record(s) renumbered{mapping.length ? `, e.g. ${mapping[0]![0]} → ${mapping[0]![1]}` : ''}. References inside this plugin were updated.
        </div>
      )}
    </div>
  );
}

function FaceGen() {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('faceGenProblems'), [client]);
  return (
    <div className="card">
      <div className="card-title">
        Character faces
        <Help text="When you change a character's face, the game needs matching FaceGen files (a head mesh and a face tint). Without them the face shows dark or wrong in game — the 'dark face bug'." />
        {data && (data.length ? <span className="chip warn">{data.length} need FaceGen</span> : <span className="chip ok">OK</span>)}
      </div>
      {data?.length ? (
        <>
          <div className="dim small" style={{ marginBottom: 6 }}>
            These characters' faces changed but have no FaceGen files, so they'd show the dark-face bug. FaceGen export isn't built in yet — export them from the Creation Kit (select, Ctrl+F4).
          </div>
          <ul className="list">
            {data.map((p) => (
              <li key={p.npc} className="list-item" onClick={() => (useStore.getState().setNpc(p.npc), useStore.getState().setTab('npc'))}>
                <span className="name">{p.editorId ?? p.npc}</span>
                <span className="meta">{p.missing.length} file(s)</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="dim small">No edited faces are missing their FaceGen files.</div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ conflicts

function Conflicts() {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('conflictReport'), [client]);
  const open = (c: ConflictEntry) => {
    const s = useStore.getState();
    s.setTab('records');
    s.showProperties(c.formKey);
  };
  const lost = data?.filter((c) => !c.mineWins) ?? [];
  return (
    <div className="card" style={{ marginTop: 12 }} data-testid="conflicts">
      <div className="card-title">
        Conflicts with other mods
        <Help text="Records your plugin changes that other plugins in your load order also change. Only one version of a record is used in game: the one from the plugin that loads last. If another mod loads after yours, your change is lost for players with that mod, unless they load yours later or someone makes a patch." />
        {data && (lost.length ? <span className="chip warn">{lost.length} of yours replaced</span> : data.length ? <span className="chip">{data.length} shared</span> : <span className="chip ok">none</span>)}
      </div>
      {!data ? (
        <div className="dim small">Looking…</div>
      ) : !data.length ? (
        <div className="dim small">No other plugin in your load order changes the same records as yours.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Record</th>
              <th>Changed by (load order)</th>
              <th>Used in game</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.formKey} onClick={() => open(c)} style={{ cursor: 'pointer' }} title="Compare the versions">
                <td>
                  {c.editorId ?? c.formKey} <span className="faint small">{c.typeName}</span>
                </td>
                <td className="small">{c.plugins.join(' → ')}</td>
                <td>{c.mineWins ? <span className="chip ok">yours</span> : <span className="chip warn">{c.winner}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ packaging

const kb = (n?: number) => (n === undefined ? '' : n === 0 ? '0 KB' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function Package() {
  const client = useStore((s) => s.client);
  const session = useStore((s) => s.session);
  const [sources, setSources] = useState(true);
  const [zipBsa, setZipBsa] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const { data: files } = useQuery(() => client?.call('packageFiles', { scriptSources: sources }), [client, sources]);
  const included = files?.filter((f) => f.status === 'included') ?? [];
  const missing = files?.filter((f) => f.status === 'missing') ?? [];
  const download = (data: Uint8Array, name: string) => {
    const url = URL.createObjectURL(new Blob([data.slice().buffer as ArrayBuffer], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const packBsa = async () => {
    const r = await engine((c) => c.call('packBsa', { scriptSources: false }), { busy: 'Packing BSA…' });
    if (r) setResult(`Packed ${r.files} file(s) into ${r.path} (${kb(r.bytes)}). The game loads it automatically with your plugin. Delete or move the loose copies when you share it, so they don't override the archive.`);
  };
  const packZip = async () => {
    const demo = client?.mode === 'demo';
    const r = await engine(
      async (c) => {
        if (session.dirty) {
          const st = useStore.getState().settings;
          await c.call('save', { removeItms: st.autoCleanOnSave, updateBounds: st.updateBoundsOnSave, generateSeq: st.generateSeqOnSave });
        }
        return c.call('packZip', { bsa: zipBsa, scriptSources: sources, returnData: demo });
      },
      { busy: 'Saving and packing ZIP…' },
    );
    if (!r) return;
    setResult(`Made ${r.path} (${r.files} file(s), ${kb(r.bytes)}): ready to upload. It unpacks into Data, so mod managers install it as is.`);
    if (r.data) download(r.data, r.path.split(/[\\/]/).pop()!);
  };
  return (
    <div className="card" style={{ marginTop: 12 }} data-testid="package">
      <div className="card-title">
        Pack your mod
        <Help text="Collects every file your plugin needs that you made yourself: meshes and their textures, compiled scripts (and their sources if you like), FaceGen for your characters, voice files, the SEQ file and translations. Files from the base game or other mods' archives are left out." />
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary" onClick={packBsa} disabled={!included.length} data-testid="pack-bsa" title="Write your plugin's loose files into a .bsa archive next to it">
          <Icon name="cube" size={13} /> Pack into a BSA
        </button>
        <Help text="A BSA is the game's own archive format. It loads faster than many loose files and keeps your files from being overwritten by accident. It's named after your plugin, so the game loads it automatically." />
        <button className="btn primary" onClick={packZip} data-testid="pack-zip" title="Make a .zip of your plugin and its files, ready to upload">
          <Icon name="folder" size={13} /> Pack as a ZIP
        </button>
        <Help text="A ZIP with your plugin and all its files in the right folders, ready to upload to Nexus or share. Your plugin is saved first." />
      </div>
      <div className="col" style={{ gap: 4, marginTop: 8 }}>
        <Checkbox checked={zipBsa} onChange={setZipBsa} label="In the ZIP, put the files in a BSA" help="Recommended: the ZIP then holds just your plugin and its BSA (plus script sources, which stay loose so others can read them)." />
        <Checkbox checked={sources} onChange={setSources} label="Include script sources (.psc)" help="Lets other modders read and patch your scripts. The game only needs the compiled .pex files." />
      </div>
      {result && (
        <div className="ok small" style={{ marginTop: 8 }} data-testid="pack-result">
          {result}
        </div>
      )}
      {missing.length > 0 && (
        <div className="warn small" style={{ marginTop: 8 }}>
          {missing.length} file(s) your plugin uses don't exist, so they can't be packed: {missing.slice(0, 3).map((f) => f.path).join(', ')}
          {missing.length > 3 ? '…' : ''}
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="small">
          {files ? `${included.length} file(s) will be packed (${kb(included.reduce((s, f) => s + (f.size ?? 0), 0))})` : 'Finding files…'}
        </summary>
        <table className="grid small" style={{ marginTop: 6 }}>
          <tbody>
            {(files ?? []).map((f: PackageFile) => (
              <tr key={f.path}>
                <td className="mono">{f.path}</td>
                <td className="dim">{f.reason}</td>
                <td>{f.status === 'included' ? kb(f.size) : f.status === 'missing' ? <span className="chip err">missing</span> : <span className="chip" title="Comes from an archive (the base game or another mod), so it isn't yours to pack">in an archive</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

