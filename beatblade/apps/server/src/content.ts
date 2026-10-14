// Inhalts-Ordner: Bloecke, Schwerter, Farben, Maps, Wand-Skins.
// Jedes Element ist ein Ordner <kategorie>/<name>/ mit info.json und optional Dateien (Vorschaubild, .glb-Modell ...).
// Gelesen werden zuerst die mitgelieferten Inhalte (content/), danach <DATA_DIR>/content im Daten-Volume.
// Gleiche Kategorie + Ordnername ueberschreibt den mitgelieferten Eintrag. Neue Ordner: Server neu starten.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const CONTENT_KINDS = ['blocks', 'sabers', 'colors', 'maps', 'walls'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Ordnernamen: klein, Ziffern, - und _ (werden Teil der URL) */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** Dateien, die ausgeliefert werden duerfen */
export const CONTENT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2',
};
/** Felder in info.json, die auf eine Datei im Ordner zeigen und als URL ausgeliefert werden */
const FILE_FIELDS = ['preview', 'model'] as const;

export interface ContentItem {
  kind: ContentKind;
  id: string;
  name: string;
  description: string;
  /** uebrige Felder aus info.json (Stil, Farben, Wand-Skin ...) */
  data: Record<string, unknown>;
  /** ausgelieferte Dateien des Ordners (Dateiname -> URL-Pfad relativ zu /api) */
  files: Record<string, string>;
  /** Vorschaubild / Modell als URL-Pfad relativ zu /api, falls vorhanden */
  preview?: string;
  model?: string;
  source: 'builtin' | 'custom';
}

interface Entry { item: ContentItem; dir: string }

const BUILTIN_DIR = path.resolve(config.contentDir);
const CUSTOM_DIR = path.join(config.dataDir, 'content');

function readKind(root: string, kind: ContentKind, source: ContentItem['source'], into: Map<string, Entry>) {
  const kindDir = path.join(root, kind);
  if (!fs.existsSync(kindDir)) return;
  for (const id of fs.readdirSync(kindDir).sort()) {
    const dir = path.join(kindDir, id);
    const file = path.join(dir, 'info.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(file)) continue;
    if (!ID_RE.test(id)) { console.warn(`content: Ordnername "${kind}/${id}" ungueltig (nur a-z, 0-9, - und _)`); continue; }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('kein JSON-Objekt');
      const { name, description, ...data } = raw as Record<string, unknown>;
      const files: Record<string, string> = {};
      for (const f of fs.readdirSync(dir)) {
        if (CONTENT_MIME[path.extname(f).toLowerCase()] && fs.statSync(path.join(dir, f)).isFile()) files[f] = `/content/${kind}/${id}/${encodeURIComponent(f)}`;
      }
      const item: ContentItem = {
        kind, id, source, data, files,
        name: typeof name === 'string' && name.trim() ? name.trim() : id,
        description: typeof description === 'string' ? description : '',
      };
      for (const k of FILE_FIELDS) {
        const v = data[k];
        if (typeof v !== 'string') continue;
        if (files[v]) item[k] = files[v];
        else console.warn(`content: ${kind}/${id}: Datei "${v}" (${k}) fehlt`);
      }
      into.set(`${kind}/${id}`, { item, dir });
    } catch (e) {
      // kaputte Datei: ueberspringen statt den Server zu stoppen
      console.warn(`content: ${file} ungueltig (${(e as Error).message})`);
    }
  }
}

let cache: Map<string, Entry> | null = null;

function load(): Map<string, Entry> {
  if (cache) return cache;
  const map = new Map<string, Entry>();
  for (const kind of CONTENT_KINDS) readKind(BUILTIN_DIR, kind, 'builtin', map);
  for (const kind of CONTENT_KINDS) readKind(CUSTOM_DIR, kind, 'custom', map);
  cache = map;
  return map;
}

/** alle Inhalte */
export function loadContent(): ContentItem[] { return [...load().values()].map((e) => e.item); }

/** neu einlesen (z. B. nach dem Hinzufuegen von Ordnern) */
export function reloadContent(): ContentItem[] { cache = null; return loadContent(); }

/** Liste fuer die API, gruppiert nach Kategorie; mitgelieferte zuerst */
export function contentByKind(): Record<ContentKind, ContentItem[]> {
  const out = Object.fromEntries(CONTENT_KINDS.map((k) => [k, [] as ContentItem[]])) as Record<ContentKind, ContentItem[]>;
  for (const item of loadContent()) out[item.kind].push(item);
  // Reihenfolge: mitgelieferte zuerst, dann Feld "order" aus info.json, dann Name
  const ord = (i: ContentItem) => (typeof i.data.order === 'number' ? i.data.order : 999);
  for (const k of CONTENT_KINDS) out[k].sort((a, b) => (a.source !== b.source ? (a.source === 'builtin' ? -1 : 1) : ord(a) - ord(b) || a.name.localeCompare(b.name)));
  return out;
}

/** absoluter Pfad einer Datei eines Elements – nur Dateien, die beim Einlesen gelistet wurden (kein Pfad-Ausbruch) */
export function contentFile(kind: string, id: string, file: string): string | null {
  const e = load().get(`${kind}/${id}`);
  if (!e || !Object.prototype.hasOwnProperty.call(e.item.files, file)) return null;
  return path.join(e.dir, file);
}
