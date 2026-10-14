// Reichweite der Arme: jede Orbit-Kugel liegt in bequemer Reichweite der zustaendigen Hand.
// Modell: Kugel mit Radius armReach um die Schulter; auf der Trefferebene (z = hitZ) ist das ein Kreis.
// s = Spielergroesse / 1,75 m (Schultern und Armlaenge wachsen mit, die Trefferebene bleibt);
// duck = so viel tiefer stehen die Schultern gerade (Ducken unter einer Wand).
import { ORBIT } from './tuning.js';

/** Radius des erreichbaren Kreises auf der Trefferebene */
export function reachRadius(s = 1): number {
  return Math.sqrt(Math.max(0.01, (ORBIT.armReach * s) ** 2 - ORBIT.hitZ ** 2));
}

/** Schulterpunkt der Hand (x, y) */
export function shoulder(hand: 0 | 1, s = 1, duck = 0): [number, number] {
  return [(hand === 0 ? -1 : 1) * ORBIT.shoulderX * s, ORBIT.shoulderY * s - duck];
}

/** Abstand (m) um den der Punkt ausserhalb der Reichweite liegt (0 = erreichbar) */
export function outOfReach(x: number, y: number, hand: 0 | 1, s = 1, duck = 0): number {
  const [sx, sy] = shoulder(hand, s, duck);
  return Math.max(0, Math.hypot(x - sx, y - sy) - reachRadius(s));
}

/** Punkt radial auf den Rand der Reichweite ziehen, falls er ausserhalb liegt (z bleibt die Trefferebene) */
export function toReach(x: number, y: number, hand: 0 | 1, s = 1, duck = 0): [number, number] {
  const [sx, sy] = shoulder(hand, s, duck), r = reachRadius(s) - 1e-3;
  const dx = x - sx, dy = y - sy, d = Math.hypot(dx, dy);
  return d <= r ? [x, y] : [sx + (dx * r) / d, sy + (dy * r) / d];
}

/** Gold: beide Beruehrpunkte (Mitte ± goldHandOffset) in Reichweite ihrer Hand – Mitte entsprechend verschieben */
export function goldToReach(x: number, y: number, s = 1, duck = 0, off = ORBIT.goldHandOffset): [number, number] {
  for (let i = 0; i < 4; i++) {
    const [lx, ly] = toReach(x - off, y, 0, s, duck), [rx, ry] = toReach(x + off, y, 1, s, duck);
    const nx = (lx + off + rx - off) / 2, ny = (ly + ry) / 2;
    if (Math.abs(nx - x) < 1e-4 && Math.abs(ny - y) < 1e-4) break;
    x = nx; y = ny;
  }
  return [x, y];
}
