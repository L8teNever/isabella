// Takt- und Downbeat-Erkennung.
// Pro Beat werden Bass-Energie (Kick auf der Eins), Bass-Onsets und harmonische Wechsel (Chroma-
// Aenderung, Akkordwechsel meist auf der Eins) gemessen. Fuer jede Taktart (4/4, 3/4) und jede Phase
// wird bewertet, wie stark diese Merkmale auf den vermuteten Downbeats ueber dem Rest liegen.
// 3/4 wird nur gewaehlt, wenn es deutlich besser passt.
import type { FrameFeatures } from './features.js';

export interface BeatFeatures {
  bass: number[];       // Bass-Energie um den Beat
  bassOnset: number[];  // Sub-Band-Onset-Staerke am Beat
  chromaChange: number[];
  chroma: number[][];   // mittleres Chroma ueber den Beat
  mfcc: number[][];     // mittleres MFCC
  melody: number[];
  rms: number[];
}

const MF = 13;

export function beatFeatures(f: FrameFeatures, beats: number[], subCurve: Float32Array): BeatFeatures {
  const frame = (t: number) => Math.max(0, Math.min(f.n - 1, Math.round((t - f.t0) / f.dt)));
  const out: BeatFeatures = { bass: [], bassOnset: [], chromaChange: [], chroma: [], mfcc: [], melody: [], rms: [] };
  for (let k = 0; k < beats.length; k++) {
    const a = frame(beats[k]), b = Math.max(a + 1, frame(beats[k + 1] ?? beats[k] + (beats[k] - (beats[k - 1] ?? beats[k] - 0.5))));
    const w = Math.max(1, Math.round(0.05 / f.dt));
    let bass = 0, bo = 0;
    for (let i = Math.max(0, a - w); i <= Math.min(f.n - 1, a + w); i++) { bass += f.bandEnergy.sub[i]; bo = Math.max(bo, subCurve[i]); }
    out.bass.push(Math.log1p(bass)); out.bassOnset.push(bo);
    const ch = new Array(12).fill(0), mf = new Array(MF).fill(0);
    let mel = 0, rms = 0, c = 0;
    for (let i = a; i < b && i < f.n; i++) {
      for (let j = 0; j < 12; j++) ch[j] += f.chroma[i * 12 + j];
      for (let j = 0; j < MF; j++) mf[j] += f.mfcc[i * MF + j];
      mel += f.melodic[i]; rms += f.rms[i]; c++;
    }
    c = Math.max(1, c);
    out.chroma.push(ch.map((v) => v / c)); out.mfcc.push(mf.map((v) => v / c));
    out.melody.push(mel / c); out.rms.push(rms / c);
  }
  for (let k = 0; k < beats.length; k++) {
    if (k === 0) { out.chromaChange.push(0); continue; }
    const p = out.chroma[k - 1], q = out.chroma[k];
    out.chromaChange.push(1 - cosine(p, q));
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

function zscore(a: number[]): number[] {
  const m = a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length)) || 1;
  return a.map((v) => (v - m) / sd);
}

export function detectMeter(bf: BeatFeatures): { beatsPerBar: number; offset: number; confidence: number } {
  const n = bf.bass.length;
  if (n < 8) return { beatsPerBar: 4, offset: 0, confidence: 0 };
  const zb = zscore(bf.bass), zo = zscore(bf.bassOnset), zc = zscore(bf.chromaChange);
  const s = zb.map((v, k) => 0.8 * v + 1.0 * zo[k] + 1.2 * zc[k]);
  const evalMeter = (m: number) => {
    let best = { off: 0, score: -Infinity };
    for (let off = 0; off < m; off++) {
      let on = 0, cOn = 0, other = 0, cO = 0;
      for (let k = 0; k < n; k++) { if ((k - off) % m === 0) { on += s[k]; cOn++; } else { other += s[k]; cO++; } }
      const score = on / Math.max(1, cOn) - other / Math.max(1, cO);
      if (score > best.score) best = { off, score };
    }
    return best;
  };
  const m4 = evalMeter(4), m3 = evalMeter(3);
  // 3/4 nur bei klarer Ueberlegenheit
  if (m3.score > m4.score * 1.35 && m3.score > 0.6) return { beatsPerBar: 3, offset: m3.off, confidence: Math.min(1, m3.score / 2) };
  return { beatsPerBar: 4, offset: m4.off, confidence: Math.min(1, Math.max(0, m4.score / 2)) };
}
