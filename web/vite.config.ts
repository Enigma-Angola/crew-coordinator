import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API and OIDC callback are proxied so the browser sees a single origin (cookies stay first-party).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
} as any);
