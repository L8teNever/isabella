// Audio-Erkennung per Magic Bytes, ID3/Tag-Auslesen, Cover speichern, Dekodieren mit ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseFile } from 'music-metadata';
import { config } from './config.js';
import { songDir, removeCovers } from './files.js';

export type AudioKind = 'mp3' | 'm4a' | 'ogg' | 'flac' | 'wav';

/** Format aus den ersten Bytes erkennen (nicht aus der Dateiendung) */
export function sniff(head: Buffer): AudioKind | null {
  if (head.length < 12) return null;
  const s = (a: number, b: number) => head.subarray(a, b).toString('latin1');
  if (s(0, 3) === 'ID3') return 'mp3';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0) return 'mp3';   // MPEG-Frame-Sync, Layer != 0
  if (s(4, 8) === 'ftyp') return 'm4a';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  return null;
}

export interface Tags { title: string; artist: string; album: string; duration: number; cover: { data: Uint8Array; format: string } | null }

/** Titel/Artist aus dem Dateinamen ableiten ("Artist - Titel.mp3") */
export function fromFileName(name: string): { title: string; artist: string } {
  const base = path.basename(name).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base || 'Unbekannter Titel' };
}

export async function readTags(file: string, originalName: string): Promise<Tags> {
  const fallback = fromFileName(originalName);
  try {
    const mm = await parseFile(file, { duration: true, skipCovers: false });
    const pic = mm.common.picture?.[0];
    return {
      title: mm.common.title?.trim() || fallback.title,
      artist: mm.common.artist?.trim() || mm.common.albumartist?.trim() || fallback.artist,
      album: mm.common.album?.trim() || '',
      duration: mm.format.duration || 0,
      cover: pic ? { data: pic.data, format: pic.format } : null,
    };
  } catch {
    return { ...fallback, album: '', duration: 0, cover: null };
  }
}

export function saveCover(id: string, data: Uint8Array, mime: string): void {
  const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : 'jpg';
  removeCovers(id);
  fs.writeFileSync(path.join(songDir(id), `cover.${ext}`), data);
}

/** Bildformat per Magic Bytes */
export function sniffImage(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Dekodieren zu PCM 44,1 kHz Mono Float32 mit ffmpeg (asynchron, blockiert den Server nicht).
 * onProgress bekommt 0..1 anhand der von ffmpeg gemeldeten Zeit.
 */
export function decode(file: string, duration: number, onProgress?: (p: number) => void): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', '-progress', 'pipe:2', 'pipe:1']);
    const chunks: Buffer[] = []; let size = 0, err = '';
    p.stdout.on('data', (c: Buffer) => { chunks.push(c); size += c.length; if (size > 1.5e9) p.kill(); });
    p.stderr.on('data', (c: Buffer) => {
      const s = c.toString(); err = (err + s).slice(-4000);
      const m = s.match(/out_time_ms=(\d+)/); if (m && duration > 0 && onProgress) onProgress(Math.min(1, +m[1] / 1e6 / duration));
    });
    p.on('error', (e) => reject(new Error(`ffmpeg nicht gefunden: ${e.message}`)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Datei konnte nicht dekodiert werden (ffmpeg ${code}): ${err.split('\n').filter((l) => /error|invalid/i.test(l)).slice(-2).join(' ') || 'unbekannter Fehler'}`));
      const buf = Buffer.concat(chunks, size);
      // eigenes ArrayBuffer (ausgerichtet), damit es an den Worker uebergeben werden kann
      const ab = new ArrayBuffer(buf.length - (buf.length % 4));
      new Uint8Array(ab).set(buf.subarray(0, ab.byteLength));
      resolve(new Float32Array(ab));
    });
  });
}
