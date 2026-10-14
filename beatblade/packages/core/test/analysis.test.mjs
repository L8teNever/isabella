import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, generate, countProblems, timingReport, DIFFICULTIES } from '../dist/index.js';
import { synthSong } from './synth.mjs';

test('BPM auf synthetischen Songs: ±1 BPM, keine Oktavfehler', () => {
  const bpms = [72, 85, 96, 104, 110, 118, 124, 128, 135, 140, 150, 160, 174];
  let ok = 0;
  for (const bpm of bpms) {
    const a = analyze(synthSong({ bpm, seconds: 50, seed: bpm }));
    const good = Math.abs(a.bpm - bpm) <= 1;
    if (!good) console.log('falsch', bpm, '->', a.bpm);
    if (good) ok++;
  }
  assert.ok(ok / bpms.length >= 0.9, `nur ${ok}/${bpms.length} korrekt`);
});

test('Beats liegen auf den Kicks (±20 ms)', () => {
  const bpm = 120, a = analyze(synthSong({ bpm, seconds: 40 }));
  const beat = 60 / bpm;
  const errs = a.beats.filter((t) => t > 2 && t < 38).map((t) => { const r = (t / beat) % 1; return Math.min(r, 1 - r) * beat; });
  const mean = errs.reduce((s, v) => s + v, 0) / errs.length;
  assert.ok(mean < 0.02, `mittlere Abweichung ${(mean * 1000).toFixed(1)} ms`);
});

test('Downbeat: Eins wird erkannt', () => {
  const bpm = 120, a = analyze(synthSong({ bpm, seconds: 40 }));
  const beat = 60 / bpm, bar = beat * 4;
  const offs = a.bars.filter((t) => t > 2 && t < 38).map((t) => { const r = (t / bar) % 1; return Math.min(r, 1 - r); });
  const good = offs.filter((r) => r < 0.05).length / offs.length;
  assert.ok(good > 0.8, `nur ${(good * 100).toFixed(0)} % der Takte auf der Eins`);
});

test('Mapping: deterministisch, ohne Parity-Fehler/Ueberkreuzungen, Dichte steigt mit Schwierigkeit', () => {
  const a = analyze(synthSong({ bpm: 128, seconds: 60 }));
  let prev = 0;
  for (const d of DIFFICULTIES) {
    const m1 = generate(a, d, 7), m2 = generate(a, d, 7), m3 = generate(a, d, 8);
    assert.deepEqual(m1.notes, m2.notes, 'gleicher Seed = gleiches Level');
    assert.notDeepEqual(m1.notes, m3.notes, 'anderer Seed = anderes Level');
    const p = countProblems(m1);
    assert.equal(p.parity, 0, `${d}: Parity-Fehler`);
    assert.equal(p.crossover, 0, `${d}: Ueberkreuzungen`);
    assert.ok(m1.stats.nps >= prev, `${d}: Dichte ${m1.stats.nps} < ${prev}`);
    prev = m1.stats.nps;
    // alle Noten auf dem Raster
    for (const n of m1.notes) assert.ok(Math.abs(n.b * 24 - Math.round(n.b * 24)) < 1e-3, 'Note nicht quantisiert');
  }
});

// Schutz: Schnitt-Level duerfen sich durch Orbit (Analyse-Erweiterung, gemeinsame Generator-Teile) nicht aendern.
// Bei einer gewollten Aenderung am Schnitt-Generator: MAPPING_VERSION erhoehen und Fingerabdruecke neu erzeugen.
test('Schnitt-Level unverändert (Fingerabdruck)', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  // Gewollte Aenderung am Schnitt-Generator: UPDATE_SNAPSHOT=1 pnpm test schreibt den Fingerabdruck neu
  const file = new URL('./schnitt-snapshot.json', import.meta.url);
  const snap = JSON.parse(readFileSync(file)), next = {};
  for (const bpm of [128, 96]) {
    const a = analyze(synthSong({ bpm, seconds: 60, seed: 3 }));
    for (const d of DIFFICULTIES) {
      const m = generate(a, d, 7);
      const h = createHash('sha256').update(JSON.stringify({ n: m.notes, b: m.bombs, o: m.obstacles, l: m.lights })).digest('hex').slice(0, 16);
      next[`${bpm}/${d}`] = h;
      if (!process.env.UPDATE_SNAPSHOT) assert.equal(h, snap[`${bpm}/${d}`], `${bpm} BPM ${d}: Schnitt-Level hat sich verändert`);
    }
  }
  if (process.env.UPDATE_SNAPSHOT) (await import('node:fs')).writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
});

test('Swing: Offbeat-Noten liegen auf der geswungenen Position (2/3), nicht auf 1/2', () => {
  const a = analyze(synthSong({ bpm: 120, seconds: 60, swing: 1, seed: 5 }));
  const m = generate(a, 'expert', 7);
  const pos = m.notes.map((n) => Math.round((n.b % 1) * 24)).filter((x) => x > 0 && x < 24);
  assert.ok(pos.filter((x) => x === 16).length >= 5, `zu wenige geswungene Offbeats: ${JSON.stringify(pos)}`);
  assert.equal(pos.filter((x) => x === 12).length, 0, 'gerade Offbeats im geswungenen Song');
});

test('Timing: Noten liegen auf echten Sounds (synthetisch)', () => {
  const a = analyze(synthSong({ bpm: 128, seconds: 60, seed: 3 }));
  for (const d of DIFFICULTIES) {
    const r = timingReport(a, generate(a, d, 7).notes);
    assert.ok(r.onsetHit >= 0.97, `${d}: nur ${(r.onsetHit * 100).toFixed(1)} % auf einem Sound`);
  }
});
