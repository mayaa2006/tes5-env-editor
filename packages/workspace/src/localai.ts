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

/**
 * Best first. Scores are from one run of nine jobs on Skyrim SE's data (looking
 * things up, adding a quest stage, a new item, placing an object, a trigger, a
 * dialogue line, a new quest, a character, raising a hill) on a 4-core
 * processor with no graphics card; times are per job there. Memory is what the
 * server used with a 32k context. Tried and left out: Qwen3.5 0.8B (3/9, its
 * changes were often wrong), LFM2.5 2.6B (most jobs ran out of time),
 * Phi-4-mini and SmolLM3 (they never used the tools), Granite 4.2 3B (about a
 * word a second on a processor).
 */
export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'qwen3.5-4b',
    label: 'Qwen3.5 4B',
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    size: 2740937888,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    context: 32768,
    memoryGb: 6.5,
    about: 'Did best in our tests on Skyrim\'s data (7 of 9 jobs right). About 3 minutes a job on a processor; a graphics card should be several times quicker.',
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
    about: 'Half the size, quicker (about 2 minutes a job) and almost as good (6 of 9 jobs). The one to pick on a PC with 8 GB of memory.',
    license: 'Apache-2.0',
  },
  {
    id: 'ministral-3-3b',
    label: 'Ministral 3 3B',
    repo: 'mistralai/Ministral-3-3B-Instruct-2512-GGUF',
    file: 'Ministral-3-3B-Instruct-2512-Q4_K_M.gguf',
    size: 2147023008,
    sha256: '9ed150d4367e68df0ac8e1540f6ddc65b42d0ee26378329d1ecbca60f93fc5f8',
    context: 32768,
    memoryGb: 7.5,
    about: 'From Mistral. As good as Qwen3.5 2B (6 of 9 jobs) but slower, and it needs the most memory of these.',
    license: 'Apache-2.0',
  },
  {
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    repo: 'ggml-org/gemma-4-E2B-it-GGUF',
    file: 'gemma-4-E2B-it-Q4_0.gguf',
    size: 2841481184,
    sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
    context: 32768,
    memoryGb: 4.5,
    about: 'From Google. Quick (about a minute a job) and fine for single changes, but it often stops before a bigger job is finished (5 of 9 jobs).',
    license: 'Apache-2.0',
  },
  {
    id: 'lfm2.5-1.2b',
    label: 'LFM2.5 1.2B',
    repo: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
    file: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    size: 730895168,
    sha256: 'b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5',
    context: 32768,
    memoryGb: 2,
    about: 'The smallest and quickest, for older PCs. Manages single changes such as a quest stage or a copied item, but got most jobs wrong (3 of 9).',
    license: 'LFM Open License v1.0 (free unless your company makes over $10M a year)',
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
  /** Run on a graphics card when there is one ('auto'), or never ('processor'). */
  setDevice(device: LocalAiDevice): Promise<LocalAiStatus>;
  /** The app's window lost its graphics card (Windows reset it): keep the AI off it from now on. */
  gpuLost(): Promise<void>;
}

export type LocalAiDevice = 'auto' | 'processor';

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
  /** Where it's set to run. */
  prefer?: LocalAiDevice;
  /** The graphics card failed while the AI was using it, so it runs on the processor for now (until 'auto' is chosen again). */
  movedOffGpu?: boolean;
}
