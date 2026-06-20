import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
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
  optimizeDeps: {
    exclude: ['phpoc_crypto_core'],
  },
  build: {
    rollupOptions: {
      // WASM glue JS is loaded at runtime via dynamic import; keep it external
      // to avoid bundling issues with wasm-bindgen's init/initSync pattern.
      external: (id) => id.includes('phpoc_crypto_core'),
    },
  },
});
