import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Relative base so the built app also loads from file:// inside Electron.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    sourcemap: false,
  },
  optimizeDeps: {
    exclude: ['recast-navigation', '@recast-navigation/core', '@recast-navigation/wasm', '@recast-navigation/generators'],
  },
  server: { port: 5173, strictPort: true },
});
