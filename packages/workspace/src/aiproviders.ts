/**
 * Which AI writes quest plans and journals. Claude (Anthropic's API, with the
 * author's own key) is the default; free alternatives are Ollama, which runs
 * open models on the author's own computer (no key, no cost, no internet),
 * and any service with the common OpenAI-style chat API (Google Gemini's free
 * tier, Groq, OpenRouter's free models, LM Studio on this computer…).
 *
 * The planner builds one request in Anthropic's format; for the others it is
 * turned into a plain chat request that asks for JSON matching the same
 * schema, and the answer is turned back into the reply the planner reads.
 */
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { WorkspaceError } from './engine';

export type AiProvider =
  | { kind: 'claude'; apiKey: string }
  | { kind: 'ollama'; url?: string; model: string }
  | { kind: 'openai'; url: string; apiKey?: string; model: string };

export const OLLAMA_URL = 'http://localhost:11434';

/**
 * Free online services with the OpenAI-style API, for the settings' quick picks.
 * `url` is the API address the app talks to (not a web page); `keyUrl` is the
 * web page where a free key is made. The model is only a starting point: the
 * app asks the service for its current models (free models come and go).
 */
export const OPENAI_PRESETS: { id: string; label: string; url: string; model: string; keyUrl?: string; note: string }[] = [
  { id: 'gemini', label: 'Google Gemini (free tier)', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', keyUrl: 'https://aistudio.google.com/apikey', note: 'Sign in with a Google account and press "Create API key". Free, with daily limits.' },
  { id: 'groq', label: 'Groq (free tier)', url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', note: 'Make a free account and press "Create API Key". Fast, with per-minute and daily limits.' },
  { id: 'openrouter', label: 'OpenRouter (free models)', url: 'https://openrouter.ai/api/v1', model: '', keyUrl: 'https://openrouter.ai/settings/keys', note: 'Make a free account and create a key. Only models ending in ":free" are listed; they change often.' },
  { id: 'lmstudio', label: 'LM Studio (on this computer)', url: 'http://localhost:1234/v1', model: '', keyUrl: 'https://lmstudio.ai', note: 'Install LM Studio, download a model in it and start its local server (Developer tab). No key needed.' },
];

/** What to call the AI in messages ("Claude", "qwen3 (Ollama)"…). */
export function aiName(p: AiProvider | undefined): string {
  if (!p || p.kind === 'claude') return 'Claude';
  if (p.kind === 'ollama') return `${p.model || 'Ollama'}${p.model ? ' (Ollama)' : ''}`;
  return p.model || hostOf(p.url) || 'the AI';
}

/** Is it set up enough to try? */
export function aiReady(p: AiProvider | undefined): boolean {
  if (!p) return false;
  if (p.kind === 'claude') return !!p.apiKey.trim();
  if (p.kind === 'ollama') return !!p.model.trim();
  return !!p.url.trim() && !!p.model.trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** The planner's reply shape (see planner.ts). */
interface Reply {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

/** Turn the planner's Anthropic-format request into one chat request for Ollama or an OpenAI-style service. */
export function chatSend(p: Exclude<AiProvider, { kind: 'claude' }>, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): (params: BetaMessageStreamParams) => Promise<Reply> {
  return async (params) => {
    const schema = (params.output_config?.format as { schema?: unknown } | undefined)?.schema;
    const system = [
      ...(Array.isArray(params.system) ? params.system.map((b) => b.text) : params.system ? [params.system] : []),
      schema ? `Answer with only one JSON object (no other text, no code fences) with these fields. Fill in every field; use null or [] where nothing applies.\n\n${schemaGuide(schema)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const messages = [
      { role: 'system', content: system },
      ...params.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map((b) => ('text' in b ? b.text : '')).join('') })),
    ];
    const name = aiName(p);
    const call = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      } catch {
        throw new WorkspaceError(p.kind === 'ollama' ? `Couldn't reach Ollama at ${p.url || OLLAMA_URL}. Is it installed and running?` : `Couldn't reach ${hostOf(p.url) || p.url}. Check the address and your internet connection.`);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        if (res.status === 401 || res.status === 403) throw new WorkspaceError(`${hostOf(p.kind === 'ollama' ? p.url || OLLAMA_URL : p.url)} rejected the API key. Check it in the AI settings.`);
        if (res.status === 404 && p.kind === 'ollama') throw new WorkspaceError(`Ollama doesn't have the model "${p.model}". Run "ollama pull ${p.model}" first, or pick an installed model.`);
        if (res.status === 429) throw new WorkspaceError(`Too many requests to ${name} right now (free tiers have limits). Wait a minute and try again.`);
        const err = new WorkspaceError(`${name} couldn't plan this (${res.status}): ${detail}`);
        (err as WorkspaceError & { status?: number }).status = res.status;
        throw err;
      }
      return res.json();
    };
    if (p.kind === 'ollama') {
      // Ollama's own API: the JSON schema constrains the answer. Ollama cuts a prompt that doesn't fit its
      // window without saying so, so the window is sized to the prompt, within what the model can read.
      const base = (p.url || OLLAMA_URL).replace(/\/+$/, '');
      const promptTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
      const max = await ollamaContextLength(base, p.model, fetchImpl);
      if (max && promptTokens + MIN_ANSWER_TOKENS > max)
        throw new WorkspaceError(
          `This is too long for ${p.model}: it reads about ${max.toLocaleString('en')} tokens and this needs about ${(promptTokens + MIN_ANSWER_TOKENS).toLocaleString('en')} (your text, the rules and the load-order list). Pick a model that reads more (the model's page on ollama.com lists its context), or shorten the text.`,
        );
      const r = await call(`${base}/api/chat`, {
        model: p.model,
        messages,
        stream: false,
        format: schema ?? 'json',
        options: { num_ctx: contextWindow(promptTokens, max), temperature: 0.3 },
      });
      return { content: [{ type: 'text', text: cleanJson(String(r?.message?.content ?? '')) }], stop_reason: r?.done_reason === 'length' ? 'max_tokens' : 'end_turn' };
    }
    const url = `${p.url.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {};
    const base = { model: p.model, messages, temperature: 0.3, max_tokens: Math.min(params.max_tokens ?? 16000, 32000) };
    let r;
    try {
      r = await call(url, { ...base, response_format: schema ? { type: 'json_schema', json_schema: { name: 'answer', schema, strict: false } } : { type: 'json_object' } }, headers);
    } catch (e) {
      // Not every service or model takes a schema; plain JSON mode (the schema is in the instructions too) is the fallback.
      if ((e as { status?: number }).status !== 400) throw e;
      r = await call(url, { ...base, response_format: { type: 'json_object' } }, headers);
    }
    const choice = r?.choices?.[0];
    return { content: [{ type: 'text', text: cleanJson(String(choice?.message?.content ?? '')) }], stop_reason: choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn' };
  };
}

/** Room left for the answer: a whole quest plan is a few thousand tokens. */
const MIN_ANSWER_TOKENS = 6000;
const ANSWER_TOKENS = 12000;

/** A safe guess at a text's length in tokens (English and JSON run at about 3.5–4 characters a token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** The context window to ask Ollama for: the prompt plus room for the answer, within what the model reads. */
export function contextWindow(promptTokens: number, max: number | null): number {
  const want = Math.max(8192, Math.ceil((promptTokens + ANSWER_TOKENS) / 2048) * 2048);
  return max ? Math.min(max, want) : want;
}

const contextLengths = new Map<string, number | null>();

/** How many tokens an Ollama model can read (its context length), or null if Ollama doesn't say. */
export async function ollamaContextLength(url: string, model: string, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): Promise<number | null> {
  const id = `${url}|${model}`;
  if (contextLengths.has(id)) return contextLengths.get(id)!;
  let n: number | null = null;
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
    if (res.ok) {
      const info = ((await res.json())?.model_info ?? {}) as Record<string, unknown>;
      const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
      n = key && typeof info[key] === 'number' ? (info[key] as number) : null;
    }
  } catch {
    // Unknown: the window is sized to the prompt.
  }
  if (n) contextLengths.set(id, n);
  return n;
}

/**
 * The answer's format as a short field guide (name: type — what it's for),
 * for models that are told the format in words. About half the size of the
 * JSON schema itself, and easier for small models to follow.
 */
export function schemaGuide(schema: unknown): string {
  const root = schema as { $defs?: Record<string, unknown> };
  const defs = (root.$defs ?? {}) as Record<string, any>;
  const res = (s: any): any => (s?.$ref ? res(defs[String(s.$ref).split('/').pop()!]) : s);
  const enumOf = (s: any): unknown[] | undefined => s.enum ?? (/\{enum: (\[[^\]]*\])\}/.exec(s.description ?? '') ? JSON.parse(/\{enum: (\[[^\]]*\])\}/.exec(s.description)![1]!) : undefined);
  const clean = (d?: string) => (d ?? '').replace(/\{(enum|minimum|maximum)[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
  const type = (raw: any, ind: string): string => {
    const s = res(raw) ?? {};
    if (s.anyOf) {
      const parts = (s.anyOf as any[]).map(res);
      const real = parts.filter((x) => x?.type !== 'null');
      return `${real.map((x) => type(x, ind)).join(' or ')}${real.length < parts.length ? ' or null' : ''}`;
    }
    const en = enumOf(s);
    if (en) return en.map((x) => JSON.stringify(x)).join(' | ');
    if (s.type === 'array') return `list of ${type(s.items, ind)}`;
    if (s.type === 'object') return `{\n${fields(s, `${ind}  `)}${ind}}`;
    return s.type === 'integer' ? 'whole number' : String(s.type ?? 'any');
  };
  const fields = (s: any, ind: string): string =>
    Object.entries((s.properties ?? {}) as Record<string, any>)
      .map(([k, v]) => {
        const d = clean(v.description ?? res(v)?.description);
        return `${ind}${k}: ${type(v, ind)}${d ? ` — ${d}` : ''}\n`;
      })
      .join('');
  return fields(res(schema), '').trimEnd();
}

/** Models installed in Ollama, for the picker. */
export async function ollamaModels(url = OLLAMA_URL, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): Promise<string[]> {
  let res;
  try {
    res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/tags`, { method: 'GET', headers: {} });
  } catch {
    throw new WorkspaceError(`Couldn't reach Ollama at ${url}. Install it from ollama.com and start it, then try again.`);
  }
  if (!res.ok) throw new WorkspaceError(`Ollama answered ${res.status} at ${url}`);
  const j = await res.json();
  return ((j?.models ?? []) as { name?: string; model?: string }[]).map((m) => m.name ?? m.model ?? '').filter(Boolean);
}

/**
 * The models an OpenAI-style service offers right now (GET …/models), best
 * first: on OpenRouter only free ones, with structured output first; chat
 * models only (no embedding, speech or image models).
 */
export async function serviceModels(p: { url: string; apiKey?: string }, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): Promise<string[]> {
  const base = p.url.trim().replace(/\/+$/, '');
  if (!base) throw new WorkspaceError('Fill in the service address first');
  let res;
  try {
    res = await fetchImpl(`${base}/models`, { method: 'GET', headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {} });
  } catch {
    throw new WorkspaceError(`Couldn't reach ${hostOf(base) || base}. Check the address${/localhost|127\.0\.0\.1/.test(base) ? ' and that the local server is started' : ' and your internet connection'}.`);
  }
  if (res.status === 401 || res.status === 403) throw new WorkspaceError(`${hostOf(base)} rejected the API key. Check it, or make a new one on the service's key page.`);
  if (!res.ok) throw new WorkspaceError(`${hostOf(base)} answered ${res.status} when asked for its models. Check the address.`);
  const j = await res.json();
  const list = ((j?.data ?? j?.models ?? []) as { id?: string; name?: string; supported_parameters?: string[] }[])
    .map((m) => ({ id: String(m.id ?? m.name ?? '').replace(/^models\//, ''), params: m.supported_parameters ?? [] }))
    .filter((m) => m.id && !/embed|tts|whisper|transcri|speech|audio|image|imagen|veo|guard|moderation|safety|aqa/i.test(m.id));
  const openrouter = /openrouter\.ai/i.test(base);
  const usable = openrouter ? list.filter((m) => m.id.endsWith(':free')) : list;
  const score = (m: { id: string; params: string[] }) =>
    (m.params.includes('structured_outputs') ? 4 : 0) + (m.params.includes('response_format') ? 2 : 0) + (/gemini/i.test(m.id) && /flash/i.test(m.id) && !/lite|preview|exp|thinking/i.test(m.id) ? 1 : 0);
  const version = (id: string) => Number(/(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  return usable.sort((a, b) => score(b) - score(a) || version(b.id) - version(a.id) || a.id.localeCompare(b.id)).map((m) => m.id);
}

/** The model to use from a service's list: the one asked for if it's still offered, else the best one listed. */
export function pickModel(models: string[], wanted: string): string {
  return models.includes(wanted) ? wanted : (models[0] ?? wanted);
}

/** Open models often wrap JSON in code fences or think aloud first: keep just the JSON object. */
export function cleanJson(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}
