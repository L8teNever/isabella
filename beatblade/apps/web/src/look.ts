// Aussehen aus den Inhalts-Ordnern (content/): Farbsets – spaeter auch Bloecke, Schwerter, Maps, Waende.
// Faellt auf die eingebauten Werte zurueck, wenn der Server nichts liefert.
import * as THREE from 'three';
import { api, contentUrl, type ContentItem, type ContentList } from './api';
import { builtinBlock, blockFromModel, type BlockSkin } from './game/blockskins';
import { buildSaberVisual, saberFromModel, type SaberVisual } from './game/sabervisuals';
import { SABER_LEN } from './game/layout';
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

// ---------- Block-Skins ----------
export function blockSkins(): ContentItem[] { return content?.blocks?.length ? content.blocks : []; }
export function currentBlock(): ContentItem | undefined {
  const list = blockSkins();
  return list.find((b) => b.id === settings.blockSkin) ?? list[0];
}
/** Name fuer das Menue */
export const blockName = () => currentBlock()?.name ?? 'Neon-Würfel';

const skinCache = new Map<string, Promise<BlockSkin>>();
/** Form + Material des gewaehlten Skins (Modell wird einmal geladen; Fehler -> eingebauter Stil) */
export function loadBlockSkin(): Promise<BlockSkin> {
  const it = currentBlock();
  const key = it ? `${it.source}/${it.id}` : 'builtin';
  let p = skinCache.get(key);
  if (!p) {
    const style = typeof it?.data.style === 'string' ? it.data.style : 'neon-cube';
    p = it?.model ? blockFromModel(contentUrl(it.model)).then((s) => s ?? builtinBlock(style)) : Promise.resolve(builtinBlock(style));
    skinCache.set(key, p);
  }
  return p;
}

// ---------- Schwerter ----------
export function saberSkins(): ContentItem[] { return content?.sabers?.length ? content.sabers : []; }
export function currentSaber(): ContentItem | undefined {
  const list = saberSkins();
  return list.find((b) => b.id === settings.saberSkin) ?? list[0];
}
export const saberName = () => currentSaber()?.name ?? 'Lichtschwert';

/** Aussehen fuer ein Schwert bauen (pro Hand eigenes Objekt). Klingenlaenge nur optisch, Treffer-Zone bleibt. */
export async function buildSaber(color: number): Promise<SaberVisual> {
  const it = currentSaber();
  const style = typeof it?.data.style === 'string' ? it.data.style : 'classic';
  const len = typeof it?.data.bladeLength === 'number' ? Math.max(0.5, Math.min(1.4, it.data.bladeLength)) : SABER_LEN;
  if (it?.model) { const v = await saberFromModel(contentUrl(it.model), len, color); if (v) return v; }
  return buildSaberVisual(style, len, color);
}

// ---------- Maps und Wand-Skins ----------
export function mapItems(): ContentItem[] { return content?.maps?.length ? content.maps : []; }
export function wallItems(): ContentItem[] { return content?.walls?.length ? content.walls : []; }
const styleOf = (it: ContentItem | undefined, d: string) => (typeof it?.data.style === 'string' ? it.data.style : d);

/** Anzeige im Menue */
export const mapName = () => (settings.mapChoice === 'zufall' ? 'Zufällig' : mapItems().find((m) => m.id === settings.mapChoice)?.name ?? 'Neon-Laufsteg');

/** Map fuer den naechsten Song: gewaehlte oder zufaellige */
export function pickMap(): ContentItem | undefined {
  const list = mapItems();
  if (settings.mapChoice === 'zufall' && list.length) return list[Math.floor(Math.random() * list.length)];
  return list.find((m) => m.id === settings.mapChoice) ?? list[0];
}

/** Wand-Skin: fest gewaehlt oder automatisch der, den die Map in info.json nennt */
export function wallFor(map: ContentItem | undefined): ContentItem | undefined {
  const walls = wallItems();
  if (settings.wallSkin !== 'auto') return walls.find((w) => w.id === settings.wallSkin) ?? walls[0];
  const want = typeof map?.data.wallSkin === 'string' ? map.data.wallSkin : '';
  return walls.find((w) => w.id === want) ?? walls[0];
}
export const wallName = () => (settings.wallSkin === 'auto' ? 'Automatisch (passend zur Map)' : wallItems().find((w) => w.id === settings.wallSkin)?.name ?? 'Neon-Glas');

/** Stil-Namen (eingebaute Darstellungen) */
export const mapStyle = (m: ContentItem | undefined) => styleOf(m, 'neon-runway');
export const wallStyle = (w: ContentItem | undefined) => styleOf(w, 'neon-glass');
