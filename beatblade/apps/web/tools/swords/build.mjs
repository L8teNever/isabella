// Baut die Schwert-Modelle und Vorschaubilder in content/sabers/<name>/ (schwert.glb, preview.jpg).
// Aufruf aus apps/web:  node tools/swords/build.mjs [ausgabe-ordner-fuer-vergleichsbild]
// Braucht: vite (ist da) und Playwright mit Chromium (z. B. pnpm dlx playwright … oder PLAYWRIGHT_MODULE=/pfad/zu/playwright/index.mjs).
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = path.resolve(here, '../../../../content/sabers');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Vite liefert page.ts samt three aus apps/web/node_modules aus
const srv = await createServer({ root: here, configFile: false, logLevel: 'warn', server: { port: 0, fs: { allow: [path.resolve(here, '../..')] } } });
await srv.listen();
const port = srv.httpServer.address().port;
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.error('Fehler:', e.message));
await p.goto(`http://localhost:${port}/index.html${process.env.SWORD_DEBUG ? '?' + process.env.SWORD_DEBUG : ''}`);
await p.waitForFunction(() => window.ready === true);
const res = await p.evaluate(() => window.build());
for (const [id, data] of Object.entries(res.glb)) {
  const dir = path.join(content, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'schwert.glb'), Buffer.from(data, 'base64'));
  fs.writeFileSync(path.join(dir, 'preview.jpg'), Buffer.from(res.shots[id].split(',')[1], 'base64'));
  console.log(id, JSON.stringify(res.stats[id]));
}
if (process.argv[2]) fs.writeFileSync(path.join(process.argv[2], 'schwerter-vergleich.png'), Buffer.from(res.shots.vergleich.split(',')[1], 'base64'));
await b.close(); await srv.close();
