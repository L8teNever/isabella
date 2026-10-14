// Inhalts-Ordner: Blöcke, Schwerter, Farben, Maps, Wand-Skins.
// Jedes Element ist ein Ordner mit info.json. Gelesen werden zuerst die mitgelieferten Inhalte (content/),
// danach der Ordner im Daten-Volume (<DATA_DIR>/content). Gleiche Kategorie + Ordnername ueberschreibt
// den mitgelieferten Eintrag.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const CONTENT_KINDS = ['blocks', 'sabers', 'colors', 'maps', 'walls'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export interface ContentItem {
  kind: ContentKind;
  id: string;
  name: string;
  description: string;
  /** alle Felder aus info.json (Stil, Farben, Wand-Skin ...) */
  data: Record<string, unknown>;
  /** 'builtin' oder 'custom' (Daten-Volume) */
  source: 'builtin' | 'custom';
}

const BUILTIN_DIR = path.resolve(config.contentDir);
const CUSTOM_DIR = path.join(config.dataDir, 'content');

function readKind(root: string, kind: ContentKind, source: ContentItem['source'], into: Map<string, ContentItem>) {
  const dir = path.join(root, kind);
  if (!fs.existsSync(dir)) return;
  for (const id of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, id, 'info.json');
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : id;
      const description = typeof data.description === 'string' ? data.description : '';
      const { name: _n, description: _d, ...rest } = data;
      into.set(`${kind}/${id}`, { kind, id, name, description, data: rest, source });
    } catch (e) {
      // kaputte Datei: ueberspringen statt den Server zu stoppen
      console.warn(`content: ${file} ungueltig (${(e as Error).message})`);
    }
  }
}

let cache: ContentItem[] | null = null;

/** alle Inhalte laden (beim ersten Aufruf und nach reloadContent) */
export function loadContent(): ContentItem[] {
  if (cache) return cache;
  const map = new Map<string, ContentItem>();
  for (const kind of CONTENT_KINDS) readKind(BUILTIN_DIR, kind, 'builtin', map);
  for (const kind of CONTENT_KINDS) readKind(CUSTOM_DIR, kind, 'custom', map);
  cache = [...map.values()];
  return cache;
}

/** nach dem Hinzufuegen neuer Ordner (ohne Neustart) neu einlesen */
export function reloadContent(): ContentItem[] { cache = null; return loadContent(); }

/** Liste fuer die API, gruppiert nach Kategorie */
export function contentByKind(): Record<ContentKind, ContentItem[]> {
  const out = Object.fromEntries(CONTENT_KINDS.map((k) => [k, [] as ContentItem[]])) as Record<ContentKind, ContentItem[]>;
  for (const item of loadContent()) out[item.kind].push(item);
  return out;
}
