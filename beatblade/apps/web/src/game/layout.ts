// Spielfeld-Geometrie: Spieler steht im Ursprung, schaut nach -Z.
import { settings } from '../settings';

export const LANE_W = 0.55;            // Abstand der Spalten (m)
export const ROW_H = 0.5;              // Abstand der Reihen (m)
export const NOTE_SIZE = 0.42;         // Kantenlaenge der Bloecke
export const HIT_Z = -0.95;            // Z, an dem eine Note "auf dem Beat" ist (bequeme Schlagdistanz)
export const SABER_LEN = 1.0;
export const COLORS = { left: 0xff3d6e, right: 0x3db8ff, bomb: 0x2a2a33 };

/** x-Position einer Spalte 0..3 */
export const laneX = (x: number) => (x - 1.5) * LANE_W;
/** y-Position einer Reihe 0..2 – skaliert mit der Spielergroesse */
export const rowY = (y: number) => {
  const base = Math.max(0.45, Math.min(0.85, settings.playerHeight * 0.33));
  return base + y * ROW_H;
};

// ---------- Sichtweite: wie frueh Bloecke im Hintergrund auftauchen ----------
export const VIEW_SEC = 3.0;            // Sekunden, die ein Block sichtbar ist, bevor er bei dir ankommt
export const VIEW_DIST_MAX = 45;        // hoechstens so weit weg (m) taucht er auf (bei schnellen Bloecken)
export const ARRIVE_PART = 0.45;        // Anteil der Sichtzeit fuers sanfte Heranschweben aus der Ferne

/** Vorlaufzeit (s): wie lange eine Note vor ihrem Zeitpunkt sichtbar ist */
export function lookahead(njs: number, _bpm?: number, _offset = 0): number {
  return Math.max(1.5, Math.min(VIEW_SEC, VIEW_DIST_MAX / njs));
}

/** sanftes Ein- und Ausblenden (0..1 -> 0..1) */
export const smooth = (p: number) => { const q = Math.min(1, Math.max(0, p)); return q * q * (3 - 2 * q); };
