// Lokaler Cache im Headset (Cache API): Audio und Beatmaps, damit erneutes Spielen sofort startet.
import { DUET_MAPPING_VERSION, type Beatmap, type Difficulty, type DuetMap, type GameModeId, type OrbitMap, type Song } from '@beatblade/core';
import { api } from '../api';

const NAME = 'beatblade-v1';
const open = () => (('caches' in self) ? caches.open(NAME) : Promise.resolve(null));

async function cached(key: string, fetcher: () => Promise<Response>): Promise<Response> {
  const c = await open().catch(() => null);
  const hit = await c?.match(key);
  if (hit) return hit;
  const r = await fetcher();
  if (r.ok && c) await c.put(key, r.clone()).catch(() => {});
  return r;
}

/** Audio als ArrayBuffer (Schluessel enthaelt den Datei-Hash -> nie veraltet) */
export async function loadAudio(song: Song, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
  const r = await cached(`/audio/${song.id}/${song.hash}`, () => fetch(api.audioUrl(song.id), { credentials: 'same-origin' }));
  if (!r.ok) throw new Error(`Audio konnte nicht geladen werden (${r.status})`);
  const total = +(r.headers.get('content-length') || 0);
  if (!r.body || !total || !onProgress) return r.arrayBuffer();
  const reader = r.body.getReader(), parts: Uint8Array[] = [];
  let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress(got / total); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

/** Beatmap (Schluessel enthaelt updatedAt + Seed -> neu generierte Levels werden neu geladen) */
export async function loadBeatmap(song: Song, d: Difficulty, seed = song.seed): Promise<Beatmap> {
  const key = `/beatmap/${song.id}/${d}/${seed}/${song.updatedAt}`;
  const r = await cached(key, async () => new Response(JSON.stringify(await api.beatmap(song.id, d, seed)), { headers: { 'Content-Type': 'application/json' } }));
  return r.json();
}

/** Orbit-Level (gleiches Schema wie loadBeatmap) */
export async function loadOrbitMap(song: Song, d: Difficulty, seed = song.seed): Promise<OrbitMap> {
  const key = `/beatmap/${song.id}/orbit-${d}/${seed}/${song.updatedAt}`;
  const r = await cached(key, async () => new Response(JSON.stringify(await api.orbitmap(song.id, d, seed)), { headers: { 'Content-Type': 'application/json' } }));
  return r.json();
}

/** Duett-Level (Schluessel mit updatedAt und Duett-Version -> neuer Generator/neue Levels werden neu geladen) */
export async function loadDuet<P = Beatmap | OrbitMap>(song: { id: string; updatedAt: number }, mode: GameModeId, d: Difficulty, seed: number, version = DUET_MAPPING_VERSION): Promise<DuetMap<P>> {
  const key = `/beatmap/${song.id}/duet-${mode}-${d}/${seed}-v${version}/${song.updatedAt}`;
  const r = await cached(key, async () => new Response(JSON.stringify(await api.duet<P>(song.id, mode, d, seed)), { headers: { 'Content-Type': 'application/json' } }));
  const dm = await r.json() as DuetMap<P>;
  if (dm.version !== version) {   // Server hat eine andere Version: Cache-Eintrag verwerfen und frisch holen
    const c = await open().catch(() => null); await c?.delete(key);
    return api.duet<P>(song.id, mode, d, seed);
  }
  return dm;
}

/** alte Eintraege eines Songs entfernen (z. B. nach Neu-Generierung) */
export async function pruneSong(id: string, keepUpdatedAt: number): Promise<void> {
  const c = await open().catch(() => null); if (!c) return;
  for (const req of await c.keys()) { const u = new URL(req.url); if (u.pathname.startsWith(`/beatmap/${id}/`) && !u.pathname.endsWith(`/${keepUpdatedAt}`)) await c.delete(req); }
}
