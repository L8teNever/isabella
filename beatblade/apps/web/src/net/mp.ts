// „Zusammen spielen“: WebSocket zum Server mit Neuverbindung (1 s, 2 s, 4 s … max. 15 s), Heartbeat,
// typisierten Nachrichten und Uhr-Abgleich (NTP-artig): serverNow() = performance.now() + offset.
import { MP_PROTOCOL, type MpClientMsg, type MpDevice, type MpLobby, type MpPerson, type MpServerMsg } from '@beatblade/core';
import { API } from '../api';
import { settings } from '../settings';

// ---------- Stellschrauben ----------
export const MP_HEARTBEAT_MS = 20_000;
export const MP_BACKOFF_MAX_MS = 15_000;
/** Uhr-Abgleich: so viele Proben, alle 30 s nachmessen */
export const MP_CLOCK_SAMPLES = 8;
export const MP_CLOCK_EVERY_MS = 30_000;
/** Proben mit mehr Laufzeit als (beste x Faktor) gelten als Ausreisser */
export const MP_CLOCK_OUTLIER = 2.5;

type Handler<T extends MpServerMsg['t']> = (m: Extract<MpServerMsg, { t: T }>) => void;
const CLIENT_KEY = 'beatblade-client-id';

/** einmalige Geraete-Kennung (lokal gespeichert) */
export function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) { id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^\w-]/g, ''); localStorage.setItem(CLIENT_KEY, id); }
    return id;
  } catch { return 'anon-' + Math.random().toString(36).slice(2); }
}

export function guessDevice(): MpDevice {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) && !/OculusBrowser|Quest/i.test(navigator.userAgent) ? 'phone' : 'desktop';
}

export class Mp {
  ws: WebSocket | null = null;
  connected = false;
  online: MpPerson[] = [];
  lobby: MpLobby | null = null;
  me = clientId();
  name = settings.name;
  device: MpDevice;
  /** Serverzeit = performance.now() + offset (ms) */
  offset = Date.now() - performance.now();
  clockOk = false;
  outdated = false;
  /** Lobby vor der Neuverbindung (um „Lobby wurde beendet“ zu erkennen) */
  hadLobby: string | null = null;
  private handlers = new Map<string, Set<(m: never) => void>>();
  private backoff = 1000;
  private beat: ReturnType<typeof setInterval> | null = null;
  private samples: { rtt: number; off: number }[] = [];
  private lastStatus: MpClientMsg | null = null;

  constructor(device: MpDevice) { this.device = device; }

  start() { this.connect(); }

  private url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${API}/mp`;
  }

  private connect() {
    if (this.outdated) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url()); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.raw({ t: 'hello', clientId: this.me, name: this.name, device: this.device, protocol: MP_PROTOCOL });
    };
    ws.onmessage = (e) => {
      let m: MpServerMsg; try { m = JSON.parse(e.data); } catch { return; }
      this.internal(m);
      for (const h of this.handlers.get(m.t) ?? []) { try { (h as (x: MpServerMsg) => void)(m); } catch (err) { console.error('[mp]', err); } }
      for (const h of this.handlers.get('*') ?? []) { try { (h as (x: MpServerMsg) => void)(m); } catch (err) { console.error('[mp]', err); } }
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false; this.ws = null;
      if (this.beat) { clearInterval(this.beat); this.beat = null; }
      if (was) this.emitLocal('disconnected');
      this.retry();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* egal */ } };
  }

  private retry() {
    if (this.outdated) return;
    const wait = this.backoff;
    this.backoff = Math.min(MP_BACKOFF_MAX_MS, this.backoff * 2);
    setTimeout(() => this.connect(), wait);
  }

  private internal(m: MpServerMsg) {
    if (m.t === 'welcome') {
      // Lobby schickt der Server gleich hinterher, falls es sie noch gibt (nach Server-Neustart nicht)
      this.hadLobby = this.lobby?.id ?? null; this.lobby = null;
      this.connected = true; this.online = m.online; this.name = m.you.name;
      this.clockOk = false; this.samples = []; this.measureClock();
      if (this.beat) clearInterval(this.beat);
      // Heartbeat (Cloudflare kappt Leerlauf) und regelmaessiger Uhr-Abgleich
      let n = 0;
      this.beat = setInterval(() => { if (++n * MP_HEARTBEAT_MS >= MP_CLOCK_EVERY_MS) { n = 0; this.measureClock(); } else this.raw({ t: 'ping', c: performance.now() }); }, MP_HEARTBEAT_MS);
      if (this.lastStatus) this.raw(this.lastStatus);
    } else if (m.t === 'outdated') { this.outdated = true; }
    else if (m.t === 'presence') this.online = m.online;
    else if (m.t === 'lobby.state') this.lobby = m.lobby;
    else if (m.t === 'pong') this.clockSample(m.c, m.s);
  }

  /** 8 Proben kurz hintereinander; die mit der kleinsten Laufzeit zaehlt */
  measureClock() {
    this.samples = [];
    for (let i = 0; i < MP_CLOCK_SAMPLES; i++) setTimeout(() => this.raw({ t: 'ping', c: performance.now() }), i * 120);
  }
  private clockSample(c: number, s: number) {
    const now = performance.now(), rtt = now - c;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push({ rtt, off: s - (c + rtt / 2) });
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    const good = this.samples.filter((x) => x.rtt <= best.rtt * MP_CLOCK_OUTLIER + 2);
    // aus den guten Proben die mit der kleinsten Laufzeit (am wenigsten verfaelscht)
    const pick = good.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    if (!this.clockOk || this.samples.length >= 3) { this.offset = pick.off; this.clockOk = true; }
  }

  /** Serverzeit (ms) -> lokale performance.now()-Zeit */
  toLocal(serverMs: number) { return serverMs - this.offset; }
  serverNow() { return performance.now() + this.offset; }

  private raw(m: MpClientMsg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  send(m: MpClientMsg) { if (m.t === 'status') this.lastStatus = m; this.raw(m); }

  on<T extends MpServerMsg['t']>(t: T, fn: Handler<T>): () => void;
  on(t: '*' | 'disconnected', fn: (m: MpServerMsg) => void): () => void;
  on(t: string, fn: (m: never) => void) {
    const set = this.handlers.get(t) ?? this.handlers.set(t, new Set()).get(t)!;
    set.add(fn);
    return () => set.delete(fn);
  }
  private emitLocal(t: string) { for (const h of this.handlers.get(t) ?? []) (h as () => void)(); }

  setName(n: string) { this.name = n; this.raw({ t: 'name', name: n }); }

  /** Anzeigename; bei gleichen Namen mit Geraet unterscheiden („Simon (Brille)“) */
  label(p: { name: string; device: MpDevice; clientId: string }): string {
    const twin = this.online.some((o) => o.clientId !== p.clientId && o.name === p.name);
    return twin ? `${p.name} (${DEVICE_LABEL[p.device]})` : p.name;
  }

  get isHost() { return !!this.lobby && this.lobby.hostId === this.me; }
  get myMember() { return this.lobby?.members.find((m) => m.clientId === this.me); }
  get partner() { return this.lobby?.members.find((m) => m.clientId !== this.me); }
}

export const DEVICE_LABEL: Record<MpDevice, string> = { vr: 'Brille', mr: 'Brille (MR)', desktop: 'PC', phone: 'Handy' };
export const STATUS_TEXT: Record<MpPerson['status'], string> = { menu: 'im Menü', lobby: 'in einer Lobby', playing: 'spielt', away: 'abwesend' };
