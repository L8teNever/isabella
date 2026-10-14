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
import { DIFFICULTY, MAPPING, ROWS as ROWS_BASE, ROWS_BY_DIFFICULTY, SECTION_DENSITY, SECTION_PATTERNS, type PatternName } from '../tuning.js';
import { MAPPING_VERSION } from '../version.js';
import { BANDS, Cut, type Beatmap, type Bomb, type Difficulty, type Note, type Obstacle, type Section, type SongAnalysis } from '../types.js';
import { Rng, beatToTime, sectionAtBeat, barOfBeat, beatOfBar } from './util.js';
import { cutFor, newHand, nextSwing, type Flavor, type HandState, type Swing } from './parity.js';
import { validate } from './validate.js';
import { lightShow } from './lights.js';

import { pickTiming, type Slot } from './timing.js';
export { fitsDensity } from './timing.js';

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
  const ROWS = { ...ROWS_BASE, ...ROWS_BY_DIFFICULTY[difficulty] };
  const beats = a.beats;
  const nBeats = beats.length - 1;
  const rngMain = new Rng(`${seed}:${difficulty}:main`);

  // ---------- 1.+2. Zeitpunkte (gemeinsam mit Orbit) ----------
  const { chosen, startT, endT, pauseBefore } = pickTiming(a, {
    subdivisions: D.subdivisions, nps: D.nps, minGap: D.minGap, maxLocalNps: D.maxLocalNps,
    longDropPause: difficulty === 'easy', bursts: !!D.patterns.burst,
  }, rngMain);

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
        // ganze Haelfte (2 Spalten) zu – nie eine einzelne Wand in der Mitte; Bloecke kommen dann alle auf der freien Seite
        if (t > startT && te > t + 0.3) obstacles.push({ b: round(b), t: round(t), dur: round(te - t), x: side % 2 === 0 ? 0 : 2, w: 2, kind: 'full' });
        side++;
      }
    }
  }

  // freie Spalte fuer eine Hand zum Zeitpunkt t (Waende beruecksichtigen)
  const freeX = (hand: 0 | 1, x: number, t: number): number => {
    const blocked = (c: number) => obstacles.some((o) => o.kind === 'full' && t >= o.t - 0.2 && t <= o.t + o.dur + 0.1 && c >= o.x && c < o.x + o.w);
    if (!blocked(x)) return x;
    // freie Spalten: rot nimmt die linkeste, blau die rechteste – so bleiben beide Farben auf derselben (freien) Seite ohne Kreuzen
    const free = [0, 1, 2, 3].filter((c) => !blocked(c));
    if (!free.length) return x;
    return hand === 0 ? free[0] : free[free.length - 1];
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
    // alle drei Reihen nutzen (Werte in ROWS); oben nur mit genug Zeit, betonte Schlaege eher oben
    if (flavor === 'side') return 1;
    const r = rng.next();
    if (swing === 'fore') {
      const top = ROWS.foreTop * (strong ? 1.3 : 1);
      if (gap >= ROWS.minGapTop && r < top) return 2;
      if (gap >= ROWS.minGapMid && r < top + ROWS.foreMid) return 1;
      return 0;
    }
    if (gap >= ROWS.minGapTop && r < ROWS.backTop) return 2;
    if (gap >= ROWS.minGapMid && r < ROWS.backTop + ROWS.backMid) return 1;
    return 0;
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
        { const g = p.t - hands[hand].t, r = rng.next();
          y = g >= ROWS.minGapTop && r < ROWS.streamTop ? 2 : g >= ROWS.minGapMid && r < ROWS.streamTop + ROWS.streamMid ? 1 : 0; }
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
        x = xFor(hand, flavor, false); y = yFor(swing, flavor, strong, p.t - hands[hand].t);
        break;
      default: {
        // simple: ruhig, gut lesbar; Melodie-Passagen bekommen fliessende Diagonalen
        flavor = p.mel > 0.6 && rng.chance(0.5) ? (rng.chance(0.5) ? 'in' : 'out') : rng.chance(0.15) ? 'out' : 'straight';
        x = xFor(hand, flavor, rng.chance(0.25));
        y = yFor(swing, flavor, strong, p.t - hands[hand].t);
      }
    }
    // gleiche Hand bei schneller Folge: keine grossen Reihen-Spruenge
    if (p.t - hands[hand].t < ROWS.fastGap && Math.abs(y - hands[hand].y) > ROWS.maxJumpFast) y = hands[hand].y + Math.sign(y - hands[hand].y) * ROWS.maxJumpFast;
    // Sichtblock vermeiden: Mitte (x 1/2, y 1) bei schneller Folge -> nach aussen statt nach unten
    if ((x === 1 || x === 2) && y === 1 && Math.min(gapPrev, gapNext) < 0.45) x = hand === 0 ? 0 : 3;
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

