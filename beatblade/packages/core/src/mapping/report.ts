// Timing-Messung: liegen die Noten auf hoerbaren Sounds? (Werkzeug fuer scripts/timing-report.mjs und Tests)
// Referenz sind die Onsets der vier Spektral-Baender und (falls vorhanden) von Gesang/Lead – unabhaengig vom Beat-Raster.
// Weil Musik sehr viele kleine Onsets hat (Hi-Hats: 15–20 pro Sekunde), gibt es zusaetzlich strengere Werte
// und als Vergleich alle 1/4-Rasterpunkte ("Raster"): so oft traefe man auch ohne Musik-Bezug.
import { BANDS, type SongAnalysis } from '../types.js';
import { STEPS } from './timing.js';

export interface TimingReport {
  /** Notenzeitpunkte (Doppelnoten zaehlen einmal) */
  notes: number;
  /** Anteil mit einem Onset (beliebiges Band, Staerke >= 0,15) innerhalb ±30 ms */
  onsetHit: number;
  /** Anteil mit einem deutlichen Onset (Staerke >= 0,5) innerhalb ±30 ms */
  clearHit: number;
  /** Anteil mit einem Onset innerhalb ±15 ms */
  tightHit: number;
  /** mittlere und 90-%-Abweichung zum naechsten Onset (ms) */
  meanDev: number;
  p90Dev: number;
  /** Zeitpunkte auf "stillen" Raster-Slots (staerkster Band-Onset dort < 0,2) */
  silent: number;
  /** Vergleich: Anteil deutlicher Treffer ueber alle 1/4-Rasterpunkte im gespielten Bereich */
  rasterClear: number;
}

export function timingReport(a: SongAnalysis, notes: { t: number; b: number }[]): TimingReport {
  const refOf = (min: number) => [...BANDS.flatMap((band) => a.onsets[band]), ...(a.leadOnsets ?? a.vocalOnsets ?? [])].filter((o) => o.s >= min).map((o) => o.t).sort((x, y) => x - y);
  const all = refOf(0.15), clear = refOf(0.5);
  const near = (ref: number[], t: number) => {
    let lo = 0, hi = ref.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < t) lo = m + 1; else hi = m; }
    return Math.min(Math.abs((ref[lo] ?? Infinity) - t), Math.abs((ref[lo - 1] ?? -Infinity) - t));
  };
  const times = [...new Map(notes.map((n) => [Math.round(n.t * 200), n])).values()].sort((x, y) => x.t - y.t);
  const devs: number[] = [];
  let hit = 0, cl = 0, tight = 0, silent = 0;
  for (const n of times) {
    const d = near(all, n.t);
    devs.push(d);
    if (d <= 0.03) hit++;
    if (d <= 0.015) tight++;
    if (near(clear, n.t) <= 0.03) cl++;
    const gi = Math.round(n.b * STEPS);
    if (Math.max(...BANDS.map((band) => a.grid.bands[band][gi] ?? 0)) < 0.2) silent++;
  }
  // Vergleich: alle 1/4-Rasterpunkte zwischen erster und letzter Note
  let rc = 0, rn = 0;
  if (times.length) {
    const b0 = Math.ceil(times[0].b), b1 = Math.floor(times[times.length - 1].b);
    for (let k = b0; k < b1 && k + 1 < a.beats.length; k++) for (let q = 0; q < 4; q++) {
      rn++; if (near(clear, a.beats[k] + (q / 4) * (a.beats[k + 1] - a.beats[k])) <= 0.03) rc++;
    }
  }
  devs.sort((x, y) => x - y);
  const n = Math.max(1, times.length), pct = (v: number) => Math.round(v * 1000) / 1000, ms = (v: number) => Math.round(v * 10000) / 10;
  return {
    notes: times.length, onsetHit: pct(hit / n), clearHit: pct(cl / n), tightHit: pct(tight / n),
    meanDev: ms(devs.reduce((s, v) => s + Math.min(v, 0.25), 0) / n), p90Dev: ms(Math.min(0.25, devs[Math.floor(devs.length * 0.9)] ?? 0)),
    silent, rasterClear: pct(rc / Math.max(1, rn)),
  };
}
