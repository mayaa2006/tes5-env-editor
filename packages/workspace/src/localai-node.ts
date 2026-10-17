/**
 * The built-in free AI's Node side: downloads llama.cpp's server and the
 * chosen model into one folder (resuming a broken download, checking the
 * model's SHA-256), starts the server on a free local port when the AI is
 * needed, and stops it when asked or when the app quits. See localai.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { WorkspaceError } from './engine';
import { LLAMA_CPP, LOCAL_MODELS, formatBytes, modelUrl, type LocalAiStatus, type LocalModel } from './localai';

type Fetch = typeof globalThis.fetch;

export interface LocalAiOptions {
  /** Where the runtime and models are kept. */
  dir: string;
  /** A llama-server to use instead of downloading one (other systems than Windows, tests). */
  serverPath?: string;
  /** Where to get the runtime (a zip with llama-server inside); default: llama.cpp's Windows release. */
  runtimeUrl?: string;
  models?: LocalModel[];
  fetch?: Fetch;
  /** Called whenever the status changes (download progress a few times a second). */
  onChange?: (s: LocalAiStatus) => void;
  /** Called when a server process starts and ends, so the app can stop it if it quits. */
  onProcess?: (pid: number, running: boolean) => void;
  /** How long to wait for the model to load. */
  startTimeoutMs?: number;
}

export class LocalAi {
  private readonly models: LocalModel[];
  private readonly fetch: Fetch;
  private download?: LocalAiStatus['download'] & { abort: AbortController };
  private server: { child: ChildProcess; model: string; url: string; log: string[]; ready: Promise<string>; device?: string } | null = null;
  private error?: string;
  private lastEmit = 0;

  constructor(private readonly opts: LocalAiOptions) {
    this.models = opts.models ?? LOCAL_MODELS;
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  private get supported() {
    return !!this.opts.serverPath || !!this.opts.runtimeUrl || process.platform === 'win32';
  }
  private get runtimeDir() {
    return join(this.opts.dir, 'runtime', LLAMA_CPP.tag);
  }
  private modelPath(m: LocalModel) {
    return join(this.opts.dir, 'models', m.file);
  }
  private model(id: string): LocalModel {
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new WorkspaceError(`There's no built-in model "${id}". Pick one in Settings → AI.`);
    return m;
  }
  private serverExe(): string | undefined {
    if (this.opts.serverPath) return this.opts.serverPath;
    const found = findFile(this.runtimeDir, LLAMA_CPP.server);
    return found;
  }

  status(): LocalAiStatus {
    const s = this.server;
    return {
      supported: this.supported,
      folder: this.opts.dir,
      runtimeInstalled: !!this.serverExe(),
      installed: this.models.filter((m) => isComplete(this.modelPath(m), m.size)).map((m) => m.id),
      ...(this.download ? { download: { model: this.download.model, what: this.download.what, done: this.download.done, total: this.download.total } } : {}),
      server: s
        ? { state: s.device === undefined ? 'starting' : 'running', model: s.model, ...(s.device ? { device: s.device } : {}) }
        : this.error
          ? { state: 'error', error: this.error }
          : { state: 'stopped' },
    };
  }

  private changed(force = true) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.opts.onChange?.(this.status());
  }

  /** Download what a model needs (the runtime the first time, then the model). One download at a time. */
  async install(id: string): Promise<LocalAiStatus> {
    if (!this.supported) throw new WorkspaceError('The built-in AI runs on Windows. On other systems, use Ollama or LM Studio (Free on this PC → Ollama, or Free online → LM Studio).');
    const m = this.model(id);
    if (this.download) throw new WorkspaceError(`Already downloading ${this.models.find((x) => x.id === this.download!.model)?.label ?? 'a model'}. Wait for it, or cancel it.`);
    const abort = new AbortController();
    this.download = { model: m.id, what: 'runtime', done: 0, total: 0, abort };
    this.error = undefined;
    try {
      if (!this.serverExe()) await this.installRuntime(abort.signal);
      if (!isComplete(this.modelPath(m), m.size)) {
        this.download.what = 'model';
        await this.fetchFile(modelUrl(m), this.modelPath(m), { size: m.size, sha256: m.sha256 }, abort.signal);
      }
    } catch (e) {
      if (abort.signal.aborted) throw new WorkspaceError('Download cancelled. What was downloaded so far is kept, so it carries on from there next time.');
      throw e;
    } finally {
      this.download = undefined;
      this.changed();
    }
    return this.status();
  }

  cancel() {
    this.download?.abort.abort();
  }

  /** Delete a downloaded model (stopping the server if it's using it). */
  async remove(id: string): Promise<LocalAiStatus> {
    const m = this.model(id);
    if (this.server?.model === id) await this.stop();
    await fsp.rm(this.modelPath(m), { force: true });
    await fsp.rm(`${this.modelPath(m)}.part`, { force: true });
    this.changed();
    return this.status();
  }

  /** The server for a model, started if needed: its OpenAI-style address. */
  async ensure(id: string): Promise<string> {
    const m = this.model(id);
    if (this.server?.model === id) return this.server.ready;
    if (!isComplete(this.modelPath(m), m.size)) throw new WorkspaceError(`${m.label} isn't downloaded yet. Download it in Settings → AI (Free on this PC).`);
    const exe = this.serverExe();
    if (!exe) throw new WorkspaceError("The AI runner (llama.cpp) isn't downloaded yet. Download a model in Settings → AI (Free on this PC) and it comes with it.");
    await this.stop();
    this.error = undefined;
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/v1`;
    const args = ['-m', this.modelPath(m), '--host', '127.0.0.1', '--port', String(port), '-c', String(m.context), '-np', '1', '--jinja', '--reasoning', 'off', '--no-webui'];
    const child = spawn(exe, args, { cwd: dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log: string[] = [];
    const keep = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log.push(line);
      if (log.length > 300) log.splice(0, log.length - 300);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const server = { child, model: id, url, log, ready: Promise.resolve(url), device: undefined as string | undefined };
    server.ready = new Promise<string>((resolve, reject) => {
      let done = false;
      const fail = (why: string) => {
        if (done) return;
        done = true;
        if (this.server === server) this.server = null;
        this.error = why;
        child.kill();
        this.changed();
        reject(new WorkspaceError(why));
      };
      child.once('error', (e) => fail(`The AI runner couldn't start: ${e.message}`));
      child.once('exit', (code) => {
        if (child.pid) this.opts.onProcess?.(child.pid, false);
        if (this.server === server) this.server = null;
        if (!done) fail(`The AI runner stopped while loading ${m.label} (code ${code}). ${explain(log)}`);
        else this.changed();
      });
      const started = Date.now();
      const poll = async () => {
        if (done) return;
        try {
          const r = await this.fetch(`http://127.0.0.1:${port}/health`);
          if (r.ok) {
            done = true;
            server.device = deviceOf(log);
            this.changed();
            resolve(url);
            return;
          }
        } catch {
          // Not listening yet.
        }
        if (Date.now() - started > (this.opts.startTimeoutMs ?? 300_000)) fail(`${m.label} took too long to load. ${explain(log)}`);
        else setTimeout(poll, 300);
      };
      void poll();
    });
    this.server = server;
    if (child.pid) this.opts.onProcess?.(child.pid, true);
    this.changed();
    return server.ready;
  }

  /** Stop the server (it starts again when the AI is next needed). */
  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      if (s.child.exitCode !== null) return resolve();
      s.child.once('exit', () => resolve());
      s.child.kill();
      setTimeout(resolve, 3000);
    });
    this.changed();
  }

  private async installRuntime(signal: AbortSignal) {
    const zipPath = join(this.opts.dir, 'runtime', `${LLAMA_CPP.tag}.zip`);
    await this.fetchFile(this.opts.runtimeUrl ?? LLAMA_CPP.windowsUrl, zipPath, {}, signal);
    this.download!.what = 'checking';
    this.changed();
    const files = unzipSync(new Uint8Array(await fsp.readFile(zipPath)));
    await fsp.rm(this.runtimeDir, { recursive: true, force: true });
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/')) continue;
      const out = join(this.runtimeDir, name);
      if (!out.startsWith(this.runtimeDir)) continue; // no paths outside the folder
      await fsp.mkdir(dirname(out), { recursive: true });
      await fsp.writeFile(out, data);
    }
    await fsp.rm(zipPath, { force: true });
    if (!this.serverExe()) throw new WorkspaceError(`The AI runner download didn't contain ${LLAMA_CPP.server}`);
    if (process.platform !== 'win32') await fsp.chmod(this.serverExe()!, 0o755).catch(() => undefined);
  }

  /** Download to a .part file (carrying on from one left by a broken download), check it, then move it into place. */
  private async fetchFile(url: string, dest: string, expect: { size?: number; sha256?: string }, signal: AbortSignal): Promise<void> {
    await fsp.mkdir(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const hash = createHash('sha256');
    let have = 0;
    if (fs.existsSync(part)) {
      // Hash what's already there, then ask for the rest.
      for await (const chunk of fs.createReadStream(part)) {
        hash.update(chunk as Buffer);
        have += (chunk as Buffer).length;
      }
    }
    let res: Response;
    try {
      res = await this.fetch(url, { signal, headers: have ? { range: `bytes=${have}-` } : {} });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new WorkspaceError(`Couldn't download ${url.split('/').pop()}. Check your internet connection and try again.`);
    }
    if (have && res.status !== 206) {
      // The server sent the whole file again: start over.
      await fsp.rm(part, { force: true });
      return this.fetchFile(url, dest, expect, signal);
    }
    if (!res.ok || !res.body) throw new WorkspaceError(`Couldn't download ${url.split('/').pop()} (${res.status}). Try again later.`);
    const total = have + Number(res.headers.get('content-length') ?? 0) || expect.size || 0;
    this.download!.done = have;
    this.download!.total = total;
    this.changed();
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        this.download!.done += chunk.length;
        this.changed(false);
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    const size = (await fsp.stat(part)).size;
    if (expect.size && size !== expect.size) {
      await fsp.rm(part, { force: true });
      throw new WorkspaceError(`The download of ${url.split('/').pop()} came out the wrong size (${formatBytes(size)} instead of ${formatBytes(expect.size)}). Try again.`);
    }
    if (expect.sha256) {
      this.download!.what = 'checking';
      this.changed();
      const got = hash.digest('hex');
      if (got !== expect.sha256) {
        await fsp.rm(part, { force: true });
        throw new WorkspaceError(`The download of ${url.split('/').pop()} was damaged (its checksum doesn't match). Try again.`);
      }
    }
    await fsp.rename(part, dest);
  }
}

function isComplete(path: string, size: number): boolean {
  try {
    return fs.statSync(path).size === size;
  } catch {
    return false;
  }
}

function findFile(dir: string, name: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) {
    const f = findFile(join(dir, e.name), name);
    if (f) return f;
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** What the model runs on, from the server's log: a graphics card's name, or the processor. */
export function deviceOf(log: string[]): string {
  const offload = log.map((l) => /offloaded (\d+)\/(\d+) layers to GPU/.exec(l)).find(Boolean);
  const gpu = log.map((l) => /ggml_vulkan: \d+ = ([^(|]+?)\s*\(/.exec(l) ?? /using device \w+ \(([^)]+)\)/.exec(l)).find(Boolean);
  if (offload && Number(offload[1]) > 0) return gpu?.[1]?.trim() || 'graphics card';
  return 'processor';
}

/** A plain reason from the server's last log lines (memory, a damaged file…). */
function explain(log: string[]): string {
  const text = log.slice(-40).join('\n');
  if (/out of memory|failed to allocate|ErrorOutOfDeviceMemory|cannot allocate/i.test(text)) return 'There was not enough memory. Close other programs, or pick a smaller model.';
  if (/failed to load model|invalid magic|unknown model architecture/i.test(text)) return 'The model file could not be read. Remove it and download it again.';
  const last = log.filter((l) => /error|failed/i.test(l)).pop();
  return last ? `Its last message: ${last.slice(0, 200)}` : '';
}
