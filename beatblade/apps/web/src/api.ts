// API-Zugriff und Live-Updates (SSE). Basis-Pfad kommt aus Vite (BASE_PATH).
import type { Beatmap, Difficulty, Highscore, Song, SongAnalysis, Waveform } from '@beatblade/core';

export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const API = `${BASE}/api`;

export interface Info { name: string; authMode: 'open' | 'password' | 'cloudflare'; loggedIn: boolean; maxUploadMb: number; publicUrl: string; basePath: string }
export interface Credit { title: string; artist: string; license: string; licenseUrl: string; source: string; attribution: string; genre?: string }
export interface LogLine { at: number; level: string; msg: string }

/** Inhalte aus content/ (Bloecke, Schwerter, Farben, Maps, Waende) */
export type ContentKind = 'blocks' | 'sabers' | 'colors' | 'maps' | 'walls';
export interface ContentItem {
  kind: ContentKind; id: string; name: string; description: string;
  data: Record<string, unknown>; files: Record<string, string>; preview?: string; model?: string;
  source: 'builtin' | 'custom';
}
export type ContentList = Record<ContentKind, ContentItem[]>;
/** volle URL einer Inhalts-Datei (preview/model/files sind relativ zu /api) */
export const contentUrl = (rel: string) => API + rel;

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, { credentials: 'same-origin', ...init });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error((body as { error?: string })?.error || `HTTP ${r.status}`), { status: r.status });
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  info: () => j<Info>('/info'),
  login: (password: string) => j<{ ok: boolean }>('/login', json('POST', { password })),
  songs: () => j<Song[]>('/songs'),
  content: () => j<ContentList>('/content'),
  song: (id: string) => j<Song>(`/songs/${id}`),
  patch: (id: string, f: Partial<Pick<Song, 'title' | 'artist' | 'album' | 'hidden'>>) => j<Song>(`/songs/${id}`, json('PATCH', f)),
  remove: (id: string) => j<{ ok: boolean }>(`/songs/${id}`, { method: 'DELETE' }),
  regenerate: (id: string, opts: { seed?: number; reanalyze?: boolean } = {}) => j<Song>(`/songs/${id}/regenerate`, json('POST', opts)),
  beatmap: (id: string, d: Difficulty, seed?: number) => j<Beatmap>(`/songs/${id}/beatmap?difficulty=${d}${seed !== undefined ? `&seed=${seed}` : ''}`),
  analysis: (id: string) => j<SongAnalysis>(`/songs/${id}/analysis`),
  waveform: (id: string) => j<Waveform>(`/songs/${id}/waveform`),
  log: (id: string) => j<LogLine[]>(`/songs/${id}/log`),
  scores: (id: string, d: Difficulty) => j<Highscore[]>(`/songs/${id}/scores?difficulty=${d}`),
  /** Bestwert je Song (Prozent, Rang, Punkte) fuer eine Schwierigkeit */
  best: (d: Difficulty) => j<Record<string, { accuracy: number; rank: string; score: number }>>(`/best?difficulty=${d}`),
  postScore: (id: string, s: Omit<Highscore, 'songId' | 'createdAt'>) => j<Highscore[]>(`/songs/${id}/scores`, json('POST', s)),
  credits: () => j<Credit[]>('/credits'),
  debug: (data: unknown) => fetch(`${API}/debug`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'same-origin', keepalive: true }).catch(() => {}),
  audioUrl: (id: string) => `${API}/songs/${id}/audio`,
  coverUrl: (s: Song) => (s.hasCover ? `${API}/songs/${s.id}/cover?v=${s.updatedAt}` : null),
  async setCover(id: string, file: File): Promise<Song> {
    const fd = new FormData(); fd.append('cover', file);
    return j<Song>(`/songs/${id}/cover`, { method: 'PUT', body: fd });
  },
  /** Upload einer Datei mit Fortschritt (XHR, weil fetch keinen Upload-Fortschritt liefert) */
  upload(file: File, onProgress: (p: number) => void): Promise<{ results: { file: string; song?: Song; duplicate?: boolean; error?: string }[] }> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${API}/songs`);
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let b: unknown; try { b = JSON.parse(x.responseText); } catch { b = null; }
        if (x.status === 429) return reject(new Error('Zu viele Uploads – kurz warten'));
        if (b && (b as { results?: unknown }).results) resolve(b as never); else reject(new Error((b as { error?: string })?.error || `HTTP ${x.status}`));
      };
      x.onerror = () => reject(new Error('Netzwerkfehler'));
      const fd = new FormData(); fd.append('file', file, file.name); x.send(fd);
    });
  },
};

/** Live-Updates: song (neu/geaendert) und deleted */
export function subscribe(on: { song?: (s: Song) => void; deleted?: (id: string) => void; open?: () => void }): () => void {
  let es: EventSource | null = null, stop = false;
  const connect = () => {
    if (stop) return;
    es = new EventSource(`${API}/events`, { withCredentials: true });
    es.addEventListener('song', (e) => on.song?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('deleted', (e) => on.deleted?.(JSON.parse((e as MessageEvent).data).id));
    es.onopen = () => on.open?.();
    es.onerror = () => { es?.close(); setTimeout(connect, 3000); };
  };
  connect();
  return () => { stop = true; es?.close(); };
}

export const STATUS_LABEL: Record<Song['status'], string> = {
  queued: 'In Warteschlange', decoding: 'Dekodieren', analyzing: 'Analysieren', mapping: 'Level generieren',
  ready: 'Fertig', error: 'Fehler', outdated: 'Wird aktualisiert',
};
export const playable = (s: Song) => (s.status === 'ready' || s.status === 'outdated') && s.difficulties.length > 0;
export const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
