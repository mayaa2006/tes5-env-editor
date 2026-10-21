/**
 * What the AI read in the author's text, beat by beat: what the player does, to whom, after what, and whether it ends
 * the quest, each with the sentence it came from. Changing a beat makes the plan again from the outline.
 */
import { BEAT_ACTIONS, ACTION_TARGET, beatOrder, type Beat, type BeatAction, type BeatQuestion, type BeatSheet } from '@tes5/workspace';
import { Help, Icon, Select } from '../../components/ui';

const ACTION_LABEL: Record<BeatAction, string> = {
  talk: 'Talk to',
  pickup: 'Pick up',
  read: 'Read',
  use: 'Use',
  arrive: 'Go to',
  kill: 'Kill',
  clear: 'Clear out',
  wait: 'Wait',
  immediately: 'Right away',
};

export function BeatOutline({ sheet, questions, onChange, onUndo, canUndo }: { sheet: BeatSheet; questions: BeatQuestion[]; onChange: (next: BeatSheet) => void; onUndo: () => void; canUndo: boolean }) {
  const order = beatOrder(sheet.beats) ?? sheet.beats;
  const number = new Map(order.map((b, i) => [b.id, i + 1]));
  const targets = (does: BeatAction) => {
    const want = ACTION_TARGET[does];
    const list = [
      ...(want === 'person' || want === 'person|item' ? sheet.people.map((p) => ({ value: p.key, label: p.name })) : []),
      ...(want === 'item' || want === 'person|item' ? sheet.items.map((p) => ({ value: p.key, label: p.name })) : []),
      ...(want === 'place' ? sheet.places.map((p) => ({ value: p.key, label: p.name })) : []),
      ...(want === 'group' ? sheet.groups.map((g) => ({ value: g.key, label: `${g.count} ${g.what}` })) : []),
    ];
    return list;
  };
  const change = (id: string, fn: (b: Beat) => void) => {
    const next = structuredClone(sheet);
    const b = next.beats.find((x) => x.id === id);
    if (!b) return;
    fn(b);
    onChange(next);
  };
  const remove = (id: string) => {
    const next = structuredClone(sheet);
    next.beats = next.beats.filter((b) => b.id !== id);
    for (const b of next.beats) b.after = b.after.filter((a) => a !== id);
    for (const d of next.dialogue) for (const l of d.lines) if (l.beat === id) l.beat = null;
    next.lines = next.lines.filter((l) => l.beat !== id);
    onChange(next);
  };
  const askedAbout = (id: string) => questions.filter((q) => q.about === id && !q.unsaid);
  const general = questions.filter((q) => !sheet.beats.some((b) => b.id === q.about) && !q.unsaid);

  return (
    <div className="col" style={{ gap: 10 }} data-testid="beat-outline">
      <div className="row" style={{ gap: 8 }}>
        <span className="dim small grow" style={{ whiteSpace: 'normal' }}>
          What the AI read in your text, in the order it's played. Change a beat and the plan is made again from this outline (hand changes to stages and dialogue are replaced).
        </span>
        <button className="btn" disabled={!canUndo} onClick={onUndo} title="Put the outline back as it was before the last change" data-testid="beat-undo">
          <Icon name="undo" size={13} /> Undo
        </button>
      </div>
      {general.length > 0 && (
        <ul className="list release-list" data-testid="beat-questions">
          {general.map((q) => (
            <li key={q.message} className="release-item warning">
              <span className="chip warn" style={{ flex: 'none' }}>
                Check
              </span>
              <span className="grow">{q.message}</span>
            </li>
          ))}
        </ul>
      )}
      {!order.length && <div className="dim">Nothing the player does was found in the text. Say what the player does (talks to someone, finds something, goes somewhere) and read it again.</div>}
      <ol className="list" style={{ listStyle: 'none', padding: 0 }}>
        {order.map((b) => {
          const options = targets(b.does);
          const before = sheet.beats.filter((x) => x.id !== b.id && !b.after.includes(x.id));
          return (
            <li key={b.id} className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }} data-testid={`beat-${number.get(b.id)}`}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <span className="chip dim" title="Its place in the order the quest is played">
                  {number.get(b.id)}
                </span>
                <span title="What the player does to reach this beat">
                  <Select
                    value={b.does}
                    options={BEAT_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
                    onChange={(v) =>
                      change(b.id, (x) => {
                        x.does = v;
                        const fits = targets(v);
                        if (!ACTION_TARGET[v]) x.target = null;
                        else if (!fits.some((f) => f.value === x.target)) x.target = fits[0]?.value ?? null;
                      })
                    }
                  />
                </span>
                {ACTION_TARGET[b.does] && (
                  <span title="Who or what it's done to">
                    <Select value={b.target ?? ''} options={[...(options.some((o) => o.value === b.target) ? [] : [{ value: b.target ?? '', label: b.target ? `${b.target} (not in the quest)` : 'Choose…' }]), ...options]} onChange={(v) => change(b.id, (x) => (x.target = v || null))} />
                  </span>
                )}
                {b.does === 'wait' && (
                  <span className="row" style={{ gap: 4 }} title="In-game hours">
                    <input className="input" type="number" min={1} style={{ width: 70 }} value={b.hours ?? 24} onChange={(e) => change(b.id, (x) => (x.hours = Math.max(1, Number(e.target.value) || 1)))} /> hours
                  </span>
                )}
                <span title="Whether reaching this beat ends the quest">
                  <Select
                    value={b.ends ?? 'no'}
                    options={[
                      { value: 'no', label: 'goes on' },
                      { value: 'complete', label: 'completes the quest' },
                      { value: 'fail', label: 'fails the quest' },
                    ]}
                    onChange={(v) => change(b.id, (x) => (x.ends = v === 'no' ? null : (v as 'complete' | 'fail')))}
                  />
                </span>
                <span className="grow" />
                <button className="btn icon" onClick={() => remove(b.id)} title="Remove this beat (Undo puts it back)" aria-label={`Remove beat ${number.get(b.id)}`}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
                <span className="dim">{b.after.length ? 'After' : 'From the start'}</span>
                {b.after.map((a) => (
                  <span key={a} className="chip">
                    {number.get(a) ?? a}
                    <button className="link-button" onClick={() => change(b.id, (x) => (x.after = x.after.filter((y) => y !== a)))} title={`Doesn't need beat ${number.get(a)} first`} aria-label={`Not after beat ${number.get(a)}`}>
                      ×
                    </button>
                  </span>
                ))}
                {before.length > 0 && (
                  <span title="Another beat that must happen first (with several, any one of them leads here)">
                    <Select value="" options={[{ value: '', label: b.after.length ? 'or after…' : 'after…' }, ...before.map((x) => ({ value: x.id, label: `${number.get(x.id)}. ${ACTION_LABEL[x.does]} ${x.target ?? ''}`.trim() }))]} onChange={(v) => v && change(b.id, (x) => x.after.push(v))} />
                  </span>
                )}
              </div>
              {b.quote && <div className="dim small" style={{ whiteSpace: 'normal' }}>“{b.quote}”</div>}
              {askedAbout(b.id).map((q) => (
                <div key={q.message} className="small warn" style={{ whiteSpace: 'normal' }}>
                  {q.message}
                </div>
              ))}
            </li>
          );
        })}
      </ol>
      <div className="dim small">
        Who and what it involves: {sheet.people.map((p) => p.name).join(', ') || 'nobody'}; {sheet.places.map((p) => p.name).join(', ') || 'no places'}; {sheet.items.map((p) => p.name).join(', ') || 'no items'}
        <Help text="Characters, places and items are changed in the Cast & places section once the plan is made." />
      </div>
    </div>
  );
}
