// BeatBlade-Server: Fastify-API + Auslieferung der Web-App, Job-Queue, Seed-Import.
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { ANALYSIS_VERSION, MAPPING_VERSION } from '@beatblade/core';
import { config } from './config.js';
import { registerAuth, loggedIn } from './auth.js';
import { contentByKind, contentFile, CONTENT_MIME } from './content.js';
import { songRoutes } from './routes/songs.js';
import { resumeAndUpgrade } from './queue.js';
import { importSeeds, readCredits } from './seed.js';
import { initYoutube } from './youtube.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: true, bodyLimit: 20 * 1024 * 1024 });
const B = config.basePath, api = `${B}/api`;

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });
// Web-App (Vite-Build) unter BASE_PATH; ausserdem fuer reply.sendFile
await app.register(fastifyStatic, { root: fs.existsSync(config.webDir) ? config.webDir : process.cwd(), prefix: `${B}/`, index: ['index.html'], wildcard: true });

registerAuth(app, api);

app.get(`${api}/info`, async (req) => ({
  name: 'BeatBlade', authMode: config.authMode, loggedIn: loggedIn(req), maxUploadMb: config.maxUploadMb,
  publicUrl: config.publicUrl || `${req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}${B}`,
  analysisVersion: ANALYSIS_VERSION, mappingVersion: MAPPING_VERSION, basePath: B,
}));
app.get(`${api}/credits`, async () => readCredits().map(({ title, artist, license, licenseUrl, source, attribution, genre }) => ({ title, artist, license, licenseUrl, source, attribution, genre })));
app.get(`${api}/health`, async () => ({ ok: true }));
app.get(`${api}/content`, async () => contentByKind());
app.get<{ Params: { kind: string; id: string; file: string } }>(`${api}/content/:kind/:id/:file`, async (req, reply) => {
  const { kind, id, file } = req.params;
  const p = contentFile(kind, id, file);
  if (!p) return reply.code(404).send({ error: 'Datei nicht gefunden' });
  reply.type(CONTENT_MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream').header('Cache-Control', 'public, max-age=3600');
  return reply.sendFile(path.basename(p), path.dirname(p));
});
// Fehlersuche: Spiel meldet Schnitt-Protokolle (letzte 300 Eintraege werden behalten)
const debugLog: unknown[] = [];
app.post(`${api}/debug`, { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
  debugLog.push({ at: new Date().toISOString(), ...(req.body as object) });
  while (debugLog.length > 300) debugLog.shift();
  try { fs.appendFileSync(path.join(config.dataDir, 'debug.log'), JSON.stringify(debugLog[debugLog.length - 1]) + '\n'); } catch { /* egal */ }
  return { ok: true };
});
app.get(`${api}/debug`, async () => debugLog.slice(-50));

songRoutes(app, api);

if (B) {
  app.get(B, async (_req, reply) => reply.redirect(`${B}/`));
  // eigene Domain (z. B. beat.kulbarts.com): Wurzel fuehrt direkt ins Spiel
  app.get('/', async (_req, reply) => reply.redirect(`${B}/play.html`));
}

await app.listen({ port: config.port, host: config.host });
app.log.info(`BeatBlade läuft auf :${config.port}${B || '/'} (Daten: ${config.dataDir}, Worker: ${config.concurrency}, Auth: ${config.authMode})`);

fs.mkdirSync(path.join(config.dataDir, 'songs'), { recursive: true });
resumeAndUpgrade();
importSeeds((m) => app.log.info(m)).catch((e) => app.log.error(e, 'Seed-Import fehlgeschlagen'));
initYoutube((m) => app.log.info(m));
