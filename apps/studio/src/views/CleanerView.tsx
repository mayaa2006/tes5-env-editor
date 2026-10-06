/**
 * Plugin cleaning (SSEEdit's "Quick Auto Clean"): remove identical-to-master
 * records and undelete/disable deleted references, with a dry-run report first.
 */
import { useEffect, useState } from 'react';
import type { CleanEntry, CleanOptions, CleanReport } from '@tes5/cleaner';
import { Checkbox, Field, Icon, Select } from '../components/ui';
import { engine, useStore } from '../state/store';

export default function CleanerView() {
  const session = useStore((s) => s.session);
  const plugins = session.loadOrder.filter((p) => p.loaded);
  const [target, setTarget] = useState(() => sessionStorage.getItem('tes5.cleanTarget') ?? plugins.find((p) => !p.isMaster)?.name ?? '');
  const [mode, setMode] = useState<'safe' | 'xedit'>('safe');
  const [removeItms, setRemoveItms] = useState(true);
  const [undelete, setUndelete] = useState(true);
  const [fixNav, setFixNav] = useState(false);
  const [report, setReport] = useState<CleanReport | null>(null);
  useEffect(() => sessionStorage.removeItem('tes5.cleanTarget'), []);
  const isOfficial = /^(skyrim|update|dawnguard|hearthfires|dragonborn)\.esm$/i.test(target) || /^cc\w+\.es[lm]$/i.test(target);
  const opts = (dryRun: boolean): CleanOptions => ({ itmMode: mode, removeItms, undeleteReferences: undelete, fixDeletedNavmeshes: fixNav, dryRun });
  const isActive = target === session.activePlugin;

  const analyze = async () => setReport((await engine((c) => c.call('clean', target, opts(true)), { busy: `Analyzing ${target}…`, refreshSession: false })) ?? null);
  const clean = async () => {
    const r = await engine((c) => (isActive ? c.call('clean', target, opts(false)) : c.call('cleanAndSave', target, opts(false))), { busy: `Cleaning ${target}…` });
    if (!r) return;
    setReport(r);
    const n = r.itmsRemoved.length + r.undeleted.length + r.navmeshesFixed.length;
    useStore.getState().toast('success', n ? `${target}: ${r.itmsRemoved.length} ITM removed, ${r.undeleted.length} reference(s) undeleted${isActive ? ' — save to write the file' : ' — saved (backup kept next to it)'}` : `${target} is already clean`);
    useStore.getState().bump();
  };

  return (
    <div className="scroll pad" style={{ flex: 1 }}>
      <h2 style={{ marginTop: 0 }}>Clean a plugin</h2>
      <p className="dim" style={{ maxWidth: 760 }}>
        Removes records that are identical to their master (ITMs) and turns deleted references (UDRs), which can crash the game, into disabled ones — the same fixes as SSEEdit's Quick Auto Clean. Run “Analyze” first to see exactly what would change.
      </p>
      <div className="card col" style={{ gap: 8, maxWidth: 760 }}>
        <Field label="Plugin">
          <Select value={target} options={plugins.map((p) => ({ value: p.name, label: `${p.name}${p.isActivePlugin ? ' (editing)' : ''}` }))} onChange={(t) => (setTarget(t), setReport(null))} />
        </Field>
        <Field label="Identical-to-master" title="Safe mode keeps records that intentionally revert another mod's change">
          <Select
            value={mode}
            options={[
              { value: 'safe', label: 'Safe — keep deliberate reverts of other mods (recommended)' },
              { value: 'xedit', label: 'xEdit — compare with the original master only' },
            ]}
            onChange={setMode}
          />
        </Field>
        <Field label="Fixes">
          <div className="col" style={{ gap: 4 }}>
            <Checkbox checked={removeItms} onChange={setRemoveItms} label="Remove identical-to-master records" help="Records copied from a master without any change ('dirty edits'). They do nothing except undo other mods' changes to the same records." />
            <Checkbox checked={undelete} onChange={setUndelete} label="Undelete and disable deleted references" help="Deleted placed objects crash the game when something else still uses them. They're brought back, disabled and moved out of sight, which is just as invisible but safe." />
            <Checkbox checked={fixNav} onChange={setFixNav} label="Restore deleted navmeshes (experimental)" help="Deleted navmeshes can crash the game. This replaces them with a tiny navmesh out of the way. The exact layout xEdit uses isn't confirmed, so test in game." />
          </div>
        </Field>
        {isOfficial && (
          <div className="small warn">
            <Icon name="warn" size={12} /> Official master files are best left alone unless you know they need cleaning (and keep a backup).
          </div>
        )}
        <div className="row" style={{ gap: 6 }}>
          <button className="btn" onClick={analyze} disabled={!target} data-testid="analyze">
            <Icon name="search" size={13} /> Analyze
          </button>
          <button className="btn primary" onClick={clean} disabled={!target} data-testid="clean">
            <Icon name="clean" size={13} /> {isActive ? 'Clean' : 'Clean & save'}
          </button>
        </div>
      </div>
      {report && <Report r={report} />}
    </div>
  );
}

function Report({ r }: { r: CleanReport }) {
  const sections: [string, CleanEntry[], string][] = [
    [r.dryRun ? 'Would remove (identical to master)' : 'Removed (identical to master)', r.itmsRemoved, 'ok'],
    [r.dryRun ? 'Would undelete & disable' : 'Undeleted & disabled', r.undeleted, 'ok'],
    ['Kept: identical but still has child records', r.itmsKept, 'dim'],
    ['Kept: deliberate reverts of another mod', r.reverts, 'dim'],
    ['Deleted navmeshes', r.deletedNavmeshes, 'warn'],
    ['Navmeshes restored', r.navmeshesFixed, 'ok'],
    ['Skipped', r.skipped, 'dim'],
  ];
  return (
    <div className="col" style={{ gap: 10, marginTop: 14, maxWidth: 960 }} data-testid="clean-report">
      <div className="row" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>
          {r.plugin} — {r.dryRun ? 'analysis' : 'cleaned'}
        </h3>
        <span className="chip">{r.mode} mode</span>
        {r.emptyGroupsRemoved > 0 && <span className="chip">{r.emptyGroupsRemoved} empty groups</span>}
      </div>
      {r.errors.map((e) => (
        <div key={e} className="err small">
          {e}
        </div>
      ))}
      {sections
        .filter(([, list]) => list.length)
        .map(([title, list, cls]) => (
          <div key={title} className="card" style={{ padding: 0 }}>
            <div className="panel-header">
              <span className={`grow ${cls}`}>{title}</span>
              <span className="faint">{list.length}</span>
            </div>
            <table className="grid">
              <tbody>
                {list.slice(0, 500).map((e) => (
                  <tr key={`${e.formId}${e.sig}`}>
                    <td className="mono small" style={{ width: 90 }}>
                      {e.formId}
                    </td>
                    <td style={{ width: 60 }}>
                      <span className="chip">{e.sig}</span>
                    </td>
                    <td>{e.editorId ?? ''}</td>
                    <td className="dim small">{e.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {sections.every(([, l]) => !l.length) && !r.errors.length && (
        <div className="card ok">
          <Icon name="check" /> Nothing to clean.
        </div>
      )}
    </div>
  );
}
