// Swing-Parity: Jede Hand wechselt natuerlich zwischen Vorhand (Schlag nach unten / nach innen)
// und Rueckhand (nach oben / nach aussen). Nach einem Down-Schlag kommt bei derselben Hand ein Up-
// Schlag – ausser es ist genug Zeit fuer einen Reset vergangen.
import { Cut } from '../types.js';

export type Swing = 'fore' | 'back';
/** Charakter der Richtung innerhalb einer Swing-Familie */
export type Flavor = 'straight' | 'in' | 'out' | 'side';

/**
 * Richtung aus Hand (0 = links/rot, 1 = rechts/blau), Swing und Flavor.
 * fore = nach unten (bzw. seitlich nach innen), back = nach oben (bzw. nach aussen).
 * 'in' = diagonal zur Mitte, 'out' = diagonal nach aussen.
 */
export function cutFor(hand: 0 | 1, swing: Swing, flavor: Flavor): Cut {
  const inward = hand === 0 ? 'R' : 'L';
  const outward = hand === 0 ? 'L' : 'R';
  if (flavor === 'side') {
    // Vorhand = nach innen ziehen, Rueckhand = nach aussen
    const dir = swing === 'fore' ? inward : outward;
    return dir === 'L' ? Cut.Left : Cut.Right;
  }
  if (swing === 'fore') {
    if (flavor === 'straight') return Cut.Down;
    const side = flavor === 'in' ? inward : outward;
    return side === 'L' ? Cut.DownLeft : Cut.DownRight;
  }
  if (flavor === 'straight') return Cut.Up;
  // Rueckhand: die Diagonale spiegelt sich (ein Down-Right-Schlag wird von Up-Left gefolgt)
  const side = flavor === 'in' ? inward : outward;
  return side === 'L' ? Cut.UpLeft : Cut.UpRight;
}

/** Swing-Familie einer Richtung fuer eine Hand (Any = neutral -> null) */
export function swingOf(hand: 0 | 1, d: Cut): Swing | null {
  switch (d) {
    case Cut.Down: case Cut.DownLeft: case Cut.DownRight: return 'fore';
    case Cut.Up: case Cut.UpLeft: case Cut.UpRight: return 'back';
    case Cut.Left: return hand === 1 ? 'fore' : 'back';
    case Cut.Right: return hand === 0 ? 'fore' : 'back';
    default: return null;
  }
}

/** Richtung in die andere Swing-Familie spiegeln (fuer Korrekturen) */
export function flipCut(hand: 0 | 1, d: Cut): Cut {
  switch (d) {
    case Cut.Down: return Cut.Up; case Cut.Up: return Cut.Down;
    case Cut.DownLeft: return Cut.UpLeft; case Cut.UpLeft: return Cut.DownLeft;
    case Cut.DownRight: return Cut.UpRight; case Cut.UpRight: return Cut.DownRight;
    case Cut.Left: return Cut.Right; case Cut.Right: return Cut.Left;
    default: return d;
  }
  void hand;
}

/** Bewegungsvektor (x nach rechts, y nach oben) einer Schnittrichtung */
export function cutVector(d: Cut): [number, number] {
  const s = Math.SQRT1_2;
  switch (d) {
    case Cut.Up: return [0, 1]; case Cut.Down: return [0, -1];
    case Cut.Left: return [-1, 0]; case Cut.Right: return [1, 0];
    case Cut.UpLeft: return [-s, s]; case Cut.UpRight: return [s, s];
    case Cut.DownLeft: return [-s, -s]; case Cut.DownRight: return [s, -s];
    default: return [0, 0];
  }
}

export interface HandState {
  last: Swing | null;
  t: number;          // Zeit des letzten Schlags
  x: number; y: number;
  d: Cut;
}

export const newHand = (hand: 0 | 1): HandState => ({ last: null, t: -1e9, x: hand === 0 ? 1 : 2, y: 0, d: Cut.Any });

/** naechster erlaubter Swing einer Hand */
export function nextSwing(h: HandState, t: number, resetTime: number): Swing {
  if (!h.last || t - h.t >= resetTime) return 'fore';     // nach Pause: frisch von oben
  return h.last === 'fore' ? 'back' : 'fore';
}
