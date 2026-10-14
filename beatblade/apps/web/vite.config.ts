import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// BASE_PATH muss zum Server passen (z. B. /beatblade/)
const base = (process.env.BASE_PATH || '/beatblade').replace(/\/?$/, '/');

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
        debug: resolve(__dirname, 'debug.html'),
      },
    },
  },
  server: {
    proxy: { [`${base}api`]: { target: process.env.API || 'http://localhost:3901', changeOrigin: true } },
  },
});
