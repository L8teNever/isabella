// Orbit-Generator: Kugel-Noten auf einer freien 2D-Flaeche, Rails auf gehaltenen Klaengen,
// Gold (beide Haende) auf Drops/Akzenten, Gruen (eine Hand nach Wahl) in ruhigen Melodie-Passagen.
// Die Zeit-Auswahl ist dieselbe wie bei Schnitt (mapping/timing.ts). Gleiche Analyse + Seed = gleiches Level.
import { BANDS, type Difficulty, type LightEvent, type Obstacle, type OrbitMap, type OrbitNote, type OrbitRail, type Section, type SongAnalysis } from '../../types.js';
import { ANALYSIS_VERSION, ORBIT_MAPPING_VERSION } from '../../version.js';
import { MAPPING } from '../../tuning.js';
import { lightShow } from '../lights.js';
import { fitsDensity, pickTiming, STEPS, type Slot, type Timing, type TimingParams } from '../timing.js';
import { Rng, beatToTime, beatOfBar, barOfBeat, sectionAtBeat } from '../util.js';
import { ORBIT, ORBIT_DIFFICULTY, ORBIT_MOTIONS, ORBIT_SECTION_DENSITY, type OrbitMotion } from './tuning.js';
import { checkOrbit, orbitPlayability, railAt, speedViolations, wallActive, wallSpan } from './validate.js';
import { goldToReach, toReach } from './reach.js';

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const side = (hand: 0 | 1) => (hand === 0 ? -1 : 1);

/** Bewegungsmuster: Phase u (0..1 ueber 2 Takte) -> X (aussen +), Y (oben +), beide -1..1 */
function motion(m: OrbitMotion, u: number): [number, number] {
  const P = Math.PI;
  switch (m) {
    case 'arc': return [Math.cos(P * u), Math.sin(P * u) * 0.9 - 0.2];
    case 'wave': return [2 * u - 1, Math.sin(4 * P * u) * 0.7];
    case 'circle': return [Math.cos(2 * P * u), Math.sin(2 * P * u)];
    case 'mirror': { const tri = 1 - Math.abs(2 * ((2 * u) % 1) - 1); return [0.3 * Math.sin(2 * P * u), 2 * tri - 1]; }
    case 'pendulum': return [Math.sin(4 * P * u), -0.6 * Math.abs(Math.cos(4 * P * u)) + 0.1];
    case 'steps': { const i = Math.floor(u * 4) % 4; return [[-0.8, 0.2, 0.9, 0.2][i], [0.6, -0.6, 0.6, -0.6][i]]; }
  }
}

/** Parameter der Zeitauswahl fuer Orbit; density > 1 = mehr Noten (Duett: beide Stimmen zusammen) */
export function orbitTiming(difficulty: Difficulty, density = 1): TimingParams {
  const D = ORBIT_DIFFICULTY[difficulty];
  return {
    subdivisions: D.subdivisions, nps: D.nps * density, minGap: D.minGap, maxLocalNps: D.maxLocalNps * density,
    longDropPause: difficulty === 'easy', bursts: difficulty === 'expertplus', sectionDensity: ORBIT_SECTION_DENSITY,
  };
}

export function generateOrbit(a: SongAnalysis, difficulty: Difficulty, seed: number): OrbitMap {
  const rng = new Rng(`${seed}:${difficulty}:orbit`);
  const timing = pickTiming(a, orbitTiming(difficulty), rng);
  return buildOrbitFromSlots(a, difficulty, seed, timing.chosen, timing, { rngRails: rng, rngNotes: rng });
}

export interface OrbitBuildOptions {
  /** Zufall fuer Rails und fuer Noten/Gold (Solo: derselbe Strom wie die Zeitauswahl, bitgenau wie vorher) */
  rngRails: Rng;
  rngNotes: Rng;
  /** Duett: gehoert eine Rail (Startzeit) zu dieser Stimme? */
  railOwner?: (t0: number) => boolean;
}

/** Rails, Haende, Gold, Positionen, Gruen, Geschwindigkeit auf einer fertigen Slot-Liste */
export function buildOrbitFromSlots(a: SongAnalysis, difficulty: Difficulty, seed: number, chosen: Slot[],
  timing: Pick<Timing, 'startT' | 'endT' | 'pauseBefore'>, opts: OrbitBuildOptions): OrbitMap {
  const D = ORBIT_DIFFICULTY[difficulty];
  const beats = a.beats;
  const nBeats = beats.length - 1;
  const { startT, endT, pauseBefore } = timing;
  let rng = opts.rngRails;
  const sortedE = [...a.barEnergy].sort((x, y) => x - y);
  const quant = (q: number) => sortedE.length ? sortedE[Math.min(sortedE.length - 1, Math.floor(q * sortedE.length))] : 0.5;
  const goldE = quant(ORBIT.goldEnergy), greenE = quant(ORBIT.greenEnergy);
  const inPause = (b: number) => [...pauseBefore.entries()].some(([db, pb]) => b >= pb - 0.5 && b < db);

  // ---------- 1. Hindernisse (gleiches Schema wie Schnitt, gleiche Wand-Skins) ----------
  const obstacles: Obstacle[] = [];
  if (D.walls) {
    let s = 0;
    for (const sec of a.sections) {
      const len = sec.endBar - sec.startBar, bar0 = beatOfBar(a, sec.startBar), bb = a.beatsPerBar;
      if (sec.type === 'breakdown' && len >= 4) {
        for (let k = 0; k + 2 <= Math.min(len, 8); k += 4) {
          const b = bar0 + (k + 1) * bb, t = beatToTime(beats, b), te = beatToTime(beats, b + 2 * bb);
          if (t < startT || te > endT) continue;
          obstacles.push({ b: r3(b), t: r3(t), dur: r3(te - t), x: s % 2 === 0 ? 0 : 3, w: 1, kind: 'full' });
          s++;
        }
        if (D.crouchWalls && len >= 6) {
          const b = bar0 + Math.floor(len / 2) * bb, t = beatToTime(beats, b);
          obstacles.push({ b: r3(b), t: r3(t), dur: r3(beatToTime(beats, b + 1) - t), x: 0, w: 4, kind: 'crouch' });
        }
      }
      if (sec.type === 'buildup' && D.crouchWalls && len >= 2) {
        const b = beatOfBar(a, sec.endBar - 1), t = beatToTime(beats, b), te = beatToTime(beats, b + bb - MAPPING.dropPause);
        if (t > startT && te > t + 0.3) obstacles.push({ b: r3(b), t: r3(t), dur: r3(te - t), x: s % 2 === 0 ? 0 : 2, w: 2, kind: 'full' });
        s++;
      }
    }
    obstacles.sort((x, y) => x.t - y.t);
  }
  const walls = (t: number) => obstacles.filter((o) => wallActive(o, t));
  /** ist eine Haelfte zu? dann spielt nur die Hand der freien Seite */
  const freeHand = (t: number): 0 | 1 | undefined => {
    for (const o of walls(t)) if (o.kind === 'full' && o.w >= 2) return o.x === 0 ? 1 : 0;
    return undefined;
  };
  /** Punkt aus Waenden und in die Flaeche schieben */
  /** liegt der Punkt (bzw. die Gold-Kugel mit Radius r) in einer Wand? */
  const inWall = (x: number, y: number, t: number, r = 0) => walls(t).some((o) => {
    if (o.kind === 'crouch') return y > ORBIT.crouchMaxY + 1e-6;
    const [x0, x1] = wallSpan(o);
    return x + r > x0 - ORBIT.wallMargin + 1e-6 && x - r < x1 + ORBIT.wallMargin - 1e-6;
  });
  /** Punkt aus Waenden, in die Flaeche und in Armreichweite schieben; ok = false, wenn beides nicht zugleich geht (Note weglassen) */
  const fit = (x: number, y: number, t: number, hand: 0 | 1 | -1, r = 0): [number, number, boolean] => {
    for (const o of walls(t)) {
      if (o.kind === 'crouch') { y = Math.min(y, ORBIT.crouchMaxY); continue; }
      const [x0, x1] = wallSpan(o), m = ORBIT.wallMargin + r;
      if (x + r > x0 - ORBIT.wallMargin && x - r < x1 + ORBIT.wallMargin) x = (x0 <= ORBIT.wallX0 + 1e-6) ? x1 + m : x0 - m;
    }
    x = clamp(x, ORBIT.minX + r, ORBIT.maxX - r);
    if (hand === 0 && freeHand(t) === undefined) x = Math.min(x, ORBIT.crossX);
    if (hand === 1 && freeHand(t) === undefined) x = Math.max(x, -ORBIT.crossX);
    y = clamp(y, ORBIT.minY, ORBIT.maxY);
    // Armreichweite: radial an den Rand der Reichweite um die Schulter ziehen (Gold: beide Beruehrpunkte);
    // unter einer Ducken-Wand stehen die Schultern tiefer
    const duck = walls(t).some((o) => o.kind === 'crouch') ? ORBIT.crouchDuck : 0;
    [x, y] = hand === -1 ? goldToReach(x, y, 1, duck) : toReach(x, y, hand, 1, duck);
    return [x, y, !inWall(x, y, t, r)];
  };

  // ---------- 2. Rails auf gehaltenen Klaengen ----------
  const rails: OrbitRail[] = [];
  const railNotes: OrbitNote[] = [];
  const sus = a.sustain ?? [];
  const pitch = (b: number) => {
    const p = a.pitch; if (!p || !p.length) return 0.5;
    const k = Math.floor(b), u = b - k;
    return (p[Math.min(k, p.length - 1)] ?? 0.5) * (1 - u) + (p[Math.min(k + 1, p.length - 1)] ?? 0.5) * u;
  };
  const onsetAt = (k: number) => Math.max(...BANDS.map((band) => a.grid.bands[band][k * STEPS] ?? 0));
  const railLimit = D.railShare * Math.max(1, endT - startT);
  let railUsed = 0;
  const railFree = [-Infinity, -Infinity];   // Beat, ab dem die Hand wieder eine Rail bekommt
  let nextHand: 0 | 1 = rng.chance(0.5) ? 0 : 1;
  let lastGoldRailBar = -Infinity;
  for (let k = 0; k < nBeats; k++) {
    if ((sus[k] ?? 0) < ORBIT.sustainMin) continue;
    const sec = sectionAtBeat(a, k);
    // einzelne schwache Beats mitten im gehaltenen Klang (schnelle Songs) unterbrechen die Rail nicht
    const held = (j: number) => (sus[j] ?? 0) >= ORBIT.sustainMin || ((sus[j - 1] ?? 0) >= ORBIT.sustainMin && (sus[j + 1] ?? 0) >= ORBIT.sustainMin);
    let L = 0;
    while (k + L < nBeats && L < D.railMaxBeats && held(k + L) && sectionAtBeat(a, k + L) === sec) L++;
    while (L > 0 && (sus[k + L - 1] ?? 0) < ORBIT.sustainMin) L--;     // nie auf einem schwachen Beat enden
    let mean = 0; for (let j = 0; j < L; j++) mean += (sus[k + j] ?? 0) / Math.max(1, L);
    if (L < D.railMinBeats || mean < ORBIT.railMeanSustain) { k += Math.max(0, L - 1); continue; }
    const t0 = beatToTime(beats, k), t1 = beatToTime(beats, k + L);
    let ok = t0 >= startT + 1 && t1 <= endT;
    for (let b = k; ok && b <= k + L; b += 0.5) if (inPause(b) || walls(beatToTime(beats, b)).some((o) => o.kind === 'full' && o.w >= 2)) ok = false;
    const prevRail = rails[rails.length - 1];
    if (prevRail && t0 < prevRail.t1 + 0.4) ok = false;
    let hand: 0 | 1 | undefined;
    for (const h of [nextHand, (1 - nextHand) as 0 | 1]) if (hand === undefined && k >= railFree[h] && railUsed + (t1 - t0) <= railLimit) hand = h;
    if (!ok || hand === undefined) { k += L - 1; continue; }
    // Gold-Rail: beide Haende folgen nebeneinander in der Mitte (energiereiche Stellen, selten)
    const bar = barOfBeat(a, k);
    const gold = D.goldAccent > 0 && L >= ORBIT.goldRailMinBeats && (a.barEnergy[bar] ?? 0) >= goldE &&
      bar - lastGoldRailBar >= ORBIT.goldRailGapBars && rng.chance(ORBIT.goldRailChance);
    if (gold) { hand = 0; lastGoldRailBar = bar; }
    // Verlauf: sanfter Bogen um die Ruheposition, Hoehe folgt der Tonhoehe
    const s = side(hand), dir = rng.chance(0.5) ? 1 : -1, waves = L >= 6 ? 2 : 1;
    const points: { t: number; x: number; y: number }[] = [];
    const n = L * ORBIT.railPointsPerBeat;
    for (let i = 0; i <= n; i++) {
      const b = k + i / ORBIT.railPointsPerBeat, t = beatToTime(beats, b);
      const wave = dir * Math.sin((Math.PI * waves * i) / n);
      let x = gold ? D.reachX * 0.45 * wave : s * (ORBIT.homeX + D.reachX * 0.55 * wave);
      let y = ORBIT.centerY + (pitch(b) - 0.5) * 2 * D.reachY * ORBIT.railPitchY;
      [x, y] = gold ? fit(x, y, t, -1, ORBIT.goldHandOffset) : fit(x, y, t, hand);
      const prev = points[points.length - 1];
      if (prev) {   // Rail nie schneller als die Hand darf
        const d = Math.hypot(x - prev.x, y - prev.y), lim = D.maxHandSpeed * 0.8 * (t - prev.t);
        if (d > lim) { x = prev.x + ((x - prev.x) * lim) / d; y = prev.y + ((y - prev.y) * lim) / d; }
      }
      points.push({ t: r3(t), x: r3(x), y: r3(y) });
    }
    // Duett: Rail gehoert einer Stimme – die andere laesst sie aus (Zufall/Zustand laufen gleich weiter)
    if (opts.railOwner && !opts.railOwner(points[0].t)) {
      railUsed += t1 - t0; railFree[hand] = k + L + ORBIT.railRestBeats;
      if (gold) railFree[1 - hand] = railFree[hand];
      nextHand = (1 - hand) as 0 | 1; k += L;
      continue;
    }
    const ri = rails.length;
    const kind = gold ? 'gold' : 'normal';
    rails.push({ hand, kind, points, t0: points[0].t, t1: points[points.length - 1].t });
    railNotes.push({ b: r3(k), t: points[0].t, x: points[0].x, y: points[0].y, hand, kind, rail: ri });
    let lastJ = 0;
    const gapBeats = Math.max(ORBIT.railNoteGapBeats, Math.ceil((2 * D.minGap) / Math.max(0.2, (t1 - t0) / L)));
    for (let j = 1; j < L; j++) {
      if (j - lastJ < gapBeats || onsetAt(k + j) < ORBIT.railNoteOnset) continue;
      const t = beatToTime(beats, k + j), p = railAt(rails[ri], t);
      railNotes.push({ b: k + j, t: r3(t), x: r3(p.x), y: r3(p.y), hand, kind, rail: ri });
      lastJ = j;
    }
    railUsed += t1 - t0;
    railFree[hand] = k + L + ORBIT.railRestBeats;
    if (gold) railFree[1 - hand] = railFree[hand];
    nextHand = (1 - hand) as 0 | 1;
    k += L;
  }
  const railOf = (t: number) => rails.find((r) => t >= r.t0 - D.minGap && t <= r.t1 + D.minGap);

  // ---------- 3. Haende, Gold, Positionen ----------
  rng = opts.rngNotes;
  const notes: OrbitNote[] = [];
  const motionOf = new Map<string, OrbitMotion>();
  const phraseMotion = (sec: Section | undefined, phrase: number): OrbitMotion => {
    const key = `${sec?.type ?? 'verse'}:${phrase % 4}`;
    let m = motionOf.get(key);
    if (!m) { m = new Rng(`${seed}:${difficulty}:orbit:${key}`).weighted(ORBIT_MOTIONS); motionOf.set(key, m); }
    return m;
  };
  let prev: { t: number; hand: 0 | 1 } | undefined;
  let lastGold = -Infinity, lastSolo = -Infinity;
  for (let i = 0; i < chosen.length; i++) {
    const s: Slot = chosen[i];
    const rail = railOf(s.t);
    let hand: 0 | 1;
    if (rail) {
      if (rail.kind === 'gold') continue;                  // beide Haende auf der Gold-Rail
      if (s.t - lastSolo < ORBIT.soloGap) continue;
      hand = (1 - rail.hand) as 0 | 1;
      lastSolo = s.t;
    } else {
      const fh = freeHand(s.t);
      if (fh !== undefined) hand = fh;
      else if (prev && s.t - prev.t < ORBIT.alternateGap) hand = (1 - prev.hand) as 0 | 1;
      else if (s.kick >= Math.max(s.snare, s.hat)) hand = 0;
      else hand = 1;
    }
    if (fhSameHandTooFast(prev, s.t, hand, freeHand(s.t))) continue;
    // Gold: Drop-Start immer, sonst starke Akzente mit Luft davor und danach
    const gapPrev = prev ? s.t - prev.t : Infinity, gapNext = i + 1 < chosen.length ? chosen[i + 1].t - s.t : Infinity;
    const energy = a.barEnergy[s.bar] ?? 0;
    const gold = !rail && freeHand(s.t) === undefined && s.t - lastGold > 2 &&
      (s.drop || (gapPrev >= 0.3 && gapNext >= 0.3 && s.kick >= ORBIT.goldKick && energy >= goldE && rng.chance(D.goldAccent)));
    // nach Gold brauchen beide Haende kurz Luft
    if (gold) while (i + 1 < chosen.length && chosen[i + 1].t - s.t < 0.35) i++;
    // Position aus dem Bewegungsmuster der Phrase
    const sec = s.sec;
    const secStartBar = sec?.startBar ?? 0;
    const phrase = Math.floor((s.bar - secStartBar) / 2);
    const phraseStart = beatOfBar(a, secStartBar + phrase * 2);
    const u = clamp((s.b - phraseStart) / (2 * a.beatsPerBar), 0, 0.999);
    let [X, Y] = motion(phraseMotion(sec, phrase), u);
    if ((sec?.occurrence ?? 0) % 2 === 1) Y = -Y;
    X += (rng.next() - 0.5) * 0.08; Y += (rng.next() - 0.5) * 0.08;
    let x: number, y: number, ok: boolean;
    if (gold) {
      [x, y, ok] = fit(0, ORBIT.centerY + Y * D.reachY * 0.4, s.t, -1, ORBIT.goldHandOffset);
      if (ok) lastGold = s.t;
    } else {
      [x, y, ok] = fit(side(hand) * (ORBIT.homeX + D.reachX * X), ORBIT.centerY + D.reachY * Y, s.t, hand);
    }
    if (!ok) continue;                                     // weder in Reichweite noch neben der Wand: Note weglassen
    notes.push({ b: r3(s.b), t: r3(s.t), x: r3(x), y: r3(y), hand: gold ? 0 : hand, kind: gold ? 'gold' : 'normal' });
    prev = { t: s.t, hand };
  }
  /** eine Hand allein bei zu kurzem Abstand (Wand-Haelfte zu) – Note auslassen */
  function fhSameHandTooFast(p: { t: number; hand: 0 | 1 } | undefined, t: number, hand: 0 | 1, fh: 0 | 1 | undefined) {
    return fh !== undefined && p !== undefined && p.hand === hand && t - p.t < ORBIT.soloGap;
  }
  notes.push(...railNotes);
  notes.sort((x, y) => x.t - y.t || x.hand - y.hand);
  // lokale Dichte: Rail-Noten bleiben, sonst die spaetere Note streichen
  {
    const kept: OrbitNote[] = [];
    for (const n of notes) {
      if (n.rail !== undefined || fitsDensity(kept.slice(-24).map((k) => k.t), n.t, D.maxLocalNps)) kept.push(n);
    }
    notes.length = 0; notes.push(...kept);
  }

  // gleichzeitige Kugeln: dieselbe Hand nie doppelt, verschiedene Haende auseinander
  for (let i = notes.length - 1; i > 0; i--) {
    const n = notes[i], o = notes[i - 1];
    if (n.t - o.t >= 0.06) continue;
    if (n.kind === 'gold' || o.kind === 'gold' || n.hand === o.hand) {
      const drop = n.rail !== undefined ? i - 1 : i;      // Rail-Noten bleiben
      notes.splice(drop, 1);
      continue;
    }
    const d = Math.hypot(n.x - o.x, n.y - o.y);
    if (d < ORBIT.minSpread) {
      const free = n.rail === undefined ? n : o, fixed = free === n ? o : n;
      const s = side(free.hand);
      const duck = walls(free.t).some((o) => o.kind === 'crouch') ? ORBIT.crouchDuck : 0;
      const [x, y] = toReach(clamp(fixed.x + s * ORBIT.minSpread, ORBIT.minX, ORBIT.maxX), free.y, free.hand, 1, duck);
      // geht der Abstand in Reichweite nicht: die freie Kugel weglassen
      if (Math.hypot(x - fixed.x, y - fixed.y) < ORBIT.minSpread - 1e-3 || inWall(x, y, free.t)) { notes.splice(notes.indexOf(free), 1); continue; }
      free.x = r3(x); free.y = r3(y);
    }
  }

  // ---------- 4. Gruen: Laeufe in ruhigen Melodie-Passagen ----------
  if (D.greenRuns) {
    let run: OrbitNote[] = [];
    let lastRunBar = -Infinity;
    const barMelody = (bar: number) => {
      const k0 = beatOfBar(a, bar); let sum = 0;
      for (let j = 0; j < a.beatsPerBar; j++) sum += a.melody[k0 + j] ?? 0;
      return sum / a.beatsPerBar;
    };
    const flush = () => {
      if (run.length >= ORBIT.greenMin) {
        const bar = barOfBeat(a, Math.floor(run[0].b));
        if (bar - lastRunBar >= 8) {
          for (const n of run.slice(0, ORBIT.greenMax)) n.kind = 'green';
          lastRunBar = bar;
        }
      }
      run = [];
    };
    for (const n of notes) {
      const k = Math.floor(n.b), bar = barOfBeat(a, k);
      const calm = n.kind === 'normal' && n.rail === undefined && !railOf(n.t) &&
        barMelody(bar) >= ORBIT.greenMelody && (a.barEnergy[bar] ?? 1) <= greenE && !walls(n.t).length;
      if (calm && (!run.length || n.t - run[run.length - 1].t < 1.6)) run.push(n);
      else { flush(); if (calm) run.push(n); }
    }
    flush();
  }

  // ---------- 5. Handgeschwindigkeit: annaehern, sonst Note streichen ----------
  for (const hand of [0, 1] as const) {
    let last: { t: number; x: number; y: number } | undefined;
    for (const n of notes) {
      const mine = n.kind === 'gold' || n.hand === hand;
      if (!mine) continue;
      const hx = n.kind === 'gold' ? n.x + side(hand) * ORBIT.goldHandOffset : n.x;
      const rail = n.rail !== undefined ? rails[n.rail] : undefined;
      if (last && n.kind !== 'gold' && !rail) {
        const dt = n.t - last.t, d = Math.hypot(hx - last.x, n.y - last.y), lim = D.maxHandSpeed * 0.95 * dt;
        if (d > lim && d > 0) {
          const [x, y, ok] = fit(last.x + ((hx - last.x) * lim) / d, last.y + ((n.y - last.y) * lim) / d, n.t, hand);
          if (ok) { n.x = r3(x); n.y = r3(y); }
        }
      }
      if (rail) { const e = railAt(rail, rail.t1); last = { t: rail.t1, x: e.x + (rail.kind === 'gold' ? side(hand) * ORBIT.goldHandOffset : 0), y: e.y }; }
      else last = { t: n.t, x: n.kind === 'gold' ? hx : n.x, y: n.y };
    }
  }
  for (let guard = 0; guard < 400; guard++) {
    const bad = speedViolations({ notes, rails }, D.maxHandSpeed).filter((n) => n.rail === undefined);
    if (!bad.length) break;
    const idx = notes.indexOf(bad[0]);
    notes.splice(idx, 1);
  }

  // ---------- 6. Licht, Werte ----------
  const lights: LightEvent[] = lightShow(a, []);
  const map: OrbitMap = {
    mode: 'orbit', version: ORBIT_MAPPING_VERSION, analysisVersion: ANALYSIS_VERSION, difficulty, seed, bpm: a.bpm, speed: D.speed,
    beats: a.beats, notes, rails, obstacles, lights,
    stats: { notes: 0, rails: 0, railSeconds: 0, nps: 0, peakNps: 0, gold: 0, green: 0, obstacles: 0, maxHandSpeed: 0, playability: 100, issues: {} },
  };
  map.stats = orbitStats(map, startT, endT);
  return map;
}

export function orbitStats(m: OrbitMap, startT?: number, endT?: number): OrbitMap['stats'] {
  const n = m.notes;
  const t0 = startT ?? (n[0]?.t ?? 0), t1 = endT ?? (n[n.length - 1]?.t ?? 1);
  let peak = 0, j = 0;
  for (let i = 0; i < n.length; i++) { while (n[i].t - n[j].t >= 1) j++; peak = Math.max(peak, i - j + 1); }
  let maxV = 0;
  for (const hand of [0, 1] as const) {
    let last: OrbitNote | undefined;
    for (const x of n) {
      if (x.kind !== 'gold' && x.hand !== hand) continue;
      if (last && x.t > last.t && x.rail === undefined) maxV = Math.max(maxV, Math.hypot(x.x - last.x, x.y - last.y) / (x.t - last.t));
      last = x;
    }
  }
  const issues = checkOrbit(m);
  return {
    notes: n.length,
    rails: m.rails.length,
    railSeconds: r3(m.rails.reduce((s, r) => s + r.t1 - r.t0, 0)),
    nps: r3(n.length / Math.max(1, t1 - t0)),
    peakNps: peak,
    gold: n.filter((x) => x.kind === 'gold').length,
    green: n.filter((x) => x.kind === 'green').length,
    obstacles: m.obstacles.length,
    maxHandSpeed: r3(maxV),
    playability: orbitPlayability(issues),
    issues,
  };
}
