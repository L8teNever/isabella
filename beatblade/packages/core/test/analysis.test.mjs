import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, generate, countProblems, DIFFICULTIES } from '../dist/index.js';
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
