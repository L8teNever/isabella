// YouTube-/SoundCloud-Link -> Tonspur -> normaler Song-Import (Analyse wie beim Upload); SoundCloud-Suche.
// yt-dlp wird nur mit festen Argumenten aufgerufen (kein Shell-Aufruf); Links werden geprueft und als
// kanonische URL weitergegeben. Downloads laufen nacheinander.
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

// SoundCloud: nur einzelne Tracks (soundcloud.com/<kuenstler>/<track>), keine Profile-Reiter oder Playlists
const SC_RE = /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;
const SC_NOT_TRACK = new Set(['tracks', 'sets', 'likes', 'reposts', 'albums', 'popular-tracks', 'followers', 'following', 'comments', 'spotlight']);
export function soundcloudUrl(url: string): string | null {
  const m = SC_RE.exec(url.trim());
  if (!m || SC_NOT_TRACK.has(m[2])) return null;
  return `https://soundcloud.com/${m[1]}/${m[2]}`;
}

/** Link pruefen: kanonische URL + Quelle */
function parseSource(url: string): { kind: 'youtube' | 'soundcloud'; url: string } | null {
  const yt = youtubeId(url);
  if (yt) return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${yt}` };
  const sc = soundcloudUrl(url);
  return sc ? { kind: 'soundcloud', url: sc } : null;
}

// ---------- SoundCloud-Suche ----------
export interface ScResult { url: string; title: string; artist: string; duration: number; cover: string | null }
const searchCache = new Map<string, { at: number; list: ScResult[] }>();
export function searchSoundcloud(query: string): Promise<ScResult[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!q) return Promise.resolve([]);
  const hit = searchCache.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return Promise.resolve(hit.list);
  return new Promise((resolve, reject) => {
    execFile(config.ytdlp, ['--no-warnings', '--flat-playlist', '-J', `scsearch24:${q}`], { timeout: 45000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(new Error('SoundCloud-Suche fehlgeschlagen.'));
      try {
        const entries = (JSON.parse(out).entries ?? []) as Record<string, unknown>[];
        const list: ScResult[] = [];
        for (const e of entries) {
          const url = soundcloudUrl(String(e.webpage_url ?? ''));
          if (!url) continue;
          const thumbs = (e.thumbnails as { id?: string; url?: string }[] | undefined) ?? [];
          const cover = thumbs.find((t) => t.id === 't300x300')?.url ?? thumbs.find((t) => t.id === 'large')?.url ?? null;
          list.push({ url, title: String(e.title ?? ''), artist: String(e.uploader ?? ''), duration: Number(e.duration ?? 0), cover: cover && /^https:\/\/[a-z0-9.-]*sndcdn\.com\//.test(cover) ? cover : null });
        }
        searchCache.set(q.toLowerCase(), { at: Date.now(), list });
        if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value!);
        resolve(list);
      } catch { reject(new Error('SoundCloud-Suche: unerwartete Antwort.')); }
    });
  });
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
  if (/go\+|subscri|preview/i.test(stderr)) return 'Track nur mit SoundCloud Go+ verfügbar – kann nicht geladen werden.';
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
const queue: { job: string; kind: 'youtube' | 'soundcloud'; url: string }[] = [];
let busy = false;

export function queueYoutube(url: string): { job: string } | { error: string } {
  const src = parseSource(url);
  if (!src) return { error: 'Kein gültiger Link (YouTube-Video oder SoundCloud-Track).' };
  if (queue.length >= 10) return { error: 'Zu viele Downloads in der Warteschlange – kurz warten.' };
  const job = crypto.randomBytes(6).toString('hex');
  queue.push({ job, kind: src.kind, url: src.url });
  send({ job, state: 'warten' });
  void pump();
  return { job };
}

async function pump() {
  if (busy) return;
  busy = true;
  try { for (let j = queue.shift(); j; j = queue.shift()) await run(j.job, j.kind, j.url); } finally { busy = false; }
}

function run(job: string, kind: 'youtube' | 'soundcloud', url: string): Promise<void> {
  const yt = kind === 'youtube';
  return new Promise((resolve) => {
    const dir = path.join(tmpDir(), `yt-${job}`); fs.mkdirSync(dir, { recursive: true });
    const args = [
      '--no-playlist', '--no-warnings', '--newline', '--no-simulate', '--restrict-filenames',
      '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '2',
      '--embed-thumbnail', '--convert-thumbnails', 'jpg', '--embed-metadata',
      '--max-filesize', `${config.maxUploadMb}M`, '--match-filter', `duration <= ${config.ytMaxMinutes * 60}`,
      // nur ein echter Pfad (z. B. /usr/bin/ffmpeg); ein blosser Name wird von yt-dlp als Ordner verstanden -> PATH nutzen
      ...(config.ffmpeg.includes('/') ? ['--ffmpeg-location', config.ffmpeg] : []),
      '--progress-template', 'download:PROG %(progress._percent_str)s',
      '--print', 'before_dl:META %(title)s\t%(uploader|)s\t%(track|)s\t%(artist|)s',
      '--print', 'after_move:FILE %(filepath)s',
      '-o', path.join(dir, '%(id)s.%(ext)s'),
      ...(yt && jsRuntime ? ['--js-runtimes', 'node'] : []),
      ...(yt && fs.existsSync(cookiesFile()) ? ['--cookies', cookiesFile()] : []),
      url,
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
        const r = await importFile(file, `${names.title}.mp3`, await hashFile(file), { title: names.title, artist: names.artist, source: url });
        send({ job, state: 'fertig', song: r.song, duplicate: r.duplicate, title: names.title });
      } catch (e) {
        send({ job, state: 'fehler', message: (e as Error).message, title: meta.title });
      } finally { cleanup(); resolve(); }
    });
  });
}
