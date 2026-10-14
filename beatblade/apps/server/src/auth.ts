// Zugriffsschutz: open | password (gemeinsames Passwort, HttpOnly-Session-Cookie) | cloudflare (Access davor)
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from './config.js';

const COOKIE = 'bb_session';
const sign = (v: string) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url');
export function makeToken(days = 60): string { const exp = String(Date.now() + days * 864e5); return `${exp}.${sign(exp)}`; }
export function validToken(t: string | undefined): boolean {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const loggedIn = (req: FastifyRequest) => config.authMode !== 'password' || validToken(req.cookies?.[COOKIE]);

export function registerAuth(app: FastifyInstance, api: string): void {
  app.post(`${api}/login`, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (config.authMode !== 'password') return { ok: true };
    const pw = (req.body as { password?: string })?.password ?? '';
    const a = Buffer.from(crypto.createHash('sha256').update(pw).digest()), b = Buffer.from(crypto.createHash('sha256').update(config.password).digest());
    if (!config.password || !crypto.timingSafeEqual(a, b)) return reply.code(401).send({ error: 'Falsches Passwort' });
    reply.setCookie(COOKIE, makeToken(), { path: config.basePath || '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https', maxAge: 60 * 864e2 });
    return { ok: true };
  });
  app.post(`${api}/logout`, async (_req, reply) => { reply.clearCookie(COOKIE, { path: config.basePath || '/' }); return { ok: true }; });
  // alle anderen API-Routen schuetzen
  app.addHook('onRequest', async (req, reply) => {
    if (config.authMode !== 'password') return;
    const url = req.url.split('?')[0];
    if (!url.startsWith(api) || url === `${api}/login` || url === `${api}/info`) return;
    if (!loggedIn(req)) return reply.code(401).send({ error: 'Nicht angemeldet' });
  });
}
