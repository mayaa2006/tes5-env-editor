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

/** Free online services with the OpenAI-style API, for the settings' quick picks. */
export const OPENAI_PRESETS: { id: string; label: string; url: string; model: string; keyUrl?: string; note: string }[] = [
  { id: 'gemini', label: 'Google Gemini (free tier)', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey', note: 'Free key from Google AI Studio; daily limits apply.' },
  { id: 'groq', label: 'Groq (free tier)', url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', note: 'Free key; fast, with per-minute limits.' },
  { id: 'openrouter', label: 'OpenRouter (free models)', url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', keyUrl: 'https://openrouter.ai/keys', note: 'Free key; pick a model ending in ":free".' },
  { id: 'lmstudio', label: 'LM Studio (on this computer)', url: 'http://localhost:1234/v1', model: '', note: 'Start its local server; no key needed.' },
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
      schema ? `Answer with only one JSON object (no other text, no code fences) that matches this JSON schema. Fill in every field; use null or [] where nothing applies.\n\n${JSON.stringify(schema)}` : '',
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
      // Ollama's own API: the JSON schema constrains the answer, and the context is made big enough for the load order list.
      const r = await call(`${(p.url || OLLAMA_URL).replace(/\/+$/, '')}/api/chat`, {
        model: p.model,
        messages,
        stream: false,
        format: schema ?? 'json',
        options: { num_ctx: 32768, temperature: 0.3 },
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

/** Open models often wrap JSON in code fences or think aloud first: keep just the JSON object. */
export function cleanJson(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}
