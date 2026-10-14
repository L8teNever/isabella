// Orbit-Wertung: gleiche Genauigkeits-Prozent und Sterne wie Schnitt (ScoreKeeper/STAR_TABLE),
// dazu Perfekt/Gut/Schlecht je Kugel und Rails, die man zu einem Mindestanteil halten muss.
import { ScoreKeeper } from '../score';

// ---------- Stellschrauben der Orbit-Wertung ----------
/** Abstand Handkugel-Mitte zu Notenkugel-Mitte (m) beim Beruehren: bis hier Perfekt / Gut, darueber Schlecht */
export const PERFECT_DIST = 0.09;
export const GOOD_DIST = 0.17;
/** so weit (m) darf die Handkugel hoechstens weg sein, damit eine Beruehrung zaehlt */
export const TOUCH_DIST = 0.27;
/** Prozentpunkte je Bewertung (Verpasst: MISS_LOSS aus score.ts) */
export const PERFECT_GAIN = 1;
export const GOOD_GAIN = 0.6;
export const BAD_LOSS = 0.5;
/** Punkte je Bewertung (vor Multiplikator) */
export const PERFECT_POINTS = 115, GOOD_POINTS = 80, BAD_POINTS = 35;
/** Rails: Hand muss innerhalb dieses Abstands (m) zur Kurve sein ... */
export const RAIL_DIST = 0.16;
/** ... und das mindestens diesen Anteil der Rail-Zeit, sonst zaehlt die Rail als verpasst */
export const RAIL_MIN_SHARE = 0.8;
/** Punkte je Sekunde auf der Rail (vor Multiplikator) */
export const RAIL_POINTS_PER_SEC = 60;
/** Gold-Rails (beide Haende) bringen so viel mehr Punkte */
export const GOLD_RAIL_FACTOR = 2;
/** Gruen: Laeufe, deren Noten weniger als so viele Sekunden auseinander liegen, gehoeren zusammen
 *  (die erste beruehrende Hand gilt fuer den ganzen Lauf) */
export const GREEN_RUN_GAP = 2;
/** Gold: beide Haende muessen innerhalb dieses Zeitfensters (s) beruehren */
export const GOLD_WINDOW = 0.18;

export type Grade = 'perfekt' | 'gut' | 'schlecht';
export const GRADE_LABEL: Record<Grade, string> = { perfekt: 'Perfekt', gut: 'Gut', schlecht: 'Schlecht' };
export const GRADE_COLOR: Record<Grade, string> = { perfekt: '#ffd65a', gut: '#7ad7ff', schlecht: '#ff9db0' };

export function gradeFor(dist: number): Grade {
  return dist <= PERFECT_DIST ? 'perfekt' : dist <= GOOD_DIST ? 'gut' : 'schlecht';
}

export class OrbitScore extends ScoreKeeper {
  perfect = 0; good = 0; bad = 0;
  railsHeld = 0; railsLost = 0;

  /** Kugel beruehrt */
  touch(g: Grade): void {
    const before = this.rating;
    const mult = this.hit();                               // Combo, Multiplikator, +HIT_GAIN
    this.rating = before;                                   // Orbit bewertet selbst
    const gain = g === 'perfekt' ? PERFECT_GAIN : g === 'gut' ? GOOD_GAIN : -BAD_LOSS;
    this.rating = Math.max(0, Math.min(100, this.rating + gain));
    if (g === 'perfekt') this.perfect++; else if (g === 'gut') this.good++; else this.bad++;
    this.score += (g === 'perfekt' ? PERFECT_POINTS : g === 'gut' ? GOOD_POINTS : BAD_POINTS) * mult;
  }

  /** Rail beendet: share = gehaltener Anteil 0..1 */
  rail(share: number, seconds: number, gold = false): void {
    if (share >= RAIL_MIN_SHARE) {
      this.railsHeld++;
      const before = this.rating;
      const mult = this.hit();                               // zaehlt wie ein Treffer (Combo)
      this.rating = Math.min(100, before + PERFECT_GAIN * share);
      this.score += Math.round(RAIL_POINTS_PER_SEC * seconds * share * (gold ? GOLD_RAIL_FACTOR : 1)) * mult;
    } else {
      this.railsLost++;
      this.miss();
    }
  }
}
