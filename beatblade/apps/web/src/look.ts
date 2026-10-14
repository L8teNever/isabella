// Aussehen aus den Inhalts-Ordnern (content/): Farbsets – spaeter auch Bloecke, Schwerter, Maps, Waende.
// Faellt auf die eingebauten Werte zurueck, wenn der Server nichts liefert.
import * as THREE from 'three';
import { api, type ContentList } from './api';
import { COLORS } from './game/layout';
import { settings } from './settings';

export interface ColorSet { id: string; name: string; left: number; right: number }

/** Schritt fuer die freie Farbwahl (Grad Farbton pro Klick) */
export const HUE_STEP = 20;

const BUILTIN: ColorSet = { id: 'klassisch', name: 'Klassisch', left: COLORS.left, right: COLORS.right };
let content: ContentList | null = null;

/** Inhalte vom Server holen (einmal beim Start) */
export async function loadLook(): Promise<void> {
  try { content = await api.content(); } catch { content = null; }
}

const hex = (v: unknown): number | null => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? parseInt(v.slice(1), 16) : null);
export const toHex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** alle gueltigen Farbsets (eingebaut zuerst) */
export function colorSets(): ColorSet[] {
  const list: ColorSet[] = [];
  for (const it of content?.colors ?? []) {
    const l = hex(it.data.left), r = hex(it.data.right);
    if (l !== null && r !== null) list.push({ id: it.id, name: it.name, left: l, right: r });
  }
  return list.length ? list : [BUILTIN];
}

export function currentSet(): ColorSet {
  const sets = colorSets();
  return sets.find((s) => s.id === settings.colorSet) ?? sets[0];
}

/** Farben links/rechts: eigene Wahl vor Farbset */
export function colorPair(): [number, number] {
  const s = currentSet();
  return [hex(settings.colorLeft) ?? s.left, hex(settings.colorRight) ?? s.right];
}

/** Farbton drehen (freie Farbwahl), Helligkeit/Saettigung bleiben */
export function shiftHue(c: number, deg: number): number {
  const col = new THREE.Color(c), hsl = { h: 0, s: 0, l: 0 };
  col.getHSL(hsl);
  // Graustufen bekommen beim ersten Drehen Farbe
  if (hsl.s < 0.15) { hsl.s = 0.85; hsl.l = Math.min(0.65, Math.max(0.45, hsl.l)); }
  col.setHSL((((hsl.h * 360 + deg) % 360) + 360) % 360 / 360, hsl.s, hsl.l);
  return col.getHex();
}
