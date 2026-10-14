// Laedt die mitgelieferten CC-BY-Songs aus seed-songs/credits.json (Quelle: incompetech.com).
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve(process.argv[2] || 'seed-songs');
const { songs } = JSON.parse(fs.readFileSync(path.join(dir, 'credits.json'), 'utf8'));
let fail = 0;
for (const s of songs) {
  const dest = path.join(dir, s.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) { console.log('vorhanden', s.file); continue; }
  try {
    const r = await fetch(s.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    console.log('geladen', s.file);
  } catch (e) { fail++; console.error('FEHLER', s.file, e.message); }
}
if (fail) console.error(`${fail} Song(s) konnten nicht geladen werden – der Server importiert nur vorhandene Dateien.`);
