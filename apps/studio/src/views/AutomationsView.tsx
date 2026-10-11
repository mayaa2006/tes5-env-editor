/**
 * Automations: what happens on its own (on every save, and always), and where
 * to find the tools that automate the bigger jobs.
 */
import { Help, Icon } from '../components/ui';
import { OnSave } from '../components/OnSave';
import { useStore, type WorkspaceTab } from '../state/store';

export default function AutomationsView() {
  return (
    <div className="scroll pad" style={{ flex: 1 }}>
      <h2 style={{ margin: '0 0 2px' }}>Automations</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        The chores the Creation Kit leaves to you, done for you. Choose what happens when you save; everything else here always happens.
      </p>
      <div className="card-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
        <OnSave />
        <Always />
        <Elsewhere />
      </div>
    </div>
  );
}

const ALWAYS: [string, string][] = [
  ['Masters added and sorted', 'Point at something from another plugin and that plugin becomes a master of yours, in load order.'],
  ['Parent records copied for you', 'Placing something in a vanilla cell or adding a line to a vanilla topic copies just the parts needed, nothing more.'],
  ['Record and dialogue counts', 'Topic response counts, record counts and the next free FormID stay correct.'],
  ['Dialogue order', 'Responses keep their order in the topic when you add, move or delete lines.'],
  ['Quest alias IDs', 'New aliases get the next free ID; nothing is reused.'],
  ['Fragment scripts and their properties', 'Writing a stage or dialogue script creates the fragment script, attaches it and fills in properties for the aliases and forms it uses.'],
  ['Safe deletes', 'Deleting a master reference disables it instead (deleted references crash the game).'],
  ['Backups and safe saving', 'The previous file is kept as a backup, and saves never leave a half-written plugin.'],
  ['Translations (strings files)', 'Localized plugins get their .strings files written alongside.'],
  ['Undo for everything', 'Every change, including generated script files, can be undone and redone.'],
];

function Always() {
  return (
    <div className="card">
      <div className="card-title">
        Always automatic
        <Help text="These always happen; there's nothing to switch on." />
      </div>
      <ul className="always-list">
        {ALWAYS.map(([t, d]) => (
          <li key={t}>
            <Icon name="check" size={12} />
            <span>
              {t}
              <Help text={d} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TOOLS: { tab: WorkspaceTab; title: string; text: string }[] = [
  { tab: 'scene', title: 'World → Tools', text: 'Paint plants and clutter, lay roads and fences, light candles and fires, dress a room, build rooms from kit pieces, link doors.' },
  { tab: 'scene', title: 'World → Navmesh', text: 'One-click navmesh with doors and neighbouring cells linked; a warning when it gets out of date.' },
  { tab: 'quest', title: 'Quests → Map', text: 'Connect stages by what moves the quest on (talk, pick up, kill, arrive…); the dialogue, triggers and scripts are written for you.' },
  { tab: 'quest', title: 'Quests → Dialogue', text: 'Write a conversation as a script and get topics, choices, conditions and stage changes.' },
  { tab: 'scene', title: 'Triggers (on any placed object)', text: '“When / If / Do” rules instead of writing Papyrus, with ready-made templates.' },
  { tab: 'release', title: 'Release', text: 'A pre-release check with one-click fixes, a conflict report, and packing into a BSA or a ZIP.' },
];

function Elsewhere() {
  return (
    <div className="card">
      <div className="card-title">Automation tools in other tabs</div>
      <ul className="list">
        {TOOLS.map((t) => (
          <li key={t.title} className="list-item" onClick={() => useStore.getState().setTab(t.tab)} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 2 }}>
            <span>{t.title}</span>
            <span className="dim small" style={{ whiteSpace: 'normal' }}>
              {t.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
