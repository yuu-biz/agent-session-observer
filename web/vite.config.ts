import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../src/core', import.meta.url)),
      '@api': fileURLToPath(new URL('../src/server', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // Keeps the published bundle auditable: one JS file, one CSS file.
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: {
    port: 7782,
    strictPort: false,
    proxy: { '/api': 'http://127.0.0.1:7781' },
  },
});
