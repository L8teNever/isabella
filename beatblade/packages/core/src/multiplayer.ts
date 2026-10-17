// Mehrspieler „Zusammen spielen“: Nachrichten zwischen Spiel und Server (WebSocket, JSON { t: '<typ>', ... }).
// Server und Web benutzen dieselben Typen. Bei Aenderungen am Protokoll MP_PROTOCOL erhoehen.
import type { Difficulty, GameModeId } from './types.js';

export const MP_PROTOCOL = 1;
/** maximal Spieler je Lobby (Datenmodell kann mehr) */
export const MP_MAX_MEMBERS = 2;
/** Laenge der Anzeigenamen */
export const MP_NAME_MAX = 24;
/** Lobby-Code: ohne verwechselbare Zeichen (0/O, 1/I/L) */
export const MP_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MP_CODE_LEN = 4;

export type MpDevice = 'vr' | 'mr' | 'desktop' | 'phone';
export type MpStatus = 'menu' | 'lobby' | 'playing' | 'away';
export type MpPart = 1 | 2;
export type MpLobbyState = 'waiting' | 'loading' | 'countdown' | 'playing' | 'paused' | 'results';

export interface MpSongRef { id: string; title: string; updatedAt?: number }

export interface MpPerson {
  clientId: string;
  name: string;
  device: MpDevice;
  status: MpStatus;
  song?: MpSongRef;
  lobbyId?: string;
}

/** Modifikatoren, die der Host fuer beide festlegt (aendern Inhalt bzw. Timing) */
export interface MpSharedModifiers { noWalls: boolean; noBombs: boolean; fastNotes: boolean; /** Richtung egal: jeder saubere Schnitt zaehlt */ anyDirection: boolean }

/** Aussehen eines Spielers (Ordnernamen aus content/, Farben #rrggbb links/rechts) */
export interface MpLook {
  saberSkin: string; saberSkinRight: string; blockSkin: string; orbSkin: string; orbNoteSkin: string;
  colors: [string, string];
}

/** Spiel-Ereignisse, die der Partner hoert/sieht */
export const MP_PLAY_EVENTS = ['hit', 'miss', 'badcut', 'bomb', 'wall', 'railLost', 'combo'] as const;
export type MpPlayEvent = (typeof MP_PLAY_EVENTS)[number];

export interface MpMember {
  clientId: string;
  name: string;
  device: MpDevice;
  part: MpPart;
  ready: boolean;
  /** Audio + Level geladen (0..1 waehrend des Ladens) */
  progress: number;
  loaded: boolean;
  /** Verbindung da (sonst Gnadenfrist) */
  connected: boolean;
  away: boolean;
  /** Aussehen (Skins), sobald gemeldet */
  look?: MpLook;
  /** Farben im Duett links/rechts (vom Server zugeteilt: Stimme 2 wird angepasst, wenn zu aehnlich) */
  colors: [string, string];
  /** Farben wurden fuer dieses Duett angepasst */
  colorsAdjusted: boolean;
}

export interface MpLobby {
  id: string;
  code: string;
  hostId: string;
  members: MpMember[];
  song?: MpSongRef;
  mode: GameModeId;
  difficulty: Difficulty;
  seed: number;
  sharedModifiers: MpSharedModifiers;
  /** Map (Umgebung) fuer beide: Ordnername aus content/maps oder 'zufall' */
  map: string;
  state: MpLobbyState;
  /** wer pausiert hat (state paused) */
  pausedBy?: string;
  /** Hinweis fuer alle (z. B. Ladefehler) */
  note?: string;
}

/** Live-Wertung waehrend des Songs */
export interface MpScoreLine { rating: number; score: number; combo: number; hits: number; misses: number }

/** Endergebnis eines Spielers */
export interface MpResult {
  accuracy: number;     // Prozent 0..100
  score: number;
  maxCombo: number;
  hits: number;
  misses: number;
  /** Notenzahl der eigenen Stimme (Gewicht der Team-Wertung) */
  notes: number;
  rank: string;
}
export interface MpResultLine extends MpResult { clientId: string; name: string; part: MpPart }

/** Pose in Spielfeld-Koordinaten: Kopf [x,y,z,qx,qy,qz,qw], Haende je 7 Werte (links, rechts) */
export interface MpPose { head: number[]; hands: number[] }

// ---------- Spiel -> Server ----------
export type MpClientMsg =
  | { t: 'hello'; clientId: string; name: string; device: MpDevice; protocol: number }
  | { t: 'status'; status: 'menu' | 'playing' | 'away'; song?: MpSongRef; device?: MpDevice }
  | { t: 'name'; name: string }
  | { t: 'ping'; c: number }
  | { t: 'lobby.create' }
  | { t: 'lobby.invite'; to: string }
  | { t: 'invite.answer'; lobbyId: string; accept: boolean }
  | { t: 'lobby.join'; code: string }
  | { t: 'lobby.leave' }
  | { t: 'lobby.update'; song?: MpSongRef | null; mode?: GameModeId; difficulty?: Difficulty; seed?: number; sharedModifiers?: MpSharedModifiers; map?: string }
  | ({ t: 'look' } & MpLook)
  | { t: 'play.event'; kind: MpPlayEvent; at: number; hand: -1 | 0 | 1; value?: number }
  | { t: 'lobby.part'; part: MpPart }
  | { t: 'lobby.ready'; ready: boolean }
  | { t: 'lobby.start' }
  | { t: 'loading'; p: number }
  | { t: 'loaded'; ok: boolean; error?: string }
  | { t: 'abort' }
  | { t: 'sync'; songTime: number }
  | { t: 'pause'; songTime: number }
  | { t: 'resume' }
  | { t: 'restart' }
  | { t: 'lobby.back' }
  | ({ t: 'pose' } & MpPose)
  | ({ t: 'score' } & MpScoreLine)
  | { t: 'finished'; result: MpResult };

// ---------- Server -> Spiel ----------
export type MpServerMsg =
  | { t: 'welcome'; protocol: number; you: { clientId: string; sessionId: string; name: string; suggestedName?: string }; online: MpPerson[] }
  | { t: 'outdated'; protocol: number }
  | { t: 'presence'; online: MpPerson[] }
  | { t: 'pong'; c: number; s: number }
  | { t: 'invite'; from: { clientId: string; name: string; device: MpDevice }; lobbyId: string; expiresAt: number; quiet: boolean }
  | { t: 'invite.gone'; lobbyId: string; reason: string }
  | { t: 'lobby.state'; lobby: MpLobby | null; reason?: string }
  /** alle laden Audio + Duett-Level; duetVersion = erwartete Level-Version */
  | { t: 'prepare'; song: MpSongRef; mode: GameModeId; difficulty: Difficulty; seed: number; sharedModifiers: MpSharedModifiers; part: MpPart; duetVersion: number; map: string }
  /** Spiel-Ereignis des Partners (at = seine Songzeit in s) */
  | { t: 'play.event'; kind: MpPlayEvent; at: number; hand: -1 | 0 | 1; value: number }
  /** Song laeuft ab Serverzeit at (ms) an Songposition from (s) */
  | { t: 'start'; at: number; from: number }
  | { t: 'pause'; by: string; name: string; songTime: number }
  | { t: 'resume'; at: number; songTime: number }
  | ({ t: 'pose' } & MpPose)
  | ({ t: 'score' } & MpScoreLine)
  | { t: 'partner'; event: 'lost' | 'back' | 'left'; name: string }
  | { t: 'results'; results: MpResultLine[]; team: { accuracy: number; score: number }; ranked: boolean }
  | { t: 'error'; message: string };

// Steuer- und unsichtbare Zeichen (inkl. Richtungs-Umschaltung)
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** Anzeigename saeubern: Steuerzeichen raus, Leerraum zusammenfassen, kuerzen */
export function cleanName(s: unknown): string {
  return String(s ?? '').replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, MP_NAME_MAX);
}

/** Team-Wertung: nach Notenzahl gewichteter Mittelwert der Prozente */
export function teamAccuracy(r: { accuracy: number; notes: number }[]): number {
  const n = r.reduce((s, x) => s + Math.max(0, x.notes), 0);
  if (!n) return r.length ? r.reduce((s, x) => s + x.accuracy, 0) / r.length : 0;
  return Math.round((r.reduce((s, x) => s + x.accuracy * Math.max(0, x.notes), 0) / n) * 100) / 100;
}

// ---------- Farben im Duett ----------
/** Mindestabstand im Farbton (Grad) zwischen den Farben der beiden Spieler */
export const COLOR_MIN_HUE_DIFF = 45;
/** Graue/blasse Farben: Mindestabstand der Helligkeit */
export const COLOR_MIN_LIGHT_DIFF = 0.18;
/** Ersatz, wenn kein Farbset passt */
export const DUET_FALLBACK_COLORS: [string, string][] = [['#ff8a1a', '#3dff7a'], ['#ffe14d', '#b04dff'], ['#ff4dd2', '#4dffe1']];

const hsl = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16), r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-6) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, s, l];
};
/** Abstand zweier Farben fuer das Auge: Farbton (Grad), bei blassen Farben ueber die Helligkeit */
export function colorDistance(a: string, b: string): number {
  const [ha, sa, la] = hsl(a), [hb, sb, lb] = hsl(b);
  if (sa < 0.25 || sb < 0.25) return (Math.abs(la - lb) / COLOR_MIN_LIGHT_DIFF) * COLOR_MIN_HUE_DIFF;
  const dh = Math.abs(ha - hb);
  return Math.min(dh, 360 - dh);
}
const minDist = (p: [string, string], q: [string, string]) => Math.min(...p.flatMap((x) => q.map((y) => colorDistance(x, y))));
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/**
 * Farben fuer Stimme 2: eigene, solange sie sich klar von Stimme 1 unterscheiden; sonst das Farbset mit dem groessten
 * Abstand (links/rechts muessen untereinander unterscheidbar bleiben), zuletzt ein festes Ersatzpaar.
 */
export function duetColors(one: [string, string], two: [string, string], sets: [string, string][]): { colors: [string, string]; adjusted: boolean } {
  if (minDist(one, two) >= COLOR_MIN_HUE_DIFF) return { colors: two, adjusted: false };
  let best: [string, string] = DUET_FALLBACK_COLORS[0], bestD = -1;
  for (const c of [...sets, ...DUET_FALLBACK_COLORS]) {
    if (colorDistance(c[0], c[1]) < COLOR_MIN_HUE_DIFF) continue;      // eigene Seiten muessen auseinanderzuhalten sein
    const d = minDist(one, c);
    if (d > bestD + 1e-9) { bestD = d; best = c; }
  }
  return { colors: [best[0].toLowerCase(), best[1].toLowerCase()] as [string, string], adjusted: true };
}
