// Orbit-Duett: gleiche Stimmen-Aufteilung wie Schnitt (mapping/duet.ts).
// Rails entstehen fuer beide Stimmen aus demselben Zufallsstrom und gehoeren der Stimme, deren Slot sie startet;
// Gold an Drop-Starts spielen beide (Unisono). Jede Stimme ist ein vollstaendiges Orbit-Level.
import type { Difficulty, DuetMap, OrbitMap, SongAnalysis } from '../../types.js';
import { Rng } from '../util.js';
import { pickTiming, type Slot } from '../timing.js';
import { DUET_DENSITY, duetResult, limitDensity, splitSlots } from '../duet.js';
import { buildOrbitFromSlots, orbitStats, orbitTiming } from './generator.js';
import { ORBIT_DIFFICULTY } from './tuning.js';

const tKey = (t: number) => Math.round(Math.round(t * 1e4) / 10);

export function generateOrbitDuet(a: SongAnalysis, difficulty: Difficulty, seed = 0): DuetMap<OrbitMap> {
  const timing = pickTiming(a, orbitTiming(difficulty, DUET_DENSITY), new Rng(`${seed}:${difficulty}:orbit:duet`));
  const split = splitSlots(timing.chosen);
  limitDensity(split, ORBIT_DIFFICULTY[difficulty].maxLocalNps);
  // Rail-Besitz: Stimme des naechsten Slots zur Startzeit (Unisono-Slot: abwechselnd nach Takt)
  const voiceOf = new Map<Slot, 0 | 1 | 2>();
  for (const v of [0, 1] as const) for (const s of split.parts[v]) voiceOf.set(s, voiceOf.has(s) ? 2 : v);
  const all = [...voiceOf.keys()].sort((x, y) => x.t - y.t);
  const owner = (t0: number): 0 | 1 => {
    let best = all[0];
    for (const s of all) if (Math.abs(s.t - t0) < Math.abs(best.t - t0)) best = s;
    const v = best ? voiceOf.get(best)! : 0;
    return v === 2 ? ((best.bar % 2) as 0 | 1) : v;
  };
  const build = (v: 0 | 1) => buildOrbitFromSlots(a, difficulty, seed, split.parts[v], timing, {
    rngRails: new Rng(`${seed}:${difficulty}:orbit:rails`), rngNotes: new Rng(`${seed}:${difficulty}:orbit:v${v + 1}`),
    railOwner: (t0) => owner(t0) === v,
  });
  let parts: [OrbitMap, OrbitMap] = [build(0), build(1)];
  // Slots, die eine Stimme nicht spielen konnte (Rail, Gold-Luft, Geschwindigkeit), einmal der anderen geben
  const moved = [false, false];
  for (const v of [0, 1] as const) {
    const have = new Set(parts[v].notes.map((n) => tKey(n.t))), other = (1 - v) as 0 | 1;
    const lost = split.parts[v].filter((s) => !s.drop && !have.has(tKey(s.t)));
    if (!lost.length) continue;
    const take = new Set(lost);
    split.parts[v] = split.parts[v].filter((s) => !take.has(s));
    split.parts[other] = [...split.parts[other], ...lost].sort((x, y) => x.b - y.b);
    moved[other] = true;
  }
  if (moved[0] || moved[1]) parts = [moved[0] ? build(0) : parts[0], moved[1] ? build(1) : parts[1]];
  for (const p of parts) p.stats = orbitStats(p, timing.startT, timing.endT);
  return duetResult('orbit', a, difficulty, seed, parts, new Set(split.unison.map((s) => tKey(s.t))));
}
