/**
 * Which AI plans quests and writes journals: Claude (best, needs a paid
 * Anthropic key), a free model on this computer through Ollama, or a free
 * online service with the OpenAI-style API. Kept in the settings.
 */
import { useEffect, useState } from 'react';
import { OLLAMA_URL, OPENAI_PRESETS, aiName, aiReady, pickModel, type AiProvider } from '@tes5/workspace';
import { useStore } from '../state/store';
import { Field, Help, Icon } from './ui';

/** The chosen AI, whether it's set up, and what to call it. */
export function useAi(): { ai: AiProvider; ready: boolean; name: string } {
  const s = useStore((st) => st.settings);
  const ai: AiProvider =
    s.aiKind === 'ollama'
      ? { kind: 'ollama', url: s.ollamaUrl || OLLAMA_URL, model: s.ollamaModel }
      : s.aiKind === 'openai'
        ? { kind: 'openai', url: s.openaiUrl, apiKey: s.openaiKey || undefined, model: s.openaiModel }
        : { kind: 'claude', apiKey: s.anthropicApiKey };
  return { ai, ready: aiReady(ai), name: aiName(ai) };
}

const KINDS = [
  { id: 'claude', label: 'Claude', title: "Anthropic's Claude: the best plans. Needs your own Anthropic API key (paid)." },
  { id: 'ollama', label: 'Free on this PC', title: 'An open model running on your own computer through Ollama: free, private, works offline. Needs a fairly strong PC.' },
  { id: 'openai', label: 'Free online', title: 'A free online service with the OpenAI-style API (Google Gemini, Groq, OpenRouter…), or LM Studio on this computer.' },
] as const;

/** A one-line summary with a Change button, or the full settings while choosing. */
export function AiPicker() {
  const { ready, name } = useAi();
  const [open, setOpen] = useState(!ready);
  if (!open && ready)
    return (
      <div className="row small dim" style={{ gap: 6 }} data-testid="ai-summary">
        <Icon name="check" size={12} /> Planning with {name}
        <Help text="Your text and a list of the characters, places, voices and races in your load order are sent to this AI to make the plan. Nothing is built until you've checked it." />
        <span className="grow" />
        <button className="btn small ghost" onClick={() => setOpen(true)} data-testid="ai-change">
          Change AI
        </button>
      </div>
    );
  return <AiSettings onDone={ready ? () => setOpen(false) : undefined} />;
}

export function AiSettings({ onDone }: { onDone?: () => void }) {
  const s = useStore((st) => st.settings);
  const update = useStore((st) => st.updateSettings);
  const { ready } = useAi();
  return (
    <div className="col" style={{ gap: 8 }} data-testid="ai-settings">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="small dim">AI to use:</span>
        {KINDS.map((k) => (
          <button key={k.id} className={`btn small ${s.aiKind === k.id ? 'active' : 'ghost'}`} aria-pressed={s.aiKind === k.id} title={k.title} onClick={() => update({ aiKind: k.id })} data-testid={`ai-kind-${k.id}`}>
            {k.label}
          </button>
        ))}
        <span className="grow" />
        {onDone && ready && (
          <button className="btn small" onClick={onDone} data-testid="ai-done">
            Done
          </button>
        )}
      </div>
      {s.aiKind === 'claude' && <ClaudeFields />}
      {s.aiKind === 'ollama' && <OllamaFields />}
      {s.aiKind === 'openai' && <OpenAiFields />}
    </div>
  );
}

function ClaudeFields() {
  const key = useStore((st) => st.settings.anthropicApiKey);
  const update = useStore((st) => st.updateSettings);
  return (
    <Field
      label="Anthropic API key"
      title="Claude plans the quest through Anthropic's API, using your own key (create one at console.anthropic.com). The key is stored on this computer only. Your text and a list of the characters, places, voices and races in your load order are sent to Anthropic to make the plan."
    >
      <input className="input mono grow" type="password" placeholder="sk-ant-…" defaultValue={key} data-testid="api-key" onBlur={(e) => update({ anthropicApiKey: e.target.value.trim() })} />
    </Field>
  );
}

function OllamaFields() {
  const s = useStore((st) => st.settings);
  const update = useStore((st) => st.updateSettings);
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setError(null);
    const c = useStore.getState().client;
    try {
      const list = (await c?.call('ollamaModels', s.ollamaUrl || OLLAMA_URL)) ?? [];
      setModels(list);
      if (!s.ollamaModel && list[0]) update({ ollamaModel: list[0] });
    } catch (e) {
      setModels([]);
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, [s.ollamaUrl]);
  return (
    <>
      <Field label="Model" title="An open model installed in Ollama. Bigger models (14B and up, e.g. qwen3:14b) make much better plans than small ones.">
        <div className="row" style={{ gap: 6 }}>
          <input className="input mono grow" list="ollama-models" value={s.ollamaModel} placeholder="e.g. qwen3:14b" onChange={(e) => update({ ollamaModel: e.target.value.trim() })} data-testid="ollama-model" />
          <datalist id="ollama-models">
            {(models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button className="btn small ghost" onClick={() => void refresh()} title="Look again for Ollama and its installed models" data-testid="ollama-refresh">
            <Icon name="redo" size={12} /> Refresh
          </button>
        </div>
      </Field>
      <Field label="Address" title="Where Ollama listens. Only change this if you run it somewhere else.">
        <input className="input mono grow" defaultValue={s.ollamaUrl} placeholder={OLLAMA_URL} onBlur={(e) => update({ ollamaUrl: e.target.value.trim() || OLLAMA_URL })} data-testid="ollama-url" />
      </Field>
      {models && models.length > 0 && <p className="dim small" style={{ margin: 0 }} data-testid="ollama-found">{`Installed: ${models.join(', ')}`}</p>}
      {(error || (models && !models.length)) && (
        <div className="dim small" data-testid="ollama-help">
          {error ? `${error} ` : 'Ollama is running but has no models yet. '}To set it up (free):
          <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>
              Install Ollama (
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer" title="Opens ollama.com/download in your browser" data-testid="ollama-download">
                download ↗
              </a>
              ) and start it.
            </li>
            <li>
              In a terminal, run <code>ollama pull qwen3:14b</code> (about 9 GB; <code>qwen3:8b</code> for smaller PCs).
            </li>
            <li>Click Refresh.</li>
          </ol>
        </div>
      )}
      <p className="dim small" style={{ margin: 0 }}>
        Runs on your computer: nothing leaves it. Free models are smaller than Claude, so the app plans in steps: the quest first, then each conversation and the journal are rewritten one at a time, and anything that would leave the quest stuck is sent back to be fixed. That takes a few minutes, and plans can still need some fixing.
      </p>
    </>
  );
}

function OpenAiFields() {
  const s = useStore((st) => st.settings);
  const update = useStore((st) => st.updateSettings);
  const preset = OPENAI_PRESETS.find((p) => p.url === s.openaiUrl);
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Ask the service what it offers now (also checks the key); keep the chosen model if it's still there.
  const find = async (url = s.openaiUrl, key = s.openaiKey) => {
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      const list = (await useStore.getState().client?.call('aiServiceModels', url, key || undefined)) ?? [];
      setModels(list);
      const model = useStore.getState().settings.openaiModel;
      if (list.length && !list.includes(model)) update({ openaiModel: pickModel(list, preset?.model ?? model) });
    } catch (e) {
      setModels(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (s.openaiUrl && (s.openaiKey || /localhost|127\.0\.0\.1/.test(s.openaiUrl))) void find();
  }, [s.openaiUrl, s.openaiKey]);
  return (
    <>
      <Field label="Service" title="Fills in the address and a model. You can change both.">
        <select
          className="input"
          value={preset?.id ?? ''}
          onChange={(e) => {
            const p = OPENAI_PRESETS.find((x) => x.id === e.target.value);
            if (p) {
              setModels(null);
              update({ openaiUrl: p.url, openaiModel: p.model });
            }
          }}
          data-testid="openai-preset"
        >
          <option value="">Other (type the address)</option>
          {OPENAI_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      {preset && (
        <p className="dim small" style={{ margin: 0 }} data-testid="openai-preset-note">
          {preset.note}{' '}
          {preset.keyUrl && (
            <a href={preset.keyUrl} target="_blank" rel="noreferrer" title={`Opens ${preset.keyUrl} in your browser`} data-testid="openai-key-link">
              {preset.id === 'lmstudio' ? 'Get LM Studio' : 'Get a free key'} ↗
            </a>
          )}
        </p>
      )}
      <Field label="API key" title="Stored on this computer only. Leave empty for services that don't need one (like LM Studio).">
        <input className="input mono grow" type="password" defaultValue={s.openaiKey} key={s.openaiUrl} placeholder={preset?.id === 'lmstudio' ? 'Not needed' : 'Paste the key from the service'} onBlur={(e) => update({ openaiKey: e.target.value.trim() })} data-testid="openai-key" />
      </Field>
      <Field label="Model" title="Which of the service's models plans the quest. The list comes from the service itself, so it's always current.">
        <div className="row" style={{ gap: 6 }}>
          {models && models.length ? (
            <select className="input grow mono" value={models.includes(s.openaiModel) ? s.openaiModel : ''} onChange={(e) => update({ openaiModel: e.target.value })} data-testid="openai-model">
              {!models.includes(s.openaiModel) && <option value="">Pick a model</option>}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input className="input mono grow" value={s.openaiModel} placeholder="Press Find models" onChange={(e) => update({ openaiModel: e.target.value.trim() })} data-testid="openai-model" />
          )}
          <button className="btn small ghost" disabled={!s.openaiUrl || busy} onClick={() => void find()} title="Ask the service which models it offers now (this also checks your key)" data-testid="openai-find-models">
            <Icon name="redo" size={12} /> {busy ? 'Looking…' : 'Find models'}
          </button>
        </div>
      </Field>
      {models && <p className="dim small" style={{ margin: 0 }} data-testid="openai-found">{models.length ? `Key works: ${models.length} model(s) available.` : 'The service lists no usable models for this key.'}</p>}
      {error && (
        <p className="small" style={{ margin: 0, color: 'var(--warn, #e0a040)' }} data-testid="openai-error">
          {error}
        </p>
      )}
      <Field label="API address" title="Where the app sends requests. This is not a web page: opening it in a browser shows an error, which is normal.">
        <input className="input mono grow" value={s.openaiUrl} placeholder="https://…/v1" onChange={(e) => update({ openaiUrl: e.target.value.trim() })} data-testid="openai-url" />
      </Field>
      <p className="dim small" style={{ margin: 0 }}>
        The API address is for the app, not a web page. Your text and a list of the characters, places, voices and races in your load order are sent to this service. Free tiers have daily limits. The app plans in steps (the quest, then each conversation and the journal), so one plan uses several requests; plans can need more fixing than Claude's.
      </p>
    </>
  );
}

