import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': { target: 'http://localhost:4000', ws: true }, '/healthz': 'http://localhost:4000' } },
});
