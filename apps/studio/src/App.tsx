import { lazy, Suspense, useEffect, useState } from 'react';
import { Icon, Modal, TextInput, Toasts, Checkbox, Field, useHotkeys } from './components/ui';
import { engine, useStore, type WorkspaceTab } from './state/store';
import { Welcome } from './views/Welcome';
import { PluginsView } from './views/PluginsView';
import { Inspector } from './views/record/Inspector';
import { ObjectBrowser } from './views/ObjectBrowser';
import { BottomLog } from './views/BottomLog';
import { AppMenu } from './views/AppMenu';
import { TestLaunchDialog } from './views/TestLaunch';

const SceneView = lazy(() => import('./views/scene/SceneView'));
const NpcCreator = lazy(() => import('./views/npc/NpcCreator'));
const BodyView = lazy(() => import('./views/body/BodyView'));
const QuestDesigner = lazy(() => import('./views/quest/QuestDesigner'));
const ScriptEditor = lazy(() => import('./views/script/ScriptEditor'));
const RecordsView = lazy(() => import('./views/record/RecordsView'));
const CatalogView = lazy(() => import('./views/catalog/CatalogView'));
const CleanerView = lazy(() => import('./views/CleanerView'));
const AutomationsView = lazy(() => import('./views/AutomationsView'));
const ReleaseView = lazy(() => import('./views/ReleaseView'));
const ScriptList = lazy(() => import('./views/script/ScriptList'));

const TABS: { id: WorkspaceTab; label: string; icon: string; key?: string; hint: string }[] = [
  { id: 'scene', label: 'World', icon: 'scene', key: '1', hint: 'Cells, placing objects, navmesh and world tools' },
  { id: 'npc', label: 'Characters', icon: 'npc', key: '2', hint: 'Characters: look, face, outfit, inventory and routine' },
  { id: 'body', label: 'Body', icon: 'body', hint: 'Shape bodies with BodySlide sliders and presets, and build the meshes' },
  { id: 'items', label: 'Items', icon: 'items', key: '3', hint: 'Weapons, armor, potions, books, loot lists and crafting recipes' },
  { id: 'magic', label: 'Magic', icon: 'magic', key: '4', hint: 'Spells, powers, abilities, enchantments, shouts and perks' },
  { id: 'quest', label: 'Quests', icon: 'quest', key: '5', hint: 'Quest map, dialogue and quests from writing' },
  { id: 'script', label: 'Scripts', icon: 'script', key: '6', hint: 'Papyrus scripts' },
  { id: 'records', label: 'Records', icon: 'records', key: '7', hint: 'Every record of every type, and how plugins conflict' },
  { id: 'clean', label: 'Clean', icon: 'clean', key: '8', hint: 'Clean dirty edits from a plugin' },
  { id: 'automations', label: 'Automations', icon: 'auto', key: '9', hint: 'What happens automatically on save' },
  { id: 'plugins', label: 'Plugins', icon: 'plugins', key: '0', hint: 'Load order and the plugin you edit' },
  { id: 'release', label: 'Release', icon: 'flag', hint: 'Check and pack your mod for sharing' },
];

export function App() {
  const session = useStore((s) => s.session);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const busy = useStore((s) => s.busy);
  const client = useStore((s) => s.client);
  const [savePrompt, setSavePrompt] = useState(false);
  const pluginPrompt = useStore((s) => s.pluginPrompt);
  const loaded = session.open && session.loadOrder.some((p) => p.loaded);
  const inspectorOpen = useStore((s) => s.settings.inspector[s.tab] ?? !CLOSED_BY_DEFAULT.has(s.tab));

  useEffect(() => {
    if (!client) return;
    return client.onEvent((e) => {
      const s = useStore.getState();
      if (e.type === 'changed' || e.type === 'saved' || e.type === 'activeChanged' || e.type === 'loaded') s.bump();
      if (e.type === 'warning') s.toast('warning', e.message);
      if (e.type === 'engineRestarted') {
        s.setSession({ open: false, dirty: false, canUndo: false, canRedo: false, loadOrder: [] });
        s.toast('error', `The editing engine crashed and was restarted (${e.message}). Changes since your last save were lost; please reopen your game folder.`);
      }
      if (e.type === 'changed') s.addLog('info', e.label);
    });
  }, [client]);

  const compilerKind = useStore((s) => s.settings.compilerKind);
  const compilerPath = useStore((s) => s.settings.compilerPath);
  useEffect(() => {
    if (client && loaded) void client.call('setCompiler', compilerPath ? { kind: compilerKind, executable: compilerPath } : null).catch(() => undefined);
  }, [client, loaded, compilerKind, compilerPath]);

  const save = async () => {
    if (!session.activePlugin) {
      setSavePrompt(true);
      return;
    }
    const st = useStore.getState().settings;
    const r = await engine((c) => c.call('save', { removeItms: st.autoCleanOnSave, updateBounds: st.updateBoundsOnSave, generateSeq: st.generateSeqOnSave, generateFaces: st.generateFacesOnSave, compileScripts: st.autoCompileOnSave }), { busy: 'Saving…' });
    if (r) {
      const parts = [`Saved ${session.activePlugin}`];
      if (r.clean?.itmsRemoved.length) parts.push(`${r.clean.itmsRemoved.length} identical-to-master record(s) cleaned`);
      if (r.boundsChanged.length) parts.push(`${r.boundsChanged.length} object bounds updated`);
      if (r.facesGenerated) parts.push(`${r.facesGenerated} face(s) generated`);
      if (r.scriptsCompiled) parts.push(`${r.scriptsCompiled} script(s) compiled`);
      if (r.extraFiles.length) parts.push(`also wrote ${r.extraFiles.length} file(s)`);
      useStore.getState().toast('success', parts.join(' · '));
      for (const w of r.warnings) useStore.getState().toast('warning', w);
    }
  };

  useHotkeys(
    {
      'ctrl+s': () => void save(),
      'ctrl+z': () => void engine((c) => c.call('undo')),
      'ctrl+shift+z': () => void engine((c) => c.call('redo')),
      'ctrl+y': () => void engine((c) => c.call('redo')),
      ...Object.fromEntries(TABS.filter((t) => t.key).map((t) => [`ctrl+${t.key}`, () => setTab(t.id)])),
    },
    [session.activePlugin],
  );

  if (!loaded) {
    return (
      <div className="app" style={{ gridTemplateRows: '38px 1fr' }}>
        <TopBar onSave={save} onNewPlugin={() => setSavePrompt(true)} />
        <div className="scroll">
          <Welcome />
        </div>
        <Toasts />
      </div>
    );
  }

  // Which side panels each workspace uses (widths shrink on small windows, see styles.css).
  const left = tab === 'scene' ? 'var(--left-wide)' : tab === 'script' ? 'var(--left-narrow)' : '0px';
  const right = hasInspector(tab) && inspectorOpen;
  return (
    <div className="app">
      <TopBar onSave={save} onNewPlugin={() => setSavePrompt(true)} />
      <div className="main" style={{ gridTemplateColumns: `${left} 1fr ${right ? 'var(--right)' : '0px'}` }}>
        <aside className="sidebar" style={left ? undefined : { overflow: 'hidden', borderRight: 'none' }}>
          {tab === 'script' ? <ScriptSidebar /> : tab === 'scene' ? <ObjectBrowser /> : null}
        </aside>
        <main className="center">
          <Suspense fallback={<div className="empty">Loading…</div>}>
            {tab === 'scene' && <SceneView />}
            {tab === 'npc' && <NpcCreator />}
            {tab === 'body' && <BodyView />}
            {tab === 'items' && <CatalogView key="items" tab="items" />}
            {tab === 'magic' && <CatalogView key="magic" tab="magic" />}
            {tab === 'quest' && <QuestDesigner />}
            {tab === 'script' && <ScriptEditor />}
            {tab === 'records' && <RecordsView />}
            {tab === 'clean' && <CleanerView />}
            {tab === 'automations' && <AutomationsView />}
            {tab === 'plugins' && <PluginsView />}
            {tab === 'release' && <ReleaseView />}
          </Suspense>
          {hasInspector(tab) && <BottomLog />}
        </main>
        <aside className="rightbar" style={right ? undefined : { overflow: 'hidden', borderLeft: 'none' }}>
          {right && <Inspector />}
        </aside>
      </div>
      <StatusBar />
      {busy && (
        <div className="modal-backdrop" style={{ background: 'rgba(0,0,0,0.25)' }}>
          <div className="card">{busy}</div>
        </div>
      )}
      {(savePrompt || pluginPrompt) && (
        <NewPluginDialog
          reason={pluginPrompt ? 'Your change needs a plugin to go into.' : undefined}
          onClose={() => {
            setSavePrompt(false);
            useStore.getState().setPluginPrompt(undefined);
          }}
          onCreated={() => void pluginPrompt?.retry?.()}
        />
      )}
      <Toasts />
    </div>
  );
}

/** Workspaces whose properties panel starts closed (they have their own editor; the panel shows linked forms). */
const CLOSED_BY_DEFAULT = new Set<WorkspaceTab>(['npc', 'quest', 'items', 'magic']);

/** Workspaces with a properties panel on the right. */
const hasInspector = (tab: WorkspaceTab) => tab === 'scene' || tab === 'npc' || tab === 'items' || tab === 'magic' || tab === 'quest' || tab === 'records';

function ScriptSidebar() {
  return (
    <Suspense fallback={null}>
      <ScriptList />
    </Suspense>
  );
}

function TopBar({ onSave, onNewPlugin }: { onSave: () => void; onNewPlugin: () => void }) {
  const session = useStore((s) => s.session);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const loaded = session.open && session.loadOrder.some((p) => p.loaded);
  const inspectorOpen = useStore((s) => s.settings.inspector[s.tab] ?? !CLOSED_BY_DEFAULT.has(s.tab));
  return (
    <header className="topbar">
      <AppMenu loaded={loaded} tabs={TABS} onSave={onSave} onNewPlugin={onNewPlugin} inspector={{ available: hasInspector(tab), open: inspectorOpen }} />
      {loaded && (
        <nav className="workspace-tabs" aria-label="Workspaces">
          {TABS.map((t) => (
            <button key={t.id} className={`workspace-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} title={`${t.hint}${t.key ? ` (Ctrl+${t.key})` : ''}`}>
              <Icon name={t.icon} size={14} />
              {t.label}
            </button>
          ))}
        </nav>
      )}
      <div className="spacer" />
      {loaded && (
        <>
          <button className="btn ghost icon" title={session.undoLabel ? `Undo ${session.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} disabled={!session.canUndo} onClick={() => engine((c) => c.call('undo'))}>
            <Icon name="undo" />
          </button>
          <button className="btn ghost icon" title={session.redoLabel ? `Redo ${session.redoLabel} (Ctrl+Shift+Z)` : 'Redo'} disabled={!session.canRedo} onClick={() => engine((c) => c.call('redo'))}>
            <Icon name="redo" />
          </button>
          <TestButton />
          {hasInspector(tab) && <PropertiesToggle />}
          <span className={`chip nowrap ${session.activePlugin ? 'accent' : 'warn'}`} title={session.activePlugin ? `Your edits go into ${session.activePlugin}${session.dirty ? ' (unsaved changes)' : ''}. Change it on the Plugins tab.` : 'No plugin selected: your first edit will ask you to create one.'}>
            {session.activePlugin ? `Editing ${session.activePlugin}` : 'No plugin selected'}
            {session.dirty ? ' •' : ''}
          </span>
          <button className="btn primary" onClick={onSave} title="Save (Ctrl+S). Cleans identical-to-master records, updates bounds, writes SEQ files.">
            <Icon name="save" /> Save
          </button>
        </>
      )}
    </header>
  );
}

function PropertiesToggle() {
  const open = useStore((s) => s.settings.inspector[s.tab] ?? !CLOSED_BY_DEFAULT.has(s.tab));
  return (
    <button className={`btn ghost ${open ? 'active' : ''}`} aria-pressed={open} title={open ? 'Hide the properties panel' : 'Show the properties panel (every field of the selected form)'} onClick={() => useStore.getState().setInspector(!open)} data-testid="toggle-properties">
      <Icon name="sliders" /> <span className="hide-narrow">Properties</span>
    </button>
  );
}

function TestButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn ghost" title="Test in game: save, then jump to a place and quest stage" onClick={() => setOpen(true)} data-testid="test-launch">
        <Icon name="play" /> <span className="hide-narrow">Test</span>
      </button>
      {open && <TestLaunchDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function StatusBar() {
  const session = useStore((s) => s.session);
  const mode = useStore((s) => s.client?.mode);
  const log = useStore((s) => s.log);
  const last = log[log.length - 1];
  const loaded = session.loadOrder.filter((p) => p.loaded).length;
  return (
    <footer className="statusbar">
      <span className="pill">{session.game === 'SkyrimLE' ? 'Skyrim LE' : 'Skyrim SE/AE'}</span>
      <span className="ellipsis" title={session.source}>
        {session.source}
      </span>
      <span>{loaded} plugins loaded</span>
      {mode === 'demo' && <span className="chip warn">Demo — changes stay in memory</span>}
      <span className="spacer" />
      {last && <span className={`ellipsis ${last.kind === 'error' ? 'err' : last.kind === 'warning' ? 'warn' : ''}`}>{last.text}</span>}
    </footer>
  );
}

export function NewPluginDialog({ onClose, onCreated, reason }: { onClose: () => void; onCreated?: () => void; reason?: string }) {
  const [name, setName] = useState('MyMod.esp');
  const [author, setAuthor] = useState('');
  const [light, setLight] = useState(false);
  return (
    <Modal
      title="Create a plugin for your changes"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const ok = await engine((c) => c.call('createPlugin', name, { author, light }), { success: `Created ${name}` });
              if (ok) {
                onClose();
                onCreated?.();
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      {reason && (
        <p className="warn" style={{ marginTop: 0 }}>
          {reason}
        </p>
      )}
      <p className="dim" style={{ marginTop: 0 }}>
        All your edits are stored in this plugin. Masters are added automatically as you reference other files.
      </p>
      <Field label="File name">
        <TextInput value={name} onCommit={setName} autoFocus />
      </Field>
      <Field label="Author">
        <TextInput value={author} onCommit={setAuthor} placeholder="optional" />
      </Field>
      <Field label="Light plugin (ESL)">
        <Checkbox checked={light} onChange={setLight} label="Flag as ESL (max 2048 new records, doesn't use a load order slot)" />
      </Field>
    </Modal>
  );
}
