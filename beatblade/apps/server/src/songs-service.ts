// Songs anlegen (Upload und mitgelieferte Songs)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { q, getSong, logSong } from './db.js';
import { songDir, audioPath } from './files.js';
import { readTags, saveCover, sniff } from './media.js';
import { enqueue } from './queue.js';
import { songChanged } from './events.js';
import type { Song } from '@beatblade/core';

export async function hashFile(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await new Promise<void>((res, rej) => fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => res()).on('error', rej));
  return h.digest('hex');
}

export interface ImportResult { song: Song; duplicate: boolean }

/** Datei (bereits auf der Platte) als Song uebernehmen. Die Datei wird verschoben. */
export async function importFile(tmpFile: string, originalName: string, hash: string, opts: { bundled?: boolean; license?: string; source?: string; title?: string; artist?: string } = {}): Promise<ImportResult> {
  const existing = q.songByHash.get(hash) as { id: string } | undefined;
  if (existing) { fs.rmSync(tmpFile, { force: true }); return { song: getSong(existing.id)!, duplicate: true }; }
  const fd = fs.openSync(tmpFile, 'r'); const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
  const kind = sniff(head);
  if (!kind) { fs.rmSync(tmpFile, { force: true }); throw Object.assign(new Error('Kein unterstütztes Audioformat (MP3, M4A, OGG, FLAC, WAV).'), { statusCode: 415 }); }
  const id = crypto.randomBytes(6).toString('base64url');
  fs.mkdirSync(songDir(id), { recursive: true });
  fs.renameSync(tmpFile, audioPath(id, kind));
  const tags = await readTags(audioPath(id, kind), originalName);
  if (tags.cover) saveCover(id, tags.cover.data, tags.cover.format);
  q.insertSong.run({
    id, title: opts.title || tags.title, artist: opts.artist || tags.artist, album: tags.album, duration: tags.duration,
    bundled: opts.bundled ? 1 : 0, has_cover: tags.cover ? 1 : 0, now: Date.now(), hash, file_name: originalName, ext: kind,
    license: opts.license ?? null, source: opts.source ?? null,
  });
  logSong(id, `Hochgeladen: ${originalName} (${kind}, ${(fs.statSync(audioPath(id, kind)).size / 1e6).toFixed(1)} MB)`);
  songChanged(getSong(id));
  enqueue(id, 'full');
  return { song: getSong(id)!, duplicate: false };
}
