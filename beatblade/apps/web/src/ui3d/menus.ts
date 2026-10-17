// Menues im Headset: Hauptmenue, Song-Auswahl (Cover, Suche, Filter, Live-Status), Song-Detail
// (Schwierigkeit, Seed, Modifikatoren, Highscores), Einstellungen, Credits, QR-Upload, Kalibrierung,
// Pause und Ergebnis. Bedienung per Laserpointer, Trigger/Pinch = Klick.
import * as THREE from 'three';
import qrcode from 'qrcode-generator';
import { BUILD_INFO } from '../version';
import { colorPair, colorSets, currentSet, shiftHue, toHex, HUE_STEP, blockName, blockSkins, currentBlock, saberName, saberSkins, currentSaber, mapItems, wallItems, mapName, wallName, content, orbItems, orbNoteItems, currentOrb, currentOrbNote, orbName, orbNoteName } from '../look';
import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty, type Highscore, type Song } from '@beatblade/core';
import { Panel, type Item, type Spec } from './panel';
import { api, contentUrl, STATUS_LABEL, playable, fmtTime, type Credit, type ScItem, type YtStatus } from '../api';
import { settings, saveSettings } from '../settings';
import { starString, starsFor, type ScoreKeeper } from '../game/score';
import { OrbitScore } from '../game/orbit/orbitscore';
import { MODE_LABEL, type ModeId } from '../game/mode';
import { DEVICE_LABEL, STATUS_TEXT, type Mp } from '../net/mp';
import type { MpDevice, MpResultLine, MpSharedModifiers } from '@beatblade/core';
import type { DuetScore } from '../api';

export interface MenuActions {
  play(song: Song, d: Difficulty, seed: number): void;
  resume(): void; restart(): void; quitToMenu(): void;
  exitXR(): void;
  calibrateLatency(): Promise<number | null>;
  setFloor(): void; setDirection(): void;
  isMR(): boolean; inXR(): boolean;
  applySettings(): void;
  /** Duett: laufendes Spiel beenden und in die Lobby (optional) */
  toLobby?(): void;
}

type Screen = 'main' | 'songs' | 'detail' | 'settings' | 'credits' | 'qr' | 'keyboard' | 'loading' | 'pause' | 'results' | 'calibrate' | 'pick' | 'sc'
  | 'online' | 'lobby' | 'invite' | 'duetresults';
type PickKind = 'maps' | 'colors' | 'blocks' | 'sabers' | 'sabersR' | 'walls' | 'orbs' | 'orbnotes';
const PICK_TITLE: Record<PickKind, string> = { maps: 'Map wählen', colors: 'Farben wählen', blocks: 'Blöcke wählen', sabers: 'Schwert wählen (links / beide)', sabersR: 'Schwert rechts wählen', walls: 'Wände wählen', orbs: 'Handkugeln wählen (Orbit)', orbnotes: 'Orbit-Noten wählen' };
const PICK_PER_PAGE = 9;

const PER_PAGE = 6;

type Tab = 'spiel' | 'aussehen' | 'audio' | 'komfort' | 'mehr';
const TABS: [Tab, string][] = [['spiel', 'Spiel'], ['aussehen', 'Aussehen'], ['audio', 'Audio'], ['komfort', 'Komfort'], ['mehr', 'Mehr']];
/** Bildschirme, bei denen die Lobby (Bestenliste links, Einstellungen rechts) mit angezeigt wird */
const LOBBY: Screen[] = ['main', 'songs', 'detail', 'credits', 'qr', 'keyboard', 'calibrate', 'pick', 'sc', 'online', 'lobby', 'invite'];
const SC_PER_PAGE = 5;

export class Menus {
  /** Mitte: Song-Auswahl, Song-Detail mit Starten, Pause, Ergebnis */
  panel = new Panel(1.5);
  /** links: Bestenliste zum gewaehlten Song */
  board = new Panel(1.05);
  /** rechts: Einstellungen in Gruppen */
  side = new Panel(1.3);
  private tab: Tab = 'aussehen';
  private pickKind: PickKind = 'maps';
  private pickPage = 0;
  private thumbs = new Map<string, HTMLImageElement>();
  // SoundCloud in VR: Treffer, Seite, Hinweis, Status je Song-Link, Download-Job -> Link
  private scItems: ScItem[] = [];
  private scPage = 0;
  private scInfo = 'Suche nach Songs oder öffne deine Likes.';
  private scState = new Map<string, string>();
  private scJobs = new Map<string, string>();
  private scCovers = new Map<string, HTMLImageElement>();
  screen: Screen = 'songs';
  songs: Song[] = [];
  private page = 0;
  private filter: 'all' | 'bundled' | 'uploaded' = 'all';
  private sort: 'new' | 'title' | 'bpm' = 'new';
  private search = '';
  private sel: Song | null = null;
  private diff: Difficulty = settings.difficulty;
  private seed: number | null = null;
  private scores: Highscore[] = [];
  /** Bestwert je Song fuer die aktuelle Schwierigkeit (Song-Liste) */
  private best: Record<string, { accuracy: number; rank: string; score: number }> = {};
  private covers = new Map<string, HTMLImageElement>();
  private credits: Credit[] = [];
  private kb: { title: string; value: string; done: (v: string) => void; back: Screen } | null = null;
  private loadingText = ''; private loadingP = 0;
  private result: { s: ScoreKeeper; song: Song; d: Difficulty; mode: ModeId; saved: boolean } | null = null;
  private qrUrl = '';
  private calibText = '';
  private backStack: Screen[] = [];
  // ---------- Zusammen spielen ----------
  /** Verbindung zum Mehrspieler-Server (setzt play.ts) */
  mp: Mp | null = null;
  /** offene Einladungen (neueste zuletzt) */
  invites: { from: { clientId: string; name: string; device: MpDevice }; lobbyId: string; expiresAt: number }[] = [];
  private duetResult: { results: MpResultLine[]; team: { accuracy: number; score: number }; ranked: boolean; song: Song | null; d: Difficulty; mode: ModeId } | null = null;
  private duetScores: DuetScore[] = [];
  private mpTimer: ReturnType<typeof setInterval> | null = null;
  /** Hinweis in der Lobby (Fehler vom Server etc.) */
  mpNote = '';

  constructor(parent: THREE.Object3D, private act: MenuActions) {
    parent.add(this.panel, this.board, this.side);
    this.place();
  }

  /** kleine Lobby: alles in Reichweite um den Spieler, ohne sich bewegen zu muessen */
  place() {
    this.panel.position.set(0, 1.45, -1.6); this.panel.rotation.set(0, 0, 0);
    this.board.position.set(-1.45, 1.45, -1.15); this.board.rotation.set(0, 0.8, 0);
    this.side.position.set(1.55, 1.45, -1.05); this.side.rotation.set(0, -0.8, 0);
  }

  private panels(): [string, Panel][] { return [['', this.panel], ['L:', this.board], ['R:', this.side]]; }

  /** Laserpointer: naechste getroffene Tafel; Knoepfe der Seitentafeln mit Praefix L:/R: */
  pick(ray: THREE.Raycaster): string | null {
    let best: { d: number; id: string | null } | null = null;
    for (const [pre, p] of this.panels()) {
      if (!p.visible) continue;
      const d = p.hits(ray); if (d === null || d === undefined) continue;
      if (!best || d < best.d) { const id = p.pick(ray); best = { d, id: id ? pre + id : null }; }
    }
    return best?.id ?? null;
  }
  hits(ray: THREE.Raycaster): number | null {
    let best: number | null = null;
    for (const [, p] of this.panels()) { if (!p.visible) continue; const d = p.hits(ray); if (d !== null && d !== undefined && (best === null || d < best)) best = d; }
    return best;
  }
  setHover(id: string | null) {
    for (const [pre, p] of this.panels()) {
      if (!p.visible) continue;
      const mine = id && (pre ? id.startsWith(pre) : !id.startsWith('L:') && !id.startsWith('R:')) ? id.slice(pre.length) : null;
      p.setHover(mine);
    }
  }

  // ---------- Daten ----------
  /** Bestwerte neu holen (Start, Schwierigkeit gewechselt, Ergebnis gespeichert) */
  loadBest() { const d = this.diff, m = this.mode; api.best(d, m).then((b) => { if (this.diff === d && this.mode === m) { this.best = b; this.refresh(); } }).catch(() => {}); }
  /** gewaehlter Spielmodus (global gemerkt) */
  get mode(): ModeId { return settings.gameMode === 'orbit' ? 'orbit' : 'schnitt'; }
  private setMode(m: ModeId) { if (m === this.mode) return; settings.gameMode = m; saveSettings(); this.best = {}; this.scores = []; this.loadBest(); this.loadScores(); this.refresh(); }

  setSongs(list: Song[]) { this.songs = list; this.loadBest(); if (this.sel) this.sel = list.find((s) => s.id === this.sel!.id) ?? this.sel; this.refresh(); }
  upsertSong(s: Song) { const i = this.songs.findIndex((x) => x.id === s.id); if (i >= 0) this.songs[i] = s; else this.songs.unshift(s); if (this.sel?.id === s.id) this.sel = s; this.refresh(); }
  removeSong(id: string) { this.songs = this.songs.filter((s) => s.id !== id); this.refresh(); }
  setQr(url: string) { this.qrUrl = url; }

  private cover(s: Song): HTMLImageElement | null {
    const url = api.coverUrl(s); if (!url) return null;
    let img = this.covers.get(s.id + s.updatedAt);
    if (!img) { img = new Image(); img.onload = () => this.refresh(); img.src = url; this.covers.set(s.id + s.updatedAt, img); }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** Vorschaubild eines Inhalts (aus content/<kategorie>/<name>/preview.*) */
  private thumb(rel?: string): HTMLImageElement | null {
    if (!rel) return null;
    let img = this.thumbs.get(rel);
    if (!img) { img = new Image(); img.onload = () => this.refresh(); img.src = contentUrl(rel); this.thumbs.set(rel, img); }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** Farbfeld fuer ein Farbset: links/rechts als zwei Haelften */
  private swatch(l: number, r: number): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = toHex(l); g.fillRect(0, 0, 32, 64); g.fillStyle = toHex(r); g.fillRect(32, 0, 32, 64);
    return c;
  }

  /** Karten fuer die Auswahl: id, Name, Beschreibung, Bild, ausgewaehlt */
  private pickCards(): { id: string; name: string; desc: string; img: CanvasImageSource | null; on: boolean }[] {
    const k = this.pickKind;
    if (k === 'colors') return colorSets().map((c) => ({ id: c.id, name: c.name, desc: content('colors', c.id)?.description ?? '', img: this.swatch(c.left, c.right), on: c.id === currentSet().id }));
    if (k === 'maps') return [{ id: 'zufall', name: 'Zufällig', desc: 'Jeder Song bekommt eine zufällige Map.', img: null, on: settings.mapChoice === 'zufall' },
      ...mapItems().map((m) => ({ id: m.id, name: m.name, desc: m.description, img: this.thumb(m.preview), on: settings.mapChoice === m.id }))];
    if (k === 'walls') return [{ id: 'auto', name: 'Automatisch', desc: 'Die Wand, die zur Map passt.', img: null, on: settings.wallSkin === 'auto' },
      ...wallItems().map((w) => ({ id: w.id, name: w.name, desc: w.description, img: this.thumb(w.preview), on: settings.wallSkin === w.id }))];
    if (k === 'sabersR') return [{ id: '', name: 'Wie links', desc: 'Rechts dasselbe Schwert wie links.', img: null, on: !settings.saberSkinRight },
      ...saberSkins().map((b) => ({ id: b.id, name: b.name, desc: b.description, img: this.thumb(b.preview), on: settings.saberSkinRight === b.id }))];
    const list = k === 'blocks' ? blockSkins() : k === 'orbs' ? orbItems() : k === 'orbnotes' ? orbNoteItems() : saberSkins();
    const cur = k === 'blocks' ? currentBlock()?.id : k === 'orbs' ? currentOrb()?.id : k === 'orbnotes' ? currentOrbNote()?.id : currentSaber()?.id;
    return list.map((b) => ({ id: b.id, name: b.name, desc: b.description, img: this.thumb(b.preview), on: b.id === cur }));
  }

  // ---------- SoundCloud direkt in VR ----------
  private scCover(u: string | null): HTMLImageElement | null {
    if (!u) return null;
    let img = this.scCovers.get(u);
    if (!img) { img = new Image(); img.onload = () => this.refresh(); img.src = api.scCover(u); this.scCovers.set(u, img); }
    return img.complete && img.naturalWidth ? img : null;
  }
  private inLibrary(url: string) { return this.songs.some((s) => s.source === url); }
  private scShow(items: ScItem[], info: string) { this.scItems = items; this.scPage = 0; this.scInfo = info; this.refresh(); }
  private scSearch(q: string) {
    if (!q.trim()) return;
    this.scShow([], `Suche „${q}“ …`);
    api.scSearch(q).then((l) => this.scShow(l, l.length ? `${l.length} Treffer für „${q}“` : `Nichts gefunden für „${q}“.`)).catch((e) => this.scShow([], (e as Error).message));
  }
  private scList(what: 'likes' | 'tracks') {
    const label = what === 'likes' ? 'Deine Likes' : 'Deine Tracks';
    this.scShow([], `${label} werden geladen …`);
    api.scList(what).then((r) => this.scShow(r.items, r.items.length ? `${label}: ${r.items.length} Songs` : `${label}: keine Songs gefunden.`)).catch((e) => this.scShow([], (e as Error).message));
  }
  /** eigenes Profil fehlt: per Tastatur eintragen, dann Liste laden */
  private scMine(what: 'likes' | 'tracks') {
    api.scProfile().then((p) => {
      if (p.profile) return this.scList(what);
      this.keyboard('Dein SoundCloud-Profilname', '', (v) => { api.scProfileSet(v).then(() => this.scList(what)).catch((e) => this.scShow([], (e as Error).message)); });
    }).catch(() => this.scList(what));
  }
  private scAdd(it: ScItem) {
    if (this.scState.has(it.url) || this.inLibrary(it.url)) return;
    this.scState.set(it.url, 'Wird geladen …'); this.refresh();
    api.youtube(it.url).then((r) => this.scJobs.set(r.job, it.url)).catch((e) => { this.scState.set(it.url, (e as Error).message); this.refresh(); });
  }
  /** Fortschritt eines Downloads (SSE 'yt') */
  ytUpdate(s: YtStatus) {
    const url = this.scJobs.get(s.job); if (!url) return;
    const txt: Record<YtStatus['state'], string> = { warten: 'Wartet …', laden: `Lädt ${s.percent ?? 0} %`, umwandeln: 'Wandelt um …', import: 'Wird übernommen …', fertig: s.duplicate ? 'Schon vorhanden' : 'Wird analysiert …', fehler: s.message ?? 'Fehler' };
    this.scState.set(url, txt[s.state]);
    if (s.state === 'fertig' || s.state === 'fehler') this.scJobs.delete(s.job);
    if (this.screen === 'sc') this.refresh();
  }
  private scStatus(url: string): string {
    const song = this.songs.find((x) => x.source === url);
    if (song) return playable(song) ? 'In der Bibliothek ✓' : `${STATUS_LABEL[song.status]} ${Math.round(song.progress * 100)} %`;
    return this.scState.get(url) ?? (this.scItems.find((i) => i.url === url)?.tooLong ? 'zu lang' : '');
  }

  /** Auswahl-Menue oeffnen (mit Vorschaubildern) */
  openPicker(kind: PickKind) { this.pickKind = kind; const i = this.pickCards().findIndex((c) => c.on); this.pickPage = Math.max(0, Math.floor(i / PICK_PER_PAGE)); this.go('pick'); }

  private visibleSongs(): Song[] {
    let l = this.songs.filter((s) => !s.hidden && (this.filter === 'all' || (this.filter === 'bundled' ? s.bundled : !s.bundled)));
    if (this.search) { const q = this.search.toLowerCase(); l = l.filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q)); }
    const cmp = { new: (a: Song, b: Song) => b.createdAt - a.createdAt, title: (a: Song, b: Song) => a.title.localeCompare(b.title, 'de'), bpm: (a: Song, b: Song) => (a.bpm ?? 999) - (b.bpm ?? 999) };
    return l.sort(cmp[this.sort]);
  }

  // ---------- Navigation ----------
  go(s: Screen, push = true) { if (s === 'main') s = 'songs'; this.tickInvite(s === 'invite'); if (push && this.screen !== s && !['loading', 'pause', 'results'].includes(this.screen)) this.backStack.push(this.screen); this.screen = s; this.refresh(); }
  back() { this.screen = this.backStack.pop() ?? 'songs'; this.refresh(); }
  show() { this.panel.visible = true; this.refresh(); }
  hide() { this.panel.hide(); this.board.hide(); this.side.hide(); if (this.screen === 'loading') this.screen = 'songs'; }
  get visible() { return this.panel.visible; }

  loading(text: string, p: number) { this.loadingText = text; this.loadingP = p; if (this.screen !== 'loading') { this.screen = 'loading'; } this.panel.visible = true; this.refresh(); }
  pause() { this.screen = 'pause'; this.show(); }
  results(s: ScoreKeeper, song: Song, d: Difficulty, mode: ModeId = 'schnitt') { this.result = { s, song, d, mode, saved: false }; this.scores = []; this.screen = 'results'; this.show(); api.scores(song.id, d, mode).then((x) => { this.scores = x; this.refresh(); }).catch(() => {}); }
  calibration(text: string) { this.calibText = text; this.screen = 'calibrate'; this.show(); }

  refresh() {
    // nur zeichnen, wenn das Menue sichtbar ist – sonst holt ein Song-Update (z. B. Level neu erzeugt)
    // waehrend des Spiels den alten 'Level laden …'-Bildschirm zurueck
    if (!this.panel.visible) return;
    const spec = this.build();
    this.panel.show(spec);
    if (LOBBY.includes(this.screen)) { this.board.show(this.buildBoard()); this.side.show(this.buildSettings()); }
    else { this.board.hide(); this.side.hide(); }
  }

  // ---------- Lobby: Bestenliste ----------
  private buildBoard(): Spec {
    const s = this.sel;
    if (!s || !['detail'].includes(this.screen)) return { title: 'Bestenliste', cols: 1, items: [
      { type: 'text', text: 'Wähle in der Mitte einen Song – hier erscheinen dann die besten Ergebnisse.', size: 28, color: '#b8b0d6' },
      { type: 'text', text: BUILD_INFO, align: 'center', size: 20, color: '#8a84a8' },
    ] };
    const rows = this.scores.slice(0, 10);
    return { title: 'Bestenliste', subtitle: `${s.title} · ${DIFFICULTY_LABEL[this.diff]} · ${MODE_LABEL[this.mode]}`, cols: 1, items: rows.length
      ? rows.map((h, i) => ({ type: 'text', text: `${i + 1}.  ${h.name}   ${h.accuracy.toFixed(1)} %  ${h.rank}   ${h.score.toLocaleString('de-DE')}`, size: 28, color: i === 0 ? '#ffd23c' : i < 3 ? '#ffffff' : '#d8d0f0' }) as Item)
      : [{ type: 'text', text: 'Noch keine Einträge. Spiel den Song und speichere dein Ergebnis!', size: 28, color: '#b8b0d6' }] };
  }

  // ---------- Lobby: Einstellungen (rechts, in Gruppen) ----------
  private buildSettings(): Spec {
    const C = 20;
    const row = (id: string, label: string, value: string): Item[] => [
      { type: 'button', id: `${id}-`, label: '−', span: 5, h: 64 }, { type: 'text', text: `${label}: ${value}`, align: 'center', size: 26, span: 10 }, { type: 'button', id: `${id}+`, label: '+', span: 5, h: 64 },
    ];
    const colorRow = (id: string, label: string, c: number, custom: boolean): Item[] => [
      { type: 'button', id: `${id}-`, label: '◀', span: 5, h: 64 },
      { type: 'text', text: `■■  ${label}${custom ? ' (eigene)' : ''}  ■■`, color: toHex(c), align: 'center', size: 28, span: 10 },
      { type: 'button', id: `${id}+`, label: '▶', span: 5, h: 64 },
    ];
    const tog = (id: keyof typeof settings, label: string): Item => ({ type: 'button', id: `t:${id}`, label: `${label} ${settings[id] ? '✓' : '✗'}`, on: !!settings[id], span: 10, h: 64 });
    const full = (id: string, label: string, extra: Partial<Item> = {}): Item => ({ type: 'button', id, label, span: C, h: 64, ...extra } as Item);
    const half = (id: string, label: string): Item => ({ type: 'button', id, label, span: 10, h: 64 });
    const tabs: Item[] = TABS.map(([t, l]) => ({ type: 'button', id: `tab:${t}`, label: l, on: this.tab === t, span: 4, h: 64 }) as Item);
    let items: Item[] = [];
    if (this.tab === 'spiel') items = [
      full('arrows', `Pfeile: ${settings.arrows === 'pflicht' ? 'Pflicht (Richtung zählt)' : 'egal (nur treffen)'}`, { on: settings.arrows === 'egal' } as Partial<Item>),
      tog('missMute', 'Verfehlt = stumm'), tog('leftHanded', 'Linkshänder'),
      tog('partnerNotes', 'Partner-Noten (Duett)'), { type: 'text', text: '', span: 10 },
      full('name', `Name: ${settings.name}`),
    ];
    else if (this.tab === 'aussehen') items = [
      half('cset', `Farben: ${currentSet().name} ›`), half('bskin', `Blöcke: ${blockName()} ›`),
      ...colorRow('cl', 'Links', colorPair()[0], !!settings.colorLeft),
      ...colorRow('cr', 'Rechts', colorPair()[1], !!settings.colorRight),
      ...(settings.colorLeft || settings.colorRight ? [full('creset', 'Eigene Farben zurücksetzen')] : []),
      half('sskin', `Schwert links: ${saberName(0)} ›`), half('sskinr', `Schwert rechts: ${settings.saberSkinRight ? saberName(1) : 'wie links'} ›`),
      half('oskin', `Handkugeln: ${orbName()} ›`), half('onskin', `Orbit-Noten: ${orbNoteName()} ›`),
      half('mapc', `Map: ${mapName()} ›`), half('wallc', `Wände: ${wallName().replace(' (passend zur Map)', '')} ›`),
      tog('glow', 'Leuchten'), { type: 'text', text: '', span: 10 },
      ...row('lgt', 'Lichteffekte', `${Math.round(settings.lightIntensity * 100)} %`),
    ];
    else if (this.tab === 'audio') items = [
      ...row('vol', 'Lautstärke', `${Math.round(settings.volume * 100)} %`),
      ...row('lat', 'Latenz', `${settings.latencyMs} ms`),
      full('calib', 'Latenz kalibrieren'),
    ];
    else if (this.tab === 'komfort') items = [
      tog('comfort', 'Komfortmodus'), tog('showFps', 'FPS-Anzeige'),
      ...row('off', 'Schwert-Offset', `${settings.saberOffsetCm} cm`),
      ...row('ang', 'Schwert-Winkel', `${settings.saberAngle}°`),
      ...row('hgt', 'Spielergröße', `${settings.playerHeight.toFixed(2)} m`),
      ...(this.act.isMR() ? [half('floor', 'Boden setzen'), half('dir', 'Richtung setzen')] : [full('dir', 'Spielfeld zentrieren')]),
    ];
    else items = [
      half('qr', 'Upload vom Handy'), half('credits', 'Credits'),
      ...(this.act.inXR() ? [full('exit', 'Beenden', { main: true } as Partial<Item>)] : []),
      { type: 'text', text: BUILD_INFO, align: 'center', size: 20, color: '#8a84a8' },
    ];
    return { title: 'Einstellungen', cols: C, items: [...tabs, { type: 'gap', h: 6 }, ...items] };
  }

  private settingsClick(id: string) {
    if (id.startsWith('tab:')) { this.tab = id.slice(4) as Tab; return this.refresh(); }
    if (id === 'credits') return this.go('credits');
    if (id === 'qr') return this.go('qr');
    if (id === 'exit') return this.act.exitXR();
    const step = (k: string, d: number) => {
      if (k === 'lat') settings.latencyMs = Math.max(-300, Math.min(500, settings.latencyMs + d * 5));
      if (k === 'off') settings.saberOffsetCm = Math.max(-20, Math.min(30, settings.saberOffsetCm + d));
      if (k === 'ang') settings.saberAngle = Math.max(-45, Math.min(60, settings.saberAngle + d * 5));
      if (k === 'hgt') settings.playerHeight = Math.round(Math.max(1.2, Math.min(2.2, settings.playerHeight + d * 0.05)) * 100) / 100;
      if (k === 'vol') settings.volume = Math.round(Math.max(0, Math.min(1, settings.volume + d * 0.1)) * 10) / 10;
      if (k === 'cl') settings.colorLeft = toHex(shiftHue(colorPair()[0], d * HUE_STEP));
      if (k === 'cr') settings.colorRight = toHex(shiftHue(colorPair()[1], d * HUE_STEP));
      if (k === 'lgt') settings.lightIntensity = Math.round(Math.max(0, Math.min(1, settings.lightIntensity + d * 0.1)) * 10) / 10;
    };
    const m = id.match(/^(\w+)([+-])$/);
    if (m) step(m[1], m[2] === '+' ? 1 : -1);
    else if (id.startsWith('t:')) { const k = id.slice(2) as 'leftHanded' | 'comfort' | 'showFps' | 'missMute' | 'glow' | 'partnerNotes'; settings[k] = !settings[k]; }
    else if (id === 'arrows') settings.arrows = settings.arrows === 'pflicht' ? 'egal' : 'pflicht';
    else if (id === 'cset') return this.openPicker('colors');
    else if (id === 'creset') settings.colorLeft = settings.colorRight = null;
    else if (id === 'mapc') return this.openPicker('maps');
    else if (id === 'wallc') return this.openPicker('walls');
    else if (id === 'sskin') return this.openPicker('sabers');
    else if (id === 'sskinr') return this.openPicker('sabersR');
    else if (id === 'bskin') return this.openPicker('blocks');
    else if (id === 'oskin') return this.openPicker('orbs');
    else if (id === 'onskin') return this.openPicker('orbnotes');
    else if (id === 'name') return this.keyboard('Spielername', settings.name, (v) => { settings.name = v.trim().slice(0, 20) || 'Spieler'; saveSettings(); this.act.applySettings(); });
    else if (id === 'floor') this.act.setFloor();
    else if (id === 'dir') this.act.setDirection();
    else if (id === 'calib') return this.go('calibrate');
    saveSettings(); this.act.applySettings(); this.refresh();
  }

  private build(): Spec {
    switch (this.screen) {
      case 'main': case 'settings':   // gibt es nicht mehr: Lobby beginnt mit der Song-Auswahl
      case 'songs': {
        const list = this.visibleSongs(), pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
        this.page = Math.min(this.page, pages - 1);
        const items: Item[] = [
          { type: 'button', id: 'f:all', label: 'Alle', on: this.filter === 'all', h: 64 },
          { type: 'button', id: 'f:bundled', label: 'Mitgeliefert', on: this.filter === 'bundled', h: 64 },
          { type: 'button', id: 'f:uploaded', label: 'Hochgeladen', on: this.filter === 'uploaded', h: 64 },
          { type: 'button', id: 'sort', label: `Sortierung: ${{ new: 'Neu', title: 'Titel', bpm: 'BPM' }[this.sort]}`, h: 64 },
          { type: 'button', id: 'search', label: this.search ? `Suche: ${this.search}` : '🔍 Suchen', h: 64, span: 2 },
          { type: 'button', id: 'scopen', label: '＋ Songs hinzufügen (SoundCloud)', h: 64, span: 2, main: false, color: '#ff7a1a' },
          { type: 'button', id: 'mode', label: `Modus: ${MODE_LABEL[this.mode]} ⇄`, h: 64, on: this.mode === 'orbit' },
          ...(this.mp ? [this.togetherButton()] : []),
        ];
        for (const s of list.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE)) {
          const ok = playable(s);
          const b = this.best[s.id];
          const bestTxt = b ? ` · Bestwert ${b.accuracy.toFixed(1)} % ${starString(starsFor(b.accuracy))}` : '';
          const status = ok ? `${s.artist || 'Unbekannt'} · ${fmtTime(s.duration)}${s.bpm ? ` · ${Math.round(s.bpm)} BPM` : ''}${bestTxt}` : `${STATUS_LABEL[s.status]}${['ready', 'error'].includes(s.status) ? '' : ` ${Math.round(s.progress * 100)} %`}`;
          items.push({ type: 'button', id: `s:${s.id}`, label: s.title, sub: status, img: this.cover(s), disabled: !ok, span: 2, h: 110 });
        }
        if (!list.length) items.push({ type: 'text', text: this.songs.length ? 'Keine Treffer.' : 'Noch keine Songs. Über „Upload vom Handy“ welche hinzufügen.', align: 'center' });
        items.push({ type: 'button', id: 'prev', label: '◀', disabled: this.page === 0 }, { type: 'text', text: `${this.page + 1} / ${pages}`, align: 'center', span: 1 }, { type: 'button', id: 'next', label: '▶', disabled: this.page >= pages - 1 });
        return { title: 'Song wählen', subtitle: `${list.length} Songs · Bestwerte ${MODE_LABEL[this.mode]} ${DIFFICULTY_LABEL[this.diff]} · neue erscheinen automatisch`, cols: 3, items: items.map((i) => (i.type === 'button' && i.span === 2 ? { ...i, span: 3 } : i)) };
      }
      case 'detail': {
        const s = this.sel!; const img = this.cover(s);
        const orbit = this.mode === 'orbit';
        const have = orbit ? (s.orbitDifficulties ?? []) : s.difficulties;
        const diffs = DIFFICULTIES.filter((d) => have.includes(d));
        if (diffs.length && !diffs.includes(this.diff)) this.diff = diffs.includes('normal') ? 'normal' : diffs[0];
        // klar gegliedert: Cover, Infos, Schwierigkeit gross, Modifikatoren, Starten
        const C = 60, dSpan = Math.floor(C / diffs.length);
        const mod = (id: string, label: string, on: boolean): Item => ({ type: 'button', id, label: `${label} ${on ? '✓' : ''}`, on, span: 20, h: 70 });
        const items: Item[] = [
          ...(img ? [{ type: 'image', img, h: 220 } as Item] : []),
          { type: 'text', text: `${s.artist || 'Unbekannt'} · ${fmtTime(s.duration)} · ${s.bpm ? Math.round(s.bpm) + ' BPM' : ''}${s.license ? ' · ' + s.license.split(' – ')[0] : ''}`, align: 'center', size: 28 },
          { type: 'button', id: 'mode:schnitt', label: '⚔  Schnitt', sub: 'Blöcke schneiden', on: !orbit, span: 30, h: 84 },
          { type: 'button', id: 'mode:orbit', label: '◉  Orbit', sub: 'Kugeln berühren, Rails folgen', on: orbit, span: 30, h: 84 },
          ...(diffs.length
            ? diffs.map((d) => ({ type: 'button', id: `d:${d}`, label: DIFFICULTY_LABEL[d], on: this.diff === d, span: dSpan, h: 84 }) as Item)
            : [{ type: 'text', text: 'Orbit-Level werden gerade erzeugt – gleich geht es los.', align: 'center', size: 26, color: '#ffd9a0' } as Item]),
          { type: 'gap', h: 6 },
          ...(orbit
            ? [mod('m:fastNotes', 'Schneller', settings.fastNotes), { ...mod('m:noWalls', 'Keine Wände', settings.noWalls), span: 40 } as Item]
            : [mod('m:fastNotes', 'Schneller', settings.fastNotes), mod('m:noWalls', 'Keine Wände', settings.noWalls), mod('m:noBombs', 'Keine Bomben', settings.noBombs)]),
          { type: 'button', id: 'seed', label: `Variante ${this.seed ?? s.seed} ⟳`, span: 30, h: 70 },
          { type: 'button', id: 'back', label: 'Zurück', span: 30, h: 70 },
          ...(this.mp?.lobby && this.mp.isHost ? this.lobbyPlayButtons(s, diffs.length > 0) : [{ type: 'button', id: 'play', label: `▶  Starten (${MODE_LABEL[this.mode]})`, main: true, h: 120, disabled: !diffs.length } as Item]),
        ];
        return { title: s.title, cols: C, items };
      }
      case 'pick': {
        const cards = this.pickCards(), pages = Math.max(1, Math.ceil(cards.length / PICK_PER_PAGE));
        this.pickPage = Math.min(this.pickPage, pages - 1);
        const items: Item[] = cards.slice(this.pickPage * PICK_PER_PAGE, (this.pickPage + 1) * PICK_PER_PAGE).map((c) => ({
          type: 'button', id: `pk:${c.id}`, label: `${c.on ? '✓ ' : ''}${c.name}`, img: c.img, on: c.on, h: 150,
        }) as Item);
        items.push({ type: 'gap', h: 4 });
        if (pages > 1) items.push({ type: 'button', id: 'pkprev', label: '◀', disabled: this.pickPage === 0 }, { type: 'text', text: `${this.pickPage + 1} / ${pages}`, align: 'center', span: 1 }, { type: 'button', id: 'pknext', label: '▶', disabled: this.pickPage >= pages - 1 });
        items.push({ type: 'button', id: 'back', label: 'Fertig', main: true });
        const cur = cards.find((c) => c.on);
        return { title: PICK_TITLE[this.pickKind], subtitle: cur ? `${cur.name}: ${cur.desc}` : 'Antippen zum Auswählen', cols: 3, items };
      }
      case 'sc': {
        const pages = Math.max(1, Math.ceil(this.scItems.length / SC_PER_PAGE));
        this.scPage = Math.min(this.scPage, pages - 1);
        const items: Item[] = [
          { type: 'button', id: 'scsearch', label: '🔍 Suchen', h: 72 },
          { type: 'button', id: 'sclikes', label: '♥ Meine Likes', h: 72 },
          { type: 'button', id: 'sctracks', label: 'Meine Tracks', h: 72 },
          { type: 'text', text: this.scInfo, align: 'center', size: 26, color: '#b8b0d6', span: 3 },
        ];
        for (const it of this.scItems.slice(this.scPage * SC_PER_PAGE, (this.scPage + 1) * SC_PER_PAGE)) {
          const st = this.scStatus(it.url), busy = !!st;
          items.push({ type: 'button', id: `sca:${it.url}`, label: `${busy ? '' : '＋ '}${it.title}`, sub: `${it.artist}${it.duration ? ` · ${fmtTime(it.duration)}` : ''}${st ? ` · ${st}` : ''}`, img: this.scCover(it.cover), disabled: busy, span: 3, h: 108 });
        }
        const addable = this.scItems.filter((i) => !this.scStatus(i.url));
        if (this.scItems.length) items.push({ type: 'button', id: 'scprev', label: '◀', disabled: this.scPage === 0 }, { type: 'text', text: `${this.scPage + 1} / ${pages}`, align: 'center', span: 1 }, { type: 'button', id: 'scnext', label: '▶', disabled: this.scPage >= pages - 1 });
        if (addable.length > 1) items.push({ type: 'button', id: 'scall', label: `Alle ${addable.length} hinzufügen`, span: 3, h: 70 });
        items.push({ type: 'button', id: 'back', label: 'Zurück', main: true });
        return { title: 'Songs hinzufügen', subtitle: 'SoundCloud · fertige Songs erscheinen automatisch in der Liste', cols: 3, items };
      }
      case 'credits':
        if (!this.credits.length) api.credits().then((c) => { this.credits = c; this.refresh(); }).catch(() => {});
        return { title: 'Credits', cols: 1, items: [
          { type: 'text', text: 'BeatBlade – eigenes Design, Spielprinzip angelehnt an Rhythmus-Spiele mit Lichtschwertern.', size: 26 },
          ...this.credits.map((c) => ({ type: 'text', text: `„${c.title}“ – ${c.artist} · ${c.license}\n${c.attribution}`, size: 22, color: '#d8d0f0' }) as Item),
          { type: 'button', id: 'back', label: 'Zurück', main: true },
        ] };
      case 'qr': {
        const url = this.qrUrl;
        const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
        const n = qr.getModuleCount(), px = 8, c = document.createElement('canvas'); c.width = c.height = (n + 8) * px;
        const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
        for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) g.fillRect((col + 4) * px, (r + 4) * px, px, px);
        return { title: 'Upload vom Handy', cols: 1, items: [
          { type: 'text', text: 'QR-Code mit dem Handy scannen und dort Songs hochladen. Sie erscheinen hier automatisch, sobald die Analyse fertig ist.', size: 26 },
          { type: 'image', img: c, h: 420 },
          { type: 'text', text: url, align: 'center', size: 26, color: '#3db8ff' },
          { type: 'button', id: 'back', label: 'Zurück', main: true },
        ] };
      }
      case 'keyboard': {
        const k = this.kb!;
        const keys = 'QWERTZUIOPASDFGHJKLYXCVBNM0123456789_'.split('');
        return { title: k.title, subtitle: `${k.value}▏`, cols: 10, items: [
          ...keys.map((ch) => ({ type: 'button', id: `k:${ch}`, label: ch, h: 66 }) as Item),
          { type: 'button', id: 'k: ', label: 'Leer', span: 3, h: 66 }, { type: 'button', id: 'k:-', label: '-', h: 66 },
          { type: 'button', id: 'kdel', label: '⌫', span: 2, h: 66 }, { type: 'button', id: 'kclr', label: 'Löschen', span: 2, h: 66 },
          { type: 'button', id: 'kcancel', label: 'Abbrechen', span: 4 }, { type: 'button', id: 'kok', label: 'OK', span: 6, main: true },
        ] };
      }
      case 'loading': return { title: 'Laden …', cols: 1, items: [{ type: 'text', text: this.loadingText, align: 'center' }, { type: 'progress', value: this.loadingP }] };
      case 'calibrate': return { title: 'Latenz kalibrieren', cols: 2, items: [
        { type: 'text', text: this.calibText || 'Du hörst einen Klick im Takt. Drück bei jedem Klick den Abzug (oder Pinch) – genau im Takt, 16 Mal. Daraus wird die Verzögerung berechnet.' },
        { type: 'button', id: 'calibstart', label: 'Start', main: true }, { type: 'button', id: 'back', label: 'Zurück' },
      ] };
      case 'pause': if (this.inDuet()) return this.duetPause();
        return { title: 'Pause', cols: 1, items: [
        { type: 'button', id: 'resume', label: '▶  Weiter (3 s Countdown)', main: true, h: 100 },
        { type: 'button', id: 'restart', label: 'Neu starten' }, { type: 'button', id: 'quit', label: 'Zum Menü' },
      ] };
      case 'online': return this.buildOnline();
      case 'lobby': return this.buildLobby();
      case 'invite': return this.buildInvite();
      case 'duetresults': return this.buildDuetResults();
      case 'results': {
        const r = this.result!; const s = r.s;
        const os = s instanceof OrbitScore ? s : null;
        return { title: `${s.rating.toFixed(1)} %  ${starString(s.stars)}`, subtitle: `${r.song.title} · ${DIFFICULTY_LABEL[r.d]} · ${MODE_LABEL[r.mode]}`, cols: 2, items: [
          { type: 'text', text: `Punkte ${s.score.toLocaleString('de-DE')}   ·   Sterne ${s.stars}/5   (5 ★ = 100 %, 4 ★ ab 90 %, 3 ★ ab 75 %, 2 ★ ab 50 %, 1 ★ ab 25 %)`, size: 26, align: 'center' },
          { type: 'text', text: `Max. Combo ${s.maxCombo}   ·   Treffer ${s.hits}/${s.total}   ·   Fehler ${s.misses + s.badCuts}   ·   Bomben ${s.bombs}`, size: 26, align: 'center', color: '#b8b0d6' },
          os
            ? { type: 'text', text: `Perfekt ${os.perfect}   ·   Gut ${os.good}   ·   Schlecht ${os.bad}   ·   Verpasst ${s.misses - os.railsLost}   ·   Rails ${os.railsHeld}/${os.railsHeld + os.railsLost}   ·   Zeit in Wänden ${s.wallTime.toFixed(1)} s`, size: 24, align: 'center', color: '#ffd9a0' }
            : { type: 'text', text: `Verpasst ${s.misses}   ·   falsche Richtung ${s.badDir}   ·   falsche Farbe ${s.badColor}   ·   Zeit in Wänden ${s.wallTime.toFixed(1)} s`, size: 24, align: 'center', color: '#ff9db0' },
          ...(this.scores.length ? [{ type: 'text', text: 'Highscores: ' + this.scores.slice(0, 5).map((h, i) => `${i + 1}. ${h.name} ${h.score.toLocaleString('de-DE')}`).join('   '), size: 22, color: '#d8d0f0' } as Item] : []),
          { type: 'button', id: 'name', label: `Name: ${settings.name}` },
          { type: 'button', id: 'save', label: r.saved ? 'Gespeichert ✓' : 'Highscore speichern', disabled: r.saved || s.judged === 0 },
          { type: 'button', id: 'again', label: 'Nochmal' }, { type: 'button', id: 'quit', label: 'Zum Menü', main: false },
        ] };
      }
    }
  }

  // ---------- Bedienung ----------
  click(id: string) {
    if (id.startsWith('R:')) return this.settingsClick(id.slice(2));
    if (id.startsWith('L:')) return;
    const s = this.screen;
    if (id.startsWith('mp:')) return this.mpClick(id.slice(3));
    if (id === 'back') return this.back();
    if (s === 'sc') {
      if (id === 'scsearch') return this.keyboard('SoundCloud suchen', '', (v) => this.scSearch(v));
      if (id === 'sclikes') return this.scMine('likes');
      if (id === 'sctracks') return this.scMine('tracks');
      if (id === 'scprev') { this.scPage = Math.max(0, this.scPage - 1); return this.refresh(); }
      if (id === 'scnext') { this.scPage++; return this.refresh(); }
      if (id === 'scall') { for (const it of this.scItems) if (!this.scStatus(it.url)) this.scAdd(it); return; }
      if (id.startsWith('sca:')) { const it = this.scItems.find((x) => x.url === id.slice(4)); if (it) this.scAdd(it); }
      return;
    }
    if (s === 'pick') {
      if (id === 'pkprev') { this.pickPage = Math.max(0, this.pickPage - 1); return this.refresh(); }
      if (id === 'pknext') { this.pickPage++; return this.refresh(); }
      if (!id.startsWith('pk:')) return;
      const v = id.slice(3), k = this.pickKind;
      if (k === 'colors') { settings.colorSet = v; settings.colorLeft = settings.colorRight = null; }
      else if (k === 'maps') settings.mapChoice = v;
      else if (k === 'walls') settings.wallSkin = v;
      else if (k === 'blocks') settings.blockSkin = v;
      else if (k === 'orbs') settings.orbSkin = v;
      else if (k === 'orbnotes') settings.orbNoteSkin = v;
      else if (k === 'sabersR') settings.saberSkinRight = v;
      else settings.saberSkin = v;
      saveSettings(); this.act.applySettings(); this.refresh();
      return;
    }
    if (s === 'songs') {
      if (id === 'scopen') return this.go('sc');
      if (id.startsWith('f:')) { this.filter = id.slice(2) as typeof this.filter; this.page = 0; this.refresh(); }
      else if (id === 'mode') this.setMode(this.mode === 'orbit' ? 'schnitt' : 'orbit');
      else if (id === 'sort') { this.sort = this.sort === 'new' ? 'title' : this.sort === 'title' ? 'bpm' : 'new'; this.refresh(); }
      else if (id === 'search') this.keyboard('Suche', this.search, (v) => { this.search = v.trim(); this.page = 0; });
      else if (id === 'prev') { this.page = Math.max(0, this.page - 1); this.refresh(); }
      else if (id === 'next') { this.page++; this.refresh(); }
      else if (id.startsWith('s:')) {
        this.sel = this.songs.find((x) => x.id === id.slice(2)) ?? null; this.seed = null; this.scores = [];
        if (this.sel) { this.go('detail'); this.loadScores(); }
      }
    } else if (s === 'detail' && this.sel) {
      if (id.startsWith('mode:')) return this.setMode(id.slice(5) as ModeId);
      if (id.startsWith('d:')) { this.diff = id.slice(2) as Difficulty; settings.difficulty = this.diff; saveSettings(); this.loadScores(); this.loadBest(); this.refresh(); }
      else if (id === 'arrows') { settings.arrows = settings.arrows === 'pflicht' ? 'egal' : 'pflicht'; saveSettings(); this.refresh(); }
      else if (id.startsWith('m:')) { const k = id.slice(2) as 'fastNotes' | 'noWalls' | 'noBombs' | 'missMute'; settings[k] = !settings[k]; saveSettings(); this.refresh(); }
      else if (id === 'seed') { this.seed = Math.floor(Math.random() * 999999) + 1; this.refresh(); }
      else if (id === 'play') { const have = this.mode === 'orbit' ? (this.sel.orbitDifficulties ?? []) : this.sel.difficulties; if (have.includes(this.diff)) this.act.play(this.sel, this.diff, this.seed ?? this.sel.seed); }
    } else if (s === 'keyboard' && this.kb) {
      const k = this.kb;
      if (id.startsWith('k:')) k.value = (k.value + id.slice(2)).slice(0, 24);
      else if (id === 'kdel') k.value = k.value.slice(0, -1);
      else if (id === 'kclr') k.value = '';
      else if (id === 'kcancel') { this.screen = k.back; this.kb = null; }
      else if (id === 'kok') { k.done(k.value); this.screen = k.back; this.kb = null; }
      this.refresh();
    } else if (s === 'calibrate') {
      if (id === 'calibstart') {
        this.calibText = 'Läuft … im Takt drücken!'; this.refresh();
        this.act.calibrateLatency().then((ms) => {
          this.calibText = ms === null ? 'Zu wenige Eingaben erkannt – bitte nochmal.' : `Gemessen: ${ms} ms. Gespeichert (Feinjustierung in den Einstellungen).`;
          if (ms !== null) { settings.latencyMs = ms; saveSettings(); }
          this.refresh();
        });
      }
    } else if (s === 'pause') {
      if (id === 'resume') this.act.resume(); else if (id === 'restart') this.act.restart(); else if (id === 'quit') this.act.quitToMenu();
    } else if (s === 'results' && this.result) {
      const r = this.result;
      if (id === 'again') this.act.restart();
      else if (id === 'quit') this.act.quitToMenu();
      else if (id === 'name') this.keyboard('Spielername', settings.name, (v) => { settings.name = v.trim().slice(0, 20) || 'Spieler'; saveSettings(); });
      else if (id === 'save' && !r.saved) {
        r.saved = true; this.refresh();
        api.postScore(r.song.id, { mode: r.mode, difficulty: r.d, name: settings.name, score: r.s.score, accuracy: Math.round(r.s.rating * 100) / 100, rank: `${r.s.stars}★`, maxCombo: r.s.maxCombo, misses: r.s.misses + r.s.badCuts, modifiers: [settings.arrows === 'egal' && 'PE', settings.fastNotes && 'FN', settings.noWalls && 'NW', settings.noBombs && 'NB'].filter(Boolean).join(',') })
          .then((x) => { this.scores = x; this.loadBest(); this.refresh(); }).catch(() => { r.saved = false; this.refresh(); });
      }
    }
  }

  private keyboard(title: string, value: string, done: (v: string) => void) {
    this.kb = { title, value, done, back: this.screen }; this.screen = 'keyboard'; this.refresh();
  }

  private loadScores() { const s = this.sel, m = this.mode; if (!s) return; api.scores(s.id, this.diff, m).then((x) => { if (this.sel?.id === s.id && this.mode === m) { this.scores = x; this.refresh(); } }).catch(() => {}); }

  // ---------- Zusammen spielen: Bildschirme ----------
  inDuet() { const l = this.mp?.lobby; return !!l && ['loading', 'countdown', 'playing', 'paused'].includes(l.state); }

  private togetherButton(): Item {
    const mp = this.mp!, l = mp.lobby, others = mp.online.filter((p) => p.clientId !== mp.me).length;
    const partner = mp.partner;
    if (this.invites.length) { const i = this.invites[this.invites.length - 1]; return { type: 'button', id: 'mp:showinv', label: `✉ Einladung von ${i.from.name}`, h: 64, span: 3, on: true, color: '#ffb44d' }; }
    const label = l ? `👥 Lobby ${l.code}${partner ? ` · ${partner.name}` : ' · wartet'}` : `👥 Zusammen spielen${others ? ` (${others} online)` : ''}`;
    return { type: 'button', id: 'mp:open', label, h: 64, span: 3, on: !!l, color: '#ffb44d' };
  }

  private lobbyPlayButtons(song: Song, ok: boolean): Item[] {
    const l = this.mp!.lobby!;
    const seed = this.seed ?? song.seed;
    const same = l.song?.id === song.id && l.mode === this.mode && l.difficulty === this.diff && l.seed === seed;
    const allReady = l.members.length >= 2 && l.members.every((m) => m.ready && m.connected);
    if (same && allReady) return [{ type: 'button', id: 'mp:start', label: '▶  Zusammen starten', main: true, h: 120, disabled: !ok }];
    return [
      { type: 'button', id: 'mp:pick', label: same ? '✓ Für die Lobby gewählt – zur Lobby' : '👥 Für die Lobby wählen', main: true, h: 100, disabled: !ok },
      { type: 'text', text: same ? 'Starten geht, sobald beide in der Lobby „Bereit“ gedrückt haben.' : 'Ihr spielt diesen Song zusammen – jeder bekommt eine eigene Stimme.', align: 'center', size: 24, color: '#ffd9a0' },
    ];
  }

  private buildOnline(): Spec {
    const mp = this.mp!;
    const people = mp.online.filter((p) => p.clientId !== mp.me);
    const inMine = (id: string) => !!mp.lobby?.members.some((m) => m.clientId === id);
    const items: Item[] = people.length ? people.map((p) => ({
      type: 'button', id: `mp:inv:${p.clientId}`, span: 2, h: 100,
      label: `${inMine(p.clientId) ? '✓ ' : '✉ '}${mp.label(p)}`,
      sub: `${DEVICE_LABEL[p.device]} · ${STATUS_TEXT[p.status]}${p.song && p.status === 'playing' ? ` „${p.song.title}“` : ''}${inMine(p.clientId) ? ' · in deiner Lobby' : ' · Einladen'}`,
      disabled: inMine(p.clientId) || !mp.connected,
    }) as Item) : [{ type: 'text', text: mp.connected ? 'Gerade ist niemand sonst online. Öffne BeatBlade auf einem zweiten Gerät (Brille, Handy, PC).' : 'Keine Verbindung zum Server … wird neu verbunden.', align: 'center', size: 28, color: '#b8b0d6', span: 2 } as Item];
    items.push({ type: 'gap', h: 6 },
      { type: 'button', id: 'mp:code', label: '⌨ Lobby-Code eingeben', h: 72 },
      mp.lobby ? { type: 'button', id: 'mp:lobby', label: `Zur Lobby ${mp.lobby.code}`, h: 72 } : { type: 'button', id: 'mp:create', label: '＋ Lobby erstellen', h: 72 },
      ...(this.mpNote ? [{ type: 'text', text: this.mpNote, align: 'center', size: 24, color: '#ff9db0', span: 2 } as Item] : []),
      { type: 'button', id: 'back', label: 'Zurück', main: true });
    return { title: 'Zusammen spielen', subtitle: `Gerade online · du bist „${mp.name}“`, cols: 2, items };
  }

  private buildLobby(): Spec {
    const mp = this.mp!, l = mp.lobby;
    if (!l) return { title: 'Lobby', cols: 1, items: [
      { type: 'text', text: this.mpNote || 'Du bist in keiner Lobby.', align: 'center', color: '#ffd9a0' },
      { type: 'button', id: 'mp:open', label: 'Zusammen spielen', main: true },
      { type: 'button', id: 'back', label: 'Zurück' },
    ] };
    const host = mp.isHost, me = mp.myMember;
    const C = 6;
    const stateTxt: Record<string, string> = { waiting: 'Warten auf beide', loading: 'Laden …', countdown: 'Gleich geht’s los', playing: 'Spielt', paused: 'Pause', results: 'Ergebnis' };
    const items: Item[] = [];
    for (const m of [...l.members].sort((a, b) => a.part - b.part)) {
      const conn = m.connected ? '' : ' · Verbindung weg';
      const extra = l.state === 'loading' ? ` · ${m.loaded ? 'geladen ✓' : `${Math.round(m.progress * 100)} %`}` : m.away ? ' · abwesend' : ` · ${m.ready ? 'bereit ✓' : 'nicht bereit'}`;
      items.push({ type: 'text', text: `Stimme ${m.part} (${m.part === 1 ? 'Rhythmus' : 'Melodie'}) · ${mp.label(m)}${m.clientId === l.hostId ? ' · Host' : ''}${m.clientId === mp.me ? ' · du' : ''}${extra}${conn}`, size: 30, color: m.ready ? '#9fe8c4' : '#ffffff', span: C });
    }
    if (l.members.length < 2) items.push({ type: 'text', text: 'Warte auf Mitspieler – einladen oder Code teilen.', size: 26, color: '#b8b0d6', span: C });
    items.push({ type: 'text', text: l.song ? `Song: ${l.song.title} · ${MODE_LABEL[l.mode]} · ${DIFFICULTY_LABEL[l.difficulty]} · Variante ${l.seed}` : 'Noch kein Song gewählt', size: 28, align: 'center', color: '#ffd23c', span: C });
    const mods: [keyof MpSharedModifiers, string][] = [['noWalls', 'Keine Wände'], ['noBombs', 'Keine Bomben'], ['fastNotes', 'Schneller']];
    for (const [k, lbl] of mods) items.push({ type: 'button', id: `mp:mod:${k}`, label: `${lbl} ${l.sharedModifiers[k] ? '✓' : ''}`, on: l.sharedModifiers[k], disabled: !host || l.state !== 'waiting', span: 2, h: 66 });
    const allReady = l.members.length >= 2 && l.members.every((m) => m.ready && m.connected);
    items.push(
      ...(host ? [{ type: 'button', id: 'mp:songs', label: l.song ? 'Song ändern ›' : 'Song wählen ›', span: 3, h: 76, disabled: l.state !== 'waiting' && l.state !== 'results' } as Item] : []),
      { type: 'button', id: 'mp:swap', label: `Stimmen tauschen (du: ${me?.part ?? '–'})`, span: host ? 3 : 6, h: 76, disabled: !me || l.state !== 'waiting' && l.state !== 'results' },
      { type: 'button', id: 'mp:ready', label: me?.ready ? 'Bereit ✓ (zurücknehmen)' : 'Bereit', on: !!me?.ready, span: 3, h: 86, disabled: l.state !== 'waiting' && l.state !== 'results' },
      host ? (() => { const off = !allReady || !l.song || l.state !== 'waiting' && l.state !== 'results'; return { type: 'button', id: 'mp:start', label: off ? '▶ Zusammen starten (beide bereit?)' : '▶ Zusammen starten', span: 3, h: 86, disabled: off, ...(off ? {} : { color: '#3dd68c' }) } as Item; })()
        : { type: 'text', text: 'Den Song wählt und startet der Host.', size: 24, align: 'center', color: '#b8b0d6', span: 3 } as Item,
    );
    if (l.note || this.mpNote) items.push({ type: 'text', text: l.note || this.mpNote, size: 24, align: 'center', color: '#ff9db0', span: C });
    // Code + QR zum Beitreten
    const link = `${this.qrUrl.replace(/\/?$/, '/')}play.html?lobby=${l.code}`;
    const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
    const n = qr.getModuleCount(), px = 5, c = document.createElement('canvas'); c.width = c.height = (n + 6) * px;
    const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) if (qr.isDark(r, q)) g.fillRect((q + 3) * px, (r + 3) * px, px, px);
    items.push({ type: 'image', img: c, h: 200, span: 2 }, { type: 'text', text: `Code ${l.code}\n${link}`, size: 24, color: '#3db8ff', span: 4 });
    items.push({ type: 'button', id: 'mp:online', label: 'Jemanden einladen', span: 3, h: 70, disabled: l.members.length >= 2 }, { type: 'button', id: 'mp:leave', label: 'Lobby verlassen', span: 3, h: 70 });
    return { title: `Lobby ${l.code}`, subtitle: stateTxt[l.state] ?? l.state, cols: C, items };
  }

  private buildInvite(): Spec {
    const inv = this.invites[this.invites.length - 1];
    if (!inv) return { title: 'Einladung', cols: 1, items: [{ type: 'text', text: 'Die Einladung ist nicht mehr gültig.', align: 'center' }, { type: 'button', id: 'back', label: 'OK', main: true }] };
    const left = Math.max(0, Math.ceil((inv.expiresAt - (this.mp?.serverNow() ?? Date.now())) / 1000));
    return { title: 'Einladung', cols: 2, items: [
      { type: 'text', text: `${inv.from.name} (${DEVICE_LABEL[inv.from.device]}) lädt dich ein, zusammen zu spielen.`, align: 'center', size: 34 },
      { type: 'text', text: `Noch ${left} s`, align: 'center', size: 28, color: '#ffd9a0' },
      { type: 'button', id: 'mp:accept', label: '✓ Annehmen', main: false, h: 110, color: '#3dd68c' },
      { type: 'button', id: 'mp:decline', label: '✗ Ablehnen', h: 110 },
    ] };
  }

  private duetPause(): Spec {
    const mp = this.mp!, l = mp.lobby!;
    const who = l.pausedBy === mp.me ? 'Du hast pausiert' : `${l.members.find((m) => m.clientId === l.pausedBy)?.name ?? 'Partner'} hat pausiert`;
    const voted = l.state === 'paused' && l.pausedBy !== mp.me ? '' : '';
    return { title: 'Pause', subtitle: `${who} · weiter geht es nur gemeinsam${voted}`, cols: 1, items: [
      { type: 'button', id: 'resume', label: l.pausedBy === mp.me ? '▶  Weiter (3 s Countdown für beide)' : '▶  Weiter (wenn beide wollen)', main: true, h: 100 },
      ...(mp.isHost ? [{ type: 'button', id: 'restart', label: 'Neu starten (beide)' } as Item, { type: 'button', id: 'mp:lobby', label: 'Zurück zur Lobby (beide)' } as Item]
        : [{ type: 'text', text: 'Neu starten und Zurück zur Lobby macht der Host.', align: 'center', size: 24, color: '#b8b0d6' } as Item]),
      { type: 'button', id: 'quit', label: 'Lobby verlassen' },
    ] };
  }

  private buildDuetResults(): Spec {
    const r = this.duetResult;
    if (!r) return { title: 'Ergebnis', cols: 1, items: [{ type: 'button', id: 'mp:lobby', label: 'Zur Lobby', main: true }] };
    const items: Item[] = r.results.map((x) => ({ type: 'text', text: `Stimme ${x.part} · ${x.name} · ${x.accuracy.toFixed(1)} % ${starString(starsFor(x.accuracy))} · ${x.score.toLocaleString('de-DE')} Punkte · Combo ${x.maxCombo} · ${x.hits}/${x.notes}`, size: 28, align: 'center', color: x.clientId === this.mp?.me ? '#ffffff' : '#ffe08a', span: 2 }) as Item);
    if (r.results.length < 2) items.push({ type: 'text', text: 'Der Partner ist ausgestiegen – Ergebnis zählt solo (keine Duett-Bestenliste).', size: 24, align: 'center', color: '#ff9db0', span: 2 });
    else items.push({ type: 'text', text: r.ranked ? 'In der Duett-Bestenliste eingetragen ✓' : 'Nicht in der Bestenliste (Unterbrechung)', size: 24, align: 'center', color: '#9fe8c4', span: 2 });
    if (this.duetScores.length) items.push({ type: 'text', text: 'Duett-Bestenliste: ' + this.duetScores.slice(0, 5).map((h, i) => `${i + 1}. ${h.name1} + ${h.name2} ${h.teamAccuracy.toFixed(1)} %`).join('   '), size: 22, color: '#d8d0f0', span: 2 });
    const host = this.mp?.isHost;
    items.push(
      host ? { type: 'button', id: 'mp:again', label: 'Nochmal (beide)', h: 86 } as Item : { type: 'text', text: 'Nochmal startet der Host.', size: 24, align: 'center', color: '#b8b0d6' } as Item,
      { type: 'button', id: 'mp:lobby', label: 'Zur Lobby', h: 86 },
      { type: 'button', id: 'mp:leave', label: 'Lobby verlassen', h: 76, span: 2 },
    );
    return { title: `Team ${r.team.accuracy.toFixed(1)} %  ${starString(starsFor(r.team.accuracy))}`, subtitle: `Duett · ${r.song?.title ?? ''} · ${DIFFICULTY_LABEL[r.d]} · ${MODE_LABEL[r.mode]} · Team-Punkte ${r.team.score.toLocaleString('de-DE')}`, cols: 2, items };
  }

  /** Duett-Ergebnis zeigen (vom Server) */
  duetResults(res: { results: MpResultLine[]; team: { accuracy: number; score: number }; ranked: boolean }, song: Song | null, d: Difficulty, mode: ModeId) {
    this.duetResult = { ...res, song, d, mode }; this.duetScores = [];
    this.screen = 'duetresults'; this.show();
    if (song) api.duetScores(song.id, d, mode).then((x) => { this.duetScores = x; this.refresh(); }).catch(() => {});
  }

  /** neue Einladung (quiet = erst nach dem Song zeigen) */
  addInvite(inv: { from: { clientId: string; name: string; device: MpDevice }; lobbyId: string; expiresAt: number }, showNow: boolean) {
    this.invites = this.invites.filter((x) => x.lobbyId !== inv.lobbyId && x.from.clientId !== inv.from.clientId);
    this.invites.push(inv);
    if (showNow && this.visible && !['loading', 'pause'].includes(this.screen)) this.go('invite');
  }
  dropInvite(lobbyId: string) {
    this.invites = this.invites.filter((x) => x.lobbyId !== lobbyId);
    if (this.screen === 'invite') { if (this.invites.length) this.refresh(); else this.back(); }
  }
  private tickInvite(on: boolean) {
    if (on && !this.mpTimer) this.mpTimer = setInterval(() => {
      const now = this.mp?.serverNow() ?? Date.now();
      this.invites = this.invites.filter((x) => x.expiresAt > now);
      if (this.screen === 'invite') { if (!this.invites.length) this.back(); else this.refresh(); }
    }, 1000);
    if (!on && this.mpTimer) { clearInterval(this.mpTimer); this.mpTimer = null; }
  }

  private mpClick(id: string) {
    const mp = this.mp; if (!mp) return;
    const l = mp.lobby;
    this.mpNote = '';
    if (id === 'open') return this.go(l ? 'lobby' : 'online');
    if (id === 'online') return this.go('online');
    if (id === 'showinv') return this.go('invite');
    if (id === 'lobby') {
      if (this.inDuet() && mp.isHost) mp.send({ t: 'lobby.back' });
      else if (l?.state === 'results' && mp.isHost) mp.send({ t: 'lobby.back' });
      this.act.toLobby?.();
      return this.go('lobby');
    }
    if (id === 'create') { mp.send({ t: 'lobby.create' }); return this.go('lobby'); }
    if (id === 'code') return this.keyboard('Lobby-Code', '', (v) => { mp.send({ t: 'lobby.join', code: v.trim().toUpperCase() }); this.backStack.push('online'); setTimeout(() => this.go('lobby'), 0); });
    if (id.startsWith('inv:')) { mp.send({ t: 'lobby.invite', to: id.slice(4) }); this.mpNote = 'Einladung gesendet …'; return this.go('lobby'); }
    if (id === 'accept' || id === 'decline') {
      const inv = this.invites.pop();
      if (inv) mp.send({ t: 'invite.answer', lobbyId: inv.lobbyId, accept: id === 'accept' });
      return id === 'accept' ? this.go('lobby', false) : this.back();
    }
    if (!l) return this.refresh();
    if (id === 'leave') { mp.send({ t: 'lobby.leave' }); this.act.toLobby?.(); this.backStack = []; return this.go('songs', false); }
    if (id === 'swap') return mp.send({ t: 'lobby.part', part: mp.myMember?.part === 1 ? 2 : 1 });
    if (id === 'ready') return mp.send({ t: 'lobby.ready', ready: !mp.myMember?.ready });
    if (id === 'songs') return this.go('songs');
    if (id.startsWith('mod:')) { const k = id.slice(4) as keyof MpSharedModifiers; return mp.send({ t: 'lobby.update', sharedModifiers: { ...l.sharedModifiers, [k]: !l.sharedModifiers[k] } }); }
    if (id === 'pick' && this.sel) {
      mp.send({ t: 'lobby.update', song: { id: this.sel.id, title: this.sel.title, updatedAt: this.sel.updatedAt }, mode: this.mode, difficulty: this.diff, seed: this.seed ?? this.sel.seed });
      return this.go('lobby');
    }
    if (id === 'start' || id === 'again') { mp.send({ t: id === 'again' ? 'restart' : 'lobby.start' }); return; }
  }

  /** Seite blaettern per Thumbstick */
  scroll(dir: number) { if (this.screen === 'songs') { const pages = Math.ceil(this.visibleSongs().length / PER_PAGE); this.page = Math.max(0, Math.min(pages - 1, this.page + dir)); this.refresh(); } }
}
