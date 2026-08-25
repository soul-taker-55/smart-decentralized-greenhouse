import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served by the backend in production (same origin, no CORS).
// In development Vite proxies /api to the backend so the frontend can run on
// its own port without the browser blocking cross-origin requests.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Built into the backend's public directory so one container serves both.
    outDir: '../backend/public',
    emptyOutDir: true,
  },
});
