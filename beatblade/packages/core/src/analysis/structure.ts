// Struktur-Segmentierung:
// Takt-Merkmale (Chroma + MFCC + Lautheit) -> Self-Similarity-Matrix (Cosinus) -> Novelty-Kurve
// (Checkerboard-Kernel entlang der Diagonale) -> Abschnittsgrenzen (Peaks, auf 4er-Phrasen
// eingerastet, ergaenzt um starke Energiespruenge) -> Klassifikation nach Energie und Lage
// (Intro, Strophe, Build-up, Drop/Refrain, Breakdown, Outro) -> Wiederholungsgruppen.
import { ANALYSIS } from '../tuning.js';
import type { Section, SectionType } from '../types.js';
import { cosine } from './meter.js';

export interface BarFeatures {
  vec: number[][];     // pro Takt normierter Merkmalsvektor
  energy: number[];    // 0..1
}

/** Novelty-Kurve aus der SSM (Checkerboard-Kernel mit Gauss-Fenster) */
export function novelty(ssm: number[][], K: number): number[] {
  const n = ssm.length, out = new Array(n).fill(0), h = Math.max(1, K >> 1);
  for (let i = 0; i < n; i++) {
    let v = 0, wsum = 0;
    for (let a = -h; a < h; a++) for (let b = -h; b < h; b++) {
      const x = i + a, y = i + b; if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const sign = (a < 0) === (b < 0) ? 1 : -1;
      const g = Math.exp(-0.5 * (((a + 0.5) / (h * 0.6)) ** 2 + ((b + 0.5) / (h * 0.6)) ** 2));
      v += sign * g * ssm[x][y]; wsum += g;
    }
    out[i] = wsum ? Math.max(0, v / wsum) : 0;
  }
  return out;
}

export function segment(bf: BarFeatures, barTimes: number[], duration: number): Section[] {
  const { kernelBars, minBars, peakRel, repeatSim } = ANALYSIS.structure;
  const n = bf.vec.length;
  if (n === 0) return [];
  const ssm = bf.vec.map((a) => bf.vec.map((b) => cosine(a, b)));
  const nov = novelty(ssm, kernelBars);
  const maxN = Math.max(...nov, 1e-9);
  // Kandidaten: lokale Maxima der Novelty
  const cand: { bar: number; s: number }[] = [];
  for (let i = 1; i < n - 1; i++) if (nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1] && nov[i] > peakRel * maxN) cand.push({ bar: i, s: nov[i] / maxN });
  // starke Energiespruenge (Drop rein/raus) als zusaetzliche Kandidaten
  for (let i = 2; i < n - 1; i++) {
    const before = (bf.energy[i - 1] + bf.energy[i - 2]) / 2, after = (bf.energy[i] + bf.energy[i + 1]) / 2;
    if (Math.abs(after - before) > 0.28) cand.push({ bar: i, s: 0.8 + Math.abs(after - before) });
  }
  // auf 4er-Phrasen einrasten, wenn nah dran
  for (const c of cand) { const r = Math.round(c.bar / 4) * 4; if (Math.abs(r - c.bar) <= 1 && r > 0 && r < n) c.bar = r; }
  // staerkste zuerst, Mindestabstand
  cand.sort((a, b) => b.s - a.s);
  const bounds: number[] = [];
  for (const c of cand) if (c.bar >= minBars && c.bar <= n - minBars && bounds.every((b) => Math.abs(b - c.bar) >= minBars)) bounds.push(c.bar);
  bounds.sort((a, b) => a - b);
  const edges = [0, ...bounds, n];
  // Abschnitte bilden
  const meanVec = (s: number, e: number) => {
    const d = bf.vec[0].length, m = new Array(d).fill(0);
    for (let i = s; i < e; i++) for (let j = 0; j < d; j++) m[j] += bf.vec[i][j];
    return m.map((v) => v / Math.max(1, e - s));
  };
  const segs = edges.slice(0, -1).map((s, k) => {
    const e = edges[k + 1];
    const en = bf.energy.slice(s, e);
    const energy = en.reduce((a, b) => a + b, 0) / Math.max(1, en.length);
    const half = Math.max(1, (e - s) >> 1);
    const rise = en.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, en.length - half) - en.slice(0, half).reduce((a, b) => a + b, 0) / half;
    return { s, e, energy, rise, vec: meanVec(s, e) };
  });
  // Schwellen relativ zum Song
  const sortedE = bf.energy.slice().sort((a, b) => a - b);
  const pct = (p: number) => sortedE[Math.min(sortedE.length - 1, Math.floor(p * (sortedE.length - 1)))];
  const hi = Math.max(pct(0.62), 0.55), lo = pct(0.3);
  const types: SectionType[] = segs.map((g, k) => {
    if (g.energy >= hi && g.e - g.s >= 4) return 'drop';
    if (k === 0) return 'intro';
    if (k === segs.length - 1) return 'outro';
    if (g.energy <= lo) return 'breakdown';
    return 'verse';
  });
  // Build-up: Abschnitt direkt vor einem Drop, nicht selbst Drop, mit steigender Energie oder kurz
  for (let k = 0; k < segs.length - 1; k++) {
    if (types[k + 1] === 'drop' && types[k] !== 'drop' && (segs[k].rise > 0.04 || segs[k].e - segs[k].s <= 8) && k > 0) types[k] = 'buildup';
  }
  // Intro/Outro, die eigentlich voll sind, bleiben Drop; ein Intro mit hoher Energie wird Strophe
  if (types[0] === 'intro' && segs[0].energy > (hi + lo) / 2) types[0] = 'verse';
  // Wiederholungsgruppen
  const group: number[] = []; let next = 0;
  segs.forEach((g, k) => {
    let found = -1;
    for (let j = 0; j < k; j++) if (cosine(g.vec, segs[j].vec) >= repeatSim && types[j] === types[k]) { found = group[j]; break; }
    group.push(found >= 0 ? found : next++);
  });
  const seen = new Map<number, number>();
  return segs.map((g, k) => {
    const occ = seen.get(group[k]) ?? 0; seen.set(group[k], occ + 1);
    return {
      start: barTimes[g.s] ?? 0,
      end: g.e < barTimes.length ? barTimes[g.e] : duration,
      startBar: g.s, endBar: g.e, type: types[k], energy: Math.round(g.energy * 1000) / 1000, group: group[k], occurrence: occ,
    };
  });
}
