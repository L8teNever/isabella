// Mehrspieler „Zusammen spielen“: Presence, Lobbys, Einladungen, synchroner Start/Pause, Partner-Daten.
// Alles im Speicher (ein Server-Neustart beendet Lobbys); nur Duett-Bestenlisten landen in der DB.
// Weitergeleitete Nachrichten baut der Server immer selbst aus gepruften Feldern.
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import {
  DIFFICULTIES, DUET_MAPPING_VERSION, GAME_MODES, MP_CODE_CHARS, MP_CODE_LEN, MP_MAX_MEMBERS, MP_PLAY_EVENTS, MP_PROTOCOL, cleanName, duetColors, isHexColor, teamAccuracy,
  type MpLook,
  type Difficulty, type GameModeId, type MpClientMsg, type MpDevice, type MpLobby, type MpMember, type MpPart, type MpPerson,
  type MpResult, type MpResultLine, type MpServerMsg, type MpSharedModifiers, type MpSongRef,
} from '@beatblade/core';
import { config } from './config.js';
import { getSong, insertDuetScore } from './db.js';
import { contentByKind } from './content.js';

// ---------- Stellschrauben ----------
/** Heartbeat (WebSocket-Ping) – Cloudflare kappt Leerlauf-Verbindungen */
export const MP_HEARTBEAT_MS = 20_000;
/** Einladungen laufen ab */
export const MP_INVITE_MS = 60_000;
/** Gnadenfrist nach Verbindungsabbruch, bevor jemand aus der Lobby fliegt */
export const MP_GRACE_MS = 20_000;
/** Vorlauf zwischen „beide geladen“ und Songstart */
export const MP_START_LEAD_MS = 4_000;
/** Countdown beim gemeinsamen Weiterspielen */
export const MP_RESUME_LEAD_MS = 3_000;
/** Laden darf so lange dauern */
export const MP_LOAD_TIMEOUT_MS = 60_000;
/** Abweichung der Songzeit: protokollieren bzw. (einmal) neu ansetzen */
export const MP_DRIFT_LOG = 0.04;
export const MP_DRIFT_RESYNC = 0.25;
/** Nachrichten je Sekunde und Verbindung: Pose/Uhr bzw. alles andere */
export const MP_RATE_FAST = 60;
export const MP_RATE_SLOW = 5;
export const MP_MAX_BYTES = 16 * 1024;

const DEVICES: MpDevice[] = ['vr', 'mr', 'desktop', 'phone'];
const FAST = new Set(['pose', 'ping', 'score', 'sync', 'loading', 'play.event']);
/** Farben, wenn jemand (noch) nichts gemeldet hat: Farbset klassisch */
const DEFAULT_COLORS: [string, string] = ['#ff3d6e', '#3db8ff'];
const CONTENT_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

interface Session {
  id: string;
  ws: WebSocket;
  clientId: string;
  name: string;
  device: MpDevice;
  status: 'menu' | 'playing' | 'away';
  song?: MpSongRef;
  lastActive: number;
  alive: boolean;
  tokens: { fast: number; slow: number; t: number };
  hello: boolean;
  look?: MpLook;
}

interface Lobby {
  id: string;
  code: string;
  hostId: string;
  members: MpMember[];
  song?: MpSongRef;
  mode: GameModeId;
  difficulty: Difficulty;
  seed: number;
  shared: MpSharedModifiers;
  /** Map-Wahl des Hosts ('zufall' oder Ordnername) und die beim Start gezogene */
  map: string;
  mapResolved?: string;
  state: MpLobby['state'];
  note?: string;
  /** Songuhr: zur Serverzeit at (ms) war die Songposition from (s) */
  clock?: { at: number; from: number };
  pausedBy?: string;
  pausedAt?: number;
  resumeVotes: Set<string>;
  loadTimer?: NodeJS.Timeout;
  results: Map<string, MpResult>;
  resynced: Set<string>;
  /** jemand ist waehrend des Songs ausgestiegen -> keine Bestenliste */
  broken: boolean;
}

interface Invite { from: string; to: string; lobbyId: string; expiresAt: number; timer: NodeJS.Timeout }

const sessions = new Map<string, Session>();
const lobbies = new Map<string, Lobby>();
const invites = new Map<string, Invite>();          // Schluessel: `${from}>${to}`
const grace = new Map<string, NodeJS.Timeout>();    // clientId -> Rauswurf-Timer
const lobbyOf = new Map<string, string>();          // clientId -> lobbyId

const send = (s: Session | undefined, m: MpServerMsg) => { if (s && s.ws.readyState === 1) s.ws.send(JSON.stringify(m)); };
const sessionsOf = (clientId: string) => [...sessions.values()].filter((s) => s.clientId === clientId && s.hello);
/** Einladungen/Lobby-Nachrichten gehen an die zuletzt aktive Sitzung */
const activeSession = (clientId: string) => sessionsOf(clientId).sort((a, b) => b.lastActive - a.lastActive)[0];
const online = (clientId: string) => sessionsOf(clientId).length > 0;
const toClient = (clientId: string, m: MpServerMsg) => send(activeSession(clientId), m);
const toLobby = (l: Lobby, m: MpServerMsg, except?: string) => { for (const mb of l.members) if (mb.clientId !== except) toClient(mb.clientId, m); };

// ---------- Presence ----------
function presence(): MpPerson[] {
  const out = new Map<string, MpPerson>();
  for (const s of [...sessions.values()].filter((x) => x.hello).sort((a, b) => a.lastActive - b.lastActive)) {
    const lid = lobbyOf.get(s.clientId), l = lid ? lobbies.get(lid) : undefined;
    const playing = l && ['loading', 'countdown', 'playing', 'paused'].includes(l.state);
    out.set(s.clientId, {
      clientId: s.clientId, name: s.name, device: s.device,
      status: s.status === 'away' ? 'away' : playing || s.status === 'playing' ? 'playing' : l ? 'lobby' : 'menu',
      song: playing ? l!.song : s.song, lobbyId: lid,
    });
  }
  return [...out.values()];
}
let presenceTimer: NodeJS.Timeout | null = null;
function presenceChanged() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    const online = presence();
    for (const s of sessions.values()) if (s.hello) send(s, { t: 'presence', online });
  }, 100);
}

// ---------- Lobby ----------
function newCode(): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < MP_CODE_LEN; i++) c += MP_CODE_CHARS[crypto.randomInt(MP_CODE_CHARS.length)];
    if (![...lobbies.values()].some((l) => l.code === c)) return c;
  }
}
// Farbsets aus content/colors und Themen-Farbset einer Map
function colorSetsFromContent(): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const it of contentByKind().colors ?? []) if (isHexColor(it.data.left) && isHexColor(it.data.right)) out.set(it.id, [it.data.left, it.data.right]);
  return out;
}
/** Farben im Duett: Stimme 1 behaelt ihre (bzw. das Themen-Farbset der Map), Stimme 2 wird bei Bedarf angepasst */
function assignColors(l: Lobby) {
  const sets = colorSetsFromContent();
  const map = contentByKind().maps?.find((m) => m.id === (l.mapResolved ?? l.map));
  const theme = typeof map?.data.colorSet === 'string' ? sets.get(map.data.colorSet) : undefined;
  const byPart = [...l.members].sort((a, b) => a.part - b.part);
  const one = byPart[0], two = byPart[1];
  if (one) { one.colors = theme ?? one.look?.colors ?? DEFAULT_COLORS; one.colorsAdjusted = false; }
  if (one && two) {
    const r = duetColors(one.colors, two.look?.colors ?? DEFAULT_COLORS, [...sets.values()]);
    two.colors = r.colors; two.colorsAdjusted = r.adjusted;
  }
}
function view(l: Lobby): MpLobby {
  assignColors(l);
  return {
    id: l.id, code: l.code, hostId: l.hostId, members: l.members.map((m) => ({ ...m, colors: [...m.colors] as [string, string] })), song: l.song, mode: l.mode, difficulty: l.difficulty,
    seed: l.seed, sharedModifiers: { ...l.shared }, map: l.mapResolved ?? l.map, state: l.state, pausedBy: l.pausedBy, note: l.note,
  };
}
function pushState(l: Lobby) { toLobby(l, { t: 'lobby.state', lobby: view(l) }); presenceChanged(); }

function memberFor(s: Session, part: MpPart): MpMember {
  return { clientId: s.clientId, name: s.name, device: s.device, part, ready: false, progress: 0, loaded: false, connected: true, away: s.status === 'away', look: s.look, colors: s.look?.colors ?? DEFAULT_COLORS, colorsAdjusted: false };
}

function createLobby(s: Session): Lobby {
  leaveLobby(s.clientId, 'neue Lobby');
  const l: Lobby = {
    id: crypto.randomUUID(), code: newCode(), hostId: s.clientId, members: [memberFor(s, 1)], mode: 'schnitt', difficulty: 'normal',
    seed: 0, shared: { noWalls: false, noBombs: false, fastNotes: false }, map: 'zufall', state: 'waiting', resumeVotes: new Set(), results: new Map(),
    resynced: new Set(), broken: false,
  };
  lobbies.set(l.id, l); lobbyOf.set(s.clientId, l.id);
  pushState(l);
  return l;
}

function joinLobby(s: Session, l: Lobby): boolean {
  if (l.members.some((m) => m.clientId === s.clientId)) { pushState(l); return true; }
  if (l.members.length >= MP_MAX_MEMBERS) { send(s, { t: 'error', message: 'Lobby voll' }); return false; }
  if (l.state !== 'waiting') { send(s, { t: 'error', message: 'Die Lobby spielt gerade' }); return false; }
  leaveLobby(s.clientId, 'gewechselt');
  const used = new Set(l.members.map((m) => m.part));
  l.members.push(memberFor(s, used.has(1) ? 2 : 1));
  for (const m of l.members) m.ready = false;
  lobbyOf.set(s.clientId, l.id);
  // offene Einladungen an diese Person fuer diese Lobby sind erledigt
  for (const [k, inv] of invites) if (inv.to === s.clientId) dropInvite(k, inv.lobbyId === l.id ? 'angenommen' : 'andere Lobby');
  pushState(l);
  return true;
}

function leaveLobby(clientId: string, reason: string) {
  const lid = lobbyOf.get(clientId), l = lid ? lobbies.get(lid) : undefined;
  lobbyOf.delete(clientId);
  const g = grace.get(clientId); if (g) { clearTimeout(g); grace.delete(clientId); }
  if (!l) return;
  const m = l.members.find((x) => x.clientId === clientId);
  l.members = l.members.filter((x) => x.clientId !== clientId);
  toClient(clientId, { t: 'lobby.state', lobby: null, reason });
  if (!l.members.length) { deleteLobby(l, reason); return; }
  if (l.hostId === clientId) l.hostId = l.members[0].clientId;     // anderer wird Host
  if (['loading', 'countdown', 'playing', 'paused'].includes(l.state)) {
    // mitten im Song: der Verbliebene spielt solo zu Ende (keine Bestenliste)
    l.broken = true;
    if (l.state === 'loading') { endLoading(l); l.state = 'waiting'; }
    if (l.state === 'paused') l.pausedBy = undefined;
  } else {
    l.state = 'waiting';
  }
  for (const x of l.members) x.ready = false;
  if (m) toLobby(l, { t: 'partner', event: 'left', name: m.name });
  maybeFinish(l);
  pushState(l);
}

function deleteLobby(l: Lobby, reason: string) {
  endLoading(l);
  lobbies.delete(l.id);
  for (const m of l.members) { lobbyOf.delete(m.clientId); toClient(m.clientId, { t: 'lobby.state', lobby: null, reason }); }
  for (const [k, inv] of invites) if (inv.lobbyId === l.id) dropInvite(k, 'Lobby beendet');
  presenceChanged();
}

// ---------- Einladungen ----------
function dropInvite(key: string, reason: string) {
  const inv = invites.get(key); if (!inv) return;
  clearTimeout(inv.timer); invites.delete(key);
  if (reason !== 'angenommen') toClient(inv.to, { t: 'invite.gone', lobbyId: inv.lobbyId, reason });
}

function invite(s: Session, to: string) {
  if (to === s.clientId) return send(s, { t: 'error', message: 'Du kannst dich nicht selbst einladen' });
  if (!online(to)) return send(s, { t: 'error', message: 'Diese Person ist nicht mehr online' });
  let l = lobbies.get(lobbyOf.get(s.clientId) ?? '');
  if (l && l.members.some((m) => m.clientId === to)) return send(s, { t: 'error', message: 'Ist schon in deiner Lobby' });
  // gleichzeitiges gegenseitiges Einladen: die vorhandene Einladung des anderen gilt, es entsteht nur eine Lobby
  const back = invites.get(`${to}>${s.clientId}`);
  if (back && !l) { const bl = lobbies.get(back.lobbyId); if (bl) { joinLobby(s, bl); return; } }
  if (!l) l = createLobby(s);
  if (l.members.length >= MP_MAX_MEMBERS) return send(s, { t: 'error', message: 'Lobby voll' });
  const key = `${s.clientId}>${to}`;
  dropInvite(key, 'ersetzt');
  const expiresAt = Date.now() + MP_INVITE_MS;
  const inv: Invite = { from: s.clientId, to, lobbyId: l.id, expiresAt, timer: setTimeout(() => dropInvite(key, 'abgelaufen'), MP_INVITE_MS) };
  inv.timer.unref?.();
  invites.set(key, inv);
  // wer schon in einer Lobby ist oder spielt, bekommt sie dezent (erst nach dem Song)
  const tl = lobbies.get(lobbyOf.get(to) ?? ''), busy = !!tl || activeSession(to)?.status === 'playing';
  toClient(to, { t: 'invite', from: { clientId: s.clientId, name: s.name, device: s.device }, lobbyId: l.id, expiresAt, quiet: busy });
}

function answer(s: Session, lobbyId: string, accept: boolean) {
  const entry = [...invites.entries()].find(([, i]) => i.to === s.clientId && i.lobbyId === lobbyId);
  if (!entry) return send(s, accept ? { t: 'error', message: 'Die Einladung gilt nicht mehr' } : { t: 'invite.gone', lobbyId, reason: 'abgelehnt' });
  const [key, inv] = entry;
  dropInvite(key, 'angenommen');
  const l = lobbies.get(lobbyId);
  if (!accept) { toClient(inv.from, { t: 'error', message: `${s.name} hat abgelehnt` }); return; }
  if (!l) return send(s, { t: 'error', message: 'Die Lobby gibt es nicht mehr' });
  joinLobby(s, l);
}

// ---------- Ablauf: laden, starten, pausieren ----------
function endLoading(l: Lobby) { if (l.loadTimer) { clearTimeout(l.loadTimer); l.loadTimer = undefined; } }

function startLoading(l: Lobby) {
  const song = l.song ? getSong(l.song.id) : null;
  if (!song || !['ready', 'outdated'].includes(song.status)) { l.note = 'Der Song ist noch nicht bereit'; pushState(l); return; }
  l.song = { id: song.id, title: song.title, updatedAt: song.updatedAt };
  // Map fuer beide gleich: 'zufall' wird hier einmal gezogen
  const maps = (contentByKind().maps ?? []).map((m) => m.id);
  l.mapResolved = maps.includes(l.map) ? l.map : maps.length ? maps[crypto.randomInt(maps.length)] : l.map;
  l.state = 'loading'; l.note = undefined; l.broken = false; l.results.clear(); l.resynced.clear(); l.clock = undefined;
  l.pausedBy = undefined; l.resumeVotes.clear();
  for (const m of l.members) { m.loaded = false; m.progress = 0; }
  endLoading(l);
  l.loadTimer = setTimeout(() => {
    if (l.state !== 'loading') return;
    const slow = l.members.filter((m) => !m.loaded).map((m) => m.name).join(', ');
    l.state = 'waiting'; l.note = `Laden dauerte zu lange (${slow})`;
    for (const m of l.members) m.ready = false;
    pushState(l);
  }, MP_LOAD_TIMEOUT_MS);
  l.loadTimer.unref?.();
  for (const m of l.members) sendPrepare(l, m);
  pushState(l);
}
function sendPrepare(l: Lobby, m: MpMember) {
  toClient(m.clientId, { t: 'prepare', song: l.song!, mode: l.mode, difficulty: l.difficulty, seed: l.seed, sharedModifiers: { ...l.shared }, part: m.part, duetVersion: DUET_MAPPING_VERSION, map: l.mapResolved ?? l.map });
}

function loaded(s: Session, l: Lobby, ok: boolean, error?: string) {
  const m = l.members.find((x) => x.clientId === s.clientId); if (!m) return;
  if (!ok) {
    endLoading(l);
    l.state = 'waiting'; l.note = `${m.name}: ${String(error ?? 'Laden fehlgeschlagen').slice(0, 120)}`;
    for (const x of l.members) x.ready = false;
    return pushState(l);
  }
  m.loaded = true; m.progress = 1;
  // Wiedereinstieg mitten im Song: an der richtigen Stelle einsteigen
  if (l.clock && ['countdown', 'playing'].includes(l.state)) { toClient(m.clientId, { t: 'start', ...l.clock }); return pushState(l); }
  if (l.state === 'paused') { toClient(m.clientId, { t: 'pause', by: l.pausedBy ?? '', name: nameOf(l, l.pausedBy), songTime: l.pausedAt ?? 0 }); return pushState(l); }
  if (l.state === 'loading' && l.members.every((x) => x.loaded || !x.connected)) {
    endLoading(l);
    l.clock = { at: Date.now() + MP_START_LEAD_MS, from: 0 };
    l.state = 'countdown';
    toLobby(l, { t: 'start', ...l.clock });
    setTimeout(() => { if (l.state === 'countdown') { l.state = 'playing'; pushState(l); } }, MP_START_LEAD_MS).unref?.();
  }
  pushState(l);
}

const nameOf = (l: Lobby, id?: string) => l.members.find((m) => m.clientId === id)?.name ?? 'Partner';
const songNow = (l: Lobby) => (l.clock ? l.clock.from + (Date.now() - l.clock.at) / 1000 : 0);

function pause(s: Session, l: Lobby, songTime: number) {
  if (l.state !== 'playing' && l.state !== 'countdown') return;
  l.state = 'paused'; l.pausedBy = s.clientId; l.pausedAt = songTime; l.resumeVotes.clear(); l.clock = undefined;
  toLobby(l, { t: 'pause', by: s.clientId, name: s.name, songTime });
  pushState(l);
}

function resume(s: Session, l: Lobby) {
  if (l.state !== 'paused') return;
  l.resumeVotes.add(s.clientId);
  const present = l.members.filter((m) => m.connected);
  if (s.clientId !== l.pausedBy && !present.every((m) => l.resumeVotes.has(m.clientId))) { pushState(l); return; }
  l.clock = { at: Date.now() + MP_RESUME_LEAD_MS, from: l.pausedAt ?? 0 };
  l.state = 'countdown'; l.pausedBy = undefined;
  toLobby(l, { t: 'resume', at: l.clock.at, songTime: l.clock.from });
  setTimeout(() => { if (l.state === 'countdown') { l.state = 'playing'; pushState(l); } }, MP_RESUME_LEAD_MS).unref?.();
  pushState(l);
}

function sync(s: Session, l: Lobby, songTime: number) {
  if (l.state !== 'playing' || !l.clock) return;
  const drift = songTime - songNow(l);
  if (Math.abs(drift) > MP_DRIFT_RESYNC && !l.resynced.has(s.clientId)) {
    // einmal neu ansetzen (Spruenge sind schlimmer als kleine Abweichungen)
    l.resynced.add(s.clientId);
    send(s, { t: 'start', ...l.clock });
  } else if (Math.abs(drift) > MP_DRIFT_LOG) {
    console.info(`[mp] ${s.name}: Songzeit weicht um ${(drift * 1000).toFixed(0)} ms ab`);
  }
}

function finished(s: Session, l: Lobby, r: MpResult) {
  if (!['playing', 'countdown', 'paused'].includes(l.state)) return;
  l.results.set(s.clientId, r);
  maybeFinish(l);
}

function maybeFinish(l: Lobby) {
  if (!['playing', 'countdown', 'paused'].includes(l.state) || !l.results.size) return;
  if (!l.members.every((m) => l.results.has(m.clientId) || !m.connected)) return;
  const results: MpResultLine[] = l.members.filter((m) => l.results.has(m.clientId)).map((m) => ({ ...l.results.get(m.clientId)!, clientId: m.clientId, name: m.name, part: m.part }))
    .sort((a, b) => a.part - b.part);
  const team = { accuracy: teamAccuracy(results), score: results.reduce((x, r) => x + r.score, 0) };
  const ranked = !l.broken && results.length === 2;
  if (ranked && l.song) {
    const mods = Object.entries(l.shared).filter(([, v]) => v).map(([k]) => k).join(',');
    try { insertDuetScore({ songId: l.song.id, mode: l.mode, difficulty: l.difficulty, results, team, modifiers: mods }); }
    catch (e) { console.error('[mp] Duett-Ergebnis nicht gespeichert', e); }
  }
  l.state = 'results'; l.clock = undefined;
  for (const m of l.members) m.ready = false;
  toLobby(l, { t: 'results', results, team, ranked });
  pushState(l);
}

// ---------- Pruefen der Eingaben ----------
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const nums = (v: unknown, n: number, lim: number): number[] | null =>
  Array.isArray(v) && v.length === n && v.every((x) => isNum(x, -lim, lim)) ? (v as number[]).map((x) => Math.round(x * 1000) / 1000) : null;
const songRef = (v: unknown): MpSongRef | undefined => {
  const o = v as MpSongRef | undefined;
  if (!o || !isStr(o.id, 80)) return undefined;
  return { id: o.id, title: cleanName(o.title).slice(0, 80) || '–', ...(isNum(o.updatedAt, 0, 1e14) ? { updatedAt: o.updatedAt } : {}) };
};
function rate(s: Session, fast: boolean): boolean {
  const now = Date.now(), dt = (now - s.tokens.t) / 1000; s.tokens.t = now;
  s.tokens.fast = Math.min(MP_RATE_FAST, s.tokens.fast + dt * MP_RATE_FAST);
  s.tokens.slow = Math.min(MP_RATE_SLOW * 2, s.tokens.slow + dt * MP_RATE_SLOW);
  const k = fast ? 'fast' : 'slow';
  if (s.tokens[k] < 1) return false;
  s.tokens[k] -= 1; return true;
}

function handle(s: Session, raw: string, req: FastifyRequest) {
  if (raw.length > MP_MAX_BYTES) return;
  let m: MpClientMsg;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
  if (!rate(s, FAST.has(m.t))) return;
  if (m.t !== 'ping' && m.t !== 'pose' && m.t !== 'score' && m.t !== 'sync') s.lastActive = Date.now();
  if (m.t === 'hello') return hello(s, m, req);
  if (!s.hello) return;
  const l = lobbies.get(lobbyOf.get(s.clientId) ?? '');
  const isHost = !!l && l.hostId === s.clientId;
  switch (m.t) {
    case 'ping': if (isNum(m.c, 0, 1e13)) send(s, { t: 'pong', c: m.c, s: Date.now() }); return;
    case 'status': {
      if (!['menu', 'playing', 'away'].includes(m.status)) return;
      s.status = m.status; s.song = m.status === 'playing' ? songRef(m.song) : undefined;
      if (m.device && DEVICES.includes(m.device)) s.device = m.device;
      if (l) {
        const mb = l.members.find((x) => x.clientId === s.clientId);
        if (mb) { mb.away = m.status === 'away'; if (mb.away) mb.ready = false; pushState(l); }
      }
      presenceChanged(); return;
    }
    case 'name': {
      const n = cleanName(m.name); if (!n) return;
      for (const x of sessionsOf(s.clientId)) x.name = n;
      if (l) { const mb = l.members.find((x) => x.clientId === s.clientId); if (mb) mb.name = n; pushState(l); }
      presenceChanged(); return;
    }
    case 'lobby.create': createLobby(s); return;
    case 'lobby.invite': if (isStr(m.to, 64)) invite(s, m.to); return;
    case 'invite.answer': if (isStr(m.lobbyId, 64)) answer(s, m.lobbyId, m.accept === true); return;
    case 'lobby.join': {
      const code = String(m.code ?? '').toUpperCase().trim();
      const t = [...lobbies.values()].find((x) => x.code === code);
      if (!t) return send(s, { t: 'error', message: `Keine Lobby mit Code ${code.slice(0, MP_CODE_LEN)}` });
      joinLobby(s, t); return;
    }
    case 'lobby.leave': leaveLobby(s.clientId, 'verlassen'); return;
    case 'look': {
      const id = (v: unknown) => (typeof v === 'string' && (v === '' || CONTENT_ID.test(v)) ? v : '');
      if (!Array.isArray(m.colors) || !isHexColor(m.colors[0]) || !isHexColor(m.colors[1])) return;
      const look: MpLook = { saberSkin: id(m.saberSkin), saberSkinRight: id(m.saberSkinRight), blockSkin: id(m.blockSkin), orbSkin: id(m.orbSkin), orbNoteSkin: id(m.orbNoteSkin),
        colors: [m.colors[0].toLowerCase(), m.colors[1].toLowerCase()] };
      for (const x of sessionsOf(s.clientId)) x.look = look;
      const mb = l?.members.find((x) => x.clientId === s.clientId);
      if (l && mb) { mb.look = look; pushState(l); }
      return;
    }
  }
  if (!l) return;
  const me = l.members.find((x) => x.clientId === s.clientId)!;
  switch (m.t) {
    case 'lobby.update': {
      if (!isHost || l.state !== 'waiting' && l.state !== 'results') return;
      let changed = false;
      if (m.song === null) { l.song = undefined; changed = true; }
      else if (m.song !== undefined) {
        const r = songRef(m.song), song = r ? getSong(r.id) : null;
        if (song) { l.song = { id: song.id, title: song.title, updatedAt: song.updatedAt }; changed = true; }
      }
      if (m.mode !== undefined && GAME_MODES.includes(m.mode)) { l.mode = m.mode; changed = true; }
      if (m.difficulty !== undefined && DIFFICULTIES.includes(m.difficulty)) { l.difficulty = m.difficulty; changed = true; }
      if (m.seed !== undefined && isNum(m.seed, 0, 1e9)) { l.seed = Math.floor(m.seed); changed = true; }
      if (typeof m.map === 'string' && (m.map === 'zufall' || CONTENT_ID.test(m.map))) { l.map = m.map; l.mapResolved = undefined; changed = true; }
      if (m.sharedModifiers && typeof m.sharedModifiers === 'object') {
        const sm = m.sharedModifiers;
        l.shared = { noWalls: sm.noWalls === true, noBombs: sm.noBombs === true, fastNotes: sm.fastNotes === true }; changed = true;
      }
      if (changed) { l.state = 'waiting'; l.note = undefined; for (const x of l.members) x.ready = false; pushState(l); }
      return;
    }
    case 'lobby.part': {
      if (l.state !== 'waiting' && l.state !== 'results' || (m.part !== 1 && m.part !== 2) || me.part === m.part) return;
      // Stimmen tauschen: hat der andere die gewuenschte Stimme, bekommt er meine
      const other = l.members.find((x) => x !== me && x.part === m.part);
      if (other) other.part = me.part;
      me.part = m.part;
      for (const x of l.members) x.ready = false;
      pushState(l); return;
    }
    case 'lobby.ready': {
      if (l.state !== 'waiting' && l.state !== 'results') return;
      if (l.state === 'results') l.state = 'waiting';
      me.ready = m.ready === true && !me.away; pushState(l); return;
    }
    case 'lobby.start': {
      if (!isHost || (l.state !== 'waiting' && l.state !== 'results')) return;
      if (l.members.length < 2) return send(s, { t: 'error', message: 'Warte auf deinen Partner' });
      if (!l.song) return send(s, { t: 'error', message: 'Bitte zuerst einen Song wählen' });
      if (!l.members.every((x) => x.ready && x.connected)) return send(s, { t: 'error', message: 'Noch nicht alle bereit' });
      startLoading(l); return;
    }
    case 'loading': if (l.state === 'loading' && isNum(m.p, 0, 1)) { me.progress = Math.round(m.p * 100) / 100; pushState(l); } return;
    case 'loaded': loaded(s, l, m.ok === true, typeof m.error === 'string' ? m.error : undefined); return;
    case 'abort': if (l.state === 'loading') { endLoading(l); l.state = 'waiting'; l.note = `${me.name} hat das Laden abgebrochen`; for (const x of l.members) x.ready = false; pushState(l); } return;
    case 'sync': if (isNum(m.songTime, -10, 1e5)) sync(s, l, m.songTime); return;
    case 'pause': if (isNum(m.songTime, -10, 1e5)) pause(s, l, m.songTime); return;
    case 'resume': resume(s, l); return;
    case 'restart': if (isHost && ['playing', 'paused', 'countdown', 'results'].includes(l.state)) startLoading(l); return;
    case 'lobby.back': {
      if (!isHost) return;
      endLoading(l); l.state = 'waiting'; l.clock = undefined; l.pausedBy = undefined; l.mapResolved = undefined;
      for (const x of l.members) x.ready = false;
      pushState(l); return;
    }
    case 'pose': {
      const head = nums(m.head, 7, 50), hands = nums(m.hands, 14, 50);
      if (!head || !hands) return;     // auch in der Lobby: der Partner steht schon rechts neben dir
      toLobby(l, { t: 'pose', head, hands }, s.clientId); return;
    }
    case 'play.event': {
      if (!MP_PLAY_EVENTS.includes(m.kind) || !isNum(m.at, -10, 1e5) || ![-1, 0, 1].includes(m.hand)) return;
      if (l.state !== 'playing' && l.state !== 'countdown') return;
      toLobby(l, { t: 'play.event', kind: m.kind, at: Math.round(m.at * 1000) / 1000, hand: m.hand, value: isNum(m.value, 0, 1e5) ? Math.round(m.value) : 0 }, s.clientId);
      return;
    }
    case 'score': {
      if (!isNum(m.rating, 0, 100) || !isNum(m.score, 0, 1e9) || !isNum(m.combo, 0, 1e5) || !isNum(m.hits, 0, 1e5) || !isNum(m.misses, 0, 1e5)) return;
      toLobby(l, { t: 'score', rating: m.rating, score: Math.round(m.score), combo: Math.round(m.combo), hits: Math.round(m.hits), misses: Math.round(m.misses) }, s.clientId);
      return;
    }
    case 'finished': {
      const r = m.result;
      if (!r || !isNum(r.accuracy, 0, 100) || !isNum(r.score, 0, 1e9) || !isNum(r.maxCombo, 0, 1e5) || !isNum(r.hits, 0, 1e5) || !isNum(r.misses, 0, 1e5) || !isNum(r.notes, 0, 1e5)) return;
      finished(s, l, { accuracy: Math.round(r.accuracy * 100) / 100, score: Math.round(r.score), maxCombo: Math.round(r.maxCombo), hits: Math.round(r.hits), misses: Math.round(r.misses), notes: Math.round(r.notes), rank: String(r.rank ?? '').slice(0, 3) });
      return;
    }
  }
}

function hello(s: Session, m: Extract<MpClientMsg, { t: 'hello' }>, req: FastifyRequest) {
  if (m.protocol !== MP_PROTOCOL) { send(s, { t: 'outdated', protocol: MP_PROTOCOL }); s.ws.close(4000, 'Version'); return; }
  if (!isStr(m.clientId, 64) || !/^[\w-]+$/.test(m.clientId)) { s.ws.close(4001, 'clientId'); return; }
  s.clientId = m.clientId; s.device = DEVICES.includes(m.device) ? m.device : 'desktop';
  // Name: aus dem Geraet; bei Cloudflare Access darf die Mail einen Vorschlag liefern
  let suggested: string | undefined;
  const mail = config.authMode === 'cloudflare' ? req.headers['cf-access-authenticated-user-email'] : undefined;
  if (typeof mail === 'string' && mail.includes('@')) suggested = cleanName(mail.split('@')[0]);
  s.name = cleanName(m.name) || suggested || 'Spieler';
  s.hello = true; s.lastActive = Date.now();
  send(s, { t: 'welcome', protocol: MP_PROTOCOL, you: { clientId: s.clientId, sessionId: s.id, name: s.name, suggestedName: suggested }, online: presence() });
  // zurueck in der Gnadenfrist: wieder in die Lobby (bei laufendem Song: neu laden, dann an der richtigen Stelle einsteigen)
  const g = grace.get(s.clientId); if (g) { clearTimeout(g); grace.delete(s.clientId); }
  const l = lobbies.get(lobbyOf.get(s.clientId) ?? '');
  if (l) {
    const mb = l.members.find((x) => x.clientId === s.clientId);
    if (mb && !mb.connected) {
      mb.connected = true; mb.name = s.name;
      toLobby(l, { t: 'partner', event: 'back', name: s.name }, s.clientId);
    }
    send(s, { t: 'lobby.state', lobby: view(l) });
    if (mb && ['countdown', 'playing', 'paused'].includes(l.state)) { mb.loaded = false; sendPrepare(l, mb); }
    pushState(l);
  }
  // offene Einladungen erneut zeigen
  for (const inv of invites.values()) if (inv.to === s.clientId) {
    const from = activeSession(inv.from);
    if (from) send(s, { t: 'invite', from: { clientId: inv.from, name: from.name, device: from.device }, lobbyId: inv.lobbyId, expiresAt: inv.expiresAt, quiet: !!l });
  }
  presenceChanged();
}

function closed(s: Session) {
  sessions.delete(s.id);
  if (!s.hello) return;
  if (!online(s.clientId)) {
    // eigene Einladungen verfallen, an diese Person gerichtete bleiben bis zum Ablauf
    for (const [k, inv] of invites) if (inv.from === s.clientId) dropInvite(k, `${s.name} ist offline`);
    const l = lobbies.get(lobbyOf.get(s.clientId) ?? '');
    if (l) {
      const mb = l.members.find((x) => x.clientId === s.clientId);
      if (mb) {
        mb.connected = false; mb.ready = false;
        toLobby(l, { t: 'partner', event: 'lost', name: mb.name }, s.clientId);
        maybeFinish(l);
        pushState(l);
      }
      const t = setTimeout(() => { grace.delete(s.clientId); leaveLobby(s.clientId, 'Verbindung verloren'); }, MP_GRACE_MS);
      t.unref?.();
      grace.set(s.clientId, t);
    }
  }
  presenceChanged();
}

/** Song geloescht oder neu erzeugt: Lobbys mit diesem Song informieren */
export function mpSongChanged(id: string, deleted: boolean) {
  for (const l of lobbies.values()) {
    if (l.song?.id !== id) continue;
    if (deleted) l.song = undefined;
    if (l.state === 'waiting' || l.state === 'results' || l.state === 'loading') {
      endLoading(l);
      l.state = 'waiting';
      if (deleted) l.note = 'Der Song wurde gelöscht';
      for (const m of l.members) m.ready = false;
    }
    pushState(l);
  }
}

export function multiplayerRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/mp`, { websocket: true }, (ws, req) => {
    const s: Session = {
      id: crypto.randomUUID(), ws, clientId: '', name: 'Spieler', device: 'desktop', status: 'menu', lastActive: Date.now(), alive: true,
      tokens: { fast: MP_RATE_FAST, slow: MP_RATE_SLOW * 2, t: Date.now() }, hello: false,
    };
    sessions.set(s.id, s);
    ws.on('pong', () => { s.alive = true; });
    ws.on('message', (data: Buffer, isBinary: boolean) => { s.alive = true; if (!isBinary) handle(s, data.toString(), req); });
    ws.on('close', () => closed(s));
    ws.on('error', () => { try { ws.terminate(); } catch { /* egal */ } });
  });
  // Heartbeat: wer zwei Runden nicht antwortet, wird getrennt
  setInterval(() => {
    for (const s of sessions.values()) {
      if (!s.alive) { try { s.ws.terminate(); } catch { /* egal */ } continue; }
      s.alive = false;
      try { s.ws.ping(); } catch { /* egal */ }
    }
  }, MP_HEARTBEAT_MS).unref();
}
