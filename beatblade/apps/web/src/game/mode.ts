// Gemeinsame Schnittstelle aller Spielmodi (Schnitt = Bloecke zerschneiden, Orbit = Kugeln beruehren).
// play.ts spricht nur ueber diese Schnittstelle mit dem laufenden Modus; ein weiterer Modus setzt sie ebenfalls um.
import type * as THREE from 'three';
import type { LightEvent } from '@beatblade/core';
import type { ScoreKeeper } from './score';

export type ModeId = 'schnitt' | 'orbit';
export const MODE_LABEL: Record<ModeId, string> = { schnitt: 'Schnitt', orbit: 'Orbit' };

export interface GameMode {
  readonly id: ModeId;
  /** Wertung des laufenden Songs */
  score: ScoreKeeper;
  /** Kopf gerade in einer Wand */
  inWall: boolean;
  /** Song zu Ende (letzte Note/Wand vorbei) */
  ended: boolean;
  /** Lichtshow des geladenen Levels */
  readonly lights: LightEvent[];
  /** Noten bewegen, Treffer/Fehler werten. t = Songzeit (Audio-Uhr), head = Kopf in Spielfeld-Koordinaten */
  update(t: number, dt: number, head: THREE.Vector3, paused: boolean): void;
  /** Farben (Farbset/eigene Wahl, Themen-Map) auf Hand-Objekte und Noten anwenden */
  applyColors(setOverride?: string): void;
  /** Desktop-Autoplay: wohin die Hand (Schwertspitze bzw. Kugel) zur Songzeit t soll; null = Ruheposition */
  autoTarget(hand: 0 | 1, t: number): THREE.Vector3 | null;
  /** letzte Eintraege fuer das Debug-Protokoll */
  debugLog(): unknown[];
}
