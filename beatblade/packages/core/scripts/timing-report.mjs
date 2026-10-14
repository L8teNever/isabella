// Timing-Report: liegen die erzeugten Noten auf hoerbaren Sounds?
// Aufruf (nach pnpm build):  node scripts/timing-report.mjs [--json out.json] [--gen anderer/dist/index.js] typ=datei.mp3 ...
// --gen: Noten mit einem anderen Generator-Stand erzeugen (z. B. main), Analyse und Messung bleiben gleich – fairer Vorher/Nachher-Vergleich.
// Gibt je Song und Schwierigkeit aus: Anteil Noten mit Onset ±30 ms (alle / deutliche / ±15 ms), mittlere/90-%-Abweichung (ms),
// Noten auf stillen Slots und als Vergleich den Anteil deutlicher Treffer aller 1/4-Rasterpunkte ("Raster").
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { analyze, generate, timingReport, DIFFICULTIES } from '../dist/index.js';

const args = process.argv.slice(2);
let json = null, gen = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') json = args[++i];
  else if (args[i] === '--gen') gen = args[++i];
  else files.push(args[i]);
}
if (!files.length) { console.error('Aufruf: node scripts/timing-report.mjs [--json out.json] typ=datei.mp3 ...'); process.exit(1); }

const generateWith = gen ? (await import(path.resolve(gen))).generate : generate;
const out = [];
const pad = (v, n) => String(v).padStart(n);
const P = (v) => (v * 100).toFixed(1) + ' %';
console.log(`${'Song'.padEnd(28)} ${'Stufe'.padEnd(10)} ${pad('Noten', 6)} ${pad('Onset±30', 9)} ${pad('deutl.±30', 10)} ${pad('±15', 8)} ${pad('Ø ms', 6)} ${pad('90% ms', 7)} ${pad('still', 6)} ${pad('Raster', 8)}`);
for (const spec of files) {
  const [type, file] = spec.includes('=') ? spec.split(/=(.*)/s) : ['?', spec];
  const buf = execFileSync('ffmpeg', ['-v', 'quiet', '-i', file, '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const a = analyze(pcm, 44100);
  const name = `${type}:${path.basename(file).replace(/\.\w+$/, '')}`.slice(0, 28);
  for (const d of DIFFICULTIES) {
    const m = generateWith(a, d, 7);
    const r = timingReport(a, m.notes);
    out.push({ song: name, type, bpm: a.bpm, difficulty: d, ...r });
    console.log(`${name.padEnd(28)} ${d.padEnd(10)} ${pad(r.notes, 6)} ${pad(P(r.onsetHit), 9)} ${pad(P(r.clearHit), 10)} ${pad(P(r.tightHit), 8)} ${pad(r.meanDev, 6)} ${pad(r.p90Dev, 7)} ${pad(r.silent, 6)} ${pad(P(r.rasterClear), 8)}`);
  }
}
// Zusammenfassung je Song-Typ (alle Stufen)
console.log('\nJe Typ (alle Stufen zusammen):');
for (const type of [...new Set(out.map((o) => o.type))]) {
  const rows = out.filter((o) => o.type === type), n = rows.reduce((s, r) => s + r.notes, 0);
  const w = (k) => rows.reduce((s, r) => s + r[k] * r.notes, 0) / Math.max(1, n);
  console.log(`${type.padEnd(10)} Noten ${pad(n, 6)}  Onset±30 ${(w('onsetHit') * 100).toFixed(1)} %  deutlich±30 ${(w('clearHit') * 100).toFixed(1)} % (Raster ${(w('rasterClear') * 100).toFixed(1)} %)  ±15 ${(w('tightHit') * 100).toFixed(1)} %  Ø ${w('meanDev').toFixed(1)} ms  90% ${w('p90Dev').toFixed(1)} ms  still ${rows.reduce((s, r) => s + r.silent, 0)} (${((rows.reduce((s, r) => s + r.silent, 0) / Math.max(1, n)) * 100).toFixed(1)} %)`);
}
if (json) fs.writeFileSync(json, JSON.stringify(out, null, 1));
