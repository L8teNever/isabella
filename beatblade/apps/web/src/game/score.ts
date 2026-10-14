// Punkte, Combo, Multiplikator, Energie, Genauigkeit und Rang.
// Pro Note: Ausholen bis 70, Durchschwung bis 30, Genauigkeit zur Mitte bis 15 (max. 115) x Multiplikator.
// Multiplikator 1x -> 2x (nach 2 Treffern) -> 4x (nach 4 weiteren) -> 8x (nach 8 weiteren); Fehler halbiert.

export const MAX_NOTE = 115;
const STEPS = [2, 4, 8];

export class ScoreKeeper {
  score = 0; combo = 0; maxCombo = 0; mult = 1; private multProg = 0;
  energy = 0.5; hits = 0; misses = 0; badCuts = 0; badDir = 0; badColor = 0; bombs = 0; wallTime = 0;
  maxPossible = 0; private idealMult = 1; private idealProg = 0;
  failed = false;
  total = 0;               // Notenanzahl
  judged = 0;              // bewertete Noten

  constructor(public noFail: boolean) {}

  private advanceIdeal() {
    // maximal moeglicher Score mit perfektem Spiel (fuer Genauigkeit %)
    this.maxPossible += MAX_NOTE * this.idealMult;
    if (this.idealMult < 8) { this.idealProg++; if (this.idealProg >= STEPS[Math.log2(this.idealMult)]) { this.idealMult *= 2; this.idealProg = 0; } }
  }

  /** Treffer registrieren (Combo/Multiplikator sofort); Punkte kommen spaeter mit finalize */
  hit(): number {
    this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo); this.hits++; this.judged++;
    const m = this.mult;
    if (this.mult < 8) { this.multProg++; if (this.multProg >= STEPS[Math.log2(this.mult)]) { this.mult *= 2; this.multProg = 0; } }
    this.energy = Math.min(1, this.energy + 0.01);
    this.advanceIdeal();
    return m;
  }

  /** Punkte eines Treffers nachtragen (nach Messung des Durchschwungs) */
  finalize(pre: number, post: number, acc: number, mult: number): number {
    const pts = Math.round(Math.min(70, pre) + Math.min(30, post) + Math.min(15, acc));
    this.score += pts * mult;
    return pts;
  }

  private breakCombo() {
    this.combo = 0;
    if (this.mult > 1) this.mult /= 2;
    this.multProg = 0;
  }

  miss(bad = false, why: 'dir' | 'color' = 'dir') {
    this.breakCombo(); this.judged++;
    if (bad) { this.badCuts++; if (why === 'dir') this.badDir++; else this.badColor++; } else this.misses++;
    this.drain(0.1);
    this.advanceIdeal();
  }

  bomb() { this.breakCombo(); this.bombs++; this.drain(0.15); }

  wall(dt: number) { this.wallTime += dt; this.drain(0.5 * dt); if (this.combo > 0) this.breakCombo(); }

  private drain(v: number) {
    this.energy = Math.max(0, this.energy - v);
    if (this.energy <= 0 && !this.noFail) this.failed = true;
  }

  get accuracy(): number { return this.maxPossible > 0 ? (100 * this.score) / this.maxPossible : 100; }

  get rank(): string {
    if (this.failed) return 'F';
    const a = this.accuracy;
    return a >= 90 ? 'SS' : a >= 80 ? 'S' : a >= 65 ? 'A' : a >= 50 ? 'B' : 'C';
  }
}
