// Zentrale Tuning-Konfiguration: alle Schwellen und Gewichte von Analyse und Mapping an einem Ort.
// Aenderungen hier, die das Ergebnis veraendern, sollten die Versionsnummer in version.ts erhoehen.
import type { Difficulty, SectionType, Band } from './types.js';

export const ANALYSIS = {
  sampleRate: 44100,
  fftSize: 2048,
  hop: 512,
  /** Frequenzbaender (Hz) der Multi-Band-Onset-Erkennung */
  bands: {
    sub: [20, 150],
    lowmid: [150, 800],
    highmid: [800, 5000],
    high: [5000, 16000],
  } as Record<Band, [number, number]>,
  /** Gewicht der Baender in der kombinierten Onset-Kurve (Tempo/Beat) */
  bandWeight: { sub: 1.0, lowmid: 0.8, highmid: 0.9, high: 0.5 } as Record<Band, number>,
  /** Log-Kompression der Magnituden: log(1 + gamma * |X|) */
  logGamma: 100,
  onset: {
    /** gleitender Median (Sekunden) fuer die adaptive Schwelle */
    medianWindow: 0.5,
    /** Schwelle = median * factor + delta (auf normalisierter Kurve) */
    factor: 1.35,
    delta: 0.04,
    /** Mindestabstand zweier Onsets im selben Band (Sekunden) */
    minGap: { sub: 0.09, lowmid: 0.07, highmid: 0.06, high: 0.05 } as Record<Band, number>,
  },
  tempo: {
    minBpm: 60,
    maxBpm: 240,
    /** bevorzugter Bereich; ausserhalb wird verdoppelt/halbiert, wenn plausibel */
    preferLow: 70,
    preferHigh: 180,
    /** log-gauss Prior um diesen Wert (Ellis) */
    priorCenter: 120,
    priorOctaves: 1.0,
  },
  beat: {
    /** Ellis-DP: wie stark Abweichungen vom Tempo bestraft werden */
    tightness: 120,
  },
  structure: {
    /** Kernel-Groesse (Takte) der Checkerboard-Novelty */
    kernelBars: 8,
    /** minimale Abschnittslaenge in Takten */
    minBars: 4,
    /** Peaks der Novelty ueber diesem Anteil des Maximums werden Grenzen */
    peakRel: 0.25,
    /** Aehnlichkeit (Cosinus) ab der zwei Abschnitte als Wiederholung gelten */
    repeatSim: 0.88,
  },
  waveformPeaks: 2000,
};

export interface DifficultyTuning {
  /** Ziel-Notendichte (Noten/Sekunde) bei mittlerer Energie in einem 'verse' */
  nps: number;
  /** erlaubte Unterteilungen pro Beat (2 = 1/2, 4 = 1/4, 3 = Triolen, 8 = 1/8) */
  subdivisions: number[];
  /** minimaler Abstand zweier Noten derselben Hand (Sekunden) */
  minHandGap: number;
  /** minimaler Abstand zwischen zwei Swings ueberhaupt (Sekunden) */
  minGap: number;
  /** Wahrscheinlichkeit fuer Doppelnoten auf starken Schlaegen */
  doubles: number;
  /** Bomben/Waende erlaubt */
  bombs: boolean;
  walls: boolean;
  crouchWalls: boolean;
  /** Muster-Gewichte */
  patterns: Partial<Record<PatternName, number>>;
  njs: number;
  offset: number;
  /** harte Obergrenze: Noten in 1 Sekunde */
  maxLocalNps: number;
  /** Anteil Punkt-Noten (beliebige Richtung) */
  dots: number;
}

export type PatternName = 'stream' | 'stair' | 'doubles' | 'windmill' | 'cross' | 'slider' | 'burst' | 'simple';

export const DIFFICULTY: Record<Difficulty, DifficultyTuning> = {
  easy: {
    nps: 1.2, subdivisions: [1], minHandGap: 0.9, minGap: 0.42, doubles: 0.0, bombs: false, walls: true, crouchWalls: false,
    patterns: { simple: 1 }, njs: 10, offset: 0, maxLocalNps: 3, dots: 0.25,
  },
  normal: {
    nps: 2.0, subdivisions: [1, 2], minHandGap: 0.5, minGap: 0.27, doubles: 0.12, bombs: false, walls: true, crouchWalls: false,
    patterns: { simple: 3, stair: 1, doubles: 1 }, njs: 10, offset: 0, maxLocalNps: 3.6, dots: 0.08,
  },
  hard: {
    nps: 3.3, subdivisions: [1, 2], minHandGap: 0.34, minGap: 0.17, doubles: 0.2, bombs: true, walls: true, crouchWalls: false,
    patterns: { simple: 2, stream: 2, stair: 2, doubles: 1, cross: 1, windmill: 1 }, njs: 12, offset: 0, maxLocalNps: 5.5, dots: 0.03,
  },
  expert: {
    nps: 5.0, subdivisions: [1, 2, 4], minHandGap: 0.22, minGap: 0.11, doubles: 0.25, bombs: true, walls: true, crouchWalls: false,
    patterns: { simple: 1, stream: 3, stair: 2, doubles: 1, cross: 1, windmill: 2, burst: 1 }, njs: 16, offset: 0, maxLocalNps: 8, dots: 0.0,
  },
  expertplus: {
    nps: 6.8, subdivisions: [1, 2, 4, 3, 8], minHandGap: 0.16, minGap: 0.075, doubles: 0.3, bombs: true, walls: true, crouchWalls: true,
    patterns: { stream: 4, stair: 2, doubles: 1, cross: 1, windmill: 2, burst: 2, slider: 1 }, njs: 18, offset: -0.2, maxLocalNps: 11, dots: 0.0,
  },
};

/** Dichte-Faktor je Abschnittstyp (multipliziert die Ziel-Dichte) */
export const SECTION_DENSITY: Record<SectionType, number> = {
  intro: 0.4, verse: 0.62, buildup: 0.85, drop: 1.6, breakdown: 0.32, outro: 0.4,
};

/** Muster-Vorliebe je Abschnitt (multipliziert die Schwierigkeits-Gewichte) */
export const SECTION_PATTERNS: Record<SectionType, Partial<Record<PatternName, number>>> = {
  intro: { simple: 3, stair: 1 },
  verse: { simple: 2, stair: 2, stream: 1, windmill: 1 },
  buildup: { stream: 3, stair: 1, burst: 2 },
  drop: { stream: 2, doubles: 3, cross: 2, windmill: 2, burst: 1, slider: 1 },
  breakdown: { simple: 3, stair: 2 },
  outro: { simple: 3, stair: 1 },
};

/** Reihen-Verteilung (0 unten, 1 Mitte, 2 oben): Wahrscheinlichkeiten je Schlagart, nur wenn genug Zeit ist */
export const ROWS = {
  foreTop: 0.18, foreMid: 0.22,      // Vorhand (Schlag nach unten): beginnt gern oben/mittig
  backMid: 0.3, backTop: 0.06,     // Rueckhand (Schlag nach oben)
  minGapMid: 0.22, minGapTop: 0.3, // Mindestabstand (s) zur vorigen Note DERSELBEN Hand, damit sie hinkommt
  maxJumpFast: 1,                  // bei schneller Folge hoechstens 1 Reihe Sprung derselben Hand
  fastGap: 0.35,
};

export const MAPPING = {
  /** Gewichte der Baender fuer die Salienz eines Rasterpunkts */
  bandSalience: { sub: 1.0, lowmid: 0.55, highmid: 0.8, high: 0.35 } as Record<Band, number>,
  /** Bonus nach metrischer Position: Downbeat, Beat, 1/2, 1/4, Rest */
  metric: { downbeat: 0.5, beat: 0.3, half: 0.12, quarter: 0.0, other: -0.1 },
  /** Melodie-Gewicht (fliessende Passagen) */
  melody: 0.25,
  /** Zeit ohne Noten vor einem Drop (Beats) */
  dropPause: 1,
  /** Parity-Reset: nach so viel Zeit darf eine Hand dieselbe Richtung wiederholen (s) */
  resetTime: 1.6,
  /** Wand: Mindest-Vorlaufzeit ohne Noten in der Wandspalte (s) */
  wallLead: 0.6,
};
