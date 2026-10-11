/**
 * Compiling scripts, set up in one place (opened from the Scripts tab): which
 * compiler is used (Caprica, which comes with the app, unless you pick
 * another), whether the game's script sources are there (with a button to
 * unpack the Creation Kit's Scripts.zip), and compiling on save.
 */
import { useState } from 'react';
import { Checkbox, Field, Help, Icon, Select, TextInput, useQuery } from '../../components/ui';
import { engine, useStore } from '../../state/store';

/** Whether compiling is ready, and which of your scripts need it. Re-checked after every change. */
export function useBuildStatus() {
  const client = useStore((s) => s.client);
  const kind = useStore((s) => s.settings.compilerKind);
  const path = useStore((s) => s.settings.compilerPath);
  // Hand the engine the current choice first, so the answer never describes the previous one.
  const q = useQuery(async () => {
    if (!client) return undefined;
    await client.call('setCompiler', path ? { kind, executable: path } : null);
    return client.call('scriptBuildStatus');
  }, [client, kind, path]);
  const st = q.data;
  return { ...q, ready: !!st && st.desktop && !!st.compiler && st.sources.ready };
}

const KIND_LABEL = { caprica: 'Caprica', 'papyrus-compiler': "Creation Kit's PapyrusCompiler.exe" } as const;

function Step({ ok, title, children, testId }: { ok: boolean; title: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }} data-testid={testId} data-ok={ok}>
      <span style={{ color: ok ? 'var(--ok, #5fbf6f)' : 'var(--warn, #e0a040)', marginTop: 2 }}>
        <Icon name={ok ? 'check' : 'warn'} size={14} />
      </span>
      <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
        <strong className="small">{title}</strong>
        {children}
      </div>
    </div>
  );
}

export function CompilerSettings() {
  const client = useStore((s) => s.client);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const { data: st, reload } = useBuildStatus();
  const [own, setOwn] = useState(!!settings.compilerPath);
  if (!st) return <div className="dim small">Checking…</div>;
  const c = st.compiler;
  return (
    <div className="col" style={{ gap: 12 }} data-testid="compile-setup">
      {!st.desktop && (
        <p className="warn small" style={{ margin: 0 }} data-testid="compile-desktop-only">
          The demo's files only exist in memory, so its scripts can't be compiled. Open your Skyrim folder from the start screen to compile. Errors are still checked as you type.
        </p>
      )}

      <Step ok={!!c} title="1. Compiler" testId="compile-step-compiler">
        <div className="small dim">
          {c?.bundled && !c.chosen && 'Caprica, which comes with this app. It is free and open source, and needs no Creation Kit.'}
          {c && !c.bundled && !c.chosen && `The Creation Kit's PapyrusCompiler.exe, found in the game folder.`}
          {c?.chosen && `${KIND_LABEL[c.kind]}, chosen by you: ${c.executable}`}
          {!c && (st.desktop ? 'None found. Pick Caprica.exe or the Creation Kit’s PapyrusCompiler.exe below.' : 'Caprica comes with the app; nothing to install.')}
        </div>
        {!own ? (
          <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setOwn(true)} title="Use a compiler you installed yourself instead of the automatic one" data-testid="compiler-choose">
            Use a different compiler…
          </button>
        ) : (
          <>
            <Field label="Compiler" title="Caprica: free and open source, compiles many scripts at once. PapyrusCompiler.exe: Bethesda's, comes with the Creation Kit.">
              <Select
                value={settings.compilerKind}
                options={[
                  { value: 'caprica', label: 'Caprica' },
                  { value: 'papyrus-compiler', label: 'PapyrusCompiler.exe (Creation Kit)' },
                ]}
                onChange={(compilerKind) => update({ compilerKind })}
              />
            </Field>
            <Field label="Path" title="The compiler program. Leave empty to go back to the automatic one.">
              <div className="row" style={{ gap: 4 }}>
                <div className="grow">
                  <TextInput value={settings.compilerPath} onCommit={(compilerPath) => update({ compilerPath })} placeholder={settings.compilerKind === 'caprica' ? '…\\Caprica.exe' : '…\\Skyrim Special Edition\\Papyrus Compiler\\PapyrusCompiler.exe'} mono />
                </div>
                {client?.canPickFolders && (
                  <button
                    className="btn small"
                    title="Pick the compiler program"
                    onClick={async () => {
                      const p = await client.openFile('Papyrus compiler', [{ name: 'Executable', extensions: ['exe'] }]);
                      if (p) update({ compilerPath: p, compilerKind: /caprica/i.test(p) ? 'caprica' : 'papyrus-compiler' });
                    }}
                  >
                    Browse…
                  </button>
                )}
              </div>
            </Field>
            <button
              className="btn small ghost"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                update({ compilerPath: '', compilerKind: 'caprica' });
                setOwn(false);
              }}
              title="Forget the chosen compiler and use Caprica, which comes with the app"
              data-testid="compiler-automatic"
            >
              Use the automatic one
            </button>
          </>
        )}
      </Step>

      <Step ok={st.sources.ready} title="2. The game's script sources" testId="compile-step-sources">
        {st.sources.ready ? (
          <div className="small dim">Found. Your scripts can use the game's (ObjectReference, Actor, Quest…).</div>
        ) : st.sources.zip ? (
          <>
            <div className="small dim">Your scripts build on the game's own scripts. They're in Scripts.zip in Data and just need unpacking.</div>
            <button
              className="btn small primary"
              style={{ alignSelf: 'flex-start' }}
              title="Unpacks the game's script sources (.psc) from Data\Scripts.zip into Data\Source\Scripts, like “Extract here”. Files already there are kept, and the zip is left as it is."
              data-testid="unpack-sources"
              onClick={async () => {
                const n = await engine((cl) => cl.call('scriptUnpackSources'), { busy: 'Unpacking the game’s scripts…', refreshSession: false });
                if (n !== undefined) {
                  useStore.getState().toast('success', `Unpacked ${n} script file(s)`);
                  useStore.getState().bump();
                }
              }}
            >
              Unpack Scripts.zip
            </button>
          </>
        ) : (
          <>
            <div className="small dim" data-testid="sources-missing">
              Your scripts build on the game's own scripts, which come with the Creation Kit. Install it once (free: in Steam, Library → Tools → “Skyrim Special Edition: Creation Kit”). It puts Scripts.zip in Data; then press Check again and unpack it here.
            </div>
            <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={reload} title="Look again for the game's script sources and Scripts.zip" data-testid="sources-recheck">
              <Icon name="redo" size={12} /> Check again
            </button>
          </>
        )}
      </Step>

      <Checkbox
        checked={settings.autoCompileOnSave}
        onChange={(autoCompileOnSave) => update({ autoCompileOnSave })}
        label="Compile scripts that changed when saving"
        help="When you save a script or the plugin, your scripts whose source is newer than their .pex are compiled. Problems are listed; the save itself always goes through. Also in Automations."
      />
      <div className="dim small">
        Errors are checked as you type even without a compiler. The game runs the compiled .pex files, written to your mod's Scripts folder. <Help text="Caprica is a free, open-source Papyrus compiler (github.com/Orvid/Caprica, MIT license). It makes the same .pex files as the Creation Kit's compiler." />
      </div>
    </div>
  );
}
