// Gemeinsame Typen fuer Server, Worker und Spiel.

export const DIFFICULTIES = ['easy', 'normal', 'hard', 'expert', 'expertplus'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: 'Easy', normal: 'Normal', hard: 'Hard', expert: 'Expert', expertplus: 'Expert+',
};

/** Frequenzbaender der Onset-Erkennung */
export const BANDS = ['sub', 'lowmid', 'highmid', 'high'] as const;
export type Band = (typeof BANDS)[number];

export type SectionType = 'intro' | 'verse' | 'buildup' | 'drop' | 'breakdown' | 'outro';

export interface Onset {
  /** Zeit in Sekunden */
  t: number;
  /** relative Staerke 0..1 (normalisiert pro Band) */
  s: number;
}

export interface Section {
  start: number;          // Sekunden
  end: number;
  startBar: number;       // Takt-Index
  endBar: number;         // exklusiv
  type: SectionType;
  energy: number;         // 0..1 (mittlere Energie)
  /** Wiederholungsgruppe: gleiche Zahl = aehnlicher Abschnitt */
  group: number;
  /** wie oft diese Gruppe vorher schon vorkam (0 = erstes Mal) */
  occurrence: number;
}

export interface SongAnalysis {
  version: number;
  duration: number;       // Sekunden
  sampleRate: number;
  bpm: number;            // global, gerundet auf 0.01
  bpmConfidence: number;  // 0..1
  /** Beat-Zeitpunkte in Sekunden (sauberes Raster, leicht variables Tempo erlaubt) */
  beats: number[];
  /** Index des ersten Downbeats im beats-Array und Taktart */
  downbeatOffset: number;
  beatsPerBar: number;
  /** Takt-Startzeiten (Sekunden) */
  bars: number[];
  /** Energie pro Takt 0..1 */
  barEnergy: number[];
  /** Melodie-/Gesangsaktivitaet pro Beat 0..1 */
  melody: number[];
  /** Onsets je Band */
  onsets: Record<Band, Onset[]>;
  /** Onset-Staerke pro Beat-Unterteilung (1/4 Beat) je Band, 0..1 – fuer das Mapping */
  grid: { step: number; bands: Record<Band, number[]> };
  /** Triolen-Neigung pro Beat 0..1 (1 = eher Triolen als 16tel) */
  triplet: number[];
  /** pro Beat: wie stark ein Klang gehalten wird (0..1; Melodie/Pad ohne neue Anschlaege) – fuer Orbit-Rails. Fehlt bei alten Analysen. */
  sustain?: number[];
  /** pro Beat: Tonhoehe/Helligkeit des melodischen Anteils (0 tief .. 1 hoch) – Form der Orbit-Rails. Fehlt bei alten Analysen. */
  pitch?: number[];
  sections: Section[];
  /** Energiekurve fuer Anzeige, ~10 Werte pro Sekunde */
  energyCurve: number[];
  /** Analysedauer in ms */
  took: number;
}

export interface Waveform {
  /** Paare [min, max] pro Peak, Werte -1..1 */
  peaks: number[];
  count: number;
  duration: number;
}

/** Schnittrichtungen. 8 = Punkt (beliebige Richtung) */
export enum Cut {
  Up = 0, Down = 1, Left = 2, Right = 3, UpLeft = 4, UpRight = 5, DownLeft = 6, DownRight = 7, Any = 8,
}

export interface Note {
  /** Zeit in Beats (Index im Beat-Raster, gebrochen fuer Unterteilungen) */
  b: number;
  /** Zeit in Sekunden */
  t: number;
  /** Spalte 0..3 (links -> rechts) */
  x: number;
  /** Reihe 0..2 (unten -> oben) */
  y: number;
  /** 0 = links/rot, 1 = rechts/blau */
  c: 0 | 1;
  d: Cut;
}

export interface Bomb { b: number; t: number; x: number; y: number }

export interface Obstacle {
  b: number; t: number;
  /** Dauer in Sekunden */
  dur: number;
  x: number;       // linke Spalte
  w: number;       // Breite in Spalten
  /** 'full' = ganze Hoehe, 'crouch' = oben (ducken) */
  kind: 'full' | 'crouch';
}

export type LightType = 'flash' | 'color' | 'laser' | 'burst' | 'off';
export interface LightEvent {
  t: number;
  type: LightType;
  /** flash: Staerke 0..1; color: Paletten-Index; laser: Geschwindigkeit 0..1; burst: Staerke */
  v: number;
}

export interface Beatmap {
  version: number;
  analysisVersion: number;
  difficulty: Difficulty;
  seed: number;
  bpm: number;
  /** Notengeschwindigkeit (m/s) und Sprung-Offset in Beats */
  njs: number;
  offset: number;
  beats: number[];
  notes: Note[];
  bombs: Bomb[];
  obstacles: Obstacle[];
  lights: LightEvent[];
  stats: BeatmapStats;
}

export interface BeatmapStats {
  notes: number;
  nps: number;           // Noten pro Sekunde (gesamt)
  peakNps: number;       // hoechste Dichte in einem 2-s-Fenster
  dropNps: number;       // Dichte in Drops
  verseNps: number;      // Dichte in Strophen
  bombs: number;
  obstacles: number;
  /** Spielbarkeits-Score 0..100 und gefundene/korrigierte Probleme */
  playability: number;
  issues: Record<string, number>;
}

export type SongStatus = 'queued' | 'decoding' | 'analyzing' | 'mapping' | 'ready' | 'error' | 'outdated';

export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  bpm: number | null;
  status: SongStatus;
  progress: number;        // 0..1 innerhalb des aktuellen Schritts
  error: string | null;
  bundled: boolean;
  hidden: boolean;
  hasCover: boolean;
  difficulties: Difficulty[];
  seed: number;
  createdAt: number;
  updatedAt: number;
  hash: string;
  fileName: string;
  /** Lizenz/Quelle (nur mitgelieferte Songs) */
  license: string | null;
  source: string | null;
}

export type JobType = 'full' | 'map';
export interface Job {
  id: number;
  songId: string;
  type: JobType;
  status: 'queued' | 'running' | 'done' | 'error';
  attempts: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Highscore {
  songId: string;
  difficulty: Difficulty;
  name: string;
  score: number;
  accuracy: number;
  rank: string;
  maxCombo: number;
  misses: number;
  modifiers: string;
  createdAt: number;
}

// ---------- Orbit-Modus (Kugeln beruehren, Rails folgen) ----------

/** normal = eine Hand (Farbe), gold = beide Haende zusammen, green = eine Hand nach Wahl */
export type OrbitKind = 'normal' | 'gold' | 'green';

export interface OrbitNote {
  /** Beat (gebrochen) und Sekunden */
  b: number;
  t: number;
  /** Position in Metern auf der Trefferflaeche: x quer (0 = Mitte), y Hoehe fuer 1,75 m Spielergroesse */
  x: number;
  y: number;
  /** Hand: 0 = links, 1 = rechts; bei gold beide (Wert = 0), bei green die vorgeschlagene */
  hand: 0 | 1;
  kind: OrbitKind;
  /** liegt auf einer Rail (Index in rails) – Start- oder Zwischen-Note */
  rail?: number;
}

export interface OrbitRailPoint { t: number; x: number; y: number }

export interface OrbitRail {
  hand: 0 | 1;
  kind: 'normal' | 'gold';
  /** Stuetzpunkte in Zeitreihenfolge (das Spiel legt eine glatte Kurve hindurch) */
  points: OrbitRailPoint[];
  t0: number;
  t1: number;
}

export interface OrbitStats {
  notes: number;
  rails: number;
  /** Sekunden auf Rails (beide Haende zusammengezaehlt) */
  railSeconds: number;
  nps: number;
  peakNps: number;
  gold: number;
  green: number;
  obstacles: number;
  /** schnellste Handbewegung (m/s) zwischen zwei Noten derselben Hand */
  maxHandSpeed: number;
  /** 0..100 */
  playability: number;
  issues: Record<string, number>;
}

export interface OrbitMap {
  mode: 'orbit';
  version: number;
  analysisVersion: number;
  difficulty: Difficulty;
  seed: number;
  bpm: number;
  /** Fluggeschwindigkeit der Noten (m/s) */
  speed: number;
  beats: number[];
  notes: OrbitNote[];
  rails: OrbitRail[];
  obstacles: Obstacle[];
  lights: LightEvent[];
  stats: OrbitStats;
}
