// Wertung pro Song: Genauigkeit in Prozent (startet bei 100 %), dazu Punkte/Combo als Zusatzinfo.
// Kein Game Over – man kann nicht rausfliegen.

// ---------- Stellschrauben der Genauigkeits-Wertung (Prozentpunkte) ----------
export const RATING_START = 100;           // jeder Song beginnt hier
export const RATING_MAX = 100;
export const RATING_MIN = 0;
export const HIT_GAIN = 1;                 // Treffer (richtige Farbe + Richtung)
export const MISS_LOSS = 3;                // Block verpasst (vorbeigeflogen)
export const BAD_CUT_LOSS = 3;             // Fehlschlag: falsche Richtung oder falsche Farbe
export const BOMB_LOSS = 4;                // Bombe getroffen
export const WALL_LOSS_PER_SEC = 5;        // pro Sekunde mit dem Kopf in einer Wand

/** Sterne-Stufen: [Mindest-Prozent, Sterne] – 5 Sterne nur bei 100 % */
export const STAR_TABLE: [number, number][] = [[100, 5], [90, 4], [75, 3], [50, 2], [25, 1], [0, 0]];

// ---------- Punkte (Zusatzinfo, wie in Rhythmus-Spielen ueblich) ----------
// Pro Note: Ausholen bis 70, Durchschwung bis 30, Genauigkeit zur Mitte bis 15 (max. 115) x Multiplikator.
// Multiplikator 1x -> 2x (nach 2 Treffern) -> 4x (nach 4 weiteren) -> 8x (nach 8 weiteren); Fehler halbiert.
export const MAX_NOTE = 115;
const STEPS = [2, 4, 8];

export function starsFor(percent: number): number {
  for (const [min, stars] of STAR_TABLE) if (percent >= min) return stars;
  return 0;
}
export const starString = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

export class ScoreKeeper {
  /** Genauigkeits-Wertung in Prozent */
  rating = RATING_START;
  score = 0; combo = 0; maxCombo = 0; mult = 1; private multProg = 0;
  hits = 0; misses = 0; badCuts = 0; badDir = 0; badColor = 0; bombs = 0; wallTime = 0;
  total = 0;               // Notenanzahl
  judged = 0;              // bewertete Noten

  private change(delta: number) { this.rating = Math.max(RATING_MIN, Math.min(RATING_MAX, this.rating + delta)); }

  /** Treffer registrieren (Combo/Multiplikator sofort); Punkte kommen spaeter mit finalize */
  hit(): number {
    this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo); this.hits++; this.judged++;
    const m = this.mult;
    if (this.mult < 8) { this.multProg++; if (this.multProg >= STEPS[Math.log2(this.mult)]) { this.mult *= 2; this.multProg = 0; } }
    this.change(HIT_GAIN);
    return m;
  }

  /** Punkte eines Treffers nachtragen (nach Messung des Durchschwungs) */
  finalize(pre: number, post: number, acc: number, mult: number): number {
    const pts = Math.round(Math.min(70, pre) + Math.min(30, post) + Math.min(15, acc));
    this.score += pts * mult;
    return pts;
  }

  private breakCombo() { this.combo = 0; if (this.mult > 1) this.mult /= 2; this.multProg = 0; }

  miss(bad = false, why: 'dir' | 'color' = 'dir') {
    this.breakCombo(); this.judged++;
    if (bad) { this.badCuts++; if (why === 'dir') this.badDir++; else this.badColor++; this.change(-BAD_CUT_LOSS); }
    else { this.misses++; this.change(-MISS_LOSS); }
  }

  bomb() { this.breakCombo(); this.bombs++; this.change(-BOMB_LOSS); }

  wall(dt: number) { this.wallTime += dt; this.change(-WALL_LOSS_PER_SEC * dt); if (this.combo > 0) this.breakCombo(); }

  get stars(): number { return starsFor(this.rating); }
}
