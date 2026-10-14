// Validierung und Korrektur einer Beatmap.
// Prueft: Parity je Hand, Ueberkreuzungen, Sichtblocks, zu knappe Abstaende derselben Hand,
// lokale Dichte, Noten in Waenden/unter Duck-Waenden, Bomben im Schlagweg.
// Fehler werden korrigiert (oder die Note entfernt) und gezaehlt; daraus der Spielbarkeits-Score.
import { DIFFICULTY, MAPPING } from '../tuning.js';
import { Cut, type Beatmap, type Note, type SongAnalysis } from '../types.js';
import { flipCut, swingOf } from './parity.js';
import { sectionAtBeat } from './util.js';

const SLIDER_GAP = 0.13;   // Noten derselben Hand, gleiche Richtung, so eng = eine Bewegung

export function validate(bm: Beatmap, a: SongAnalysis): void {
  const D = DIFFICULTY[bm.difficulty];
  const issues: Record<string, number> = {};
  const bump = (k: string, n = 1) => { issues[k] = (issues[k] ?? 0) + n; };
  let notes = bm.notes.slice().sort((x, y) => x.t - y.t || x.c - y.c);
  const before = notes.length;

  // 1) Noten in Waenden: in eine freie Spalte schieben, sonst entfernen; unter Duck-Waenden nur unten
  const fitWalls = () => { for (const o of bm.obstacles) {
    const t0 = o.t - 0.2, t1 = o.t + o.dur + 0.1;
    for (const n of notes) {
      if (n.t < t0 || n.t > t1) continue;
      if (o.kind === 'crouch') { if (n.y > 0) { n.y = 0; bump('crouchWall'); } continue; }
      if (o.w >= 2) {
        // halbe Bahn zu: alle Bloecke auf die freie Seite, rot links, blau rechts (kein Kreuzen, nichts in der Wand)
        const free = [0, 1, 2, 3].filter((x) => x < o.x || x >= o.x + o.w);
        if (!free.length) { n.t = -1; continue; }
        const want = n.c === 0 ? free[0] : free[free.length - 1];
        if (n.x !== want) { if (n.x >= o.x && n.x < o.x + o.w) bump('wallBlock'); n.x = want; }
        continue;
      }
      if (n.x >= o.x && n.x < o.x + o.w) {
        bump('wallBlock');
        // Ausweichen zur eigenen Seite
        const cands = n.c === 0 ? [1, 0, 2] : [2, 3, 1];
        const free = cands.find((x) => x < o.x || x >= o.x + o.w);
        if (free !== undefined) n.x = free; else n.t = -1;
      }
    }
  } };
  fitWalls();
  notes = notes.filter((n) => n.t >= 0);

  // 2) Abstand derselben Hand (Slider-Ketten ausgenommen)
  // Wird eine Note entfernt, faellt auch die naechste derselben Hand weg (sonst kippt die Parity
  // aller folgenden Noten) – ausser nach einer Reset-Pause.
  const lastOf: (Note | null)[] = [null, null];
  const skip = [false, false];
  const dropNext = (n: Note): boolean => {
    if (!skip[n.c]) return false;
    skip[n.c] = false;
    const p = lastOf[n.c];
    return !!p && n.t - p.t < MAPPING.resetTime;
  };
  notes = notes.filter((n) => {
    if (dropNext(n)) return false;
    const p = lastOf[n.c];
    if (p) {
      const gap = n.t - p.t;
      const slider = gap < SLIDER_GAP && n.d === p.d && n.d !== Cut.Any;
      if (!slider && gap < D.minHandGap * 0.7) { bump('handGap'); skip[n.c] = true; return false; }
    }
    lastOf[n.c] = n; return true;
  });

  // 3) lokale Dichte: max. D.maxLocalNps Schlaege (Doppel = 1) in 1 s – vor der Parity-Pruefung,
  //    damit entfernte Noten keine Parity-Luecken hinterlassen
  {
    const kept: Note[] = [];
    lastOf[0] = lastOf[1] = null; skip[0] = skip[1] = false;
    for (const n of notes) {
      if (dropNext(n)) continue;
      const ts = new Set<number>([Math.round(n.t * 50)]);
      for (let k = kept.length - 1; k >= 0 && n.t - kept[k].t < 1 - 1e-9; k--) ts.add(Math.round(kept[k].t * 50));
      if (ts.size > Math.floor(D.maxLocalNps)) { bump('density'); skip[n.c] = true; continue; }
      kept.push(n); lastOf[n.c] = n;
    }
    notes = kept;
  }

  // 4) Parity je Hand
  for (const hand of [0, 1] as const) {
    let prev: Note | null = null, prevSwing: 'fore' | 'back' | null = null;
    for (const n of notes) {
      if (n.c !== hand) continue;
      const sw = swingOf(hand, n.d);
      if (prev && n.t - prev.t < SLIDER_GAP && n.d === prev.d) { prev = n; continue; }   // Slider
      if (sw && prevSwing && prev && n.t - prev.t < MAPPING.resetTime && sw === prevSwing) {
        n.d = flipCut(hand, n.d); bump('parity');
      }
      const s2 = swingOf(hand, n.d);
      // Punkt-Note: Hand schwingt natuerlich weiter – nach einer Pause beginnt sie neu von oben
      prevSwing = s2 ?? (prev && n.t - prev.t < MAPPING.resetTime ? (prevSwing === 'fore' ? 'back' : 'fore') : 'fore');
      prev = n;
    }
  }

  // 5) Ueberkreuzungen: gleichzeitig (oder sehr knapp) rot rechts von blau -> Spalten tauschen
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    for (let j = i + 1; j < notes.length && notes[j].t - n.t < 0.2; j++) {
      const m = notes[j];
      if (m.c === n.c) continue;
      const red = n.c === 0 ? n : m, blue = n.c === 0 ? m : n;
      if (red.x > blue.x || (red.x === blue.x && red.y === blue.y)) {
        bump('crossover');
        if (red.x === blue.x) { red.x = Math.max(0, red.x - 1); blue.x = Math.min(3, blue.x + 1); if (red.x === blue.x) blue.x = Math.min(3, red.x + 1); }
        else { const t = red.x; red.x = blue.x; blue.x = t; }
      }
    }
  }

  // Kreuzungs-Korrektur darf nichts zurueck in eine Wand schieben
  fitWalls();
  notes = notes.filter((n) => n.t >= 0);

  // 6) Sichtblock: Mitte (x 1/2, y 1) mit schneller Folge -> nach unten
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if ((n.x === 1 || n.x === 2) && n.y === 1) {
      const nx = notes[i + 1];
      if (nx && nx.t - n.t < 0.3) { n.y = 0; bump('visionBlock'); }
    }
  }

  // 7) Bomben nicht im Weg (nah an Noten oder in Waenden)
  const bombsBefore = bm.bombs.length;
  bm.bombs = bm.bombs.filter((b) => !notes.some((n) => Math.abs(n.t - b.t) < 0.3 && Math.abs(n.x - b.x) <= 1 && Math.abs(n.y - b.y) <= 1));
  if (bm.bombs.length !== bombsBefore) bump('bomb', bombsBefore - bm.bombs.length);

  bm.notes = notes;
  // ---------- Statistik ----------
  const first = notes[0]?.t ?? 0, last = notes[notes.length - 1]?.t ?? 0;
  const span = Math.max(1, last - first);
  const npsIn = (types: string[]) => {
    let c = 0, dur = 0;
    for (const s of a.sections) if (types.includes(s.type)) { dur += s.end - s.start; c += notes.filter((n) => n.t >= s.start && n.t < s.end).length; }
    return dur > 0 ? round2(c / dur) : 0;
  };
  let peak = 0, j0 = 0;
  for (let i = 0; i < notes.length; i++) { while (notes[i].t - notes[j0].t > 2) j0++; peak = Math.max(peak, (i - j0 + 1) / 2); }
  const totalIssues = Object.values(issues).reduce((s, v) => s + v, 0);
  bm.stats = {
    notes: notes.length, nps: round2(notes.length / span), peakNps: round2(peak), dropNps: npsIn(['drop']), verseNps: npsIn(['verse']),
    bombs: bm.bombs.length, obstacles: bm.obstacles.length,
    // Score: Anteil der Probleme an der Notenzahl (vor Korrektur), gewichtet
    playability: Math.max(0, Math.round(100 - (100 * totalIssues) / Math.max(1, before) * 2)),
    issues,
  };
  void sectionAtBeat;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Pruefung ohne Korrektur (fuer Tests): zaehlt verbleibende Parity-Fehler und Kreuzungen */
export function countProblems(bm: Beatmap): { parity: number; crossover: number; handGap: number } {
  const D = DIFFICULTY[bm.difficulty];
  let parity = 0, crossover = 0, handGap = 0;
  for (const hand of [0, 1] as const) {
    let prev: Note | null = null, prevSwing: string | null = null;
    for (const n of bm.notes) {
      if (n.c !== hand) continue;
      if (prev && n.t - prev.t < SLIDER_GAP && n.d === prev.d) { prev = n; continue; }
      const sw = swingOf(hand, n.d);
      if (prev && sw && prevSwing && n.t - prev.t < MAPPING.resetTime && sw === prevSwing) parity++;
      if (prev && n.t - prev.t < D.minHandGap * 0.7) handGap++;
      prevSwing = sw ?? (prev && n.t - prev.t < MAPPING.resetTime ? (prevSwing === 'fore' ? 'back' : 'fore') : 'fore');
      prev = n;
    }
  }
  for (let i = 0; i < bm.notes.length; i++) for (let j = i + 1; j < bm.notes.length && bm.notes[j].t - bm.notes[i].t < 0.2; j++) {
    const n = bm.notes[i], m = bm.notes[j];
    if (n.c !== m.c) { const red = n.c === 0 ? n : m, blue = n.c === 0 ? m : n; if (red.x > blue.x) crossover++; }
  }
  return { parity, crossover, handGap };
}
