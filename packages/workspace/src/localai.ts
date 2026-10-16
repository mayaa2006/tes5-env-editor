/**
 * The built-in free AI: a small open model that runs on the author's own PC,
 * downloaded and started by the app (no account, no separate install, works
 * offline once downloaded). It runs in llama.cpp's server, which speaks the
 * OpenAI-style API the free online services use, so it goes through the same
 * code as they do. The Node side (downloading, starting and stopping the
 * server) is in localai-node.ts.
 *
 * Every model here was tried on the AI tab's real work against Skyrim SE's
 * own data (apps/studio/test/models/model-trial.ts); the notes say how it did.
 */

/** The llama.cpp release the app downloads (its Windows Vulkan build: any graphics card, or the processor). */
export const LLAMA_CPP = {
  tag: 'b11700',
  /** The Windows x64 build: llama-server, every processor variant and the Vulkan backend. */
  windowsUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-win-vulkan-x64.zip',
  server: 'llama-server.exe',
} as const;

export interface LocalModel {
  /** Kept in the settings. */
  id: string;
  label: string;
  /** Hugging Face repository and file. */
  repo: string;
  file: string;
  /** Bytes, and the file's SHA-256 (checked after downloading). */
  size: number;
  sha256: string;
  /** How much the server reads at once (tokens). */
  context: number;
  /** About how much free memory it needs while running, in GB. */
  memoryGb: number;
  /** One line for the picker: what it's good for. */
  about: string;
  license: string;
  recommended?: boolean;
}

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'qwen3.5-4b',
    label: 'Qwen3.5 4B',
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    size: 2740937888,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    context: 32768,
    memoryGb: 5,
    about: 'PROVISIONAL',
    license: 'Apache-2.0',
    recommended: true,
  },
  {
    id: 'qwen3.5-2b',
    label: 'Qwen3.5 2B',
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    file: 'Qwen3.5-2B-Q4_K_M.gguf',
    size: 1280835840,
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
    context: 32768,
    memoryGb: 3,
    about: 'PROVISIONAL',
    license: 'Apache-2.0',
  },
];

export function localModel(id: string): LocalModel | undefined {
  return LOCAL_MODELS.find((m) => m.id === id);
}

export function modelUrl(m: LocalModel): string {
  return `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;
}

/** Sizes in words: "1.3 GB", "730 MB". */
export function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
}

/** What the host needs from the built-in AI's manager (LocalAi in localai-node.ts; absent in the browser). */
export interface LocalAiControl {
  status(): LocalAiStatus;
  install(id: string): Promise<LocalAiStatus>;
  cancel(): void;
  remove(id: string): Promise<LocalAiStatus>;
  /** Start the server for a model if needed; its OpenAI-style address. */
  ensure(id: string): Promise<string>;
  stop(): Promise<void>;
}

export interface LocalAiStatus {
  /** False where the app can't run it (the browser demo, or not Windows without a server of your own). */
  supported: boolean;
  /** Where its files are kept. */
  folder: string;
  runtimeInstalled: boolean;
  installed: string[];
  /** The download in progress: which model (its id), and whether it's the runner, the model or the final check. */
  download?: { model: string; what: 'runtime' | 'model' | 'checking'; done: number; total: number };
  server: { state: 'stopped' | 'starting' | 'running' | 'error'; model?: string; device?: string; error?: string };
}
