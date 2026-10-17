// Komplette Song-Analyse: PCM (Mono, Float32; optional die Stereo-Seite L-R fuer die Melodie ohne Gesang) -> SongAnalysis.
import { ANALYSIS } from '../tuning.js';
import { ANALYSIS_VERSION } from '../version.js';
import { BANDS, type Band, type SongAnalysis, type Waveform } from '../types.js';
import { computeFeatures } from './features.js';
import { detectOnsets, normalize, percentile, pickPeaks } from './onsets.js';
import { estimateTempo, trackBeats, refineBeats, rigidGrid } from './tempo.js';
import { beatFeatures, detectMeter } from './meter.js';
import { segment } from './structure.js';

/** Raster-Aufloesung fuer Onset-Staerken: 24 Schritte pro Beat (deckt 1/2, 1/3, 1/4, 1/6, 1/8 ab) */
export const GRID_STEPS = 24;

export type Progress = (stage: string, p: number) => void;

export function analyze(pcm: Float32Array, sr = ANALYSIS.sampleRate, onProgress?: Progress, side?: Float32Array): SongAnalysis {
  const t0 = Date.now();
  const duration = pcm.length / sr;
  const f = computeFeatures(pcm, sr, (p) => onProgress?.('features', p));
  onProgress?.('onsets', 0);
  const on = detectOnsets(f);
  onProgress?.('tempo', 0);
  const tempo = estimateTempo(on.envelope, f.dt);
  let frames = trackBeats(on.envelope, tempo.period);
  let ref = refineBeats(frames, f.dt, f.t0, duration, on.envelope);
  // Plausibilitaet: weicht das getrackte Tempo um eine Oktave ab, mit halbem/doppeltem Raster vergleichen
  const ratio = ref.bpm / tempo.bpm;
  if (Math.abs(ratio - 2) < 0.1 || Math.abs(ratio - 0.5) < 0.05) {
    frames = trackBeats(on.envelope, tempo.period, ANALYSIS.beat.tightness * 3);
    ref = refineBeats(frames, f.dt, f.t0, duration, on.envelope);
  }
  // Oktave final in den bevorzugten Bereich (70..180) holen: Raster halbieren/verdoppeln
  let beats = ref.beats, bpm = ref.bpm;
  while (bpm > ANALYSIS.tempo.preferHigh && beats.length > 8) { beats = beats.filter((_, k) => k % 2 === 0); bpm /= 2; }
  while (bpm < ANALYSIS.tempo.preferLow) {
    const nb: number[] = [];
    beats.forEach((t, k) => { nb.push(t); if (k < beats.length - 1) nb.push((t + beats[k + 1]) / 2); });
    beats = nb; bpm *= 2;
  }
  // sehr schnelle Tempi (> 162) mit starker Periodizitaet auf halbem Tempo sind fast immer Halbtakt-gefuehlt
  const acfAt = (b: number) => tempo.candidates.reduce((m, c) => (Math.abs(c.bpm - b) < 0.6 ? Math.max(m, c.score) : m), 0);
  // Oktav-Pruefung ueber Kick/Snare: Der Beat ist die Ebene, auf der Kick und Snare liegen; Hi-Hats
  // fuellen nur Unterteilungen. Tragen die ungeraden Beats kaum Bass/Snare-Energie, ist das halbe Tempo richtig.
  const low = (t: number) => {
    const i = Math.round((t - f.t0) / f.dt); let m = 0;
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < f.n) m = Math.max(m, on.curves.sub[j] + on.curves.lowmid[j] + on.curves.highmid[j]);
    return m;
  };
  let even = 0, odd = 0;
  for (let k = 0; k + 1 < beats.length; k += 2) { even += low(beats[k]); odd += low(beats[k + 1]); }
  const lowRatio = Math.min(even, odd) / (Math.max(even, odd) || 1);
  const halve = beats.length > 8 && ((bpm >= 140 && lowRatio < 0.6) || (bpm > 162 && lowRatio < 0.85 && acfAt(bpm / 2) >= 0.85 * acfAt(bpm)));
  if (halve) { const ph = odd > even ? 1 : 0; beats = beats.filter((_, k) => k % 2 === ph); bpm /= 2; }
  // festes Tempo (Techno, House, elektronisch produziert): exakt auf die Kicks einrasten
  // (gesamte Anschlags-Kurve: verzerrte Hard-Techno-Kicks liegen nicht nur im Sub-Band)
  const rigid = rigidGrid(beats, bpm, on.envelope, f.dt, f.t0, duration);
  if (rigid) { beats = rigid.beats; bpm = rigid.bpm; }
  bpm = Math.round(bpm * 100) / 100;
  onProgress?.('meter', 0);
  const bf = beatFeatures(f, beats, on.curves.sub);
  const meter = detectMeter(bf);
  const bpb = meter.beatsPerBar;
  // Takte
  const bars: number[] = [];
  for (let k = meter.offset; k < beats.length; k += bpb) bars.push(beats[k]);
  if (meter.offset > 0) bars.unshift(Math.max(0, beats[meter.offset] - bpb * (60 / bpm)));
  // Energie pro Takt: Lautheit (dB) + Helligkeit
  const frame = (t: number) => Math.max(0, Math.min(f.n - 1, Math.round((t - f.t0) / f.dt)));
  const rmsDb = Array.from(f.rms, (v) => 20 * Math.log10(v + 1e-6));
  const lo = percentile(rmsDb, 0.05), hi = percentile(rmsDb, 0.97);
  const cLo = percentile(f.centroid, 0.05), cHi = percentile(f.centroid, 0.95);
  const barEnergyRaw: number[] = [];
  const barVec: number[][] = [];
  for (let b = 0; b < bars.length; b++) {
    const a = frame(bars[b]), e = Math.max(a + 1, frame(bars[b + 1] ?? duration));
    let r = 0, c = 0, cnt = 0;
    const ch = new Array(12).fill(0), mf = new Array(13).fill(0);
    for (let i = a; i < e; i++) {
      r += rmsDb[i]; c += f.centroid[i]; cnt++;
      for (let j = 0; j < 12; j++) ch[j] += f.chroma[i * 12 + j];
      for (let j = 0; j < 13; j++) mf[j] += f.mfcc[i * 13 + j];
    }
    cnt = Math.max(1, cnt);
    const en = 0.75 * clamp01((r / cnt - lo) / (hi - lo || 1)) + 0.25 * clamp01((c / cnt - cLo) / (cHi - cLo || 1));
    barEnergyRaw.push(en);
    barVec.push([...ch.map((v) => v / cnt), ...mf.slice(1).map((v) => v / cnt / 10), en * 2]);
  }
  // Merkmale je Dimension standardisieren (sonst dominiert MFCC-Skala)
  const dims = barVec[0]?.length ?? 0;
  for (let j = 0; j < dims; j++) {
    const col = barVec.map((v) => v[j]); const m = col.reduce((s, v) => s + v, 0) / col.length;
    const sd = Math.sqrt(col.reduce((s, v) => s + (v - m) ** 2, 0) / col.length) || 1;
    barVec.forEach((v) => { v[j] = (v[j] - m) / sd; });
  }
  // Energie leicht glaetten (3 Takte)
  const barEnergy = barEnergyRaw.map((_, k) => {
    const w = [barEnergyRaw[k - 1], barEnergyRaw[k], barEnergyRaw[k + 1]].filter((v) => v !== undefined) as number[];
    return Math.round((w.reduce((s, v) => s + v, 0) / w.length) * 1000) / 1000;
  });
  onProgress?.('structure', 0);
  // festes Tempo (eingerastetes Raster oder gleichmaessig getrackt): ruhigere Abschnitte in 8er-Phrasen
  const fixedTempo = !!rigid || ref.steady;
  const sections = segment({ vec: barVec, energy: barEnergy }, bars, duration, fixedTempo ? { minBars: ANALYSIS.structure.minBarsFixed, phrase: 8 } : {});
  // Raster: Onset-Staerke je Band an 1/24-Beat-Positionen (max. im +-20-ms-Fenster)
  const win = Math.max(1, Math.round(0.02 / f.dt));
  const grid: SongAnalysis['grid'] = { step: 1 / GRID_STEPS, bands: {} as Record<Band, number[]> };
  for (const b of BANDS) {
    const c = on.curves[b], arr: number[] = [];
    for (let k = 0; k < beats.length - 1; k++) {
      for (let s = 0; s < GRID_STEPS; s++) {
        const t = beats[k] + ((beats[k + 1] - beats[k]) * s) / GRID_STEPS, i = frame(t);
        let m = 0; for (let j = i - win; j <= i + win; j++) if (j >= 0 && j < f.n) m = Math.max(m, c[j]);
        arr.push(Math.round(Math.min(1, m) * 1000) / 1000);
      }
    }
    grid.bands[b] = arr;
  }
  // ---------- Melodie ohne Gesang ----------
  // Gesang steht im Stereobild fast immer genau in der Mitte, Melodie-Instrumente (Synths, Gitarren, Pads, Leads) sind breit.
  // Die Seite (L-R) enthaelt deshalb die Instrumente ohne den Gesang. Ist das Lied (fast) mono, bleibt nur die Mitte:
  // dort zaehlen nur Toene mit hartem Anschlag (Instrumente) – gesungene Silben setzen weich ein.
  onProgress?.('melody', 0);
  let src = f, stereoWidth = 0;
  if (side) {
    const sf = computeFeatures(side, sr);
    const mean = (x: Float32Array) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / (x.length || 1); };
    stereoWidth = Math.round((mean(sf.rms) / (mean(f.rms) || 1)) * 1000) / 1000;
    if (stereoWidth >= ANALYSIS.lead.minWidth) src = sf;
  }
  const fromSide = src !== f;
  const lvlMax = percentile(src.rms, 0.9) || 1;
  const atk = new Float32Array(src.n);
  for (let i = 0; i < src.n; i++) atk[i] = src.flux.lowmid[i] + src.flux.highmid[i];
  const atkMax = percentile(atk, 0.9) || 1;
  const leadCurve = new Float32Array(src.n), leadLevel = new Float32Array(src.n);
  for (let i = 2; i < src.n; i++) {
    // neue Toene: positive Chroma-Aenderung (Schlagzeug aendert die Chroma kaum), nur wo es klingt und melodisch ist
    let d = 0;
    for (let c = 0; c < 12; c++) d += Math.max(0, src.chromaHi[i * 12 + c] - src.chromaHi[(i - 2) * 12 + c]);
    // Anteil im Melodie-Bereich absolut (nicht am Song gemessen – sonst wird bei reinem Schlagzeug der Snare-Anteil zur „Melodie“)
    const level = Math.min(1, src.rms[i] / lvlMax), mel = clamp01((src.melodic[i] - ANALYSIS.lead.melodicMin) / ANALYSIS.lead.melodicRange);
    const attack = Math.min(1, Math.max(atk[i], atk[i - 1]) / atkMax);
    // Tonalitaet: echte Toene sammeln sich auf wenigen Tonklassen, Schlagzeug/Rauschen verteilt sich auf alle
    let sum = 0; for (let c = 0; c < 12; c++) sum += src.chromaHi[i * 12 + c];
    const tonal = clamp01((12 / (sum || 12) - ANALYSIS.lead.tonalMin) / ANALYSIS.lead.tonalRange);
    leadLevel[i] = level * mel * tonal;
    leadCurve[i] = d * level * mel * tonal * (fromSide ? Math.sqrt(attack) : attack);
  }
  // absolut skaliert (nicht am eigenen Maximum): ein Lied ohne Melodie bekommt so auch keine „lautesten“ Melodie-Toene
  const leadRef = Math.max(percentile(leadCurve, 0.99), ANALYSIS.lead.curveFloor);
  const leadN = new Float32Array(src.n);
  for (let i = 0; i < src.n; i++) leadN[i] = Math.min(1, leadCurve[i] / leadRef);
  const leadOnsets = pickPeaks(leadN, src, ANALYSIS.onset.leadMinGap).map((o) => ({ t: Math.round(o.t * 1000) / 1000, s: Math.round(o.s * 1000) / 1000 }));
  const leadGrid: number[] = [];
  for (let k = 0; k < beats.length - 1; k++) {
    for (let s = 0; s < GRID_STEPS; s++) {
      const t = beats[k] + ((beats[k + 1] - beats[k]) * s) / GRID_STEPS, i = frame(t);
      let m = 0; for (let j = i - win; j <= i + win; j++) if (j >= 0 && j < src.n) m = Math.max(m, leadN[j]);
      leadGrid.push(Math.round(Math.min(1, m) * 1000) / 1000);
    }
  }
  grid.lead = leadGrid;
  // Melodie pro Beat (0..1): wie viel Melodie-Instrument klingt (ohne Gesang)
  const melRaw: number[] = [];
  for (let k = 0; k < beats.length - 1; k++) {
    const a0 = frame(beats[k]), e = Math.max(a0 + 1, frame(beats[k + 1]));
    let s = 0; for (let i = a0; i < e; i++) s += leadLevel[i];
    melRaw.push(s / (e - a0));
  }
  if (beats.length > 1) melRaw.push(melRaw[melRaw.length - 1]);
  // dazu: wie oft wirklich Melodie-Toene anschlagen (staerkster Ton je Beat, ueber ±2 Beats geglaettet)
  const act = melRaw.map((_, k) => { let m = 0; for (let s = 0; s < GRID_STEPS; s++) m = Math.max(m, leadGrid[k * GRID_STEPS + s] ?? 0); return m; });
  const actS = act.map((_, k) => { const w = act.slice(Math.max(0, k - 2), k + 3); return w.reduce((x, v) => x + v, 0) / w.length; });
  const lvl = melRaw.map((v) => clamp01(v / ANALYSIS.lead.levelRef));
  const melN = lvl.map((v, k) => clamp01(0.5 * v + 0.5 * Math.min(1, actS[k] * 1.5)));
  // Triolen-Neigung pro Beat: Onsets auf 1/3, 2/3 vs. 1/4, 1/2, 3/4
  const triplet: number[] = [];
  for (let k = 0; k < beats.length - 1; k++) {
    const g = (s: number) => BANDS.reduce((acc, b) => acc + grid.bands[b][k * GRID_STEPS + s], 0);
    const tri = g(8) + g(16), str = g(6) + g(12) + g(18);
    triplet.push(Math.round((tri / 2 / ((tri / 2 + str / 3) || 1)) * 100) / 100);
  }
  // Gehaltene Klaenge (fuer Orbit-Rails): Melodie da und die Toene bleiben ueber die Beats gleich
  // (stabile Harmonie statt staendig neuer Toene). Drums duerfen dabei weiterlaufen.
  const sustain: number[] = [], pitchRaw: number[] = [];
  for (let k = 0; k < beats.length - 1; k++) {
    const change = Math.max(bf.chromaChange[k] ?? 0, bf.chromaChange[k + 1] ?? 0);
    const steady = 1 - Math.min(1, change * 4);
    sustain.push(Math.round(clamp01(Math.sqrt(melN[k]) * steady) * 100) / 100);
    // Tonhoehe: Schwerpunkt der melodischen Frames, logarithmisch
    const a = frame(beats[k]), e = Math.max(a + 1, frame(beats[k + 1]));
    let num = 0, den = 0;
    for (let i = a; i < e; i++) { const w = src.melodic[i] + 1e-3; num += Math.log2(Math.max(50, src.centroid[i])) * w; den += w; }
    pitchRaw.push(den ? num / den : 10);
  }
  // Tonhoehe auf 0..1 normieren (5.–95. Perzentil des Songs) und ueber 3 Beats glaetten
  const pl = percentile(pitchRaw, 0.05), ph = percentile(pitchRaw, 0.95);
  const pitch = pitchRaw.map((_, k) => {
    const w = [pitchRaw[k - 1], pitchRaw[k], pitchRaw[k + 1]].filter((v) => v !== undefined) as number[];
    return Math.round(clamp01((w.reduce((s, v) => s + v, 0) / w.length - pl) / (ph - pl || 1)) * 100) / 100;
  });
  // Energiekurve ~10/s
  const ec: number[] = [];
  const step = Math.max(1, Math.round(0.1 / f.dt));
  for (let i = 0; i < f.n; i += step) {
    let r = 0; for (let j = i; j < Math.min(f.n, i + step); j++) r += rmsDb[j];
    ec.push(Math.round(clamp01((r / step - lo) / (hi - lo || 1)) * 100) / 100);
  }
  const onsets = {} as SongAnalysis['onsets'];
  for (const b of BANDS) onsets[b] = on.onsets[b].map((o) => ({ t: Math.round(o.t * 1000) / 1000, s: Math.round(o.s * 100) / 100 }));
  return {
    version: ANALYSIS_VERSION, duration, sampleRate: sr, bpm, bpmConfidence: Math.round(tempo.confidence * 100) / 100,
    beats: beats.map((t) => Math.round(t * 10000) / 10000), downbeatOffset: meter.offset, beatsPerBar: bpb,
    bars: bars.map((t) => Math.round(t * 10000) / 10000), barEnergy, melody: melN.map((v) => Math.round(v * 100) / 100),
    onsets, leadOnsets, stereoWidth, fixedTempo: !!rigid, grid, triplet, sustain, pitch, sections, energyCurve: ec, took: Date.now() - t0,
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
function normalizeArr(a: number[]): number[] {
  const n = normalize(Float32Array.from(a), 0.95);
  const lo = percentile(n, 0.1);
  return Array.from(n, (v) => clamp01((v - lo) / (1 - lo || 1)));
}

/** kompakte Wellenform fuer die Debug-Ansicht: count Paare (min, max) */
export function waveform(pcm: Float32Array, sr: number, count = ANALYSIS.waveformPeaks): Waveform {
  const per = Math.max(1, Math.floor(pcm.length / count)), peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    let mn = 0, mx = 0;
    for (let j = i * per; j < Math.min(pcm.length, (i + 1) * per); j++) { const v = pcm[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
    peaks.push(Math.round(mn * 1000) / 1000, Math.round(mx * 1000) / 1000);
  }
  return { peaks, count, duration: pcm.length / sr };
}
