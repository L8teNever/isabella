// Lichtshow aus der Analyse:
//  - Flash auf starken Kicks (begrenzte Rate)
//  - Farbwechsel an Abschnittsgrenzen (Palette je Abschnittstyp)
//  - Laser-Rotation pro Takt nach Energie
//  - Explosion (burst) auf dem ersten Schlag eines Drops, kurz davor Licht aus
import type { LightEvent, Note, SongAnalysis, SectionType } from '../types.js';

/** Paletten-Index je Abschnitt (das Spiel definiert die Farben) */
export const SECTION_PALETTE: Record<SectionType, number> = { intro: 0, verse: 1, buildup: 2, drop: 3, breakdown: 4, outro: 0 };

export function lightShow(a: SongAnalysis, notes: Note[]): LightEvent[] {
  const ev: LightEvent[] = [];
  let lastFlash = -1;
  for (const o of a.onsets.sub) {
    if (o.s < 0.45 || o.t - lastFlash < 0.14) continue;
    ev.push({ t: o.t, type: 'flash', v: Math.round(Math.min(1, o.s) * 100) / 100 });
    lastFlash = o.t;
  }
  a.sections.forEach((s, i) => {
    ev.push({ t: s.start, type: 'color', v: SECTION_PALETTE[s.type] });
    if (s.type === 'drop' && (i === 0 || a.sections[i - 1].type !== 'drop')) {
      ev.push({ t: Math.max(0, s.start - 0.35), type: 'off', v: 0 });
      ev.push({ t: s.start, type: 'burst', v: 1 });
    }
  });
  a.bars.forEach((t, k) => ev.push({ t, type: 'laser', v: Math.round((a.barEnergy[k] ?? 0) * 100) / 100 }));
  void notes;
  return ev.sort((x, y) => x.t - y.t);
}
