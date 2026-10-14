// Level-Generator: SongAnalysis + Schwierigkeit + Seed -> Beatmap.
//
// Ablauf
//  1. Rasterpunkte (Slots) auf erlaubten Unterteilungen bilden und bewerten (Salienz):
//     Onset-Staerke je Band (Kick, Snare, Hi-Hat ...) + metrische Position + Melodie.
//  2. Pro Takt ein Budget aus Ziel-Dichte (Schwierigkeit x Abschnitt x Energie) und die besten Slots
//     waehlen (Mindestabstand, wiederkehrende Positionen im Takt bevorzugt -> menschlicher Groove).
//  3. Drops inszenieren: Pause davor, Doppelnote auf dem ersten Downbeat.
//  4. Phrasen (je 2 Takte) bekommen ein Muster (Stream, Treppe, Doppel, Windmuehle, Kreuz, Slider,
//     Burst, Simple). Wiederholte Abschnitte nutzen denselben Zufallsstrom und werden gespiegelt.
//  5. Parity-Engine vergibt Richtungen, Positionen folgen ergonomischen Regeln.
//  6. Waende, Bomben, Lichtshow; danach Validierung (validate.ts).
import { DIFFICULTY, MAPPING, SECTION_DENSITY, SECTION_PATTERNS, type PatternName } from '../tuning.js';
import { MAPPING_VERSION } from '../version.js';
import { BANDS, Cut, type Beatmap, type Bomb, type Difficulty, type Note, type Obstacle, type Section, type SongAnalysis } from '../types.js';
import { Rng, beatToTime, sectionAtBeat, barOfBeat, beatOfBar } from './util.js';
import { cutFor, newHand, nextSwing, type Flavor, type HandState, type Swing } from './parity.js';
import { validate } from './validate.js';
import { lightShow } from './lights.js';

const STEPS = 24;      // Rasteraufloesung der Analyse (pro Beat)

interface Slot {
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

interface Planned extends Slot {
  pattern: PatternName;
  /** 0 = rot, 1 = blau, 2 = beide */
  hand?: 0 | 1 | 2;
  flavor?: Flavor;
  /** Slider-Kette: gehoert zum Schwung der vorigen Note derselben Hand */
  chain?: boolean;
  mirror: boolean;
  phraseIdx: number;
}

export function generate(a: SongAnalysis, difficulty: Difficulty, seed = 0): Beatmap {
  const D = DIFFICULTY[difficulty];
  const beats = a.beats;
  const nBeats = beats.length - 1;
  const rngMain = new Rng(`${seed}:${difficulty}:main`);

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
    pauseBefore.set(db, db - MAPPING.dropPause * (difficulty === 'easy' ? 2 : 1));
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
    let target = D.nps * SECTION_DENSITY[type] * (0.45 + 1.1 * energy);
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

  // ---------- 3. Phrasen und Muster ----------
  const planned: Planned[] = [];
  const PHRASE_BARS = 2;
  let phraseKey = '', phraseIdx = -1, pattern: PatternName = 'simple', mirror = false;
  for (const s of chosen) {
    const sec = s.sec;
    const pIn = sec ? Math.floor((s.bar - sec.startBar) / PHRASE_BARS) : 0;
    const key = `${sec?.startBar}:${pIn}`;
    if (key !== phraseKey) {
      phraseKey = key; phraseIdx++;
      // gleicher Zufallsstrom fuer wiederholte Abschnitte (Gruppe + Phrasenposition) -> gleiche Muster
      const r = new Rng(`${seed}:${difficulty}:g${sec?.group}:p${pIn}`);
      const w: Partial<Record<PatternName, number>> = {};
      const secW = SECTION_PATTERNS[sec?.type ?? 'verse'];
      for (const [k, v] of Object.entries(D.patterns) as [PatternName, number][]) {
        const m = secW[k] ?? 0.3;
        if (v * m > 0) w[k] = v * m;
      }
      pattern = Object.keys(w).length ? r.weighted(w) : 'simple';
      mirror = (sec?.occurrence ?? 0) % 2 === 1;
    }
    planned.push({ ...s, pattern, mirror, phraseIdx });
  }

  // ---------- 4a. Waende (vor den Noten, damit Noten ausweichen) ----------
  const obstacles: Obstacle[] = [];
  if (D.walls) {
    let side = 0;
    for (const sec of a.sections) {
      const len = sec.endBar - sec.startBar;
      const bar0 = beatOfBar(a, sec.startBar);
      const barBeats = a.beatsPerBar;
      if (sec.type === 'breakdown' && len >= 4) {
        // Seitenwaende im Breakdown, abwechselnd links/rechts, je 2 Takte
        for (let k = 0; k + 2 <= Math.min(len, 8); k += 4) {
          const b = bar0 + (k + 1) * barBeats;
          const t = beatToTime(beats, b), te = beatToTime(beats, b + 2 * barBeats);
          if (t < startT || te > endT) continue;
          obstacles.push({ b: round(b), t: round(t), dur: round(te - t), x: side % 2 === 0 ? 0 : 3, w: 1, kind: 'full' });
          side++;
        }
        // Ducken (Expert+), kurz, Mitte des Breakdowns
        if (D.crouchWalls && len >= 6) {
          const b = bar0 + Math.floor(len / 2) * barBeats, t = beatToTime(beats, b);
          obstacles.push({ b: round(b), t: round(t), dur: round(beatToTime(beats, b + 1) - t), x: 0, w: 4, kind: 'crouch' });
        }
      }
      // vor Drops (ab Expert): Ausweich-Wand im letzten Takt des Build-ups
      if (sec.type === 'buildup' && (difficulty === 'expert' || difficulty === 'expertplus') && len >= 2) {
        const b = beatOfBar(a, sec.endBar - 1), t = beatToTime(beats, b), te = beatToTime(beats, b + barBeats - MAPPING.dropPause);
        if (t > startT && te > t + 0.3) obstacles.push({ b: round(b), t: round(t), dur: round(te - t), x: side % 2 === 0 ? 1 : 2, w: 1, kind: 'full' });
        side++;
      }
    }
  }

  // freie Spalte fuer eine Hand zum Zeitpunkt t (Waende beruecksichtigen)
  const freeX = (hand: 0 | 1, x: number, t: number): number => {
    const blocked = (c: number) => obstacles.some((o) => o.kind === 'full' && t >= o.t - 0.2 && t <= o.t + o.dur + 0.1 && c >= o.x && c < o.x + o.w);
    if (!blocked(x)) return x;
    const order = hand === 0 ? [1, 0, 2] : [2, 3, 1];
    return order.find((c) => !blocked(c)) ?? x;
  };
  const crouchAt = (t: number) => obstacles.some((o) => o.kind === 'crouch' && t >= o.t - 0.2 && t <= o.t + o.dur + 0.1);

  // ---------- 4. Haende, Richtungen, Positionen ----------
  const notes: Note[] = [];
  const hands: [HandState, HandState] = [newHand(0), newHand(1)];
  const rng = new Rng(`${seed}:${difficulty}:place`);
  let lastHand: 0 | 1 = 1;
  let stairStep = 0, windStep = 0, lastPhrase = -1;
  const put = (p: Planned, hand: 0 | 1, swing: Swing, flavor: Flavor, x: number, y: number, dot = false) => {
    const h = hands[hand];
    let d = cutFor(hand, swing, flavor);
    if (dot) d = Cut.Any;
    // Spiegeln fuer wiederholte Abschnitte: Haende tauschen ist zu aufwendig – stattdessen Diagonalen spiegeln
    x = freeX(hand, x, p.t);
    if (crouchAt(p.t)) y = 0;
    notes.push({ b: round(p.b), t: round(p.t), x, y, c: hand, d });
    h.last = swing; h.t = p.t; h.x = x; h.y = y; h.d = d;
  };
  const yFor = (swing: Swing, flavor: Flavor, strong: boolean, gap: number): number => {
    // Vorhand (unten) meist untere Reihe, Rueckhand unten/mitte; obere Reihe fuer betonte Schlaege mit Zeit
    if (swing === 'fore') return strong && gap > 0.35 && rng.chance(0.25) ? 2 : 0;
    if (flavor === 'side') return 1;
    return gap > 0.3 && rng.chance(0.35) ? 1 : 0;
  };
  const xFor = (hand: 0 | 1, flavor: Flavor, wide: boolean): number => {
    // rot links (0/1), blau rechts (2/3); 'out' und weite Positionen nach aussen
    const outer = flavor === 'out' || wide;
    return hand === 0 ? (outer ? 0 : 1) : (outer ? 3 : 2);
  };

  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    const prev = planned[i - 1], next = planned[i + 1];
    const gapPrev = prev ? p.t - prev.t : 9;
    const gapNext = next ? next.t - p.t : 9;
    if (p.phraseIdx !== lastPhrase) { stairStep = 0; windStep = 0; lastPhrase = p.phraseIdx; }
    const strong = p.kick > 0.55 || p.inBar === 0;
    // --- Doppelnoten: Drop-Downbeats, starke Kicks in dichten Abschnitten, Muster 'doubles'/'cross'
    const wantDouble = p.drop || ((p.pattern === 'doubles' || p.pattern === 'cross') && strong && gapPrev > D.minHandGap && gapNext > D.minGap * 1.5)
      || (strong && p.kick > 0.7 && p.sec?.type === 'drop' && gapPrev >= D.minHandGap && gapNext >= D.minGap * 1.5 && rng.chance(D.doubles));
    if (wantDouble && difficulty !== 'easy') {
      const s0 = nextSwing(hands[0], p.t, MAPPING.resetTime), s1 = nextSwing(hands[1], p.t, MAPPING.resetTime);
      // beide Haende muessen genug Abstand haben
      if (p.t - hands[0].t >= D.minHandGap && p.t - hands[1].t >= D.minHandGap) {
        const cross = p.pattern === 'cross' && !p.drop;
        const fl0: Flavor = cross ? (rng.chance(0.5) ? 'in' : 'out') : 'straight';
        const fl1: Flavor = fl0;
        const wide = p.drop || fl0 === 'out';
        put(p, 0, s0, fl0, xFor(0, fl0, wide), s0 === 'fore' ? 0 : 0);
        put(p, 1, s1, fl1, xFor(1, fl1, wide), s1 === 'fore' ? 0 : 0);
        lastHand = 1;
        continue;
      }
    }
    // --- Einzelnote: Hand waehlen
    let hand: 0 | 1;
    const other = (h: 0 | 1) => (1 - h) as 0 | 1;
    if (p.pattern === 'slider' && gapPrev < 0.13 && i > 0 && notes.length && p.t - hands[lastHand].t < 0.13) {
      // Slider: gleiche Hand, gleiche Richtung, Position folgt der Bewegung
      hand = lastHand;
      const h = hands[hand];
      const ny = h.d === Cut.Down ? Math.max(0, h.y - 1) : h.d === Cut.Up ? Math.min(2, h.y + 1) : h.y;
      notes.push({ b: round(p.b), t: round(p.t), x: h.x, y: ny, c: hand, d: h.d });
      h.t = p.t; h.y = ny;
      continue;
    }
    if (p.snare > p.kick + 0.15 && gapPrev < 0.6) hand = other(lastHand);         // Snare -> Gegenhand
    else hand = other(lastHand);                                                     // Grundregel: abwechseln
    // Hand braucht genug Abstand – sonst die andere
    if (p.t - hands[hand].t < D.minHandGap && p.t - hands[other(hand)].t >= D.minHandGap) hand = other(hand);
    if (p.t - hands[hand].t < D.minHandGap * 0.75) continue;                         // keine Hand frei: Note weglassen
    // gespiegelte Wiederholung: Handwahl umdrehen (gleicher Rhythmus, andere Seite)
    if (p.mirror && p.pattern !== 'stream' && p.t - hands[other(hand)].t >= D.minHandGap && rng.chance(0.5)) hand = other(hand);
    const swing = nextSwing(hands[hand], p.t, MAPPING.resetTime);
    let flavor: Flavor = 'straight';
    let x = xFor(hand, 'straight', false);
    let y = 0;
    const dot = rng.chance(D.dots);
    switch (p.pattern) {
      case 'stream':
        flavor = rng.chance(0.2) ? 'in' : 'straight';
        x = xFor(hand, flavor, false);
        y = swing === 'back' && gapPrev > 0.25 && rng.chance(0.3) ? 1 : 0;
        break;
      case 'stair': {
        // Treppe: Positionen wandern nach aussen und nach oben, Diagonalen folgen der Bewegung
        const st = stairStep++ % 4;
        flavor = st % 2 === 0 ? 'out' : 'in';
        x = hand === 0 ? (st < 2 ? 1 : 0) : (st < 2 ? 2 : 3);
        y = Math.min(2, [0, 0, 1, 1][st] + (swing === 'back' && gapPrev > 0.4 ? 1 : 0));
        if (swing === 'fore' && y === 2 && gapPrev < 0.4) y = 0;
        break;
      }
      case 'windmill': {
        const seq: Flavor[] = ['straight', 'out', 'side', 'in'];
        flavor = seq[windStep++ % 4];
        if (flavor === 'side' && gapPrev < 0.25) flavor = 'out';
        x = xFor(hand, flavor, flavor === 'side');
        y = flavor === 'side' ? 1 : 0;
        break;
      }
      case 'burst': case 'slider':
        flavor = 'straight'; x = xFor(hand, 'straight', false); y = 0;
        break;
      case 'doubles': case 'cross':
        flavor = rng.chance(0.3) ? 'out' : 'straight';
        x = xFor(hand, flavor, false); y = yFor(swing, flavor, strong, gapPrev);
        break;
      default: {
        // simple: ruhig, gut lesbar; Melodie-Passagen bekommen fliessende Diagonalen
        flavor = p.mel > 0.6 && rng.chance(0.5) ? (rng.chance(0.5) ? 'in' : 'out') : rng.chance(0.15) ? 'out' : 'straight';
        x = xFor(hand, flavor, rng.chance(0.25));
        y = yFor(swing, flavor, strong, gapPrev);
      }
    }
    // Sichtblock vermeiden: Mitte (x 1/2, y 1) nur bei viel Zeit
    if ((x === 1 || x === 2) && y === 1 && Math.min(gapPrev, gapNext) < 0.45) y = 0;
    put(p, hand, swing, flavor, x, y, dot);
    lastHand = hand;
  }

  // ---------- 6. Bomben (ab Hard): sparsam, als Reset-Hilfe in ruhigen Passagen ----------
  const bombs: Bomb[] = [];
  if (D.bombs) {
    const r = new Rng(`${seed}:${difficulty}:bombs`);
    // Bombe auf der Seite der Hand, die gerade Pause hat (aeussere Spalte, mittlere Reihe):
    // sichtbar, aber nicht im Schlagweg der aktiven Hand
    for (let i = 1; i < notes.length; i++) {
      const n = notes[i], p = notes[i - 1];
      const gap = n.t - p.t;
      if (gap < 0.45 || gap > 2.5 || !r.chance(0.22)) continue;
      const bt = p.t + gap / 2, idle = (1 - n.c) as 0 | 1;
      const bx = idle === 0 ? 0 : 3;
      if (notes.some((q) => q.c === idle && Math.abs(q.t - bt) < 0.6)) continue;
      if (notes.some((q) => Math.abs(q.t - bt) < 0.35 && Math.abs(q.x - bx) <= 1)) continue;
      if (obstacles.some((o) => bt >= o.t - 0.3 && bt <= o.t + o.dur + 0.3)) continue;
      bombs.push({ b: round(p.b + (n.b - p.b) / 2), t: round(bt), x: bx, y: 1 });
    }
  }

  const lights = lightShow(a, notes);
  const bm: Beatmap = {
    version: MAPPING_VERSION, analysisVersion: a.version, difficulty, seed, bpm: a.bpm, njs: D.njs, offset: D.offset,
    beats: a.beats, notes, bombs, obstacles, lights,
    stats: { notes: 0, nps: 0, peakNps: 0, dropNps: 0, verseNps: 0, bombs: 0, obstacles: 0, playability: 100, issues: {} },
  };
  validate(bm, a);
  return bm;
}

const round = (v: number) => Math.round(v * 10000) / 10000;

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
