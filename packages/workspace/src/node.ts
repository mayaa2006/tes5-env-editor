/**
 * Node.js implementations of the host interfaces (file system, process
 * runner). Imported via "@tes5/workspace/node" so browser bundles never pull
 * in node:fs.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { DirEntry, FileStat, FileSystem, RandomAccessFile } from './fs';
import type { ProcessRunner } from './scripts';

export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array> {
    const b = await fsp.readFile(path);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    // Write to a temp file then rename, so a crash never leaves a half-written plugin.
    const tmp = `${path}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, path);
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }
  async stat(path: string): Promise<FileStat | undefined> {
    try {
      const s = await fsp.stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch {
      return undefined;
    }
  }
  async readdir(path: string): Promise<DirEntry[]> {
    const entries = await fsp.readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }
  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }
  async remove(path: string): Promise<void> {
    await fsp.rm(path, { force: true, recursive: true });
  }
  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  }
  openRandomAccess(path: string): RandomAccessFile {
    const fd = fs.openSync(path, 'r');
    const size = fs.fstatSync(fd).size;
    return {
      size,
      read(offset: number, length: number): Uint8Array {
        const buf = Buffer.allocUnsafe(length);
        const n = fs.readSync(fd, buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, n);
      },
      close() {
        fs.closeSync(fd);
      },
    };
  }
}

export class NodeProcessRunner implements ProcessRunner {
  run(command: string, args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: opts.cwd, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  /** Start a program and leave it running (the game). */
  launch(command: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: opts.cwd, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}
