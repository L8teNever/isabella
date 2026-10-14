// Onset-Erkennung pro Band: Spectral Flux -> normalisieren -> adaptive Schwelle
// (gleitender Median * Faktor + Delta) -> Peak-Picking mit Mindestabstand.
import { ANALYSIS } from '../tuning.js';
import { BANDS, type Band, type Onset } from '../types.js';
import type { FrameFeatures } from './features.js';

/** Wert am Perzentil p (0..1) */
export function percentile(a: ArrayLike<number>, p: number): number {
  const s = Float32Array.from(a as ArrayLike<number>).sort();
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** Kurve auf 0..1 skalieren (99. Perzentil = 1, Ausreisser abgeschnitten) */
export function normalize(a: Float32Array, p = 0.99): Float32Array {
  const m = percentile(a, p) || 1e-9;
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = Math.min(1.5, a[i] / m);
  return o;
}

/** gleitender Median (Fenster in Frames, ungerade) */
export function movingMedian(a: Float32Array, win: number): Float32Array {
  const h = Math.max(1, win >> 1), o = new Float32Array(a.length), buf: number[] = [];
  for (let i = 0; i < a.length; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(a.length - 1, i + h); j++) buf.push(a[j]);
    buf.sort((x, y) => x - y);
    o[i] = buf[buf.length >> 1];
  }
  return o;
}

/** gleitender Mittelwert */
export function movingMean(a: ArrayLike<number>, win: number): Float32Array {
  const h = Math.max(1, win >> 1), o = new Float32Array(a.length);
  let s = 0, c = 0;
  // Praefixsummen
  const pre = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - h), hi = Math.min(a.length, i + h + 1);
    s = pre[hi] - pre[lo]; c = hi - lo; o[i] = s / c;
  }
  return o;
}

export function pickPeaks(curve: Float32Array, f: FrameFeatures, minGap: number): Onset[] {
  const { onset } = ANALYSIS;
  const med = movingMedian(curve, Math.round(onset.medianWindow / f.dt) | 1);
  const gap = Math.max(1, Math.round(minGap / f.dt));
  const out: Onset[] = [];
  let last = -1e9;
  for (let i = 1; i < curve.length - 1; i++) {
    const v = curve[i];
    if (v < med[i] * onset.factor + onset.delta) continue;
    if (v < curve[i - 1] || v < curve[i + 1]) continue;   // lokales Maximum
    // im Fenster +-gap das groesste
    let isMax = true;
    for (let j = Math.max(0, i - gap); j <= Math.min(curve.length - 1, i + gap); j++) if (curve[j] > v) { isMax = false; break; }
    if (!isMax) continue;
    if (i - last < gap) continue;
    last = i;
    out.push({ t: f.t0 + i * f.dt, s: Math.min(1, v) });
  }
  return out;
}

export interface OnsetResult {
  /** normalisierte Flux-Kurven je Band */
  curves: Record<Band, Float32Array>;
  /** kombinierte Onset-Staerke (fuer Tempo/Beats), mittelwertbefreit, >= 0 */
  envelope: Float32Array;
  onsets: Record<Band, Onset[]>;
}

export function detectOnsets(f: FrameFeatures): OnsetResult {
  const curves = {} as Record<Band, Float32Array>;
  const onsets = {} as Record<Band, Onset[]>;
  for (const b of BANDS) {
    curves[b] = normalize(f.flux[b]);
    onsets[b] = pickPeaks(curves[b], f, ANALYSIS.onset.minGap[b]);
  }
  // kombinierte Kurve: gewichtete Summe, lokaler Mittelwert abgezogen (Hochpass), halbwellen-gleichgerichtet
  const env = new Float32Array(f.n);
  for (const b of BANDS) { const w = ANALYSIS.bandWeight[b], c = curves[b]; for (let i = 0; i < f.n; i++) env[i] += w * c[i]; }
  const mean = movingMean(env, Math.round(1 / f.dt) | 1);
  for (let i = 0; i < f.n; i++) env[i] = Math.max(0, env[i] - mean[i]);
  const envN = normalize(env);
  return { curves, envelope: envN, onsets };
}
