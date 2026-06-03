import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import manifest from './extension/manifest.json' with { type: 'json' };

export default defineConfig({
  root: 'extension',
  plugins: [crx({ manifest })],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'extension/src/offscreen.html'),
      },
    },
  },
  test: {
    root: '.',
    include: ['extension/tests/**/*.test.ts'],
    environment: 'node',
  },
});
