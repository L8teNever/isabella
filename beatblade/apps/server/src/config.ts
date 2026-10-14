// Konfiguration aus Umgebungsvariablen (siehe .env.example)
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? +v : d);
/** Wurzel des Repos (aus dist/ oder src/ gleich tief: apps/server/{src,dist} -> beatblade) */
function repoRoot() { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'); }
const base = (env.BASE_PATH || '').replace(/\/+$/, '');

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  /** Unterpfad, unter dem die App laeuft (z. B. /beatblade), leer = Wurzel */
  basePath: base && !base.startsWith('/') ? '/' + base : base,
  dataDir: path.resolve(env.DATA_DIR || './data'),
  seedDir: path.resolve(env.SEED_DIR || './seed-songs'),
  webDir: path.resolve(env.WEB_DIR || '../web/dist'),
  /** mitgelieferte Inhalte (Blöcke, Schwerter, Farben, Maps, Wände) */
  contentDir: path.resolve(env.CONTENT_DIR || path.join(repoRoot(), 'content')),
  /** open | password | cloudflare */
  authMode: (env.AUTH_MODE || 'open') as 'open' | 'password' | 'cloudflare',
  password: env.APP_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || 'bitte-aendern',
  maxUploadMb: num(env.MAX_UPLOAD_MB, 50),
  uploadsPerMinute: num(env.UPLOADS_PER_MINUTE, 20),
  concurrency: Math.max(1, num(env.CONCURRENCY, Math.max(1, os.cpus().length - 1))),
  /** oeffentliche Adresse (fuer den QR-Code im Headset) */
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  importSeeds: env.IMPORT_SEEDS !== 'false',
};
