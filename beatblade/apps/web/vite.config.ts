import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Versionsnummer automatisch beim Bauen: package.json-Version + Build-Zeit (UTC) + Git-Kurzhash, falls verfuegbar
const pkgVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version as string;
const gitHash = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } })();
const buildStamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const BUILD_INFO = `v${pkgVersion} · Build ${buildStamp} UTC${gitHash ? ' · ' + gitHash : ''}`;

// BASE_PATH muss zum Server passen (z. B. /beatblade/)
const base = (process.env.BASE_PATH || '/beatblade').replace(/\/?$/, '/');

export default defineConfig({
  base,
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
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
