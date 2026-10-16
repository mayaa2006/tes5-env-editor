import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { LocalAi, deviceOf } from '../src/node';
import type { LocalAiStatus, LocalModel } from '../src';

/** A stand-in for llama-server: says what it runs on, then answers /health (or fails like a server out of memory). */
const FAKE_SERVER = `#!/usr/bin/env node
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
if (process.env.FAKE_LLAMA === 'oom') { console.error('ggml_vulkan: failed to allocate buffer: ErrorOutOfDeviceMemory'); process.exit(1); }
console.error('load_tensors: offloaded 0/29 layers to GPU');
http.createServer((req, res) => res.end(req.url === '/health' ? '{"status":"ok"}' : JSON.stringify({ args: process.argv.slice(2) }))).listen(port, '127.0.0.1');
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
  const m: LocalModel = { id: 'tiny', label: 'Tiny 1B', repo: 'x/y', file: 'tiny.gguf', size: MODEL_BYTES.length, sha256: sha(MODEL_BYTES), context: 4096, memoryGb: 1, about: '', license: 'apache-2.0', ...model };
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

  it('tells a graphics card from the processor in the log', () => {
    expect(deviceOf(['ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 (NVIDIA) | uma: 0 | fp16: 1', 'load_tensors: offloaded 29/29 layers to GPU'])).toBe('NVIDIA GeForce RTX 3060');
    expect(deviceOf(['load_tensors: offloaded 0/29 layers to GPU'])).toBe('processor');
    expect(deviceOf([])).toBe('processor');
  });
});
