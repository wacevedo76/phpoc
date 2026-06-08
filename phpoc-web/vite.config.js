import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
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
});
