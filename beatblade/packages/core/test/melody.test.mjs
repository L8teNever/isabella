import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/index.js';
import { synthSong } from './synth.mjs';

// Stereo-Testsong: Schlagzeug + Bass (Mitte), „Gesang“ (Mitte, weicher Einsatz, Vibrato) und ein breiter Synth-Lead
// (links/rechts gegeneinander verzoegert) auf anderen Zeitpunkten. Die Melodie-Onsets sollen dem Synth folgen, nicht dem Gesang.
function stereoSong({ bpm = 124, seconds = 40, sr = 44100 } = {}) {
  const mid = synthSong({ bpm, seconds, sr, seed: 7, structure: false });
  for (let i = 0; i < mid.length; i++) mid[i] *= 0.5;
  const n = mid.length, L = Float32Array.from(mid), R = Float32Array.from(mid);
  const beat = 60 / bpm, vocal = [], synth = [];
  const scale = [220, 247, 262, 294, 330, 349, 392, 440];
  for (let k = 4; k < seconds / beat - 2; k++) {
    // Gesang auf 1 und 3 (lange Silben), Synth auf den Achteln dazwischen
    if (k % 2 === 0) vocal.push({ t: k * beat, f: scale[(k * 3) % 8], d: beat * 1.6 });
    synth.push({ t: k * beat + beat / 2, f: scale[(k * 5 + 2) % 8] * 2, d: beat * 0.4 });
  }
  for (const v of vocal) {
    const a = Math.floor(v.t * sr), m = Math.floor(v.d * sr);
    for (let i = 0; i < m && a + i < n; i++) {
      const u = i / sr, env = Math.min(1, u / 0.12) * Math.exp(-u * 1.2);   // weicher Einsatz
      const f = v.f * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * u));
      const x = env * 0.22 * (Math.sin(2 * Math.PI * f * u) + 0.5 * Math.sin(4 * Math.PI * f * u) + 0.3 * Math.sin(6 * Math.PI * f * u));
      L[a + i] += x; R[a + i] += x;
    }
  }
  const haas = Math.floor(0.012 * sr);
  for (const s of synth) {
    const a = Math.floor(s.t * sr), m = Math.floor(s.d * sr);
    for (let i = 0; i < m; i++) {
      const u = i / sr, env = Math.min(1, u / 0.004) * Math.exp(-u * 6);   // harter Anschlag
      const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));
      const x = env * 0.16 * (saw(s.f * u) + saw(s.f * 1.007 * u));
      if (a + i < n) L[a + i] += x;
      if (a + i + haas < n) R[a + i + haas] -= x * 0.9;
    }
  }
  const mono = new Float32Array(n), side = new Float32Array(n);
  for (let i = 0; i < n; i++) { mono[i] = (L[i] + R[i]) / 2; side[i] = (L[i] - R[i]) / 2; }
  return { mono, side, vocal, synth };
}

test('Melodie ohne Gesang: Melodie-Töne folgen dem breiten Synth, nicht dem Gesang in der Mitte', () => {
  const { mono, side, vocal, synth } = stereoSong();
  const a = analyze(mono, 44100, undefined, side);
  assert.ok((a.stereoWidth ?? 0) >= 0.12, `Stereobreite ${a.stereoWidth}`);
  const strong = (a.leadOnsets ?? []).filter((o) => o.s >= 0.3);
  const near = (list, t, w = 0.04) => list.some((x) => Math.abs(x.t - t) <= w);
  const onSynth = strong.filter((o) => near(synth, o.t)).length;
  const onVocal = strong.filter((o) => near(vocal, o.t) && !near(synth, o.t)).length;
  const synthFound = synth.filter((s) => near(strong, s.t)).length / synth.length;
  console.log(`Melodie-Töne: ${strong.length}, auf Synth ${onSynth}, auf Gesang ${onVocal}, Synth-Noten gefunden ${(synthFound * 100).toFixed(0)} %`);
  assert.ok(synthFound >= 0.7, `nur ${(synthFound * 100).toFixed(0)} % der Synth-Noten erkannt`);
  assert.ok(onVocal <= strong.length * 0.1, `${onVocal} von ${strong.length} Melodie-Tönen liegen auf dem Gesang`);
});
