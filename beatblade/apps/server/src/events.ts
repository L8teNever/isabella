// Server-Sent Events: Status-Updates an alle offenen Seiten (Handy, PC, Brille)
import type { FastifyReply } from 'fastify';
import type { Song } from '@beatblade/core';

const clients = new Set<FastifyReply>();

export function addClient(reply: FastifyReply): void {
  clients.add(reply);
  reply.raw.on('close', () => clients.delete(reply));
}

export function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.raw.write(msg); } catch { clients.delete(c); } }
}

export const songChanged = (song: Song | null) => { if (song) broadcast('song', song); };
export const songDeleted = (id: string) => broadcast('deleted', { id });

setInterval(() => { for (const c of clients) { try { c.raw.write(': ping\n\n'); } catch { clients.delete(c); } } }, 25000).unref();
