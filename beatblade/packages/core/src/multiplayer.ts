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
export interface MpSharedModifiers { noWalls: boolean; noBombs: boolean; fastNotes: boolean }

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
  | { t: 'status'; status: 'menu' | 'playing' | 'away'; song?: MpSongRef }
  | { t: 'name'; name: string }
  | { t: 'ping'; c: number }
  | { t: 'lobby.create' }
  | { t: 'lobby.invite'; to: string }
  | { t: 'invite.answer'; lobbyId: string; accept: boolean }
  | { t: 'lobby.join'; code: string }
  | { t: 'lobby.leave' }
  | { t: 'lobby.update'; song?: MpSongRef | null; mode?: GameModeId; difficulty?: Difficulty; seed?: number; sharedModifiers?: MpSharedModifiers }
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
  | { t: 'prepare'; song: MpSongRef; mode: GameModeId; difficulty: Difficulty; seed: number; sharedModifiers: MpSharedModifiers; part: MpPart; duetVersion: number }
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
