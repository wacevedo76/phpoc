/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/vitest-setup.js'],
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', '**/*_test.?(c|m)[jt]s?(x)'],
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    open: '/?dev=false',
    fs: {
      // Allow serving files from the parent project root (for phpoc-crypto-core WASM)
      allow: [
        path.resolve(__dirname, '..'),
      ],
    },
  },
  resolve: {
    alias: {
      '@crypto': '/src/crypto',
      '@sync': '/src/sync',
      '@components': '/src/components',
      '@context': '/src/context',
      '@hooks': '/src/hooks',
      '@services': '/src/services',
    },
  },
  build: {
    rolldownOptions: {
      // WASM artifacts are bundled from src/crypto/wasm/ — Vite natively
      // handles .wasm files via new URL() asset references.
    },
  },
});
