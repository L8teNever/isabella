// Mitgelieferte CC-Songs beim ersten Start importieren (seed-songs/credits.json)
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { q } from './db.js';
import { hashFile, importFile } from './songs-service.js';
import { tmpDir } from './files.js';

export interface Credit { file: string; title: string; artist: string; license: string; licenseUrl: string; source: string; genre?: string; bpm?: number; attribution: string; url?: string }

export function readCredits(): Credit[] {
  try { return JSON.parse(fs.readFileSync(path.join(config.seedDir, 'credits.json'), 'utf8')).songs as Credit[]; } catch { return []; }
}

export async function importSeeds(log: (m: string) => void): Promise<void> {
  if (!config.importSeeds) return;
  for (const c of readCredits()) {
    const src = path.join(config.seedDir, c.file);
    if (!fs.existsSync(src)) { log(`Mitgelieferter Song fehlt: ${c.file}`); continue; }
    const hash = await hashFile(src);
    if (q.songByHash.get(hash)) continue;
    const tmp = path.join(tmpDir(), `seed-${Date.now()}-${path.basename(c.file)}`);
    fs.copyFileSync(src, tmp);
    await importFile(tmp, c.file, hash, { bundled: true, license: `${c.license} – ${c.attribution}`, source: c.source, title: c.title, artist: c.artist });
    log(`Mitgelieferter Song importiert: ${c.title}`);
  }
}
