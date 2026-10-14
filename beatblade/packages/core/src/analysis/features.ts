// Ein STFT-Durchlauf (Hann, 2048/512) berechnet alle Merkmale pro Frame, ohne das ganze
// Spektrogramm im Speicher zu halten:
//  - Spectral Flux je Band (Sub, Low-Mid, High-Mid, High) auf log-komprimierten Magnituden
//  - Band-Energien, RMS, spektraler Schwerpunkt (Helligkeit)
//  - Chroma (12 Tonklassen) und MFCC (13) fuer die Struktur-Analyse
//  - Anteil harmonischer Energie 300–3400 Hz (Melodie/Gesang)
import { FFT, hann } from './fft.js';
import { ANALYSIS } from '../tuning.js';
import { BANDS, type Band } from '../types.js';

export interface FrameFeatures {
  n: number;
  hop: number;
  sr: number;
  /** Sekunden pro Frame */
  dt: number;
  /** Zeit des Frames i = (i * hop + fft/2) / sr */
  t0: number;
  flux: Record<Band, Float32Array>;
  bandEnergy: Record<Band, Float32Array>;
  rms: Float32Array;
  centroid: Float32Array;   // Hz
  chroma: Float32Array;     // n * 12
  mfcc: Float32Array;       // n * 13
  melodic: Float32Array;    // 0..1
}

const N_MEL = 40, N_MFCC = 13;

function melFilterbank(nBins: number, sr: number, fft: number, fmin = 0, fmax = 8000) {
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700), inv = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const m0 = mel(fmin), m1 = mel(fmax);
  const pts = Array.from({ length: N_MEL + 2 }, (_, i) => inv(m0 + ((m1 - m0) * i) / (N_MEL + 1)));
  const bin = (f: number) => (f * fft) / sr;
  // je Filter: [startBin, Gewichte[]]
  return Array.from({ length: N_MEL }, (_, m) => {
    const a = bin(pts[m]), c = bin(pts[m + 1]), b = bin(pts[m + 2]);
    const s = Math.max(0, Math.floor(a)), e = Math.min(nBins - 1, Math.ceil(b));
    const w = new Float32Array(e - s + 1);
    for (let k = s; k <= e; k++) w[k - s] = k < c ? Math.max(0, (k - a) / (c - a)) : Math.max(0, (b - k) / (b - c));
    return { s, w };
  });
}

export function computeFeatures(pcm: Float32Array, sr = ANALYSIS.sampleRate, onProgress?: (p: number) => void): FrameFeatures {
  const N = ANALYSIS.fftSize, H = ANALYSIS.hop, nBins = N / 2 + 1;
  const n = Math.max(1, Math.floor((pcm.length - N) / H) + 1);
  const fft = new FFT(N), win = hann(N), frame = new Float32Array(N);
  const mag = new Float32Array(nBins), logm = new Float32Array(nBins), prev = new Float32Array(nBins);
  const hz = (k: number) => (k * sr) / N;
  const bandRange: Record<Band, [number, number]> = {} as never;
  for (const b of BANDS) {
    const [lo, hi] = ANALYSIS.bands[b];
    bandRange[b] = [Math.max(1, Math.round((lo * N) / sr)), Math.min(nBins - 1, Math.round((hi * N) / sr))];
  }
  const flux = Object.fromEntries(BANDS.map((b) => [b, new Float32Array(n)])) as Record<Band, Float32Array>;
  const bandEnergy = Object.fromEntries(BANDS.map((b) => [b, new Float32Array(n)])) as Record<Band, Float32Array>;
  const rms = new Float32Array(n), centroid = new Float32Array(n), melodic = new Float32Array(n);
  const chroma = new Float32Array(n * 12), mfcc = new Float32Array(n * N_MFCC);
  // Chroma: Bin -> Tonklasse (nur 55 Hz – 5 kHz)
  const pc = new Int8Array(nBins).fill(-1);
  for (let k = 1; k < nBins; k++) {
    const f = hz(k); if (f < 55 || f > 5000) continue;
    pc[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
  }
  const mels = melFilterbank(nBins, sr, N);
  const melE = new Float32Array(N_MEL);
  // DCT-II Matrix fuer MFCC
  const dct = new Float32Array(N_MFCC * N_MEL);
  for (let c = 0; c < N_MFCC; c++) for (let m = 0; m < N_MEL; m++) dct[c * N_MEL + m] = Math.cos((Math.PI * c * (m + 0.5)) / N_MEL);
  const melLo = Math.round((300 * N) / sr), melHi = Math.round((3400 * N) / sr);
  const g = ANALYSIS.logGamma;

  for (let i = 0; i < n; i++) {
    const off = i * H;
    let sq = 0;
    for (let j = 0; j < N; j++) { const v = pcm[off + j] || 0; frame[j] = v * win[j]; sq += v * v; }
    rms[i] = Math.sqrt(sq / N);
    fft.forward(frame); fft.magnitude(mag);
    let num = 0, den = 0;
    for (let k = 0; k < nBins; k++) {
      logm[k] = Math.log1p(g * mag[k]);
      num += hz(k) * mag[k]; den += mag[k];
    }
    centroid[i] = den > 1e-9 ? num / den : 0;
    // Flux und Energie je Band
    for (const b of BANDS) {
      const [lo, hi] = bandRange[b];
      let f = 0, e = 0;
      for (let k = lo; k <= hi; k++) { const d = logm[k] - prev[k]; if (d > 0) f += d; e += mag[k] * mag[k]; }
      flux[b][i] = i === 0 ? 0 : f / (hi - lo + 1);
      bandEnergy[b][i] = e;
    }
    // Chroma
    const cb = i * 12;
    for (let k = 1; k < nBins; k++) if (pc[k] >= 0) chroma[cb + pc[k]] += logm[k];
    let cmax = 1e-9; for (let c = 0; c < 12; c++) cmax = Math.max(cmax, chroma[cb + c]);
    for (let c = 0; c < 12; c++) chroma[cb + c] /= cmax;
    // MFCC
    for (let m = 0; m < N_MEL; m++) { const { s, w } = mels[m]; let e = 0; for (let k = 0; k < w.length; k++) e += w[k] * mag[s + k] * mag[s + k]; melE[m] = Math.log(e + 1e-10); }
    for (let c = 0; c < N_MFCC; c++) { let v = 0; for (let m = 0; m < N_MEL; m++) v += dct[c * N_MEL + m] * melE[m]; mfcc[i * N_MFCC + c] = v; }
    // Melodie: Anteil 300–3400 Hz an der Gesamtenergie, gewichtet mit "Tonalitaet" (wenig Flux)
    let me = 0, te = 1e-12;
    for (let k = 1; k < nBins; k++) { const e = mag[k] * mag[k]; te += e; if (k >= melLo && k <= melHi) me += e; }
    melodic[i] = me / te;
    prev.set(logm);
    if (onProgress && (i & 1023) === 0) onProgress(i / n);
  }
  return { n, hop: H, sr, dt: H / sr, t0: N / 2 / sr, flux, bandEnergy, rms, centroid, chroma, mfcc, melodic };
}

export const MFCC_DIM = N_MFCC;
