/**
 * The built-in free AI's settings: pick a model, download it (the program
 * that runs it comes with the first one), and see whether it's running and on
 * what. Downloads and the server live in the engine (LocalAi); progress comes
 * as localAi events.
 */
import { useEffect, useState } from 'react';
import { LLAMA_CPP, LOCAL_MODELS, formatBytes, type LocalAiStatus, type LocalModel } from '@tes5/workspace';
import { useStore } from '../state/store';
import { Help, Icon, Select } from './ui';

export function useLocalAi(): [LocalAiStatus | null, (s: LocalAiStatus) => void] {
  const client = useStore((st) => st.client);
  const [status, setStatus] = useState<LocalAiStatus | null>(null);
  useEffect(() => {
    if (!client) return;
    void client
      .call('localAiStatus')
      .then(setStatus)
      .catch(() => setStatus(null));
    return client.onEvent((e) => {
      if (e.type === 'localAi') setStatus(e.status);
    });
  }, [client]);
  return [status, setStatus];
}

export function LocalAiFields() {
  const s = useStore((st) => st.settings);
  const update = useStore((st) => st.updateSettings);
  const client = useStore((st) => st.client);
  const toast = useStore((st) => st.toast);
  const [status, setStatus] = useLocalAi();
  const [busy, setBusy] = useState(false);
  // A model already on this PC is used without pressing Use first (the first one listed, when none is picked or the picked one was removed).
  useEffect(() => {
    if (!status?.installed.length || status.installed.includes(s.localModel)) return;
    const first = LOCAL_MODELS.find((m) => status.installed.includes(m.id));
    if (first) update({ localModel: first.id });
  }, [status, s.localModel, update]);
  const call = async (method: 'localAiInstall' | 'localAiRemove' | 'localAiStart' | 'localAiStop' | 'localAiSetDevice', ...args: unknown[]) => {
    try {
      const r = (await (client as unknown as { call(m: string, ...a: unknown[]): Promise<unknown> } | null)?.call(method, ...args)) as LocalAiStatus | undefined;
      if (r && typeof r === 'object' && 'installed' in r) setStatus(r);
      return true;
    } catch (e) {
      toast('error', (e as Error).message);
      return false;
    }
  };
  const download = async (m: LocalModel) => {
    if (await call('localAiInstall', m.id)) {
      if (!s.localModel) update({ localModel: m.id });
      toast('success', `${m.label} is ready to use.`);
    }
  };
  const remove = async (m: LocalModel) => {
    if (!window.confirm(`Delete ${m.label} (${formatBytes(m.size)}) from this computer? You can download it again later.`)) return;
    await call('localAiRemove', m.id);
  };
  const start = async () => {
    setBusy(true);
    await call('localAiStart', s.localModel);
    setBusy(false);
  };

  if (status && !status.supported)
    return (
      <p className="dim small" style={{ margin: 0 }} data-testid="local-unsupported">
        The built-in AI runs in the Windows app: it downloads a small AI and the program that runs it, and starts it when needed. Here, use <b>Free online</b>, or <b>Ollama</b> if you have it.
      </p>
    );
  const installed = new Set(status?.installed ?? []);
  const dl = status?.download;
  const server = status?.server;
  const current = LOCAL_MODELS.find((m) => m.id === s.localModel);
  return (
    <div className="col" style={{ gap: 6 }} data-testid="local-ai">
      {!LOCAL_MODELS.length && <p className="dim small">No models are listed yet.</p>}
      <div className="col" style={{ gap: 4 }}>
        {LOCAL_MODELS.map((m) => {
          const have = installed.has(m.id);
          const using = s.localModel === m.id;
          const here = dl && dl.model === m.id;
          return (
            <div key={m.id} className={`local-model ${using ? 'selected' : ''}`} data-testid={`local-model-${m.id}`}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <b title={`${m.file} from huggingface.co/${m.repo} · licence: ${m.license}`}>{m.label}</b>
                {m.recommended && <span className="chip">Recommended</span>}
                <span className="dim small" title="Download size, and about how much free memory it needs while it runs">
                  {formatBytes(m.size)} · needs about {m.memoryGb} GB of memory
                </span>
                <span className="grow" />
                {have ? (
                  <>
                    {using ? (
                      <span className="chip" data-testid="local-in-use">
                        <Icon name="check" size={11} /> In use
                      </span>
                    ) : (
                      <button className="btn small" onClick={() => update({ localModel: m.id })} title={`Use ${m.label} for the AI tab, quest plans and journals`} data-testid="local-use">
                        Use
                      </button>
                    )}
                    <button className="btn small ghost" onClick={() => void remove(m)} title={`Delete the downloaded file (${formatBytes(m.size)}). You can download it again later.`} data-testid="local-remove">
                      Remove
                    </button>
                  </>
                ) : here ? (
                  <button className="btn small ghost" onClick={() => void client?.call('localAiCancel')} title="Stop downloading. What's downloaded so far is kept, so it carries on from there next time." data-testid="local-cancel">
                    Cancel
                  </button>
                ) : (
                  <button
                    className="btn small"
                    disabled={!!dl}
                    onClick={() => void download(m)}
                    title={`Download ${formatBytes(m.size)} from Hugging Face${status?.runtimeInstalled ? '' : ', and the program that runs it (llama.cpp, from GitHub) the first time'}. It can carry on later if it's interrupted.`}
                    data-testid="local-download"
                  >
                    <Icon name="download" size={12} /> Download
                  </button>
                )}
              </div>
              <div className="dim small">{m.about}</div>
              {here && (
                <div className="row" style={{ gap: 6 }} data-testid="local-progress">
                  <progress className="grow" max={dl.total || 1} value={dl.what === 'checking' ? undefined : dl.done} />
                  <span className="small dim">{dl.what === 'checking' ? 'Checking…' : `${dl.what === 'runtime' ? 'AI runner' : 'Model'}: ${formatBytes(dl.done)}${dl.total ? ` of ${formatBytes(dl.total)}` : ''}`}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="row small" style={{ gap: 6 }}>
        <span className="dim" title="A graphics card makes the AI several times faster. On some PCs a long job can make Windows reset the card, which turns the screen black; the processor never does that.">
          Run it on
        </span>
        <div style={{ width: 300 }} data-testid="local-device">
          <Select
            value={s.localDevice}
            options={[
              { value: 'auto', label: 'The graphics card if there is one (faster)' },
              { value: 'processor', label: 'The processor only (slower, never affects the screen)' },
            ]}
            onChange={(localDevice) => {
              update({ localDevice });
              void call('localAiSetDevice', localDevice);
            }}
          />
        </div>
        <Help text="The graphics card makes the AI several times faster. If the screen goes black or flickers while the AI works (Windows resets a graphics card that's kept busy too long), choose the processor. The AI starts again on the new choice the next time it's needed." />
      </div>
      {status?.movedOffGpu && s.localDevice === 'auto' && (
        <div className="small" style={{ color: 'var(--warn, #e0a040)' }} data-testid="local-moved-off-gpu">
          The graphics card stopped responding while the AI was using it, so the AI runs on the processor for now. Choose the processor above to keep it that way, or the graphics card to try it again.
        </div>
      )}
      {current && installed.has(current.id) && (
        <div className="row small" style={{ gap: 6 }} data-testid="local-server">
          <span className={server?.state === 'error' ? '' : 'dim'} style={server?.state === 'error' ? { color: 'var(--warn, #e0a040)' } : undefined}>
            {server?.state === 'running' && server.model === current.id
              ? server.device === 'processor'
                ? `${current.label} is running on the processor. It works, but a graphics card would make it several times faster.`
                : `${current.label} is running on your graphics card (${server.device}).`
              : server?.state === 'starting'
                ? `Starting ${current.label}…`
                : server?.state === 'error'
                  ? server.error
                  : `${current.label} starts when the AI is first needed (loading takes a few seconds).`}
          </span>
          <span className="grow" />
          {server?.state === 'running' ? (
            <button className="btn small ghost" onClick={() => void call('localAiStop')} title="Stop the AI and free its memory. It starts again when it's next needed." data-testid="local-stop">
              Stop
            </button>
          ) : (
            <button className="btn small ghost" disabled={busy || server?.state === 'starting'} onClick={() => void start()} title="Load the model now, so the first message doesn't wait for it" data-testid="local-start">
              Start now
            </button>
          )}
        </div>
      )}
      <p className="dim small" style={{ margin: 0 }}>
        Runs on your computer: nothing you write leaves it, and it works offline once downloaded. These are small models, so they're slower and make more mistakes than Claude: give them one clear job at a time.
        {status?.folder && (
          <>
            {' '}
            <Help text={`Downloads are kept in ${status.folder}. The model comes from Hugging Face and is checked after downloading; the program that runs it is llama.cpp (release ${LLAMA_CPP.tag}) from GitHub.`} />
          </>
        )}
      </p>
    </div>
  );
}
