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

/** Vorlaufzeit (s): wie lange eine Note vor ihrem Zeitpunkt sichtbar ist (aus NJS, wie Sprungdistanz) */
export function lookahead(njs: number, bpm: number, offset = 0): number {
  // halbe Sprungdauer in Beats: bei hohem Tempo/NJS kuerzer, mindestens 1 Beat
  const spb = 60 / bpm;
  let hjd = 4;
  while (njs * spb * hjd > 18) hjd /= 2;
  hjd = Math.max(1, hjd + offset);
  return Math.max(0.75, Math.min(1.6, hjd * spb * 1.2));
}
