// Hilfen fuer das Mapping: deterministischer Zufall, Beat <-> Zeit, Abschnitte.
import type { SongAnalysis, Section } from '../types.js';

/** 32-bit-Hash eines Strings (FNV-1a) */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** deterministischer Zufallsgenerator (mulberry32) */
export class Rng {
  private s: number;
  constructor(seed: number | string) { this.s = typeof seed === 'string' ? hash(seed) : seed >>> 0; }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p: number): boolean { return this.next() < p; }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]; }
  /** gewichtete Auswahl */
  weighted<K extends string>(w: Partial<Record<K, number>>): K {
    const e = Object.entries(w) as [K, number][];
    const sum = e.reduce((s, [, v]) => s + (v || 0), 0);
    let r = this.next() * sum;
    for (const [k, v] of e) { r -= v || 0; if (r <= 0) return k; }
    return e[e.length - 1][0];
  }
}

/** Beat (gebrochen) -> Sekunden ueber das variable Beat-Raster */
export function beatToTime(beats: number[], b: number): number {
  const n = beats.length;
  if (n < 2) return b * 0.5;
  if (b <= 0) return beats[0] + b * (beats[1] - beats[0]);
  const k = Math.floor(b);
  if (k >= n - 1) return beats[n - 1] + (b - (n - 1)) * (beats[n - 1] - beats[n - 2]);
  return beats[k] + (b - k) * (beats[k + 1] - beats[k]);
}

/** Abschnitt zu einem Beat-Index */
export function sectionAtBeat(a: SongAnalysis, k: number): Section | undefined {
  const bar = Math.floor((k - a.downbeatOffset) / a.beatsPerBar) + (a.downbeatOffset > 0 ? 1 : 0);
  return a.sections.find((s) => bar >= s.startBar && bar < s.endBar) ?? a.sections[a.sections.length - 1];
}

/** Takt-Index eines Beats */
export function barOfBeat(a: SongAnalysis, k: number): number {
  return Math.max(0, Math.floor((k - a.downbeatOffset) / a.beatsPerBar) + (a.downbeatOffset > 0 ? 1 : 0));
}

/** erster Beat-Index eines Takts */
export function beatOfBar(a: SongAnalysis, bar: number): number {
  return a.downbeatOffset + (bar - (a.downbeatOffset > 0 ? 1 : 0)) * a.beatsPerBar;
}
