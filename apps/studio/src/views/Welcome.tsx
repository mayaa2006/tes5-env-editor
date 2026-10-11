import { useEffect, useState } from 'react';
import { DEMO_GAME_DIR } from '../engine/constants';
import { Checkbox, Help, Icon, TextInput } from '../components/ui';
import { engine, useStore } from '../state/store';

export function Welcome() {
  const session = useStore((s) => s.session);
  const client = useStore((s) => s.client);
  const [mo2Path, setMo2Path] = useState('');
  const [profile, setProfile] = useState('');
  const [gamePath, setGamePath] = useState('');
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);

  /** The folder to save into, if the user chose one: undefined = the usual place, null = they backed out. */
  const saveTo = async (): Promise<string | undefined | null> => {
    if (!settings.saveToFolder) return undefined;
    if (settings.saveFolder.trim()) return settings.saveFolder.trim();
    const picked = await client?.openFolder('Choose or create the folder your mod will be saved into');
    if (!picked) {
      useStore.getState().toast('info', 'Type a folder name under “Where my files are saved”, or untick the box to use the usual place.');
      return null;
    }
    update({ saveFolder: picked });
    return picked;
  };

  const openDemo = async () => {
    const outputDir = await saveTo();
    if (outputDir === null) return;
    await engine(
      (c) =>
        c.call('open', {
          kind: 'demo',
          path: DEMO_GAME_DIR,
          outputDir,
          loadOrder: [
            { name: 'DemoWorld.esm', active: true },
            { name: 'DirtyPatch.esp', active: true },
          ],
        }),
      { busy: 'Opening demo data…' },
    );
  };

  const openFolder = async () => {
    const path = gamePath || (await client?.openFolder('Select your Skyrim folder (the one containing SkyrimSE.exe)'));
    if (!path) return;
    const outputDir = await saveTo();
    if (outputDir === null) return;
    await engine((c) => c.call('open', { kind: 'folder', path, outputDir }), { busy: 'Reading plugins…' });
  };

  const openMo2 = async () => {
    const path = mo2Path || (await client?.openFolder('Select your Mod Organizer 2 instance folder (contains ModOrganizer.ini)'));
    if (!path) return;
    const outputDir = await saveTo();
    if (outputDir === null) return;
    await engine((c) => c.call('open', { kind: 'mo2', path, profile: profile || undefined, outputDir }), { busy: 'Reading MO2 profile…' });
  };

  // Look for the game in the usual places, so most people never have to browse for it.
  const [found, setFound] = useState<{ game: string; gameDir?: string; dataDir: string }[]>([]);
  useEffect(() => {
    if (!client || client.mode === 'demo') return;
    client.call('findInstalls').then(setFound, () => setFound([]));
  }, [client]);
  const openFound = async (path: string) => {
    const outputDir = await saveTo();
    if (outputDir === null) return;
    await engine((c) => c.call('open', { kind: 'folder', path, outputDir }), { busy: 'Reading plugins…' });
  };

  if (session.open) return <LoadOrderPicker />;

  return (
    <div className="welcome">
      <h1>Welcome</h1>
      <div className="lead">
        A cleaner, automation-first editor for Skyrim plugins: build environments, characters, quests and scripts; clean plugins; and let the boring parts happen automatically.
      </div>
      {found.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }} data-testid="found-installs">
          <div className="card-title">Found on this computer</div>
          {found.map((f) => (
            <div key={f.dataDir} className="row" style={{ gap: 10, marginTop: 4 }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div>{f.game === 'SkyrimSE' ? 'Skyrim Special Edition' : 'Skyrim (original)'}</div>
                <div className="dim small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.gameDir ?? f.dataDir}>
                  {f.gameDir ?? f.dataDir}
                </div>
              </div>
              <button className="btn primary" onClick={() => void openFound(f.gameDir ?? f.dataDir)} title="Open this game's Data folder and choose which plugins to load">
                Open
              </button>
            </div>
          ))}
          <div className="dim small" style={{ marginTop: 6 }}>Using Mod Organizer 2? Open your MO2 instance below instead, so your mods are included.</div>
        </div>
      )}
      <div className="card" style={{ marginBottom: 12 }} data-testid="save-folder-card">
        <div className="card-title">Where my files are saved</div>
        <Checkbox
          checked={settings.saveToFolder}
          onChange={(v) => update({ saveToFolder: v })}
          label="Save into a new folder"
          help="Everything this editor writes (your plugin, scripts, SEQ and face files, backups) goes into this one folder, whichever way you open the game. Add the folder to your mod manager as a mod, or copy it into Data. Off: saves go to the Data folder, or to MO2's Overwrite."
        />
        {settings.saveToFolder ? (
          <div className="row" style={{ marginTop: 6, gap: 6 }}>
            <div className="grow">
              <TextInput value={settings.saveFolder} onCommit={(v) => update({ saveFolder: v })} placeholder="Folder to save into, e.g. C:\Modding\MyMod (made if it doesn't exist)" mono />
            </div>
            {client?.canPickFolders && (
              <button className="btn" onClick={async () => { const p = await client.openFolder('Choose or create the folder your mod will be saved into'); if (p) update({ saveFolder: p }); }} title="Pick the folder in a window">
                Browse…
              </button>
            )}
          </div>
        ) : (
          <div className="dim small" style={{ marginTop: 4 }}>Using the usual place: your Skyrim Data folder, or Overwrite when you open Mod Organizer 2.</div>
        )}
      </div>
      <div className="welcome-grid">
        <button className="welcome-card" onClick={openMo2} disabled={client?.mode === 'demo' && !mo2Path}>
          <h3>
            <Icon name="folder" /> Open Mod Organizer 2
          </h3>
          <p>Reads your MO2 instance and profile directly — no need to launch through MO2. Saves go to Overwrite, or to a folder you choose below.</p>
          {client?.mode === 'demo' && <p className="warn small">Not available in the demo.</p>}
        </button>
        <button className="welcome-card" onClick={openFolder} disabled={client?.mode === 'demo' && !gamePath}>
          <h3>
            <Icon name="folder" /> Open Skyrim folder
          </h3>
          <p>Use a vanilla Data folder (Steam/GOG install) or any folder containing SkyrimSE.exe / TESV.exe.</p>
          {client?.mode === 'demo' && <p className="warn small">Not available in the demo.</p>}
        </button>
        <button className="welcome-card" onClick={openDemo}>
          <h3>
            <Icon name="play" /> Explore the demo
          </h3>
          <p>A small synthetic world (a tavern, a valley, NPCs, a quest and a dirty plugin) to try every tool. Nothing touches your game.</p>
        </button>
      </div>
      {client?.mode === 'electron' && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">Paths (optional)</div>
          <div className="row">
            <div className="grow">
              <TextInput value={mo2Path} onCommit={setMo2Path} placeholder="MO2 instance folder" />
            </div>
            <div style={{ width: 160 }}>
              <TextInput value={profile} onCommit={setProfile} placeholder="Profile (default: selected)" />
            </div>
          </div>
          <div style={{ marginTop: 6 }}>
            <TextInput value={gamePath} onCommit={setGamePath} placeholder="Skyrim folder" />
          </div>
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">What's automated</div>
        <ul className="dim" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Masters, overrides of parent cells/topics, alias IDs, response ordering and topic counts</li>
          <li>Identical-to-master cleanup on every save; deleted references become disabled ones</li>
          <li>Object bounds from meshes, SEQ files, quest/dialogue fragment scripts and their bindings</li>
          <li>Script property auto-fill, voice file lists, ESL checks, one-click navmeshes with door and cell links</li>
        </ul>
      </div>
    </div>
  );
}

function LoadOrderPicker() {
  const session = useStore((s) => s.session);
  const [active, setActive] = useState<Set<string>>(() => new Set(session.loadOrder.filter((p) => p.active).map((p) => p.name)));
  const toggle = (name: string, on: boolean) => {
    const next = new Set(active);
    if (on) {
      next.add(name);
      for (const m of session.loadOrder.find((p) => p.name === name)?.masters ?? []) next.add(m);
    } else {
      // Plugins that need this one as a master can't load without it.
      const drop = [name];
      while (drop.length) {
        const n = drop.pop()!;
        next.delete(n);
        for (const p of session.loadOrder) if (next.has(p.name) && p.masters.some((m) => m.toLowerCase() === n.toLowerCase())) drop.push(p.name);
      }
    }
    setActive(next);
  };
  const [filter, setFilter] = useState('');
  const shown = session.loadOrder.filter((p) => !filter.trim() || p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const editable = session.loadOrder.filter((p) => !p.isMaster && active.has(p.name));
  const [edit, setEdit] = useState<string>('__new__');
  const [newName, setNewName] = useState('MyMod.esp');
  const load = () =>
    engine(
      async (c) => {
        await c.call('loadPlugins', [...active]);
        if (edit === '__new__') return c.call('createPlugin', newName, {});
        if (edit) return c.call('setActivePlugin', edit);
      },
      { busy: 'Loading plugins… (large masters take a few seconds)' },
    );
  return (
    <div className="welcome">
      <h1>Choose plugins to load</h1>
      <div className="lead">{session.source}</div>
      {session.outputDir && (
        <div className="dim small" style={{ marginTop: -8, marginBottom: 8 }} data-testid="save-location" title={session.outputDir}>
          Your files will be saved to: <span className="mono">{session.outputDir}</span>
        </div>
      )}
      <p className="dim" style={{ marginTop: 0 }}>
        Tick the plugins you want to see and work with. Their masters are ticked for you. Fewer plugins load faster; the official masters are always enough to get started.
      </p>
      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        <input className="input" style={{ width: 220 }} placeholder="Find plugin…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find plugin" data-testid="plugin-filter" />
        <button className="btn small" onClick={() => setActive(new Set(session.loadOrder.map((p) => p.name)))} title="Tick every plugin in the load order">
          All
        </button>
        <button className="btn small" onClick={() => setActive(new Set(session.loadOrder.filter((p) => p.isMaster).map((p) => p.name)))} title="Tick only master files (.esm), such as the game and its DLC">
          Only masters
        </button>
        <button className="btn small" onClick={() => setActive(new Set())} title="Untick everything">
          None
        </button>
      </div>
      <div className="card" style={{ maxHeight: '50vh', overflow: 'auto', padding: 0 }}>
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 30 }} />
              <th>Plugin</th>
              <th>Flags</th>
              <th>Masters</th>
            </tr>
          </thead>
          <tbody>
            {!shown.length && (
              <tr>
                <td colSpan={4} className="dim">
                  No plugin matches "{filter}".
                </td>
              </tr>
            )}
            {shown.map((p) => (
              <tr key={p.name}>
                <td>
                  <Checkbox checked={active.has(p.name)} onChange={(v) => toggle(p.name, v)} label="" />
                </td>
                <td>
                  {p.name}
                  {p.error && (
                    <div className="small warn" title={p.error}>
                      {p.error}
                    </div>
                  )}
                </td>
                <td>
                  <div className="chips">
                    {p.isMaster && <span className="chip">ESM</span>}
                    {p.isLight && <span className="chip">ESL</span>}
                    {p.isLocalized && <span className="chip">Localized</span>}
                  </div>
                </td>
                <td className="dim small">{p.masters.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <span className="dim">{active.size} selected</span>
        <span className="spacer grow" />
        <span className="dim">Save my changes to</span>
        <Help text="Your edits go into one plugin. A new plugin keeps your work separate from everything else (best for a new mod). You can also keep editing a plugin you made before, or choose later on the Plugins tab." />
        <select className="input" style={{ width: 200 }} value={edit} onChange={(e) => setEdit(e.target.value)} data-testid="edit-target">
          <option value="__new__">a new plugin…</option>
          {editable.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
          <option value="">decide later</option>
        </select>
        {edit === '__new__' && (
          <div style={{ width: 170 }}>
            <TextInput value={newName} onCommit={setNewName} mono />
          </div>
        )}
        <button className="btn primary" onClick={load} data-testid="load-plugins">
          Load
        </button>
      </div>
    </div>
  );
}
