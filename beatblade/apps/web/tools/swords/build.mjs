// Baut die Schwert-Modelle und Vorschaubilder in content/sabers/<name>/ (schwert.glb, preview.jpg).
// Aufruf aus apps/web:  node tools/swords/build.mjs [ausgabe-ordner-fuer-vergleichsbild] [name,name …]   (ohne Namen: alle)
// Braucht: vite (ist da) und Playwright mit Chromium (z. B. pnpm dlx playwright … oder PLAYWRIGHT_MODULE=/pfad/zu/playwright/index.mjs).
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = path.resolve(here, '../../../../content/sabers');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Vite liefert page.ts samt three aus apps/web/node_modules aus
const srv = await createServer({ root: here, configFile: false, logLevel: 'warn', server: { port: 0, fs: { allow: [path.resolve(here, '../..'), content] } } });
await srv.listen();
const port = srv.httpServer.address().port;
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.error('Fehler:', e.message));
const q = [process.env.SWORD_DEBUG, process.argv[3] && `nur=${process.argv[3]}`].filter(Boolean).join('&');
await p.goto(`http://localhost:${port}/index.html${q ? '?' + q : ''}`);
await p.waitForFunction(() => window.ready === true);
// fertige Modelle (--extern name,name): nur Vorschaubilder aus content/sabers/<name>/<model>
const ext = process.argv.indexOf('--extern');
if (ext > 0) {
  const list = process.argv[ext + 1].split(',').map((id) => {
    const info = JSON.parse(fs.readFileSync(path.join(content, id, 'info.json'), 'utf8'));
    return { id, url: `/@fs${path.join(content, id, info.model)}`, len: info.bladeLength ?? 1, color: info.previewColor ? parseInt(info.previewColor.slice(1), 16) : 0x3fc8ff, flip: info.flip === true, glow: info.glow !== false };
  });
  const shots = await p.evaluate((l) => window.previewExtern(l), list);
  for (const [id, data] of Object.entries(shots)) { fs.writeFileSync(path.join(content, id, 'preview.jpg'), Buffer.from(data.split(',')[1], 'base64')); console.log('Vorschau', id); }
  await b.close(); await srv.close(); process.exit(0);
}
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
