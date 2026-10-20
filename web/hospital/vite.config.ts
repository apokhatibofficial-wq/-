import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API is proxied under /api so the session cookie is same-origin.
// In production VITE_API_URL points at https://api.medlink.website.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: process.env.MEDLINK_API_ORIGIN ?? 'http://localhost:8080', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') },
    },
  },
  build: { sourcemap: false },
});
