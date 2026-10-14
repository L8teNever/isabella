// Alle Stellschrauben des Orbit-Generators (Kugeln beruehren, Rails folgen).
// Positionen in Metern fuer 1,75 m Spielergroesse; das Spiel skaliert die Hoehe auf die eingestellte Groesse.
import type { Difficulty, SectionType } from '../../types.js';

export interface OrbitDifficulty {
  /** Ziel-Noten pro Sekunde bei mittlerer Energie, Unterteilungen pro Beat, Mindestabstand, lokale Dichtegrenze */
  nps: number; subdivisions: number[]; minGap: number; maxLocalNps: number;
  /** Fluggeschwindigkeit der Noten (m/s) */
  speed: number;
  /** halbe Breite/Hoehe des Bewegungsbereichs je Hand (m) – groesser = weitere Bewegungen */
  reachX: number; reachY: number;
  /** schnellste erlaubte Handbewegung zwischen zwei Noten (m/s) */
  maxHandSpeed: number;
  /** hoechstens dieser Anteil der Songzeit auf Rails (beide Haende zusammen) */
  railShare: number;
  /** Rail-Laenge in Beats */
  railMinBeats: number; railMaxBeats: number;
  /** Gold (beide Haende) auf starken Akzenten: Wahrscheinlichkeit je Kandidat; Drop-Start immer */
  goldAccent: number;
  /** Gruen (eine Hand nach Wahl): Laeufe in ruhigen Melodie-Passagen */
  greenRuns: boolean;
  /** Hindernisse / Ducken */
  walls: boolean; crouchWalls: boolean;
}

export const ORBIT_DIFFICULTY: Record<Difficulty, OrbitDifficulty> = {
  easy:       { nps: 1.0, subdivisions: [1],          minGap: 0.5,  maxLocalNps: 2.5, speed: 7,  reachX: 0.22, reachY: 0.16, maxHandSpeed: 1.6, railShare: 0.18, railMinBeats: 2, railMaxBeats: 6,  goldAccent: 0,    greenRuns: false, walls: true, crouchWalls: false },
  normal:     { nps: 1.6, subdivisions: [1, 2],       minGap: 0.32, maxLocalNps: 3.2, speed: 8,  reachX: 0.28, reachY: 0.2,  maxHandSpeed: 2.0, railShare: 0.22, railMinBeats: 2, railMaxBeats: 8,  goldAccent: 0.15, greenRuns: true,  walls: true, crouchWalls: false },
  hard:       { nps: 2.4, subdivisions: [1, 2],       minGap: 0.22, maxLocalNps: 4.5, speed: 9,  reachX: 0.34, reachY: 0.24, maxHandSpeed: 2.6, railShare: 0.25, railMinBeats: 2, railMaxBeats: 8,  goldAccent: 0.25, greenRuns: true,  walls: true, crouchWalls: false },
  expert:     { nps: 3.4, subdivisions: [1, 2, 4],    minGap: 0.15, maxLocalNps: 6.5, speed: 10, reachX: 0.4,  reachY: 0.28, maxHandSpeed: 3.2, railShare: 0.28, railMinBeats: 2, railMaxBeats: 12, goldAccent: 0.3,  greenRuns: true,  walls: true, crouchWalls: true },
  expertplus: { nps: 4.4, subdivisions: [1, 2, 4, 3], minGap: 0.11, maxLocalNps: 8.5, speed: 11, reachX: 0.46, reachY: 0.32, maxHandSpeed: 3.8, railShare: 0.3,  railMinBeats: 2, railMaxBeats: 12, goldAccent: 0.35, greenRuns: true,  walls: true, crouchWalls: true },
};

export const ORBIT = {
  /** Mitte der Trefferflaeche (Hoehe fuer 1,75 m) und Ruheposition der Haende */
  centerY: 1.25,
  homeX: 0.32,
  /** Grenzen der Flaeche (m) – Noten liegen immer bequem erreichbar */
  minX: -0.75, maxX: 0.75, minY: 0.75, maxY: 1.85,
  /** Mindestabstand zweier gleichzeitiger Noten (m), damit sich die Kugeln nicht beruehren */
  minSpread: 0.28,
  /** Rails: ab diesem sustain-Wert gilt ein Beat als gehalten */
  sustainMin: 0.62,
  /** ... und im Mittel ueber die ganze Rail mindestens so viel (einzelne schwache Beats sind erlaubt) */
  railMeanSustain: 0.5,
  /** Rails: Hoehe folgt der Tonhoehe (Anteil von reachY) */
  railPitchY: 1.0,
  /** Stuetzpunkte pro Beat auf Rails */
  railPointsPerBeat: 4,
  /** Zwischen-Noten auf Rails: ab dieser Onset-Staerke, Mindestabstand (Beats; mindestens 2x minGap der Stufe) */
  railNoteOnset: 0.65, railNoteGapBeats: 1,
  /** Pause nach einer Rail (Beats), bevor dieselbe Hand wieder eine Rail bekommt */
  railRestBeats: 2,
  /** Gruen-Laeufe: 4..8 Noten, nur wenn Melodie hoch und Takt-Energie hoechstens im unteren Anteil (Quantil des Songs) */
  greenMin: 4, greenMax: 8, greenMelody: 0.5, greenEnergy: 0.6,
  /** Gold-Rails (beide Haende nebeneinander): Chance je passender Rail in energiereichen Takten (nur Stufen mit Gold),
   *  Mindestlaenge in Beats und Mindestabstand zwischen zwei Gold-Rails in Takten */
  goldRailChance: 0.35, goldRailMinBeats: 3, goldRailGapBars: 16,
  /** Gold-Akzent: Kick-Staerke ab diesem Wert und Takt-Energie im oberen Anteil (Quantil des Songs) */
  goldKick: 0.8, goldEnergy: 0.7,
  /** schnelle Folge: unter diesem Abstand (s) wechseln die Haende ab */
  alternateGap: 0.32,
  /** Hand darf hoechstens so weit ueber die Mitte greifen (m) – sonst Ueberkreuzung */
  crossX: 0.02,
  /** Gold-Kugel: die Haende beruehren sie links/rechts der Mitte (m) */
  goldHandOffset: 0.15,
  /** Waende: Spalte c (0..3) deckt x = wallX0 + c*wallCol .. +wallCol ab; Noten halten wallMargin Abstand */
  wallX0: -1.0, wallCol: 0.5, wallMargin: 0.12,
  /** Ducken: Noten unter diese Hoehe (m, fuer 1,75 m) */
  crouchMaxY: 1.0,
  /** Einhand-Folge waehrend die andere Hand auf einer Rail ist: Mindestabstand (s) */
  soloGap: 0.25,
};

/** Dichte je Abschnitt (wie Schnitt, Breakdowns etwas ruhiger – dort laufen Rails) */
export const ORBIT_SECTION_DENSITY: Record<SectionType, number> = { intro: 0.55, verse: 0.85, buildup: 1.0, drop: 1.3, breakdown: 0.55, outro: 0.5 };

/** Bewegungsmuster je 2-Takt-Phrase (Gewichte) */
export const ORBIT_MOTIONS = { arc: 3, wave: 3, circle: 2, mirror: 3, pendulum: 2, steps: 2 } as const;
export type OrbitMotion = keyof typeof ORBIT_MOTIONS;
