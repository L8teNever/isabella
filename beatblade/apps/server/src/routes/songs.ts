// REST-API fuer Songs, Upload, Audio (Range), Cover, Beatmaps, Analyse/Wellenform, Log, Highscores.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { DIFFICULTIES, type Difficulty } from '@beatblade/core';
import { config } from '../config.js';
import { queueYoutube, cookiesFile, searchSoundcloud, getScProfile, setScProfile, scCollectionUrl, listSoundcloud, fetchScCover } from '../youtube.js';
import { db, q, getSong, songRow, updateSong, rowToSong, topScores, bestScores, logSong } from '../db.js';
import { songDir, audioPath, coverPath, analysisPath, waveformPath, beatmapPath, tmpDir } from '../files.js';
import { importFile } from '../songs-service.js';
import { enqueue, mapOnDemand } from '../queue.js';
import { songChanged, songDeleted, addClient } from '../events.js';
import { saveCover, sniffImage } from '../media.js';

const MIME: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' };
const isDiff = (d: unknown): d is Difficulty => DIFFICULTIES.includes(d as Difficulty);

export function songRoutes(app: FastifyInstance, api: string): void {
  // ---------- Liste / Einzeln ----------
  app.get(`${api}/songs`, async () => (q.songs.all() as Record<string, unknown>[]).map(rowToSong));
  app.get<{ Params: { id: string } }>(`${api}/songs/:id`, async (req, reply) => getSong(req.params.id) ?? reply.code(404).send({ error: 'Song nicht gefunden' }));

  // ---------- Upload (multipart, mehrere Dateien) ----------
  app.post(`${api}/songs`, { config: { rateLimit: { max: config.uploadsPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    const results: unknown[] = [];
    const parts = req.files({ limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 } });
    for await (const part of parts) {
      const tmp = path.join(tmpDir(), `up-${crypto.randomBytes(8).toString('hex')}`);
      const hash = crypto.createHash('sha256');
      try {
        await pipeline(part.file, new Transform({ transform(c, _e, cb) { hash.update(c); cb(null, c); } }), fs.createWriteStream(tmp));
        if (part.file.truncated) { fs.rmSync(tmp, { force: true }); results.push({ file: part.filename, error: `Datei zu groß (max. ${config.maxUploadMb} MB)` }); continue; }
        const r = await importFile(tmp, part.filename || 'upload', hash.digest('hex'));
        results.push({ file: part.filename, song: r.song, duplicate: r.duplicate });
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        results.push({ file: part.filename, error: (e as Error).message });
      }
    }
    const anyOk = results.some((r) => (r as { song?: unknown }).song);
    return reply.code(anyOk ? 200 : 400).send({ results });
  });

  // ---------- YouTube-Link -> Song (laeuft im Hintergrund, Status per SSE 'yt') ----------
  app.post<{ Body: { url?: string } }>(`${api}/youtube`, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.slice(0, 500) : '';
    const r = queueYoutube(url);
    if ('error' in r) return reply.code(400).send(r);
    return reply.code(202).send(r);
  });

  // SoundCloud durchsuchen (Ergebnisse dann per /youtube-Route mit dem Track-Link hinzufuegen)
  app.get<{ Querystring: { q?: string } }>(`${api}/soundcloud/search`, { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    try { return await searchSoundcloud(String(req.query.q ?? '')); }
    catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });

  // eigenes SoundCloud-Profil (einmal eintragen, dann Likes/Tracks auch in VR)
  app.get(`${api}/soundcloud/profile`, async () => ({ profile: getScProfile() }));
  app.post<{ Body: { profile?: string } }>(`${api}/soundcloud/profile`, async (req, reply) => {
    const p = setScProfile(String(req.body?.profile ?? ''));
    return p ? { profile: p } : reply.code(400).send({ error: 'Kein gültiger Profilname oder Profil-Link (soundcloud.com/<name>).' });
  });
  // Likes, Tracks oder Playlist auflisten: what = 'likes' | 'tracks' | Link
  app.get<{ Querystring: { what?: string } }>(`${api}/soundcloud/list`, { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const url = scCollectionUrl(String(req.query.what ?? 'likes').slice(0, 300), getScProfile());
    if (!url) return reply.code(400).send({ error: getScProfile() ? 'Kein gültiger SoundCloud-Profil- oder Playlist-Link.' : 'Bitte zuerst dein SoundCloud-Profil eintragen.' });
    try { return { url, items: await listSoundcloud(url) }; }
    catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });
  // Cover-Bild durchreichen (nur i*.sndcdn.com)
  app.get<{ Querystring: { u?: string } }>(`${api}/soundcloud/cover`, async (req, reply) => {
    const c = await fetchScCover(String(req.query.u ?? '')).catch(() => null);
    if (!c) return reply.code(404).send({ error: 'Kein Bild' });
    return reply.type(c.type).header('Cache-Control', 'public, max-age=86400').send(c.data);
  });

  // YouTube-Cookies hinterlegen (gegen die Bot-Pruefung); Datei liegt nur im Daten-Volume, wird nie ausgeliefert
  app.get(`${api}/youtube/cookies`, async () => {
    const f = cookiesFile();
    return fs.existsSync(f) ? { present: true, updatedAt: fs.statSync(f).mtimeMs } : { present: false };
  });
  app.post<{ Body: { text?: string } }>(`${api}/youtube/cookies`, { bodyLimit: 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    // Netscape-Cookie-Datei: Tab-getrennte Zeilen, mindestens ein youtube.com-Eintrag
    const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#') || l.startsWith('#HttpOnly_'));
    if (!lines.some((l) => /youtube\.com\t/.test(l) && l.split('\t').length >= 7)) return reply.code(400).send({ error: 'Keine gültige Cookie-Datei (Netscape-Format mit youtube.com-Einträgen).' });
    fs.writeFileSync(cookiesFile(), text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
    return { ok: true };
  });
  app.delete(`${api}/youtube/cookies`, async () => { fs.rmSync(cookiesFile(), { force: true }); return { ok: true }; });

  // ---------- Bearbeiten ----------
  app.patch<{ Params: { id: string }; Body: Partial<{ title: string; artist: string; album: string; hidden: boolean }> }>(`${api}/songs/:id`, async (req, reply) => {
    const s = getSong(req.params.id); if (!s) return reply.code(404).send({ error: 'Song nicht gefunden' });
    const b = req.body ?? {}; const f: Record<string, unknown> = {};
    for (const k of ['title', 'artist', 'album'] as const) if (typeof b[k] === 'string') f[k] = b[k]!.slice(0, 200).trim();
    if (typeof b.hidden === 'boolean') f.hidden = b.hidden ? 1 : 0;
    updateSong(s.id, f);
    const n = getSong(s.id); songChanged(n); return n;
  });

  app.delete<{ Params: { id: string } }>(`${api}/songs/:id`, async (req, reply) => {
    const s = getSong(req.params.id); if (!s) return reply.code(404).send({ error: 'Song nicht gefunden' });
    if (s.bundled) return reply.code(403).send({ error: 'Mitgelieferte Songs können nur ausgeblendet werden.' });
    q.deleteSong.run(s.id);
    fs.rmSync(songDir(s.id), { recursive: true, force: true });
    songDeleted(s.id);
    return { ok: true };
  });

  // ---------- Audio (mit Range Requests) ----------
  app.get<{ Params: { id: string } }>(`${api}/songs/:id/audio`, async (req, reply) => {
    const r = songRow(req.params.id); if (!r) return reply.code(404).send({ error: 'Song nicht gefunden' });
    const file = audioPath(r.id as string, r.ext as string);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.type(MIME[r.ext as string] ?? 'application/octet-stream');
    return reply.sendFile(path.basename(file), path.dirname(file));
  });

  // ---------- Cover ----------
  app.get<{ Params: { id: string } }>(`${api}/songs/:id/cover`, async (req, reply) => {
    const p = coverPath(req.params.id); if (!p) return reply.code(404).send({ error: 'Kein Cover' });
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.sendFile(path.basename(p), path.dirname(p));
  });
  app.put<{ Params: { id: string } }>(`${api}/songs/:id/cover`, async (req, reply) => {
    const s = getSong(req.params.id); if (!s) return reply.code(404).send({ error: 'Song nicht gefunden' });
    const file = await req.file({ limits: { fileSize: 8 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: 'Kein Bild' });
    const buf = await file.toBuffer();
    const mime = sniffImage(buf); if (!mime) return reply.code(415).send({ error: 'Nur JPG, PNG oder WebP' });
    saveCover(s.id, buf, mime); updateSong(s.id, { has_cover: 1 });
    const n = getSong(s.id); songChanged(n); return n;
  });

  // ---------- Beatmap ----------
  app.get<{ Params: { id: string }; Querystring: { difficulty?: string; seed?: string } }>(`${api}/songs/:id/beatmap`, async (req, reply) => {
    const s = getSong(req.params.id); if (!s) return reply.code(404).send({ error: 'Song nicht gefunden' });
    const d = (req.query.difficulty ?? 'expert') as Difficulty;
    if (!isDiff(d)) return reply.code(400).send({ error: 'Unbekannte Schwierigkeit' });
    const seed = req.query.seed !== undefined ? Math.max(0, Math.floor(+req.query.seed) || 0) : s.seed;
    const file = beatmapPath(s.id, d, seed);
    if (!fs.existsSync(file)) {
      if (!fs.existsSync(analysisPath(s.id))) return reply.code(409).send({ error: 'Song wird noch verarbeitet' });
      await mapOnDemand(s.id, d, seed);
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.type('application/json').send(fs.createReadStream(file));
  });

  // Level-Import (eigene/angepasste Beatmap als JSON hochladen)
  app.put<{ Params: { id: string }; Querystring: { difficulty?: string; seed?: string } }>(`${api}/songs/:id/beatmap`, async (req, reply) => {
    const s = getSong(req.params.id); if (!s) return reply.code(404).send({ error: 'Song nicht gefunden' });
    const bm = req.body as { notes?: unknown[]; difficulty?: string };
    const d = (req.query.difficulty ?? bm?.difficulty) as Difficulty;
    if (!isDiff(d) || !Array.isArray(bm?.notes)) return reply.code(400).send({ error: 'Ungültige Beatmap' });
    const seed = Math.max(0, Math.floor(+(req.query.seed ?? s.seed)) || 0);
    fs.mkdirSync(path.dirname(beatmapPath(s.id, d, seed)), { recursive: true });
    fs.writeFileSync(beatmapPath(s.id, d, seed), JSON.stringify(bm));
    logSong(s.id, `Beatmap ${d} (Seed ${seed}) importiert`);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { seed?: number; reanalyze?: boolean } }>(`${api}/songs/:id/regenerate`, async (req, reply) => {
    const s = getSong(req.params.id); if (!s) return reply.code(404).send({ error: 'Song nicht gefunden' });
    const b = req.body ?? {};
    const seed = typeof b.seed === 'number' ? Math.max(0, Math.floor(b.seed)) : crypto.randomInt(1, 1e6);
    updateSong(s.id, { seed });
    logSong(s.id, b.reanalyze ? `Neu analysieren (Seed ${seed})` : `Neu generieren mit Seed ${seed}`);
    enqueue(s.id, b.reanalyze || !fs.existsSync(analysisPath(s.id)) ? 'full' : 'map');
    return getSong(s.id);
  });

  // ---------- Debug: Analyse, Wellenform, Log ----------
  app.get<{ Params: { id: string } }>(`${api}/songs/:id/analysis`, async (req, reply) => {
    const p = analysisPath(req.params.id); if (!fs.existsSync(p)) return reply.code(404).send({ error: 'Noch keine Analyse' });
    return reply.type('application/json').send(fs.createReadStream(p));
  });
  app.get<{ Params: { id: string } }>(`${api}/songs/:id/waveform`, async (req, reply) => {
    const p = waveformPath(req.params.id); if (!fs.existsSync(p)) return reply.code(404).send({ error: 'Noch keine Wellenform' });
    return reply.type('application/json').send(fs.createReadStream(p));
  });
  app.get<{ Params: { id: string } }>(`${api}/songs/:id/log`, async (req) => (q.logs.all(req.params.id) as unknown[]).reverse());

  // ---------- Highscores ----------
  app.get<{ Querystring: { difficulty?: string } }>(`${api}/best`, async (req, reply) => {
    const d = (req.query.difficulty ?? 'normal') as Difficulty;
    if (!isDiff(d)) return reply.code(400).send({ error: 'Unbekannte Schwierigkeit' });
    return bestScores(d);
  });
  app.get<{ Params: { id: string }; Querystring: { difficulty?: string } }>(`${api}/songs/:id/scores`, async (req, reply) => {
    const d = (req.query.difficulty ?? 'expert') as Difficulty;
    if (!isDiff(d)) return reply.code(400).send({ error: 'Unbekannte Schwierigkeit' });
    return topScores(req.params.id, d, 10);
  });
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(`${api}/songs/:id/scores`, { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = getSong(req.params.id); if (!s) return reply.code(404).send({ error: 'Song nicht gefunden' });
    const b = req.body ?? {};
    const d = b.difficulty as Difficulty;
    const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    if (!isDiff(d) || !num(b.score, 0, 1e8) || !num(b.accuracy, 0, 100) || !num(b.maxCombo, 0, 1e5) || !num(b.misses, 0, 1e5)) return reply.code(400).send({ error: 'Ungültiger Score' });
    const name = String(b.name ?? 'Spieler').replace(/[^\p{L}\p{N} _.\-!?]/gu, '').trim().slice(0, 20) || 'Spieler';
    q.insertScore.run({ songId: s.id, difficulty: d, name, score: Math.round(b.score as number), accuracy: Math.round((b.accuracy as number) * 100) / 100,
      rank: String(b.rank ?? '').slice(0, 3), maxCombo: Math.round(b.maxCombo as number), misses: Math.round(b.misses as number), modifiers: String(b.modifiers ?? '').slice(0, 100), createdAt: Date.now() });
    return topScores(s.id, d, 10);
  });

  // ---------- Live-Status ----------
  app.get(`${api}/events`, async (req, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(`retry: 3000\n\n`);
    addClient(reply);
    reply.hijack();
    void req;
  });

  // Job-Uebersicht (Debug)
  app.get(`${api}/jobs`, async () => db.prepare(`SELECT id, song_id AS songId, type, status, attempts, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt FROM jobs ORDER BY id DESC LIMIT 100`).all());
}
