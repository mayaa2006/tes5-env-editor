/** Test launch: save, then jump into the game at a place and quest stage. */
import { useState } from 'react';
import type { FormKey } from '@tes5/esp';
import { Checkbox, DragNumber, Field, FormPicker, Icon, Modal, Select, TextInput, useQuery } from '../components/ui';
import { engine, useStore } from '../state/store';

export function TestLaunchDialog({ onClose }: { onClose: () => void }) {
  const client = useStore((s) => s.client);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const session = useStore((s) => s.session);
  const [cell, setCell] = useState<FormKey | null>(useStore.getState().cell ?? null);
  const [quest, setQuest] = useState<FormKey | null>(useStore.getState().quest ?? null);
  const [stage, setStage] = useState<number | null>(null);
  const [replay, setReplay] = useState(true);
  const [god, setGod] = useState(false);
  const [items, setItems] = useState<{ item: FormKey; count: number }[]>([]);
  const [launch, setLaunch] = useState(client?.mode === 'electron');
  const [result, setResult] = useState<{ lines: string[]; consoleCommand: string; batPath: string; launched: boolean; how?: string } | null>(null);
  const { data: graph } = useQuery(() => (quest ? client?.call('questGraph', quest) : undefined), [quest], { revision: false });
  const viaMo2 = session.source?.startsWith('MO2');

  const go = async () => {
    const st = useStore.getState().settings;
    const r = await engine(
      async (c) => {
        if (session.activePlugin) await c.call('save', { removeItms: st.autoCleanOnSave, updateBounds: st.updateBoundsOnSave, generateSeq: st.generateSeqOnSave, generateFaces: st.generateFacesOnSave, compileScripts: st.autoCompileOnSave });
        return c.call('testLaunch', { cell, quest, stage, replayStages: replay, items, godMode: god, launch, mo2Executable: st.mo2Executable, mo2Exe: st.mo2Exe });
      },
      { busy: launch ? 'Saving and starting the game…' : 'Saving…' },
    );
    if (r) setResult(r);
  };

  if (result)
    return (
      <Modal
        title={result.launched ? 'The game is starting' : 'Ready to test'}
        onClose={onClose}
        footer={
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        }
      >
        <p style={{ marginTop: 0 }}>
          {result.launched ? `Started via ${result.how}. ` : ''}Once you’re in the game (load any save or start a new game), open the console with <span className="kbd">~</span> and type:
        </p>
        <div className="row" style={{ gap: 6 }}>
          <code className="input mono grow" style={{ fontSize: 15 }} data-testid="console-command">
            {result.consoleCommand}
          </code>
          <button className="btn small" onClick={() => void navigator.clipboard?.writeText(result.consoleCommand)}>
            <Icon name="copy" size={12} /> Copy
          </button>
        </div>
        <p className="dim small">It runs these commands (written to {result.batPath}):</p>
        <pre className="mono small code-frame" style={{ padding: 8 }} data-testid="test-commands">
          {result.lines.join('\n')}
        </pre>
      </Modal>
    );

  return (
    <Modal
      title="Test in game"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go} disabled={!cell && !quest && !items.length} data-testid="test-go">
            <Icon name="play" size={12} /> {launch ? 'Save & start game' : 'Save & prepare'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 8 }}>
        <Field label="Start in">
          <FormPicker value={cell} sigs={['CELL']} onChange={setCell} placeholder="Wherever the save puts you" />
        </Field>
        <Field label="Quest">
          <FormPicker
            value={quest}
            sigs={['QUST']}
            onChange={(q) => {
              setQuest(q);
              setStage(null);
            }}
            placeholder="None"
          />
        </Field>
        {quest && (
          <>
            <Field label="Jump to stage">
              <Select value={stage ?? -1} options={[{ value: -1, label: 'Just start the quest' }, ...(graph?.nodes ?? []).map((n) => ({ value: n.stage, label: `${n.stage}${n.text ? ` — ${n.text.slice(0, 50)}` : ''}` }))]} onChange={(v) => setStage(v < 0 ? null : v)} />
            </Field>
            {stage !== null && <Checkbox checked={replay} onChange={setReplay} label="Also run the stages on the way there (so their scripts and objectives happen)" />}
          </>
        )}
        <Field label="Give the player">
          <div className="col" style={{ gap: 4 }}>
            {items.map((it, i) => (
              <div key={i} className="row" style={{ gap: 4 }}>
                <div style={{ width: 70 }}>
                  <DragNumber value={it.count} min={1} precision={0} onCommit={(count) => setItems(items.map((x, j) => (j === i ? { ...x, count } : x)))} />
                </div>
                <div className="grow">
                  <FormPicker value={it.item} sigs={['MISC', 'WEAP', 'ARMO', 'BOOK', 'KEYM', 'ALCH', 'INGR', 'AMMO', 'SLGM', 'SCRL']} onChange={(item) => item && setItems(items.map((x, j) => (j === i ? { ...x, item } : x)))} allowNone={false} />
                </div>
                <button className="btn icon ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            <FormPicker value={null} sigs={['MISC', 'WEAP', 'ARMO', 'BOOK', 'KEYM', 'ALCH', 'INGR', 'AMMO', 'SLGM', 'SCRL']} onChange={(item) => item && setItems([...items, { item, count: 1 }])} placeholder="+ Add an item" />
          </div>
        </Field>
        <Checkbox checked={god} onChange={setGod} label="God mode (tgm)" help="You can't be hurt and have unlimited magicka and stamina, so testing isn't interrupted." />
        <Checkbox checked={launch} onChange={setLaunch} disabled={client?.mode !== 'electron'} label={client?.mode === 'electron' ? `Start the game now${viaMo2 ? ' through Mod Organizer 2' : ''}` : 'Start the game (not in the demo)'} />
        {launch && viaMo2 && (
          <div className="row" style={{ gap: 6 }}>
            <span className="dim small">MO2 executable</span>
            <div style={{ width: 140 }}>
              <TextInput value={settings.mo2Executable} onCommit={(mo2Executable) => update({ mo2Executable })} />
            </div>
            <div className="grow">
              <TextInput value={settings.mo2Exe} onCommit={(mo2Exe) => update({ mo2Exe })} placeholder="ModOrganizer.exe path (if not in the instance folder)" />
            </div>
          </div>
        )}
        <p className="dim small" style={{ margin: 0 }}>
          Skyrim can’t run commands on its own at start-up, so after loading into the game you type one console command. Your plugin is saved first.
        </p>
      </div>
    </Modal>
  );
}
