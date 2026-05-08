import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir:   'dist',
    emptyOutDir: true,
    // Keep a single clean bundle
    rollupOptions: {
      input: 'index.html',
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
