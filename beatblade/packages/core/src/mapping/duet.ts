// Duett-Generator (Schnitt): dasselbe Lied in zwei Stimmen fuer zwei Spieler.
//  Stimme 1 = Rhythmus (Kick, Snare, Bass), Stimme 2 = Melodie und Glanz (Hi-Hat, Melodie, Gesang).
//  1. Zeitauswahl wie Solo, aber dichter (DUET_DENSITY) – jede Stimme hat dann etwa die normale Dichte.
//  2. Jeder Slot gehoert genau einer Stimme; knappe Faelle entscheidet die 2-Takt-Phrase.
//     Fast nur eine Klangart im Abschnitt -> Frage-Antwort (Phrasen wechseln ab).
//  3. Ausgleich je Abschnitt (DUET_MIN_SHARE..DUET_MAX_SHARE), schwaechste Slots wandern zur anderen Stimme.
//  4. Drop-Einsaetze spielen beide (Unisono).
//  5. Jede Stimme wird fuer sich zur vollstaendigen Zwei-Hand-Map (eigene Parity, Bomben in eigenen Luecken);
//     Waende und Lichtshow kommen aus dem ganzen Lied und sind fuer beide gleich.
import { DUET_MAPPING_VERSION } from '../version.js';
import type { Beatmap, Difficulty, DuetMap, Note, SongAnalysis } from '../types.js';
import { Rng } from './util.js';
import { fitsDensity, pickTiming, type Slot } from './timing.js';
import { DIFFICULTY } from '../tuning.js';
import { buildFromSlots, schnittTiming } from './generator.js';
import { lightShow } from './lights.js';

/** Gesamtdichte beider Stimmen relativ zu Solo */
export const DUET_DENSITY = 1.7;
/** |Rhythmus − Melodie| darunter: die Phrase entscheidet */
export const DUET_TIE = 0.15;
/** Anteil einer Stimme je Abschnitt */
export const DUET_MIN_SHARE = 0.35;
export const DUET_MAX_SHARE = 0.65;
/** ab diesem Anteil einer Klangart im Abschnitt: Frage-Antwort statt Klang-Aufteilung */
export const DUET_MONO = 0.85;
const PHRASE_BARS = 2;

export interface DuetSplit { parts: [Slot[], Slot[]]; unison: Slot[] }

const rhythmOf = (s: Slot) => s.kick + s.snare;
const melodyOf = (s: Slot) => s.hat + s.mel + (s.voc ? 1 : 0);
const phraseOf = (s: Slot) => `${s.sec?.startBar ?? -1}:${s.sec ? Math.floor((s.bar - s.sec.startBar) / PHRASE_BARS) : s.bar}`;

/** Slots auf die Stimmen verteilen (fuer Schnitt und Orbit gleich) */
export function splitSlots(chosen: Slot[]): DuetSplit {
  const voice = new Map<Slot, 0 | 1 | 2>();   // 0 = Stimme 1, 1 = Stimme 2, 2 = beide
  // Phrasen-Neigung: Summe (Rhythmus − Melodie)
  const lean = new Map<string, number>();
  for (const s of chosen) lean.set(phraseOf(s), (lean.get(phraseOf(s)) ?? 0) + rhythmOf(s) - melodyOf(s));
  for (const s of chosen) {
    if (s.drop) { voice.set(s, 2); continue; }
    const d = rhythmOf(s) - melodyOf(s);
    voice.set(s, Math.abs(d) > DUET_TIE ? (d > 0 ? 0 : 1) : (lean.get(phraseOf(s))! >= 0 ? 0 : 1));
  }
  // je Abschnitt: Frage-Antwort bei einseitiger Musik, danach ausgleichen
  const bySec = new Map<string, Slot[]>();
  for (const s of chosen) { const k = `${s.sec?.startBar ?? -1}`; (bySec.get(k) ?? bySec.set(k, []).get(k)!).push(s); }
  for (const list of bySec.values()) {
    const own = list.filter((s) => voice.get(s) !== 2);
    if (own.length < 2) continue;
    const n0 = own.filter((s) => voice.get(s) === 0).length;
    if (Math.max(n0, own.length - n0) / own.length >= DUET_MONO) {
      const phrases = [...new Set(own.map(phraseOf))];
      if (phrases.length >= 2) for (const s of own) voice.set(s, (phrases.indexOf(phraseOf(s)) % 2) as 0 | 1);
    }
    balance(own, voice);
  }
  const parts: [Slot[], Slot[]] = [[], []], unison: Slot[] = [];
  for (const s of chosen) {
    const v = voice.get(s)!;
    if (v === 2) { parts[0].push(s); parts[1].push(s); unison.push(s); } else parts[v].push(s);
  }
  return { parts, unison };
}

// schwaechste Slots der vollen Stimme wandern zur anderen, bis beide im Rahmen sind
function balance(own: Slot[], voice: Map<Slot, 0 | 1 | 2>) {
  const n = own.length;
  for (let guard = 0; guard < n; guard++) {
    const n0 = own.filter((s) => voice.get(s) === 0).length;
    const full: 0 | 1 | null = n0 > n * DUET_MAX_SHARE ? 0 : n - n0 > n * DUET_MAX_SHARE ? 1 : null;
    if (full === null) return;
    const weakest = own.filter((s) => voice.get(s) === full).sort((x, y) => x.sal - y.sal || x.t - y.t)[0];
    voice.set(weakest, (1 - full) as 0 | 1);
  }
}

// Zeitschluessel in ms; erst wie die Noten auf 4 Stellen runden (sonst kippt x.xxx5 einmal hoch, einmal runter)
const tKey = (t: number) => Math.round(Math.round(t * 1e4) / 10);
const timesOf = (notes: { t: number }[]) => new Set(notes.map((n) => tKey(n.t)));

export function generateDuet(a: SongAnalysis, difficulty: Difficulty, seed = 0): DuetMap<Beatmap> {
  const rngMain = new Rng(`${seed}:${difficulty}:duet`);
  const { chosen, startT, endT } = pickTiming(a, schnittTiming(difficulty, DUET_DENSITY), rngMain);
  const split = splitSlots(chosen);
  limitDensity(split, DIFFICULTY[difficulty].maxLocalNps);
  const build = (v: 0 | 1) => buildFromSlots(a, difficulty, seed, split.parts[v], { startT, endT, salt: `:v${v + 1}` });
  let parts: [Beatmap, Beatmap] = [build(0), build(1)];
  // Slots, die eine Stimme nicht spielen konnte (Hand nicht frei), einmal der anderen Stimme geben
  const moved = [false, false];
  for (const v of [0, 1] as const) {
    const have = timesOf(parts[v].notes), other = (1 - v) as 0 | 1;
    const lost = split.parts[v].filter((s) => !s.drop && !have.has(tKey(s.t)));
    if (!lost.length) continue;
    const take = new Set(lost);
    split.parts[v] = split.parts[v].filter((s) => !take.has(s));
    split.parts[other] = [...split.parts[other], ...lost].sort((x, y) => x.b - y.b);
    moved[other] = true;
  }
  if (moved[0] || moved[1]) parts = [moved[0] ? build(0) : parts[0], moved[1] ? build(1) : parts[1]];
  // was auch danach nicht spielbar ist, faellt weg: slots = was wirklich gespielt wird
  const unisonT = new Set(split.unison.map((s) => tKey(s.t)));
  // Lichtshow aus dem ganzen Lied, fuer beide gleich
  const all: Note[] = [...parts[0].notes, ...parts[1].notes].sort((x, y) => x.t - y.t);
  const lights = lightShow(a, all);
  for (const p of parts) p.lights = lights;
  return duetResult('schnitt', a, difficulty, seed, parts, unisonT);
}

/** keine Stimme lokal dichter als Solo erlaubt: ueberzaehlige Slots zur anderen Stimme, sonst weglassen */
export function limitDensity(split: DuetSplit, max: number) {
  const kept: [number[], number[]] = [[], []], out: [Slot[], Slot[]] = [[], []];
  const all = [...split.parts[0].map((s) => [s, 0] as const), ...split.parts[1].filter((s) => !s.drop).map((s) => [s, 1] as const)]
    .sort((x, y) => x[0].t - y[0].t);
  for (const [s, v] of all) {
    if (s.drop) {   // Unisono: beide Stimmen
      kept[0].push(s.t); kept[1].push(s.t); out[0].push(s); out[1].push(s); continue;
    }
    const o = (1 - v) as 0 | 1;
    if (fitsDensity(kept[v].slice(-24), s.t, max)) { kept[v].push(s.t); out[v].push(s); }
    else if (fitsDensity(kept[o].slice(-24), s.t, max)) { kept[o].push(s.t); out[o].push(s); }
  }
  split.parts = out;
}

/** gemeinsames Ergebnis-Objekt (Schnitt und Orbit) */
export function duetResult<P extends { notes: { t: number }[] }>(mode: 'schnitt' | 'orbit', a: SongAnalysis, difficulty: Difficulty, seed: number, parts: [P, P], unisonT: Set<number>): DuetMap<P> {
  const t0 = timesOf(parts[0].notes), t1 = timesOf(parts[1].notes);
  const unison = [...unisonT].filter((k) => t0.has(k) && t1.has(k)).sort((x, y) => x - y);
  const slots = [...new Set([...t0, ...t1])].sort((x, y) => x - y);
  const solo0 = [...t0].filter((k) => !t1.has(k)).length, solo1 = [...t1].filter((k) => !t0.has(k)).length;
  const own = Math.max(1, solo0 + solo1);
  return {
    mode, version: DUET_MAPPING_VERSION, analysisVersion: a.version, difficulty, seed, parts,
    unison: unison.map((k) => k / 1000), slots: slots.map((k) => k / 1000),
    stats: { share: [Math.round((solo0 / own) * 1000) / 1000, Math.round((solo1 / own) * 1000) / 1000], unison: unison.length },
  };
}
