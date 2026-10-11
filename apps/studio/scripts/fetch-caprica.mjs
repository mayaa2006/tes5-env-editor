/**
 * Puts Caprica.exe (the free, MIT-licensed Papyrus compiler,
 * https://github.com/Orvid/Caprica) in resources/caprica so the Windows app
 * ships with it and scripts compile without the Creation Kit. The download is
 * pinned and checked against its SHA-256, so a changed file is never shipped.
 * Run by `npm run dist`; safe to run again (skips when already there).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v0.3.0';
const ARCHIVE = { url: `https://github.com/Orvid/Caprica/releases/download/${VERSION}/Caprica.${VERSION}.7z`, sha256: '0037e54cf3a1021e976278d9a637e8ae541aaf9ebeb8d274b6c2cfe32f4ee559' };
const EXE_SHA256 = '389fef19a803c36342fa7f733c96b6e27ef10fcd0b171af10427e29cbe153ec6';
const LICENSE = { url: `https://raw.githubusercontent.com/Orvid/Caprica/${VERSION}/LICENSE`, sha256: '9dfe1562901b1f9f83250d0213f3befe9a91b55e7e1f61c704446a3c0de32464' };

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'caprica');
const exePath = join(out, 'Caprica.exe');
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function download({ url, sha256 }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading ${url} failed: ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (sha(data) !== sha256) throw new Error(`${url} isn't the expected file (SHA-256 ${sha(data)})`);
  return data;
}

if (existsSync(exePath) && sha(readFileSync(exePath)) === EXE_SHA256) {
  console.log(`Caprica ${VERSION} already in ${out}`);
} else {
  mkdirSync(out, { recursive: true });
  const archive = await download(ARCHIVE);
  // The release is a .7z; 7-Zip compiled to WebAssembly unpacks it on any OS.
  const SevenZip = (await import('7z-wasm')).default;
  const sz = await SevenZip({ print: () => {}, printErr: (m) => console.error(m) });
  sz.FS.writeFile('/caprica.7z', archive);
  sz.FS.mkdir('/out');
  sz.FS.chdir('/out');
  sz.callMain(['x', '/caprica.7z', '-y']);
  const exe = sz.FS.readFile('/out/Caprica.exe');
  if (sha(exe) !== EXE_SHA256) throw new Error(`Caprica.exe from the archive isn't the expected file (SHA-256 ${sha(exe)})`);
  writeFileSync(exePath, exe);
  writeFileSync(join(out, 'LICENSE.txt'), await download(LICENSE));
  writeFileSync(join(out, 'README.txt'), `Caprica ${VERSION}: a free, open-source Papyrus compiler by Orvid King and contributors.\r\nhttps://github.com/Orvid/Caprica\r\nShipped unchanged with TES5 Env Editor under the MIT license (LICENSE.txt).\r\n`);
  console.log(`Caprica ${VERSION} saved to ${out}`);
}
