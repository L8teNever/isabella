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
import { songRoutes } from './routes/songs.js';
import { resumeAndUpgrade } from './queue.js';
import { importSeeds, readCredits } from './seed.js';

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
