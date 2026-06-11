import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
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
});
