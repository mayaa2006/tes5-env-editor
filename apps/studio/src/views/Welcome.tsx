import { useState } from 'react';
import { DEMO_GAME_DIR } from '../engine/constants';
import { Checkbox, Icon, TextInput } from '../components/ui';
import { engine, useStore } from '../state/store';

export function Welcome() {
  const session = useStore((s) => s.session);
  const client = useStore((s) => s.client);
  const [mo2Path, setMo2Path] = useState('');
  const [profile, setProfile] = useState('');
  const [gamePath, setGamePath] = useState('');

  const openDemo = () =>
    engine(
      (c) =>
        c.call('open', {
          kind: 'demo',
          path: DEMO_GAME_DIR,
          loadOrder: [
            { name: 'DemoWorld.esm', active: true },
            { name: 'DirtyPatch.esp', active: true },
          ],
        }),
      { busy: 'Opening demo data…' },
    );

  const openFolder = async () => {
    const path = gamePath || (await client?.openFolder('Select your Skyrim folder (the one containing SkyrimSE.exe)'));
    if (!path) return;
    await engine((c) => c.call('open', { kind: 'folder', path }), { busy: 'Reading plugins…' });
  };

  const openMo2 = async () => {
    const path = mo2Path || (await client?.openFolder('Select your Mod Organizer 2 instance folder (contains ModOrganizer.ini)'));
    if (!path) return;
    await engine((c) => c.call('open', { kind: 'mo2', path, profile: profile || undefined }), { busy: 'Reading MO2 profile…' });
  };

  if (session.open) return <LoadOrderPicker />;

  return (
    <div className="welcome">
      <h1>Welcome</h1>
      <div className="lead">
        A cleaner, automation-first editor for Skyrim plugins: build environments, characters, quests and scripts; clean plugins; and let the boring parts happen automatically.
      </div>
      <div className="welcome-grid">
        <button className="welcome-card" onClick={openMo2} disabled={client?.mode === 'demo' && !mo2Path}>
          <h3>
            <Icon name="folder" /> Open Mod Organizer 2
          </h3>
          <p>Reads your MO2 instance and profile directly — no need to launch through MO2. Saves go to Overwrite.</p>
          {client?.mode === 'demo' && <p className="warn small">Needs the desktop app.</p>}
        </button>
        <button className="welcome-card" onClick={openFolder} disabled={client?.mode === 'demo' && !gamePath}>
          <h3>
            <Icon name="folder" /> Open Skyrim folder
          </h3>
          <p>Use a vanilla Data folder (Steam/GOG install) or any folder containing SkyrimSE.exe / TESV.exe.</p>
          {client?.mode === 'demo' && <p className="warn small">Needs the desktop app.</p>}
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
    } else next.delete(name);
    setActive(next);
  };
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
      <div className="card" style={{ maxHeight: '55vh', overflow: 'auto', padding: 0 }}>
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
            {session.loadOrder.map((p) => (
              <tr key={p.name}>
                <td>
                  <Checkbox checked={active.has(p.name)} onChange={(v) => toggle(p.name, v)} label="" />
                </td>
                <td>{p.name}</td>
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
