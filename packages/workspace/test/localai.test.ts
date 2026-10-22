import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { LocalAi, deviceOf, gpuFailed, offloadOf, parseDevices } from '../src/node';
import { LOCAL_MODELS, fitsGpu, localModel, recommendedModel, type LocalAiStatus, type LocalModel } from '../src';

/** A stand-in for llama-server: says what it runs on, then answers /health (or fails like a server out of memory). */
const FAKE_SERVER = `#!/usr/bin/env node
const http = require('node:http');
if (process.argv.includes('--list-devices')) {
  console.log('Available devices:');
  if (process.env.FAKE_GPU === 'none') console.log('  (none)');
  else for (const d of ['Vulkan0: AMD Radeon RX 6600 (8176 MiB, 7600 MiB free)', 'Vulkan1: llvmpipe (LLVM 15.0.7, 256 bits) (32000 MiB, 32000 MiB free)']) console.log('  ' + d);
  process.exit(0);
}
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
if (process.env.FAKE_LLAMA === 'oom') { console.error('ggml_vulkan: failed to allocate buffer: ErrorOutOfDeviceMemory'); process.exit(1); }
console.error('load_tensors: offloaded 0/29 layers to GPU');
http.createServer((req, res) => {
  // Like a graphics card reset by Windows in the middle of an answer.
  if (req.url === '/crash' && process.env.FAKE_LLAMA === 'devicelost') { console.error('ggml_vulkan: vk::Queue::submit: ErrorDeviceLost'); process.exit(1); }
  res.end(req.url === '/health' ? '{"status":"ok"}' : JSON.stringify({ args: process.argv.slice(2) }));
}).listen(port, '127.0.0.1');
`;

const MODEL_BYTES = new Uint8Array(200_000).map((_, i) => (i * 7) % 251);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let server: Server | undefined;
afterEach(() => {
  server?.close();
  delete process.env.FAKE_LLAMA;
});

/** A web server with the runtime zip and a model, which honours Range requests like Hugging Face. */
async function files(): Promise<{ url: string; requests: string[] }> {
  const zip = zipSync({ 'llama-b11700/llama-server.exe': strToU8(FAKE_SERVER), 'llama-b11700/ggml-cpu.dll': strToU8('x') });
  const requests: string[] = [];
  server = createServer((req, res) => {
    requests.push(`${req.url} ${req.headers.range ?? ''}`.trim());
    const body = req.url === '/runtime.zip' ? zip : req.url === '/model.gguf' ? MODEL_BYTES : null;
    if (!body) return void res.writeHead(404).end();
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (range) {
      const from = Number(range[1]);
      res.writeHead(206, { 'content-length': body.length - from });
      return void res.end(Buffer.from(body.subarray(from)));
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(Buffer.from(body));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, requests };
}

function setup(base: string, model: Partial<LocalModel> = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'localai-'));
  const m: LocalModel = { id: 'tiny', label: 'Tiny 1B', repo: 'x/y', file: 'tiny.gguf', size: MODEL_BYTES.length, sha256: sha(MODEL_BYTES), context: 4096, memoryGb: 1, gpuGb: 1, jobsRight: 6, about: '', license: 'apache-2.0', ...model };
  const seen: LocalAiStatus[] = [];
  const pids: string[] = [];
  // Hugging Face's address for the model goes to the test server instead.
  const fetchImpl: typeof fetch = (u, init) => fetch(String(u).startsWith('https://huggingface.co/') ? `${base}/model.gguf` : u, init);
  const ai = new LocalAi({ dir, runtimeUrl: `${base}/runtime.zip`, models: [m], fetch: fetchImpl, onChange: (s) => seen.push(s), onProcess: (pid, on) => pids.push(`${on ? 'start' : 'end'}`) });
  return { ai, dir, m, seen, pids };
}

describe('the built-in AI', () => {
  it('downloads the runner and a model, checks it, starts the server and stops it', async () => {
    const { url } = await files();
    const { ai, dir, seen, pids } = setup(url);
    expect(ai.status()).toMatchObject({ supported: true, runtimeInstalled: false, installed: [], server: { state: 'stopped' } });
    await expect(ai.ensure('tiny')).rejects.toThrow(/isn't downloaded yet/);
    const s = await ai.install('tiny');
    expect(s).toMatchObject({ runtimeInstalled: true, installed: ['tiny'] });
    expect(s.download).toBeUndefined();
    // Progress went through the runner, then the model, then the checksum.
    expect(seen.map((x) => x.download?.what).filter(Boolean)).toEqual(expect.arrayContaining(['runtime', 'model', 'checking']));
    expect(fs.existsSync(join(dir, 'runtime', 'b11700', 'llama-b11700', 'llama-server.exe'))).toBe(true);
    expect(fs.existsSync(join(dir, 'runtime', 'b11700.zip'))).toBe(false);

    const api = await ai.ensure('tiny');
    expect(api).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(ai.status().server).toEqual({ state: 'running', model: 'tiny', device: 'processor' });
    expect(await ai.ensure('tiny')).toBe(api);
    // It was started with the model, on this computer only, with its context and no web page.
    const args = (await (await fetch(api.replace('/v1', '/args'))).json()).args as string[];
    expect(args).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '-c', '4096', '--jinja', '--no-webui']));
    expect(args[args.indexOf('-m') + 1]).toBe(join(dir, 'models', 'tiny.gguf'));
    await ai.stop();
    expect(ai.status().server.state).toBe('stopped');
    expect(pids).toEqual(['start', 'end']);
    await ai.remove('tiny');
    expect(ai.status().installed).toEqual([]);
  });

  it('carries on from a broken download, and throws away a damaged one', async () => {
    const { url, requests } = await files();
    const { ai, dir } = setup(url);
    fs.mkdirSync(join(dir, 'models'), { recursive: true });
    fs.writeFileSync(join(dir, 'models', 'tiny.gguf.part'), MODEL_BYTES.subarray(0, 50_000));
    await ai.install('tiny');
    expect(requests).toContain('/model.gguf bytes=50000-');
    expect(ai.status().installed).toEqual(['tiny']);

    const bad = setup(url, { sha256: '0'.repeat(64) });
    await expect(bad.ai.install('tiny')).rejects.toThrow(/damaged/);
    expect(fs.existsSync(join(bad.dir, 'models', 'tiny.gguf.part'))).toBe(false);
    expect(bad.ai.status().installed).toEqual([]);
  });

  it('explains a server that fails to load', async () => {
    const { url } = await files();
    const { ai } = setup(url);
    await ai.install('tiny');
    process.env.FAKE_LLAMA = 'oom';
    await expect(ai.ensure('tiny')).rejects.toThrow(/not enough memory/);
    expect(ai.status().server).toMatchObject({ state: 'error' });
  });

  it('runs gently on a graphics card or only on the processor, and moves off a card that fails', async () => {
    const { url } = await files();
    const { ai } = setup(url);
    await ai.install('tiny');
    const argsOf = async (api: string) => (await (await fetch(api.replace('/v1', '/args'))).json()).args as string[];
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    };
    // A graphics card gets small pieces of work and keeps 1.5 GB free for the app's window.
    let api = await ai.ensure('tiny');
    expect(await argsOf(api)).toEqual(expect.arrayContaining(['-ub', '256', '--fit-target', '1536']));
    // Memory for reusing past prompts is capped (8 GB by default).
    expect(await argsOf(api)).toEqual(expect.arrayContaining(['--cache-ram', '512']));
    expect(await argsOf(api)).not.toContain('--device');
    expect(ai.status().prefer).toBe('auto');

    // The processor only: the server stops, and starts again without the graphics card.
    await ai.setDevice('processor');
    expect(ai.status()).toMatchObject({ prefer: 'processor', server: { state: 'stopped' } });
    api = await ai.ensure('tiny');
    expect(await argsOf(api)).toEqual(expect.arrayContaining(['--device', 'none']));

    // Back on the graphics card, it fails in the middle of an answer: the AI says why and moves to the processor.
    await ai.setDevice('auto');
    process.env.FAKE_LLAMA = 'devicelost';
    api = await ai.ensure('tiny');
    await fetch(api.replace('/v1', '/crash')).catch(() => undefined);
    await until(() => ai.status().server.state === 'error');
    expect(ai.status()).toMatchObject({ movedOffGpu: true, server: { state: 'error', error: expect.stringMatching(/graphics card stopped responding.*processor/) } });
    delete process.env.FAKE_LLAMA;
    api = await ai.ensure('tiny');
    expect(await argsOf(api)).toEqual(expect.arrayContaining(['--device', 'none']));

    // Choosing the graphics card again tries it again; the app's window losing its card moves the AI off it.
    await ai.setDevice('auto');
    expect(ai.status().movedOffGpu).toBeUndefined();
    await ai.ensure('tiny');
    await ai.gpuLost();
    expect(ai.status()).toMatchObject({ movedOffGpu: true, server: { state: 'error' } });
    // A runner on the processor isn't affected by the window's graphics card.
    await ai.setDevice('processor');
    await ai.ensure('tiny');
    await ai.gpuLost();
    expect(ai.status().server.state).toBe('running');
    await ai.stop();
  });

  it("checks the graphics card once the runner is downloaded, and recommends the best model that fits on it", async () => {
    const { url } = await files();
    const { ai } = setup(url);
    expect(ai.status().gpus).toBeUndefined();
    await ai.install('tiny');
    for (let i = 0; i < 100 && !ai.status().gpus; i++) await new Promise((r) => setTimeout(r, 50));
    // The software renderer isn't a graphics card.
    expect(ai.status().gpus).toEqual([{ name: 'AMD Radeon RX 6600', memoryMb: 8176, freeMb: 7600 }]);
    const gpus = ai.status().gpus!;
    // 7.6 GB free, 1.5 GB kept for the app's window: Qwen3.5 4B (4.8 GB) fits, Ministral 3 3B (6 GB) doesn't.
    expect(recommendedModel(gpus)!.id).toBe('qwen3.5-4b');
    expect(fitsGpu(localModel('ministral-3-3b')!, gpus)).toBe(false);
    // A 6 GB card: the best that fits is Qwen3.5 2B. A 4 GB card fits none of the good ones entirely: the smallest of
    // them (not LFM2.5, which fits but got most jobs wrong). With no card, the one that did best in the tests.
    const six = [{ name: 'GeForce GTX 1660', memoryMb: 6144, freeMb: 5800 }];
    expect(recommendedModel(six)!.id).toBe('qwen3.5-2b');
    expect(fitsGpu(localModel('qwen3.5-4b')!, six)).toBe(false);
    const four = [{ name: 'GeForce GTX 1650', memoryMb: 4096, freeMb: 3900 }];
    expect(fitsGpu(localModel('qwen3.5-2b')!, four)).toBe(false);
    expect(recommendedModel(four)!.id).toBe('qwen3.5-2b');
    expect(recommendedModel([])!.id).toBe('qwen3.5-4b');
    expect(fitsGpu(localModel('qwen3.5-2b')!, [])).toBe(false);
    expect(fitsGpu(localModel('qwen3.5-2b')!, undefined)).toBeUndefined();
  });

  it('reads the graphics cards and how much of a model went on one', () => {
    expect(parseDevices('Available devices:\n  (none)\n')).toEqual([]);
    expect(parseDevices('Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11520 MiB free)\n  Vulkan1: Intel(R) UHD Graphics 770 (16300 MiB, 16000 MiB free)\n')).toEqual([
      { name: 'NVIDIA GeForce RTX 3060', memoryMb: 12288, freeMb: 11520 },
      { name: 'Intel(R) UHD Graphics 770', memoryMb: 16300, freeMb: 16000 },
    ]);
    expect(offloadOf(['load_tensors: offloaded 20/33 layers to GPU'])).toEqual({ layers: 20, of: 33 });
    expect(offloadOf([])).toBeUndefined();
  });

  it('tells a graphics card failing from other trouble in the log', () => {
    expect(gpuFailed(['ggml_vulkan: vk::Queue::submit: ErrorDeviceLost'])).toBe(true);
    expect(gpuFailed(['ggml_vulkan: Device memory allocation of size 123 failed.', 'ErrorOutOfDeviceMemory'])).toBe(true);
    expect(gpuFailed(['main: server is listening', 'srv  operator(): cleaning up before exit...'])).toBe(false);
  });

  it('tells a graphics card from the processor in the log', () => {
    expect(deviceOf(['ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 (NVIDIA) | uma: 0 | fp16: 1', 'load_tensors: offloaded 29/29 layers to GPU'])).toBe('NVIDIA GeForce RTX 3060');
    expect(deviceOf(['load_tensors: offloaded 0/29 layers to GPU'])).toBe('processor');
    expect(deviceOf([])).toBe('processor');
  });

  it('lists models that can be downloaded and checked, with one recommended', () => {
    expect(LOCAL_MODELS.length).toBeGreaterThan(1);
    expect(LOCAL_MODELS.filter((m) => m.recommended)).toHaveLength(1);
    expect(new Set(LOCAL_MODELS.map((m) => m.id)).size).toBe(LOCAL_MODELS.length);
    for (const m of LOCAL_MODELS) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.file).toMatch(/\.gguf$/);
      expect(m.size).toBeGreaterThan(1e8);
      expect(m.memoryGb * 1e9).toBeGreaterThan(m.size);
      expect(m.gpuGb * 1e9).toBeGreaterThan(m.size);
      expect(m.about).not.toMatch(/PROVISIONAL/);
    }
  });
});
