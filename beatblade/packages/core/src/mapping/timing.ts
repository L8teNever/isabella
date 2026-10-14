// Gemeinsame Zeit-Auswahl fuer alle Generatoren (Schnitt, Orbit): Raster-Slots mit Salienz, Musik-Anfang/-Ende,
// Drop-Pausen und Auswahl pro Takt nach Ziel-Dichte. Gleiche Eingaben + gleicher Zufall = gleiches Ergebnis.
import { MAPPING, SECTION_DENSITY } from '../tuning.js';
import { BANDS, type Section, type SongAnalysis, type SectionType } from '../types.js';
import { Rng, beatToTime, sectionAtBeat, barOfBeat, beatOfBar } from './util.js';

export const STEPS = 24;      // Rasteraufloesung der Analyse (pro Beat)

export interface Slot {
  b: number;          // Beat (gebrochen)
  t: number;          // Sekunden
  g: number;          // Index im Analyse-Raster
  sal: number;        // Salienz
  kick: number; snare: number; hat: number; mel: number;
  bar: number;
  inBar: number;      // Position im Takt in Beats
  sec: Section | undefined;
  /** Markierungen */
  drop?: boolean;     // erster Schlag eines Drops
  burst?: boolean;
}


/** Parameter der Zeit-Auswahl (aus der Schwierigkeit des jeweiligen Modus) */
export interface TimingParams {
  /** Unterteilungen pro Beat (1, 2, 4, 3, 8) */
  subdivisions: number[];
  /** Ziel-Noten pro Sekunde bei mittlerer Energie */
  nps: number;
  /** Mindestabstand zweier Noten (s) */
  minGap: number;
  /** hoechstens so viele Noten in einem 1-s-Fenster */
  maxLocalNps: number;
  /** Pause vor Drops verdoppeln (leichteste Stufe) */
  longDropPause: boolean;
  /** schnelle Fuellnoten vor Drops (Bursts) */
  bursts: boolean;
  /** Dichte je Abschnittstyp (Standard: wie Schnitt) */
  sectionDensity?: Record<SectionType, number>;
}

export interface Timing {
  slots: Slot[];
  chosen: Slot[];
  startT: number;
  endT: number;
  /** Beat-Index des Drops -> Pausenbeginn (Beat) */
  pauseBefore: Map<number, number>;
  dropStarts: Set<number>;
}

/** passt ein Schlag zur Zeit t, ohne dass irgendein 1-s-Fenster mehr als max Schlaege enthaelt? */
export function fitsDensity(times: number[], t: number, max: number): boolean {
  const near = times.filter((x) => Math.abs(x - t) < 1);
  near.push(t);
  const u = [...new Set(near.map((x) => Math.round(x * 50)))].sort((a, b) => a - b).map((x) => x / 50);
  let j = 0;
  for (let i = 0; i < u.length; i++) {
    while (u[i] - u[j] >= 1 - 1e-9) j++;
    if (i - j + 1 > Math.floor(max)) return false;
  }
  return true;
}

export function pickTiming(a: SongAnalysis, P: TimingParams, rngMain: Rng): Timing {
  const D = { subdivisions: P.subdivisions, nps: P.nps, minGap: P.minGap, maxLocalNps: P.maxLocalNps, patterns: { burst: P.bursts ? 1 : 0 } };
  const SD = P.sectionDensity ?? SECTION_DENSITY;
  const beats = a.beats;
  const nBeats = beats.length - 1;
  // ---------- 1. Slots ----------
  const subdivs = D.subdivisions;
  const slots: Slot[] = [];
  const g = a.grid.bands;
  const at = (band: (typeof BANDS)[number], i: number) => g[band][i] ?? 0;
  for (let k = 0; k < nBeats; k++) {
    const seen = new Set<number>();
    for (const s of subdivs) {
      // Triolen nur, wo die Musik wirklich in Triolen laeuft; 1/8 nur bei hoher Energie (Bursts/Slider)
      if (s === 3 && (a.triplet[k] ?? 0) < 0.58) continue;
      for (let j = 0; j < s; j++) {
        const gi = Math.round((j * STEPS) / s);
        if (seen.has(gi)) continue;
        seen.add(gi);
        const idx = k * STEPS + gi;
        const kick = at('sub', idx), snare = Math.max(at('lowmid', idx) * 0.6, at('highmid', idx)), hat = at('high', idx);
        const mel = a.melody[k] ?? 0;
        const bar = barOfBeat(a, k), inBar = ((k - a.downbeatOffset) % a.beatsPerBar + a.beatsPerBar) % a.beatsPerBar + j / s;
        // metrische Position
        let metric = MAPPING.metric.other;
        if (gi === 0) metric = inBar === 0 ? MAPPING.metric.downbeat : MAPPING.metric.beat;
        else if (gi === 12) metric = MAPPING.metric.half;
        else if (gi === 6 || gi === 18) metric = MAPPING.metric.quarter;
        const W = MAPPING.bandSalience;
        let sal = W.sub * kick + W.lowmid * at('lowmid', idx) + W.highmid * at('highmid', idx) + W.high * hat + metric;
        if (gi === 0 || gi === 12) sal += MAPPING.melody * mel;
        // feinere Unterteilungen brauchen einen echten Onset
        if (s >= 4 && gi % 12 !== 0 && Math.max(kick, snare, hat) < 0.35) continue;
        if (s === 8 && gi % 6 !== 0 && Math.max(snare, hat) < 0.5) continue;
        slots.push({ b: k + gi / STEPS, t: beatToTime(beats, k + gi / STEPS), g: idx, sal, kick, snare, hat, mel, bar, inBar, sec: sectionAtBeat(a, k) });
      }
    }
  }
  slots.sort((x, y) => x.b - y.b);

  // Musik-Anfang/-Ende: erste/letzte Stelle mit hoerbarer Energie
  const ec = a.energyCurve;
  const firstSound = Math.max(0, ec.findIndex((v) => v > 0.12)) * 0.1;
  let lastSound = a.duration;
  for (let i = ec.length - 1; i >= 0; i--) if (ec[i] > 0.12) { lastSound = i * 0.1; break; }
  const startT = Math.max(firstSound, 1.5);       // nie in den ersten 1,5 s
  const endT = Math.min(lastSound, a.duration - 0.5);

  // Drops und Pausen
  const dropStarts = new Set<number>();
  a.sections.forEach((s, i) => { if (s.type === 'drop' && (i === 0 || a.sections[i - 1].type !== 'drop')) dropStarts.add(s.startBar); });
  const pauseBefore = new Map<number, number>();   // Beat-Index des Drops -> Pausenbeginn (Beat)
  for (const bar of dropStarts) {
    const db = beatOfBar(a, bar); if (db <= 0) continue;
    pauseBefore.set(db, db - MAPPING.dropPause * (P.longDropPause ? 2 : 1));
  }

  // ---------- 2. Auswahl pro Takt ----------
  const chosen: Slot[] = [];
  const byBar = new Map<number, Slot[]>();
  for (const s of slots) { if (s.t < startT || s.t > endT) continue; (byBar.get(s.bar) ?? byBar.set(s.bar, []).get(s.bar)!).push(s); }
  let prevPositions = new Set<number>();
  let prevSec: Section | undefined;
  for (const [bar, list] of [...byBar.entries()].sort((x, y) => x[0] - y[0])) {
    const sec = list[0].sec;
    if (sec !== prevSec) { prevPositions = new Set(); prevSec = sec; }
    const energy = a.barEnergy[bar] ?? 0.5;
    if (energy < 0.06) continue;                               // praktisch Stille
    const barDur = (list[list.length - 1].t - list[0].t) + (beats[1] - beats[0]);
    const type = sec?.type ?? 'verse';
    let target = D.nps * SD[type] * (0.45 + 1.1 * energy);
    // Build-up: Dichte steigt zum Ende des Abschnitts
    if (type === 'buildup' && sec) target *= 0.75 + 0.6 * ((bar - sec.startBar) / Math.max(1, sec.endBar - sec.startBar));
    const budget = Math.max(1, Math.round(target * barDur));
    // Kandidaten: Salienz + Bonus fuer Positionen wie im vorigen Takt
    const cands = list
      .filter((s) => ![...pauseBefore.entries()].some(([db, pb]) => s.b >= pb && s.b < db))
      .map((s) => ({ s, v: s.sal + (prevPositions.has(Math.round(s.inBar * STEPS)) ? 0.18 : 0) + rngMain.next() * 0.03 }))
      .sort((x, y) => y.v - x.v);
    const pick: Slot[] = [];
    for (const { s, v } of cands) {
      if (pick.length >= budget) break;
      if (v < 0.15 && pick.length >= Math.ceil(budget / 2)) break;     // nichts erfinden, wo nichts klingt
      const near = pick.some((p) => Math.abs(p.t - s.t) < D.minGap) || chosen.slice(-4).some((p) => Math.abs(p.t - s.t) < D.minGap);
      if (near) continue;
      // lokale Dichte (1-s-Fenster) einhalten – sonst muesste die Validierung spaeter Noten streichen
      if (!fitsDensity([...chosen.slice(-24), ...pick].map((p) => p.t), s.t, D.maxLocalNps)) continue;
      pick.push(s);
    }
    pick.sort((x, y) => x.b - y.b);
    prevPositions = new Set(pick.map((p) => Math.round(p.inBar * STEPS)));
    chosen.push(...pick);
  }
  // Drop-Downbeats: Doppelnote erzwingen
  for (const [db] of pauseBefore) {
    const t = beatToTime(beats, db);
    if (t < startT || t > endT) continue;
    let s = chosen.find((c) => Math.abs(c.b - db) < 1e-6);
    if (!s) {
      const sl = slots.find((c) => Math.abs(c.b - db) < 1e-6);
      if (sl) { s = sl; chosen.push(sl); }
    }
    if (s) s.drop = true;
  }
  chosen.sort((x, y) => x.b - y.b);
  // Bursts: letzte Viertel vor einer Drop-Pause (Expert+), schnelle Fuellnoten auf 1/4
  if (D.patterns.burst) {
    for (const [, pb] of pauseBefore) {
      for (let q = 0; q < 4; q++) {
        const b = pb - 1 + q * 0.25; if (b < 0) continue;
        const t = beatToTime(beats, b);
        if (t < startT || chosen.some((c) => Math.abs(c.t - t) < D.minGap * 0.9)) continue;
        if (!fitsDensity(chosen.map((c) => c.t), t, D.maxLocalNps)) continue;
        const k = Math.floor(b), gi = Math.round((b - k) * STEPS);
        chosen.push({ b, t, g: k * STEPS + gi, sal: 0.5, kick: 0, snare: 0.5, hat: 0.5, mel: 0, bar: barOfBeat(a, k), inBar: 0, sec: sectionAtBeat(a, k), burst: true });
      }
    }
    chosen.sort((x, y) => x.b - y.b);
  }

  return { slots, chosen, startT, endT, pauseBefore, dropStarts };
}
