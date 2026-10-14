// Spieler-Einstellungen (lokal im Geraet gespeichert)
import type { Difficulty } from '@beatblade/core';

export interface Settings {
  latencyMs: number;          // manuelle/kalibrierte Audio-Verzoegerung
  saberOffsetCm: number;      // Griff-Verschiebung nach vorn
  saberAngle: number;         // Neigung in Grad (positiv = nach unten)
  playerHeight: number;       // Meter
  volume: number;             // 0..1
  lightIntensity: number;     // 0..1
  leftHanded: boolean;
  comfort: boolean;           // weniger Blitze/Bewegung
  showFps: boolean;
  name: string;
  difficulty: Difficulty;
  noFail: boolean; fastNotes: boolean; noWalls: boolean; noBombs: boolean;
  floorOffset: number;        // MR: Bodenkorrektur (m)
}

const KEY = 'beatblade-settings';
export const DEFAULTS: Settings = {
  latencyMs: 0, saberOffsetCm: 0, saberAngle: 0, playerHeight: 1.75, volume: 0.9, lightIntensity: 0.8,
  leftHanded: false, comfort: false, showFps: false, name: 'Spieler', difficulty: 'normal',
  noFail: false, fastNotes: false, noWalls: false, noBombs: false, floorOffset: 0,
};

export const settings: Settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
})();

export function saveSettings(): void { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* privat/voll */ } }

export function modifiersLabel(s: Settings = settings): string {
  return [s.noFail && 'NF', s.fastNotes && 'FN', s.noWalls && 'NW', s.noBombs && 'NB'].filter(Boolean).join(',');
}
