import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Relative base so the built app also loads from file:// inside Electron.
export default defineConfig({
  base: './',
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
