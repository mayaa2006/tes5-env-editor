/**
 * The app menu in the top-left corner: the logo opens one dropdown with Save and
 * Settings first, then file, edit, create, workspace and help actions. Everything
 * here is also reachable elsewhere; this is the one place that lists it all.
 */
import { useState } from 'react';
import { Icon, Menu, MenuItem, Modal } from '../components/ui';
import { engine, useStore, type WorkspaceTab } from '../state/store';
import { OnSave } from '../components/OnSave';
import { TestLaunchDialog } from './TestLaunch';

declare const __APP_VERSION__: string | undefined;
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

export interface MenuTab {
  id: WorkspaceTab;
  label: string;
  key?: string;
  hint: string;
}

/** The app logo: a small mountain peak on the accent gradient. */
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <defs>
        <linearGradient id="logo-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="#8a5cf6" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#logo-grad)" />
      <path d="M4 18l5.5-9 3 4.5L15 10l5 8z" fill="#fff" fillOpacity="0.92" />
    </svg>
  );
}

export function AppMenu({
  loaded,
  tabs,
  onSave,
  onNewPlugin,
  inspector,
}: {
  loaded: boolean;
  tabs: MenuTab[];
  onSave: () => void;
  onNewPlugin: () => void;
  /** Whether this workspace has a properties panel, and whether it is open. */
  inspector: { available: boolean; open: boolean };
}) {
  const session = useStore((s) => s.session);
  const tab = useStore((s) => s.tab);
  const [dialog, setDialog] = useState<'settings' | 'shortcuts' | 'about' | 'test' | 'close' | undefined>();
  const go = (id: WorkspaceTab) => useStore.getState().setTab(id);
  const create = (kind: 'npc' | 'quest' | 'script') => {
    go(kind);
    useStore.getState().requestNew(kind);
  };
  const closeGame = () => {
    useStore.getState().setSession({ open: false, dirty: false, canUndo: false, canRedo: false, loadOrder: [] });
    useStore.getState().setTab('scene');
  };
  const needsGame = loaded ? undefined : 'Open a game folder first';

  return (
    <>
      <Menu
        testId="app-menu"
        title="Menu: save, settings, undo, new things, workspaces and help"
        label={
          <>
            <Logo />
            <span className="brand-name">TES5 Env Editor</span>
          </>
        }
      >
        {(close) => {
          const run = (fn: () => void) => () => {
            close();
            fn();
          };
          return (
            <>
              <MenuItem hint="Ctrl+S" disabled={!loaded} title={needsGame ?? 'Save your plugin, running the clean-up steps chosen in Settings'} onClick={run(onSave)}>
                <Icon name="save" size={13} /> Save
              </MenuItem>
              <MenuItem title="Choose what happens on save, and where scripts are compiled" onClick={run(() => setDialog('settings'))}>
                <Icon name="sliders" size={13} /> Settings…
              </MenuItem>

              <div className="menu-sep" />
              <MenuItem disabled={!loaded} title={needsGame ?? 'Create a new plugin to put your edits in'} onClick={run(onNewPlugin)}>
                New plugin…
              </MenuItem>
              <MenuItem
                disabled={!loaded}
                title={needsGame ?? 'Go back to the start screen to open a different game folder or Mod Organizer profile'}
                onClick={run(() => (session.dirty ? setDialog('close') : closeGame()))}
              >
                Close game folder
              </MenuItem>

              <div className="menu-sep" />
              <MenuItem hint="Ctrl+Z" disabled={!session.canUndo} title={session.undoLabel ? `Undo ${session.undoLabel}` : 'Nothing to undo yet'} onClick={run(() => void engine((c) => c.call('undo')))}>
                <Icon name="undo" size={13} /> Undo{session.undoLabel ? ` ${session.undoLabel}` : ''}
              </MenuItem>
              <MenuItem hint="Ctrl+Shift+Z" disabled={!session.canRedo} title={session.redoLabel ? `Redo ${session.redoLabel}` : 'Nothing to redo'} onClick={run(() => void engine((c) => c.call('redo')))}>
                <Icon name="redo" size={13} /> Redo{session.redoLabel ? ` ${session.redoLabel}` : ''}
              </MenuItem>

              <div className="menu-sep" />
              <div className="menu-label">Create</div>
              <MenuItem disabled={!loaded} title={needsGame ?? 'Go to Characters and start a new character'} onClick={run(() => create('npc'))}>
                New character
              </MenuItem>
              <MenuItem disabled={!loaded} title={needsGame ?? 'Go to Quests and start a new quest'} onClick={run(() => create('quest'))}>
                New quest
              </MenuItem>
              <MenuItem disabled={!loaded} title={needsGame ?? 'Go to Scripts and start a new Papyrus script'} onClick={run(() => create('script'))}>
                New script
              </MenuItem>

              <div className="menu-sep" />
              <MenuItem
                checked={loaded && inspector.available ? inspector.open : undefined}
                disabled={!loaded || !inspector.available}
                title={needsGame ?? (inspector.available ? 'Show or hide the properties panel (every field of the selected form)' : 'This workspace has no properties panel')}
                onClick={run(() => useStore.getState().setInspector(!inspector.open))}
              >
                Properties panel
              </MenuItem>
              <MenuItem disabled={!loaded} title={needsGame ?? 'Save, then jump to a place and quest stage in the game'} onClick={run(() => setDialog('test'))}>
                <Icon name="play" size={13} /> Test in game…
              </MenuItem>

              <div className="menu-sep" />
              <MenuItem title="Every keyboard shortcut in one list" onClick={run(() => setDialog('shortcuts'))}>
                Keyboard shortcuts
              </MenuItem>
              <MenuItem title="Version and project page" onClick={run(() => setDialog('about'))}>
                About
              </MenuItem>
            </>
          );
        }}
      </Menu>

      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(undefined)} onGoTo={(t) => { setDialog(undefined); go(t); }} loaded={loaded} />}
      {dialog === 'shortcuts' && <ShortcutsDialog tabs={tabs} onClose={() => setDialog(undefined)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(undefined)} />}
      {dialog === 'test' && <TestLaunchDialog onClose={() => setDialog(undefined)} />}
      {dialog === 'close' && (
        <Modal
          title="Close without saving?"
          onClose={() => setDialog(undefined)}
          footer={
            <>
              <button className="btn" onClick={() => setDialog(undefined)}>
                Keep editing
              </button>
              <button
                className="btn"
                onClick={() => {
                  setDialog(undefined);
                  closeGame();
                }}
              >
                Close and discard changes
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  setDialog(undefined);
                  await onSave();
                  if (!useStore.getState().session.dirty) closeGame();
                }}
              >
                Save, then close
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>You have changes that aren’t saved to {session.activePlugin ?? 'a plugin'} yet. Closing the game folder throws them away.</p>
        </Modal>
      )}
    </>
  );
}

function SettingsDialog({ onClose, onGoTo, loaded }: { onClose: () => void; onGoTo: (t: WorkspaceTab) => void; loaded: boolean }) {
  return (
    <Modal
      title="Settings"
      onClose={onClose}
      width={560}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="dim" style={{ marginTop: 0 }}>
        Changes apply straight away and are remembered next time. Each option has a ? with the details.
      </p>
      <OnSave />
      <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn" disabled={!loaded} title={loaded ? 'Set up the script compiler on the Scripts tab' : 'Open a game folder first'} onClick={() => onGoTo('script')}>
          Script compiler setup…
        </button>
        <button className="btn" disabled={!loaded} title={loaded ? 'Choose the plugin your edits go into and the load order' : 'Open a game folder first'} onClick={() => onGoTo('plugins')}>
          Plugin and load order…
        </button>
      </div>
    </Modal>
  );
}

const GLOBAL_KEYS: [string, string][] = [
  ['Ctrl+S', 'Save'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z or Ctrl+Y', 'Redo'],
];

function ShortcutsDialog({ tabs, onClose }: { tabs: MenuTab[]; onClose: () => void }) {
  const rows = [...GLOBAL_KEYS, ...tabs.filter((t) => t.key).map((t): [string, string] => [`Ctrl+${t.key}`, `Go to ${t.label}`])];
  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div data-testid="shortcuts-list" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px' }}>
        {rows.map(([k, d]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span className="kbd">{k}</span>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="About"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true">
          <rect width="24" height="24" rx="6" fill="var(--accent)" />
          <path d="M4 18l5.5-9 3 4.5L15 10l5 8z" fill="#fff" fillOpacity="0.92" />
        </svg>
        <div>
          <strong>TES5 Env Editor</strong>
          {VERSION && <div className="dim">Version {VERSION}</div>}
        </div>
      </div>
      <p className="dim">An editor for Skyrim mods: worlds, characters, quests, scripts and more.</p>
      <p style={{ marginBottom: 0 }}>
        <a href="https://github.com/mayaa2006/tes5-env-editor" target="_blank" rel="noreferrer">
          github.com/mayaa2006/tes5-env-editor
        </a>
      </p>
    </Modal>
  );
}
