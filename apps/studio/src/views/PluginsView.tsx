import { useState } from 'react';
import { Icon, useQuery } from '../components/ui';
import { engine, useStore } from '../state/store';
import { NewPluginDialog } from '../App';

export function PluginsView() {
  const session = useStore((s) => s.session);
  const setTab = useStore((s) => s.setTab);
  const [showNew, setShowNew] = useState(false);
  const { data: esl } = useQuery(() => (session.activePlugin ? useStore.getState().client?.call('eslReport') : undefined), [session.activePlugin]);
  return (
    <div className="scroll pad" style={{ flex: 1 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }} className="grow">
          Load order
        </h2>
        <button className="btn primary" onClick={() => setShowNew(true)}>
          <Icon name="plus" /> New plugin
        </button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>Plugin</th>
              <th>Flags</th>
              <th>Masters</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {session.loadOrder
              .filter((p) => p.loaded)
              .map((p, i) => (
                <tr key={p.name} style={p.isActivePlugin ? { background: 'rgba(79,156,247,0.08)' } : undefined}>
                  <td className="mono dim">{i.toString(16).toUpperCase().padStart(2, '0')}</td>
                  <td>
                    {p.name} {p.isActivePlugin && <span className="chip accent">editing</span>}
                  </td>
                  <td>
                    <div className="chips">
                      {p.isMaster && <span className="chip">ESM</span>}
                      {p.isLight && <span className="chip">ESL</span>}
                      {p.isLocalized && <span className="chip">Localized</span>}
                    </div>
                  </td>
                  <td className="dim small">{p.masters.join(', ') || '—'}</td>
                  <td>
                    <div className="row">
                      {!p.isActivePlugin && (
                        <button className="btn small" onClick={() => engine((c) => c.call('setActivePlugin', p.name), { success: `Now editing ${p.name}` })}>
                          Edit this plugin
                        </button>
                      )}
                      <button
                        className="btn small ghost"
                        onClick={() => {
                          setTab('clean');
                          sessionStorage.setItem('tes5.cleanTarget', p.name);
                        }}
                      >
                        Clean…
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {esl && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-title">
            ESL check for {esl.plugin}
            {esl.eligible ? <span className="chip ok">can be ESL-flagged</span> : esl.eligibleAfterCompaction ? <span className="chip warn">needs FormID compaction</span> : <span className="chip err">too many records</span>}
          </div>
          <div className="dim">
            {esl.newRecords} new records, highest object ID {esl.maxObjectId.toString(16).toUpperCase()}.
          </div>
          {esl.notes.map((n) => (
            <div key={n} className="small warn">
              {n}
            </div>
          ))}
        </div>
      )}
      {showNew && <NewPluginDialog onClose={() => setShowNew(false)} />}
    </div>
  );
}
