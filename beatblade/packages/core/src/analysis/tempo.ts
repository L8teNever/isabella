// Tempo (BPM) und Beat-Tracking.
// 1) Tempogramm: Autokorrelation der Onset-Kurve in Fenstern (~8 s), gemittelt -> robuste Periodizitaet.
// 2) Kandidaten bewerten: ACF-Staerke inkl. Harmonischer (2x, 4x Lag) * log-Gauss-Prior um 120 BPM.
// 3) Oktavfehler aufloesen: Kandidaten T/2, T, 2T (und 3/2) – bevorzugt 70..180 BPM, dann die
//    Variante, deren Beats besser auf starken Onsets liegen.
// 4) Beat-Tracking nach Ellis (dynamische Programmierung) mit dem gewaehlten Tempo.
// 5) Feinjustierung: lineare Regression der Beat-Zeiten -> exakte BPM; bei stabilem Tempo
//    wird das Raster begradigt (perfekt gleichmaessige Beats).
import { ANALYSIS } from '../tuning.js';
import { movingMean } from './onsets.js';

export interface TempoResult {
  bpm: number;
  confidence: number;
  /** Periodenlaenge in Frames (fractional) */
  period: number;
  /** ACF-Kurve ueber BPM (fuer Debug) */
  candidates: { bpm: number; score: number }[];
}

const prior = (bpm: number) => {
  const { priorCenter, priorOctaves } = ANALYSIS.tempo;
  const x = Math.log2(bpm / priorCenter) / priorOctaves;
  return Math.exp(-0.5 * x * x);
};

/** Tempogramm-gemittelte, normalisierte Autokorrelation fuer Lags 1..maxLag */
export function autocorr(env: Float32Array, maxLag: number, win: number, hop: number): Float32Array {
  const acf = new Float32Array(maxLag + 1);
  let windows = 0;
  for (let s = 0; s + win <= env.length || (s === 0 && env.length > maxLag * 2); s += hop) {
    const e = Math.min(env.length, s + win);
    let e0 = 0;
    for (let i = s; i < e; i++) e0 += env[i] * env[i];
    if (e0 < 1e-6) { if (e >= env.length) break; continue; }
    for (let L = 1; L <= maxLag; L++) {
      let v = 0;
      for (let i = s; i + L < e; i++) v += env[i] * env[i + L];
      acf[L] += v / e0;
    }
    windows++;
    if (e >= env.length) break;
  }
  if (windows) for (let L = 0; L <= maxLag; L++) acf[L] /= windows;
  return acf;
}

/** linear interpolierter ACF-Wert an fraktionalem Lag */
const at = (a: Float32Array, x: number) => {
  if (x < 1 || x >= a.length - 1) return 0;
  const i = Math.floor(x), f = x - i;
  return a[i] * (1 - f) + a[i + 1] * f;
};

export function estimateTempo(env: Float32Array, dt: number): TempoResult {
  const { minBpm, maxBpm, preferLow, preferHigh } = ANALYSIS.tempo;
  const maxLag = Math.ceil(60 / (minBpm / 2) / dt) + 2;          // bis halbes Mindesttempo (fuer 2x-Harmonische)
  const acf = autocorr(env, Math.min(maxLag, env.length - 2), Math.round(8 / dt), Math.round(2 / dt));
  // ACF leicht glaetten
  const sm = movingMean(acf, 3);
  // Score je BPM in 0.25er Schritten: Grund-Lag + Harmonische
  const raw = (bpm: number) => {
    const L = 60 / bpm / dt;
    return at(sm, L) + 0.5 * at(sm, 2 * L) + 0.25 * at(sm, 4 * L) + 0.25 * at(sm, L / 2);
  };
  const candidates: { bpm: number; score: number }[] = [];
  let best = { bpm: 120, score: -Infinity };
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
    const s = raw(bpm) * prior(bpm);
    candidates.push({ bpm, score: s });
    if (s > best.score) best = { bpm, score: s };
  }
  // lokale Verfeinerung (0.02 BPM)
  for (let bpm = best.bpm - 0.3; bpm <= best.bpm + 0.3; bpm += 0.02) {
    const s = raw(bpm) * prior(bpm); if (s > best.score) best = { bpm, score: s };
  }
  // Konfidenz: Abstand zum zweitbesten Peak (nicht Oktave)
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const second = sorted.find((c) => Math.abs(Math.log2(c.bpm / best.bpm)) > 0.1 && Math.abs(Math.abs(Math.log2(c.bpm / best.bpm)) - 1) > 0.05);
  const confidence = second ? Math.max(0, Math.min(1, 1 - second.score / best.score)) : 1;
  // Oktave in den bevorzugten Bereich holen
  let bpm = best.bpm;
  while (bpm < preferLow && bpm * 2 <= maxBpm) bpm *= 2;
  while (bpm > preferHigh && bpm / 2 >= minBpm) bpm /= 2;
  return { bpm, confidence, period: 60 / bpm / dt, candidates };
}

/** Ellis-DP-Beat-Tracker. Liefert Beat-Frames (fraktional nicht noetig) */
export function trackBeats(env: Float32Array, period: number, tightness = ANALYSIS.beat.tightness): number[] {
  const n = env.length;
  // lokale Bewertung: Onset-Kurve mit Gauss (sigma = period/32) gefaltet
  const sigma = Math.max(1, period / 32), k = Math.ceil(sigma * 3);
  const local = new Float32Array(n);
  const gw: number[] = []; for (let j = -k; j <= k; j++) gw.push(Math.exp(-0.5 * (j / sigma) ** 2));
  for (let i = 0; i < n; i++) { let v = 0; for (let j = -k; j <= k; j++) { const q = i + j; if (q >= 0 && q < n) v += env[q] * gw[j + k]; } local[i] = v; }
  const score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  // Uebergangskosten vorberechnen
  const cost = new Float32Array(hi + 1);
  for (let d = lo; d <= hi; d++) cost[d] = -tightness * Math.log(d / period) ** 2;
  for (let i = 0; i < n; i++) {
    let bestV = -Infinity, bestJ = -1;
    for (let d = lo; d <= hi; d++) {
      const j = i - d; if (j < 0) break;
      const v = score[j] + cost[d];
      if (v > bestV) { bestV = v; bestJ = j; }
    }
    score[i] = local[i] + (bestJ >= 0 ? Math.max(0, bestV) : 0);
    back[i] = bestV > 0 ? bestJ : -1;
  }
  // Ende: bester Score in den letzten 2 Perioden
  let end = n - 1, bv = -Infinity;
  for (let i = Math.max(0, n - Math.round(2 * period)); i < n; i++) if (score[i] > bv) { bv = score[i]; end = i; }
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) { beats.push(i); if (back[i] < 0) break; }
  beats.reverse();
  return beats;
}

/**
 * Beat-Frames -> Sekunden, Raster nach vorn/hinten bis Songgrenzen auffuellen, Tempo per Regression
 * bestimmen und bei stabilem Tempo begradigen. Gibt Beats (s) und exakte BPM zurueck.
 */
export function refineBeats(frames: number[], dt: number, t0: number, duration: number, env: Float32Array): { beats: number[]; bpm: number; steady: boolean } {
  let beats = frames.map((f) => t0 + f * dt);
  if (beats.length < 4) return { beats, bpm: 120, steady: false };
  // Regression t = a + b*k
  const fit = (bs: number[]) => {
    const n = bs.length; let sk = 0, st = 0, skk = 0, skt = 0;
    bs.forEach((t, k) => { sk += k; st += t; skk += k * k; skt += k * t; });
    const b = (n * skt - sk * st) / (n * skk - sk * sk), a = (st - b * sk) / n;
    const res = bs.map((t, k) => t - (a + b * k));
    const sd = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / n);
    return { a, b, sd, res };
  };
  // robuste Regression: Ausreisser (|res| > 2 sd) entfernen und neu anpassen – Indizes bleiben erhalten
  let f = fit(beats);
  const idx = beats.map((_, k) => k).filter((k) => Math.abs(f.res[k]) <= Math.max(0.02, 2 * f.sd));
  if (idx.length > beats.length * 0.6) {
    const n = idx.length; let sk = 0, st = 0, skk = 0, skt = 0;
    for (const k of idx) { sk += k; st += beats[k]; skk += k * k; skt += k * beats[k]; }
    const b = (n * skt - sk * st) / (n * skk - sk * sk), a = (st - b * sk) / n;
    const res = beats.map((t, k) => t - (a + b * k));
    const sd = Math.sqrt(idx.reduce((s, k) => s + res[k] * res[k], 0) / n);
    f = { a, b, sd, res };
  }
  const steady = f.sd < 0.018;
  let bpm = 60 / f.b;
  if (steady) {
    // Phase fein justieren: Verschiebung (+-30 ms), bei der das Raster die meiste Onset-Energie trifft
    let bestOff = 0, bestS = -1;
    for (let off = -0.03; off <= 0.03; off += 0.002) {
      let s = 0;
      for (let k = 0; k < beats.length; k++) {
        const t = f.a + f.b * k + off, i = Math.round((t - t0) / dt);
        if (i >= 0 && i < env.length) s += env[i];
      }
      if (s > bestS) { bestS = s; bestOff = off; }
    }
    beats = beats.map((_, k) => f.a + f.b * k + bestOff);
  } else {
    // variables Tempo: Beat-Abstaende leicht glaetten (3er-Mittel), Positionen behalten
    const ibi = beats.slice(1).map((t, k) => t - beats[k]);
    const sm = ibi.map((_, k) => (ibi[Math.max(0, k - 1)] + ibi[k] + ibi[Math.min(ibi.length - 1, k + 1)]) / 3);
    const out = [beats[0]];
    for (let k = 0; k < sm.length; k++) out.push(out[k] + sm[k]);
    // Drift korrigieren: alle 8 Beats auf das Original zurueckziehen
    beats = out.map((t, k) => t * 0.5 + beats[k] * 0.5);
    // Tempo aus 8-Beat-Spannen (vermeidet die Frame-Quantisierung einzelner Abstaende)
    const spans: number[] = [];
    for (let k = 0; k + 8 < frames.length; k++) spans.push((frames[k + 8] - frames[k]) * dt / 8);
    const mid = (spans.length ? spans : ibi).slice().sort((a, b) => a - b)[(spans.length ? spans : ibi).length >> 1];
    bpm = 60 / mid;
  }
  // Raster bis an die Songgrenzen verlaengern
  const p0 = beats[1] - beats[0], p1 = beats[beats.length - 1] - beats[beats.length - 2];
  while (beats[0] - p0 > 0) beats.unshift(beats[0] - p0);
  while (beats[beats.length - 1] + p1 < duration) beats.push(beats[beats.length - 1] + p1);
  return { beats, bpm: Math.round(bpm * 100) / 100, steady };
}
