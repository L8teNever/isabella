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
  fastNotes: boolean; noWalls: boolean; noBombs: boolean;
  /** Pfeile: 'pflicht' = Schlagrichtung wird geprueft, 'egal' = jeder saubere Schnitt zaehlt */
  arrows: 'pflicht' | 'egal';
  /** Verfehlt = stumm: an verfehlten Bloecken setzt die Musik kurz aus */
  missMute: boolean;
  /** Leuchten (Halos, Bodenlicht) – auf schwacher Hardware abschaltbar */
  glow: boolean;
  /** Farbset (Ordnername in content/colors) und eigene Farben links/rechts (#rrggbb, null = aus dem Set) */
  colorSet: string; colorLeft: string | null; colorRight: string | null;
  /** Block-Skin (Ordnername in content/blocks) */
  blockSkin: string;
  /** Schwert (Ordnername in content/sabers) */
  saberSkin: string;
  /** Schwert der rechten Hand ('' = wie links / saberSkin) */
  saberSkinRight: string;
  /** Map (Ordnername in content/maps) oder 'zufall'; Wand-Skin oder 'auto' (passend zur Map) */
  mapChoice: string; wallSkin: string;
  floorOffset: number;        // MR: Bodenkorrektur (m)
  /** Orbit: Handkugel (content/orbs) und Notenkugeln (content/orbnotes) */
  orbSkin: string; orbNoteSkin: string;
  /** zuletzt gespielter Spielmodus (gilt fuer alle Songs) */
  gameMode: 'schnitt' | 'orbit';
  /** Duett: Noten der anderen Stimme halbtransparent auf der Partnerspur zeigen */
  partnerNotes: boolean;
  /** Duett: Treffer und Fehler des Partners hoeren (0 = aus) */
  partnerVolume: number;
}

const KEY = 'beatblade-settings';
export const DEFAULTS: Settings = {
  latencyMs: 0, saberOffsetCm: 0, saberAngle: 0, playerHeight: 1.75, volume: 0.9, lightIntensity: 0.8,
  leftHanded: false, comfort: false, showFps: false, name: 'Spieler', difficulty: 'normal',
  fastNotes: false, noWalls: false, noBombs: false, arrows: 'pflicht', missMute: false, glow: true, colorSet: 'klassisch', colorLeft: null, colorRight: null, blockSkin: 'neon', saberSkin: 'lichtschwert', saberSkinRight: '', mapChoice: 'neon-laufsteg', wallSkin: 'auto', floorOffset: 0, gameMode: 'schnitt', orbSkin: 'leuchten', orbNoteSkin: 'neon-kugel', partnerNotes: true, partnerVolume: 0.8,
};

const SETTINGS_V = 2;
export const settings: Settings = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    delete stored.noFail;            // gibt es nicht mehr (kein Game Over)
    return { ...DEFAULTS, ...stored };
  } catch { return { ...DEFAULTS }; }
})();

export function saveSettings(): void { try { localStorage.setItem(KEY, JSON.stringify({ ...settings, v: SETTINGS_V })); } catch { /* privat/voll */ } }

export function modifiersLabel(s: Settings = settings): string {
  return [s.arrows === 'egal' && 'PE', s.fastNotes && 'FN', s.noWalls && 'NW', s.noBombs && 'NB'].filter(Boolean).join(',');
}
