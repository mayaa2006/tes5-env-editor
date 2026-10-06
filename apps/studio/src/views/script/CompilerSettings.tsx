/** Which Papyrus compiler to use (shown from the Scripts tab). */
import { Field, Select, TextInput } from '../../components/ui';
import { useStore } from '../../state/store';

export function CompilerSettings() {
  const client = useStore((s) => s.client);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return (
    <div className="col" style={{ gap: 6 }}>
      <Field label="Compiler">
        <Select
          value={settings.compilerKind}
          options={[
            { value: 'papyrus-compiler', label: 'PapyrusCompiler.exe (Creation Kit)' },
            { value: 'caprica', label: 'Caprica' },
          ]}
          onChange={(compilerKind) => update({ compilerKind })}
        />
      </Field>
      <Field label="Path">
        <div className="row" style={{ gap: 4 }}>
          <div className="grow">
            <TextInput value={settings.compilerPath} onCommit={(compilerPath) => update({ compilerPath })} placeholder="…\Skyrim Special Edition\Papyrus Compiler\PapyrusCompiler.exe" mono />
          </div>
          {client?.canPickFolders && (
            <button
              className="btn small"
              onClick={async () => {
                const p = await client.openFile('Papyrus compiler', [{ name: 'Executable', extensions: ['exe'] }]);
                if (p) update({ compilerPath: p });
              }}
            >
              Browse…
            </button>
          )}
        </div>
      </Field>
      <div className="dim small">The language service (errors as you type, completion) works without a compiler. Compiling needs the CK's script sources (Scripts.zip) extracted into Data.</div>
    </div>
  );
}
