// YouTube-Link -> Tonspur -> normaler Song-Import (Analyse wie beim Upload).
// yt-dlp wird nur mit festen Argumenten aufgerufen (kein Shell-Aufruf); der Link wird auf eine Video-ID
// geprueft und als kanonische URL weitergegeben. Downloads laufen nacheinander.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { config } from './config.js';
import { tmpDir } from './files.js';
import { hashFile, importFile } from './songs-service.js';
import { broadcast } from './events.js';
import type { Song } from '@beatblade/core';

/** YouTube-Cookies (Netscape-Format, z. B. per Browser-Erweiterung exportiert): helfen gegen die Bot-Pruefung */
export const cookiesFile = () => path.join(config.dataDir, 'youtube-cookies.txt');

const ID_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#/].*)?$/;

/** Video-ID aus einem YouTube-Link, sonst null */
export function youtubeId(url: string): string | null {
  const m = ID_RE.exec(url.trim());
  return m ? m[1] : null;
}

export interface YtStatus { job: string; state: 'warten' | 'laden' | 'umwandeln' | 'import' | 'fertig' | 'fehler'; percent?: number; message?: string; song?: Song; duplicate?: boolean; title?: string }
const send = (s: YtStatus) => broadcast('yt', s);

// ---------- yt-dlp: Faehigkeiten und Aktualisierung ----------
let jsRuntime = false;
/** beim Start: yt-dlp aktualisieren (YouTube aendert sich oft) und pruefen, ob es Node als JS-Laufzeit nutzen kann */
export function initYoutube(log: (m: string) => void): void {
  const check = () => execFile(config.ytdlp, ['--help'], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
    if (err) { log(`yt-dlp nicht verfügbar (${err.message}) – YouTube-Import aus`); return; }
    jsRuntime = out.includes('--js-runtimes');
  });
  const update = () => execFile(config.ytdlp, ['-U'], { timeout: 120000 }, (err, out) => { log(`yt-dlp Update: ${(err?.message || out || '').trim().split('\n').pop()}`); check(); });
  update();
  setInterval(update, 24 * 3600 * 1000).unref();
}

/** Titel/Artist aus "Artist - Titel (Official Video)" */
function splitTitle(raw: string, uploader: string): { title: string; artist: string } {
  const clean = (s: string) => s.replace(/\s*[([](official|offizielles|lyric|lyrics|audio|video|music video|hd|4k|visualizer|clip)[^)\]]*[)\]]/gi, '').replace(/\s+/g, ' ').trim();
  const m = raw.split(/\s+[-–—]\s+/);
  if (m.length >= 2) return { artist: clean(m[0]), title: clean(m.slice(1).join(' - ')) };
  return { title: clean(raw), artist: uploader.replace(/\s*-\s*Topic$/i, '').trim() };
}

function friendly(stderr: string): string {
  if (/sign in to confirm|not a bot/i.test(stderr)) return fs.existsSync(cookiesFile())
    ? 'YouTube blockiert trotz Cookies (Bot-Prüfung) – Cookies sind evtl. abgelaufen, bitte neu hinterlegen.'
    : 'YouTube verlangt eine Anmeldung (Bot-Prüfung). Bitte YouTube-Cookies hinterlegen (Bibliothek → YouTube-Cookies).';
  if (/does not pass filter|duration/i.test(stderr)) return `Video ist zu lang (max. ${config.ytMaxMinutes} Minuten).`;
  if (/larger than max-filesize|File is larger/i.test(stderr)) return `Datei zu groß (max. ${config.maxUploadMb} MB).`;
  if (/private video|video unavailable|not available|removed/i.test(stderr)) return 'Video nicht verfügbar (privat, gelöscht oder gesperrt).';
  if (/age/i.test(stderr) && /confirm|restricted/i.test(stderr)) return 'Altersbeschränktes Video – kann nicht geladen werden.';
  const last = stderr.trim().split('\n').filter((l) => /ERROR/.test(l)).pop();
  return last ? last.replace(/^.*ERROR:\s*/, '').slice(0, 200) : 'Download fehlgeschlagen.';
}

// ---------- Warteschlange (einer nach dem anderen) ----------
const queue: { job: string; id: string }[] = [];
let busy = false;

export function queueYoutube(url: string): { job: string } | { error: string } {
  const id = youtubeId(url);
  if (!id) return { error: 'Kein gültiger YouTube-Link (youtube.com/watch?v=…, youtu.be/…, Shorts).' };
  if (queue.length >= 10) return { error: 'Zu viele Downloads in der Warteschlange – kurz warten.' };
  const job = crypto.randomBytes(6).toString('hex');
  queue.push({ job, id });
  send({ job, state: 'warten' });
  void pump();
  return { job };
}

async function pump() {
  if (busy) return;
  busy = true;
  try { for (let j = queue.shift(); j; j = queue.shift()) await run(j.job, j.id); } finally { busy = false; }
}

function run(job: string, id: string): Promise<void> {
  return new Promise((resolve) => {
    const dir = path.join(tmpDir(), `yt-${job}`); fs.mkdirSync(dir, { recursive: true });
    const args = [
      '--no-playlist', '--no-warnings', '--newline', '--no-simulate', '--restrict-filenames',
      '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '2',
      '--embed-thumbnail', '--convert-thumbnails', 'jpg', '--embed-metadata',
      '--max-filesize', `${config.maxUploadMb}M`, '--match-filter', `duration <= ${config.ytMaxMinutes * 60}`,
      '--ffmpeg-location', config.ffmpeg,
      '--progress-template', 'download:PROG %(progress._percent_str)s',
      '--print', 'before_dl:META %(title)s\t%(uploader|)s\t%(track|)s\t%(artist|)s',
      '--print', 'after_move:FILE %(filepath)s',
      '-o', path.join(dir, '%(id)s.%(ext)s'),
      ...(jsRuntime ? ['--js-runtimes', 'node'] : []),
      ...(fs.existsSync(cookiesFile()) ? ['--cookies', cookiesFile()] : []),
      `https://www.youtube.com/watch?v=${id}`,
    ];
    const p = spawn(config.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', file = '', meta = { title: '', uploader: '', track: '', artist: '' }, lastPct = -1;
    const timer = setTimeout(() => { err += '\nERROR: Zeitüberschreitung'; p.kill('SIGKILL'); }, 8 * 60 * 1000);
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    let buf = '';
    p.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith('META ')) { const [title, uploader, track, artist] = line.slice(5).split('\t'); meta = { title, uploader, track, artist }; send({ job, state: 'laden', percent: 0, title }); }
        else if (line.startsWith('PROG ')) { const pct = Math.round(parseFloat(line.slice(5))); if (!Number.isNaN(pct) && pct !== lastPct) { lastPct = pct; send({ job, state: 'laden', percent: pct, title: meta.title }); } }
        else if (line.startsWith('FILE ')) file = line.slice(5);
      }
    });
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); if (err.length > 20000) err = err.slice(-10000); if (/ExtractAudio|Destination/.test(c.toString())) send({ job, state: 'umwandeln', title: meta.title }); });
    p.on('error', (e) => { clearTimeout(timer); cleanup(); send({ job, state: 'fehler', message: `yt-dlp nicht verfügbar (${e.message})` }); resolve(); });
    p.on('close', async (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !file || !fs.existsSync(file)) throw new Error(friendly(err));
        send({ job, state: 'import', title: meta.title });
        const names = meta.track ? { title: meta.track, artist: meta.artist || meta.uploader } : splitTitle(meta.title, meta.uploader);
        const r = await importFile(file, `${names.title}.mp3`, await hashFile(file), { title: names.title, artist: names.artist, source: `https://youtu.be/${id}` });
        send({ job, state: 'fertig', song: r.song, duplicate: r.duplicate, title: names.title });
      } catch (e) {
        send({ job, state: 'fehler', message: (e as Error).message, title: meta.title });
      } finally { cleanup(); resolve(); }
    });
  });
}
