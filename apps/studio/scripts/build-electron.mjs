// Bundles the Electron main process, preload and engine worker into
// self-contained CommonJS files in dist-electron/ (no node_modules needed at runtime).
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts', 'engine-worker': 'electron/engine-worker.ts' },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
});
