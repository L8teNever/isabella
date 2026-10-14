// Combo-Effekte: je laenger die Trefferserie, desto staerker Leuchten, Funken und Lichtshow.
// Ein Fehler (verpasst, Fehlschlag, Bombe, Wand) beendet die Combo sofort.

/** ab dieser Combo sind die Effekte auf voller Staerke */
export const COMBO_FULL = 50;
/** Meilensteine mit grosser Einblendung, Ton und Vibration */
export const COMBO_MILESTONES = [10, 25, 50, 75, 100, 150, 200, 300, 400, 500];
/** ab dieser Combo wird "Combo vorbei" angezeigt, wenn sie reisst */
export const COMBO_BREAK_MIN = 5;

/** Effekt-Staerke 0..1 */
export const comboLevel = (combo: number) => Math.min(1, combo / COMBO_FULL);

/** Farbe je Stufe: weiss -> tuerkis -> gold -> pink */
export function comboColor(combo: number): string {
  if (combo >= 100) return '#ff5fa2';
  if (combo >= 50) return '#ffd23c';
  if (combo >= 25) return '#4be3e0';
  if (combo >= 10) return '#9fd8ff';
  return '#ffffff';
}
