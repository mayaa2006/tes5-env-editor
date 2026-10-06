import { useState } from 'react';
import { Icon } from '../components/ui';
import { useStore } from '../state/store';

/** Collapsible activity log under the main view (edits, warnings, errors). */
export function BottomLog() {
  const log = useStore((s) => s.log);
  const [open, setOpen] = useState(false);
  const errors = log.filter((l) => l.kind === 'error' || l.kind === 'warning').length;
  return (
    <div style={{ borderTop: '1px solid var(--border)', background: 'var(--panel)', maxHeight: open ? 180 : 26, display: 'flex', flexDirection: 'column', flex: 'none' }}>
      <button className="row small dim" style={{ height: 26, padding: '0 10px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', flex: 'none' }} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevron'} size={12} />
        Activity
        {errors > 0 && <span className="chip warn">{errors}</span>}
        <span className="spacer" />
        <span className="ellipsis faint">{!open && log.length ? log[log.length - 1]!.text : ''}</span>
      </button>
      {open && (
        <div className="scroll mono small" style={{ padding: '0 10px 6px' }}>
          {[...log].reverse().map((l, i) => (
            <div key={i} className={l.kind === 'error' ? 'err' : l.kind === 'warning' ? 'warn' : l.kind === 'success' ? 'ok' : 'dim'}>
              <span className="faint">{new Date(l.time).toLocaleTimeString()}</span> {l.text}
            </div>
          ))}
          {!log.length && <div className="faint">Nothing yet.</div>}
        </div>
      )}
    </div>
  );
}
