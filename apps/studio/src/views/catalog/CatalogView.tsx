/**
 * The Items and Magic workspaces: categories on the left (weapons, potions,
 * spells, perks…), the records of the chosen one with a one-line summary each,
 * and a full-size editor for the open record.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { FormKey } from '@tes5/esp';
import type { CatalogItem, CatalogTab, RecordView } from '@tes5/workspace';
import { Checkbox, Help, Icon, useDebounced, useQuery, useSummaries } from '../../components/ui';
import { engine, useStore } from '../../state/store';
import { Header, RecordActions } from '../record/Inspector';
import { RecordForm } from '../record/RecordForm';
import { FRIENDLY_EDITORS, type EditorProps } from './editors';

const INTRO: Record<CatalogTab, string> = {
  items: 'Everything that can be carried, crafted or found as loot.',
  magic: 'Spells, powers, enchantments, shouts and perks.',
};

export default function CatalogView({ tab }: { tab: CatalogTab }) {
  const place = useStore((s) => s.catalog[tab]);
  const open = useStore((s) => s.openCatalog);
  return (
    <div className="row catalog" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }} data-testid={`catalog-${tab}`}>
      <Categories tab={tab} current={place.category} onPick={(category) => open(tab, { category })} />
      <List tab={tab} category={place.category} current={place.record} onPick={(record) => open(tab, { record })} />
      <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {place.record ? (
          <Editor key={place.record} formKey={place.record} onSelect={(record) => open(tab, { record })} />
        ) : (
          <div className="empty grow">Pick something on the left to edit it, or click New to make one.</div>
        )}
      </div>
    </div>
  );
}

function Categories({ tab, current, onPick }: { tab: CatalogTab; current: string; onPick: (id: string) => void }) {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('catalogCounts', tab), [tab]);
  return (
    <div className="panel catalog-categories" style={{ flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--panel)' }}>
      <div className="panel-header">
        <span className="grow">{tab === 'items' ? 'Items' : 'Magic'}</span>
        <Help text={INTRO[tab]} />
      </div>
      <ul className="list scroll" style={{ flex: 1 }} data-testid="catalog-categories">
        {(data ?? []).map((c) => (
          <li key={c.id} className={`list-item ${current === c.id ? 'selected' : ''}`} onClick={() => onPick(c.id)} title={c.help} data-testid={`category-${c.id}`}>
            <span className="name">{c.label}</span>
            <span className="meta">{c.count}</span>
          </li>
        ))}
        {!data && <li className="empty">Loading…</li>}
      </ul>
    </div>
  );
}

function List({ tab, category, current, onPick }: { tab: CatalogTab; category: string; current?: FormKey; onPick: (k: FormKey) => void }) {
  const client = useStore((s) => s.client);
  const activePlugin = useStore((s) => s.session.activePlugin);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  useEffect(() => setQ(''), [category]);
  const { data: counts } = useQuery(() => client?.call('catalogCounts', tab), [tab]);
  const cat = counts?.find((c) => c.id === category);
  const { data, loading } = useQuery(() => client?.call('catalogList', category, dq, 300), [category, dq]);
  const create = () =>
    engine(
      async (c) => {
        const key = await c.call('createInCategory', category);
        onPick(key);
        return key;
      },
      { success: `Created a new ${cat?.one ?? 'record'}. Ctrl+Z undoes it.` },
    );
  return (
    <div className="panel catalog-list" style={{ flex: 'none', borderRight: '1px solid var(--border)' }}>
      <div className="panel-header">
        <span className="grow ellipsis">{cat?.label ?? ''}</span>
        {cat?.help && <Help text={cat.help} />}
        <button
          className="btn small primary"
          data-testid="catalog-new"
          disabled={!cat?.creatable}
          onClick={create}
          title={activePlugin ? `Create a new ${cat?.one ?? 'record'} in ${activePlugin}, with sensible starting values. Ctrl+Z undoes it.` : `Create a new ${cat?.one ?? 'record'}. You'll be asked which plugin to put it in first.`}
        >
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <div className="searchbox">
        <input className="input" placeholder={`Find ${cat?.label.toLowerCase() ?? ''}…`} value={q} onChange={(e) => setQ(e.target.value)} data-testid="catalog-search" />
      </div>
      <ul className="list scroll" style={{ flex: 1 }} data-testid="catalog-records">
        {data?.items.map((i) => <Row key={i.formKey} item={i} selected={current === i.formKey} onPick={onPick} />)}
        {data && data.total > data.items.length && <li className="list-item dim">Showing {data.items.length} of {data.total}. Type to narrow it down.</li>}
        {data && !data.items.length && (
          <li className="empty">{q ? 'Nothing matches that search.' : `No ${cat?.label.toLowerCase() ?? 'records'} in your load order yet. Click New to make one.`}</li>
        )}
        {!data && loading && <li className="empty">Loading…</li>}
      </ul>
    </div>
  );
}

function Row({ item, selected, onPick }: { item: CatalogItem; selected: boolean; onPick: (k: FormKey) => void }) {
  return (
    <li className={`list-item catalog-row ${selected ? 'selected' : ''}`} onClick={() => onPick(item.formKey)} title={`${item.editorId ?? ''} (${item.formKey})`}>
      <div className="row" style={{ gap: 6, minWidth: 0 }}>
        <span className="name ellipsis">{item.title}</span>
        {item.editorId && item.editorId !== item.title && <span className="faint small ellipsis" style={{ flexShrink: 1 }}>{item.editorId}</span>}
        {item.inActive && <span className="chip accent">yours</span>}
      </div>
      {item.summary && <div className="small faint ellipsis">{item.summary}</div>}
    </li>
  );
}

function Editor({ formKey, onSelect }: { formKey: FormKey; onSelect: (k: FormKey) => void }) {
  const client = useStore((s) => s.client);
  const session = useStore((s) => s.session);
  const { data: view } = useQuery(() => client?.call('view', formKey), [formKey]);
  const { data: schema } = useQuery(() => (view ? client?.call('uiSchema', view.sig) : undefined), [view?.sig], { revision: false });
  const [draft, setDraft] = useState<Record<string, unknown> | undefined>(view?.data);
  const [all, setAll] = useState(false);
  useEffect(() => setDraft(view?.data), [view]);
  if (view === null) return <div className="empty">This record no longer exists (it was deleted or undone).</div>;
  if (!view || !draft) return <div className="empty">Loading…</div>;
  const commit = async (data: Record<string, unknown>) => {
    setDraft(data);
    await engine((c) => c.call('updateRecord', view.formKey, data, { unknown: view.unknown, label: `Edit ${view.name ?? view.editorId ?? view.typeName}` }));
  };
  const Friendly = FRIENDLY_EDITORS[view.sig] as ((p: EditorProps) => ReactNode) | undefined;
  const editable = view.hasSchema && view.lossless;
  return (
    <div className="scroll" style={{ flex: 1 }} data-testid="catalog-editor">
      <div className="catalog-editor">
        <div className="row" style={{ alignItems: 'baseline', gap: 8, padding: '12px 12px 0' }}>
          <h2 style={{ margin: 0 }}>{(draft.name as string) || (view.sig === 'COBJ' ? <RecipeTitle view={view} data={draft} /> : view.editorId || view.typeName)}</h2>
          <span className="dim small">{view.editorId}</span>
        </div>
        <Header view={view} />
        {!session.activePlugin && <div className="pad small warn" style={{ paddingTop: 0 }}>Your first edit will ask you to create a plugin to hold your changes.</div>}
        <RecordActions view={view} onSelect={(k) => k && onSelect(k)} />
        {!editable ? (
          <div className="pad warn small">This record uses a layout the editor can't write back exactly, so it can only be viewed in Records (raw fields) to avoid damaging it.</div>
        ) : (
          <>
            {Friendly && !all && <Friendly view={view as RecordView} data={draft as any} commit={commit} />}
            <div className="pad" style={{ paddingTop: 4 }}>
              {Friendly && (
                <Checkbox
                  checked={all}
                  onChange={setAll}
                  label="Show every field (like the Creation Kit)"
                  help="Lists every stored field of this record, including models, sounds and other details the simple view leaves out. Changes there are saved the same way."
                />
              )}
            </div>
            {(all || !Friendly) && schema && <RecordForm schema={schema} data={draft} onChange={commit} />}
          </>
        )}
      </div>
    </div>
  );
}

/** Recipes have no name: call them by what they make. */
function RecipeTitle({ view, data }: { view: RecordView; data: Record<string, any> }) {
  const sums = useSummaries([view.sig === 'COBJ' ? data.createdObject : null]);
  if (view.sig !== 'COBJ') return null;
  const made = data.createdObject ? sums[data.createdObject] : undefined;
  return <>{made ? `${made.name ?? made.editorId} recipe` : 'New recipe'}</>;
}
