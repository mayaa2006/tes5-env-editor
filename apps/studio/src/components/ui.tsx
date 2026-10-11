import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FormKey } from '@tes5/esp';
import { engine, useStore } from '../state/store';

// ------------------------------------------------------------------ data hooks

/** Run an async query; re-runs when deps or the engine revision change. */
export function useQuery<T>(fn: () => Promise<T | undefined> | undefined, deps: unknown[], opts: { revision?: boolean } = {}): { data: T | undefined; loading: boolean; reload: () => void } {
  const revision = useStore((s) => s.revision);
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const p = fn();
    if (!p) {
      setData(undefined);
      return;
    }
    setLoading(true);
    p.then((v) => alive && setData(v))
      .catch(() => alive && setData(undefined))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts.revision === false ? 0 : revision, nonce]);
  return { data, loading, reload: () => setNonce((n) => n + 1) };
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ------------------------------------------------------------------ icons

const ICONS: Record<string, string> = {
  scene: 'M3 17l6-10 4 6 3-4 5 8z',
  npc: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0z',
  body: 'M12 7a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM9 9h6l1 6-1.5 1L14 22h-4l-.5-6L8 15z',
  items: 'M4 8l8-4 8 4v9l-8 4-8-4zM4 8l8 4 8-4M12 12v9',
  magic: 'M12 3l2.2 5.8L20 9.5l-4.5 3.8L17 19l-5-3.2L7 19l1.5-5.7L4 9.5l5.8-.7z',
  quest: 'M6 3h10l3 3v15H6zM9 9h7M9 13h7M9 17h4',
  script: 'M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16',
  records: 'M4 5h16M4 10h16M4 15h16M4 20h10',
  clean: 'M5 19l7-14 7 14M8 13h8',
  auto: 'M13 2L4 14h7l-1 8 9-12h-7z',
  plugins: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  save: 'M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  folder: 'M3 6h6l2 2h10v11H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.6M6.6 6.6A17 17 0 002 12s4 6 10 6a10 10 0 004.4-1',
  link: 'M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6l-1 1M14 10a4 4 0 00-5.6 0l-3 3a4 4 0 005.6 5.6l1-1',
  play: 'M7 4l13 8-13 8z',
  check: 'M4 12l5 5L20 6',
  warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  magnet: 'M6 4v8a6 6 0 0012 0V4M6 4h4v8a2 2 0 004 0V4h4',
  navmesh: 'M3 18l6-12 6 12zM9 6l12 4-6 8',
  light: 'M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0012 3z',
  frame: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  wand: 'M15 4l5 5L9 20H4v-5zM14 5l5 5',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  palette: 'M12 3a9 9 0 100 18c1 0 1.5-.8 1.5-1.5 0-1.5-1-2 0-3 .7-.7 2-.5 3.5-.5A3 3 0 0020 13 9 9 0 0012 3z',
  chat: 'M4 5h16v11H9l-5 4z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  route: 'M6 19a2 2 0 100-4 2 2 0 000 4zM18 9a2 2 0 100-4 2 2 0 000 4zM6 15V9a4 4 0 014-4h6M18 9v6a4 4 0 01-4 4H8',
};

export function Icon({ name, size = 15, className }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name] ?? ICONS.cube} />
    </svg>
  );
}

// ------------------------------------------------------------------ layout bits

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`panel ${className ?? ''}`}>
      {title !== undefined && (
        <div className="panel-header">
          <span className="grow ellipsis">{title}</span>
          {actions}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="panel-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={`panel-tab ${t.id === value ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A small (?) that explains a control on hover, focus or click. */
export function Help({ text }: { text: ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ x: Math.min(r.left, window.innerWidth - 300), y: r.bottom + 6 });
  };
  return (
    <span
      ref={ref}
      className="help"
      tabIndex={0}
      role="button"
      aria-label="What does this do?"
      onMouseEnter={show}
      onMouseLeave={() => setAt(null)}
      onFocus={show}
      onBlur={() => setAt(null)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        at ? setAt(null) : show();
      }}
    >
      ?
      {at && (
        <span className="help-pop" role="tooltip" style={{ left: at.x, top: at.y }}>
          {text}
        </span>
      )}
    </span>
  );
}

export function Field({ label, children, stack, title }: { label: ReactNode; children: ReactNode; stack?: boolean; title?: string }) {
  return (
    <div className={`field ${stack ? 'stack' : ''}`}>
      <label>
        {label}
        {title && <Help text={title} />}
      </label>
      <div>{children}</div>
    </div>
  );
}

export function Section({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section">
      {(title || actions) && (
        <div className="row" style={{ marginBottom: 6 }}>
          {title && <h3 className="grow" style={{ margin: 0 }}>{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ inputs

/** Text input that commits on blur / Enter (so each keystroke isn't an undo step). */
export function TextInput({ value, onCommit, placeholder, multiline, mono, disabled, autoFocus }: { value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean; disabled?: boolean; autoFocus?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  if (multiline)
    return <textarea className={`input ${mono ? 'mono' : ''}`} value={v} placeholder={placeholder} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={commit} autoFocus={autoFocus} />;
  return (
    <input
      className={`input ${mono ? 'mono' : ''}`}
      value={v}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
        e.stopPropagation();
      }}
    />
  );
}

/** Blender-style number field: drag horizontally to scrub, click to type. */
/**
 * A text box with an expand button beside it. The button opens the text in a big editing box;
 * whatever you typed is saved when you click off it (outside the box, Done, Escape or Ctrl+Enter).
 */
export function ExpandableText({ value, onCommit, multiline, placeholder, title = 'Edit text' }: { value: string; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const finish = () => {
    setOpen(false);
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className="row" style={{ gap: 4, alignItems: 'flex-start' }}>
      <div className="grow">
        <TextInput multiline={multiline} value={value} onCommit={onCommit} placeholder={placeholder} />
      </div>
      <button
        className="btn icon ghost"
        title="Open in a bigger box to write and edit more comfortably. It saves when you click off it."
        aria-label={`${title} in a bigger box`}
        data-testid="expand-text"
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        <Icon name="frame" size={13} />
      </button>
      {open && (
        <Modal
          title={title}
          width={640}
          onClose={finish}
          footer={
            <button className="btn primary" onClick={finish} title="Save and close (clicking outside the box does the same)">
              Done
            </button>
          }
        >
          <textarea
            className="input"
            style={{ height: 'min(50vh, 360px)', resize: 'vertical' }}
            value={draft}
            autoFocus
            placeholder={placeholder}
            data-testid="expanded-text"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish();
              e.stopPropagation();
            }}
          />
          <div className="dim small" style={{ marginTop: 6 }}>
            Saved when you click outside this box. Ctrl+Enter also saves and closes.
          </div>
        </Modal>
      )}
    </div>
  );
}

export function DragNumber({ value, onCommit, step = 1, precision = 2, min, max, disabled, suffix }: { value: number; onCommit: (v: number) => void; step?: number; precision?: number; min?: number; max?: number; disabled?: boolean; suffix?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [live, setLive] = useState<number | null>(null);
  const start = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const shown = live ?? value;
  if (editing)
    return (
      <input
        className="input mono"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const n = Number(draft);
          if (Number.isFinite(n) && n !== value) onCommit(clamp(n));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  return (
    <div
      className="input mono"
      style={{ cursor: disabled ? 'default' : 'ew-resize', userSelect: 'none', opacity: disabled ? 0.5 : 1 }}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, v: value, moved: false };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        if (Math.abs(dx) > 2) s.moved = true;
        if (s.moved) setLive(clamp(s.v + Math.round(dx / 4) * step * (e.shiftKey ? 0.1 : 1)));
      }}
      onPointerUp={() => {
        const s = start.current;
        start.current = null;
        if (!s) return;
        if (!s.moved) {
          setDraft(String(value));
          setEditing(true);
        } else if (live !== null && live !== value) onCommit(live);
        setLive(null);
      }}
    >
      {Number(shown.toFixed(precision))}
      {suffix && <span className="faint"> {suffix}</span>}
    </div>
  );
}

/** A friendly empty screen: an icon, what this place is for, and the next things to do. */
export function EmptyState({ icon, title, children, actions, testId }: { icon: string; title: ReactNode; children?: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <div className="empty-state" data-testid={testId}>
      <Icon name={icon} size={36} />
      <div className="empty-state-title">{title}</div>
      {children && <div className="empty-state-text">{children}</div>}
      {actions && <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>{actions}</div>}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, help }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; help?: ReactNode }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
      {help && <Help text={help} />}
    </label>
  );
}

export function Slider({ value, onChange, onCommit, min, max, step = 0.01 }: { value: number; onChange?: (v: number) => void; onCommit: (v: number) => void; min: number; max: number; step?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value);
          setV(n);
          onChange?.(n);
        }}
        onPointerUp={() => onCommit(v)}
        onKeyUp={() => onCommit(v)}
      />
      <span className="mono small dim" style={{ textAlign: 'right' }}>
        {v.toFixed(step < 1 ? 2 : 0)}
      </span>
    </div>
  );
}

export function Select<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <select className="input" value={String(value)} disabled={disabled} onChange={(e) => onChange((typeof value === 'number' ? Number(e.target.value) : e.target.value) as T)}>
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------ modal / toasts

export function Modal({ title, children, footer, onClose, width, className }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number; className?: string }) {
  useEffect(() => {
    // Capture phase: text boxes stop key events from bubbling, but Escape should still close the dialog.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} style={width ? { width } : undefined} role="dialog">
        <div className="modal-header">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ forms

export interface Summary {
  formKey: FormKey;
  sig: string;
  editorId?: string;
  name?: string;
  owner: string;
  winner: string;
  inActive: boolean;
}

export function useSummaries(keys: (FormKey | null | undefined)[]): Record<string, Summary | null> {
  const list = useMemo(() => [...new Set(keys.filter((k): k is FormKey => !!k))].sort(), [keys.join('|')]);
  const { data } = useQuery(() => (list.length ? useStore.getState().client?.call('summaries', list) : Promise.resolve({})) as Promise<Record<string, Summary | null>>, [list.join('|')]);
  return data ?? {};
}

/** Shows a FormKey as "EditorID 'Name'"; click to open it in the inspector. */
export function FormLink({ value, summary }: { value: FormKey | null | undefined; summary?: Summary | null }) {
  const sums = useSummaries(summary ? [] : [value]);
  if (!value) return <span className="faint">None</span>;
  const s = summary ?? sums[value];
  return (
    <a
      href="#"
      title={value}
      onClick={(e) => {
        e.preventDefault();
        useStore.getState().showProperties(value);
      }}
      style={{ color: 'var(--accent)', textDecoration: 'none' }}
    >
      {s?.editorId ?? s?.name ?? value}
      {s?.name && s.editorId && <span className="faint"> “{s.name}”</span>}
      {s && <span className="faint mono small"> [{s.sig}]</span>}
    </a>
  );
}

/** Search-as-you-type picker for forms of the given record types. */
export function FormPicker({ value, sigs, onChange, placeholder, allowNone = true }: { value: FormKey | null | undefined; sigs?: string[]; onChange: (v: FormKey | null) => void; placeholder?: string; allowNone?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 150);
  const sums = useSummaries([value]);
  const { data } = useQuery(() => (open ? useStore.getState().client?.call('search', { sigs: sigs?.length ? sigs : undefined, query: dq, limit: 60 }) : undefined), [open, dq, (sigs ?? []).join(',')], { revision: false });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const cur = value ? sums[value] : undefined;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div className="row">
        <button className="input" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen(!open)} title={value ?? ''}>
          {value ? (
            cur?.name ? (
              <>
                {cur.name} <span className="faint small">{cur.editorId}</span>
              </>
            ) : (
              (cur?.editorId ?? value)
            )
          ) : (
            <span className="faint">{placeholder ?? 'None'}</span>
          )}
        </button>
        {value && (
          <button className="btn icon ghost" title="Show its properties" onClick={() => useStore.getState().showProperties(value)}>
            <Icon name="link" size={13} />
          </button>
        )}
      </div>
      {open && (
        <div className="card" style={{ position: 'absolute', zIndex: 50, left: 0, right: 0, top: 30, padding: 0, maxHeight: 320, display: 'flex', flexDirection: 'column' }}>
          <div className="searchbox">
            <input className="input" autoFocus placeholder={`Search ${sigs?.join(', ') ?? 'forms'}…`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <ul className="list scroll" style={{ flex: 1 }}>
            {allowNone && (
              <li
                className="list-item"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                <span className="faint">None</span>
              </li>
            )}
            {data?.items.map((i) => (
              <li
                key={i.formKey}
                className={`list-item ${i.formKey === value ? 'selected' : ''}`}
                onClick={() => {
                  onChange(i.formKey);
                  setOpen(false);
                }}
              >
                <span className="sig">{i.sig}</span>
                <span className="name">{i.name || i.editorId || i.formKey}</span>
                {i.name && i.editorId && <span className="meta">{i.editorId}</span>}
              </li>
            ))}
            {data && data.total > data.items.length && <li className="list-item dim">{data.total - data.items.length} more…</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A toolbar button that opens a small menu (closes on outside click, Esc, or after picking). */
export function Menu({ label, title, active, children, testId }: { label: ReactNode; title?: string; active?: boolean; children: (close: () => void) => ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={`btn small ${active || open ? 'active' : 'ghost'}`} aria-haspopup="menu" aria-expanded={open} title={title} onClick={() => setOpen(!open)} data-testid={testId}>
        {label}
        <Icon name="chevronDown" size={11} />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One entry in a Menu; `checked` shows a tick for on/off options, `hint` a shortcut. */
export function MenuItem({ children, onClick, checked, hint, disabled, title }: { children: ReactNode; onClick: () => void; checked?: boolean; hint?: string; disabled?: boolean; title?: string }) {
  return (
    <button className="menu-item" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} disabled={disabled} onClick={onClick} title={title}>
      <span className="menu-check">{checked ? <Icon name="check" size={12} /> : null}</span>
      <span className="grow">{children}</span>
      {hint && <span className="kbd">{hint}</span>}
    </button>
  );
}

export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[]): void {
  const cb = useCallback((e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('.monaco-editor'))) return;
    const key = `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.key.toLowerCase()}`;
    const fn = map[key];
    if (fn) {
      e.preventDefault();
      fn(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    window.addEventListener('keydown', cb);
    return () => window.removeEventListener('keydown', cb);
  }, [cb]);
}

const drafts = new Map<string, unknown>();

/** Like useState, but remembered by `key` while the app is open, so closing a dialog and reopening it keeps what was typed. Call clearDraft(prefix) once the work is done. */
export function useDraft<T>(key: string | undefined, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [v, setV] = useState<T>(() => (key !== undefined && drafts.has(key) ? (drafts.get(key) as T) : initial));
  const set = useCallback(
    (n: T | ((prev: T) => T)) =>
      setV((prev) => {
        const next = typeof n === 'function' ? (n as (p: T) => T)(prev) : n;
        if (key !== undefined) drafts.set(key, next);
        return next;
      }),
    [key],
  );
  return [v, set];
}

/** Forget every remembered draft whose key starts with `prefix`. */
export function clearDraft(prefix: string) {
  for (const k of [...drafts.keys()]) if (k.startsWith(prefix)) drafts.delete(k);
}

/** State for a new form's Editor ID, pre-filled with the first free variant of `base`. Pass `draftKey` to remember it. */
export function useUniqueEditorId(base: string, draftKey?: string): [string, (v: string) => void] {
  const [v, setV] = useDraft(draftKey, base);
  useEffect(() => {
    let alive = true;
    void useStore
      .getState()
      .client?.call('uniqueEditorId', base)
      .then((u) => alive && setV((cur) => (cur === base ? u : cur)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [base]);
  return [v, setV];
}

export { engine };
