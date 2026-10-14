// Menues im Headset: Hauptmenue, Song-Auswahl (Cover, Suche, Filter, Live-Status), Song-Detail
// (Schwierigkeit, Seed, Modifikatoren, Highscores), Einstellungen, Credits, QR-Upload, Kalibrierung,
// Pause und Ergebnis. Bedienung per Laserpointer, Trigger/Pinch = Klick.
import * as THREE from 'three';
import qrcode from 'qrcode-generator';
import { BUILD_INFO } from '../version';
import { colorPair, colorSets, currentSet, shiftHue, toHex, HUE_STEP, blockName, blockSkins, currentBlock, saberName, saberSkins, currentSaber, mapItems, wallItems, mapName, wallName } from '../look';
import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty, type Highscore, type Song } from '@beatblade/core';
import { Panel, type Item, type Spec } from './panel';
import { api, STATUS_LABEL, playable, fmtTime, type Credit } from '../api';
import { settings, saveSettings } from '../settings';
import { starString, starsFor, type ScoreKeeper } from '../game/score';

export interface MenuActions {
  play(song: Song, d: Difficulty, seed: number): void;
  resume(): void; restart(): void; quitToMenu(): void;
  exitXR(): void;
  calibrateLatency(): Promise<number | null>;
  setFloor(): void; setDirection(): void;
  isMR(): boolean; inXR(): boolean;
  applySettings(): void;
}

type Screen = 'main' | 'songs' | 'detail' | 'settings' | 'credits' | 'qr' | 'keyboard' | 'loading' | 'pause' | 'results' | 'calibrate';

const PER_PAGE = 6;

type Tab = 'spiel' | 'aussehen' | 'audio' | 'komfort' | 'mehr';
const TABS: [Tab, string][] = [['spiel', 'Spiel'], ['aussehen', 'Aussehen'], ['audio', 'Audio'], ['komfort', 'Komfort'], ['mehr', 'Mehr']];
/** Bildschirme, bei denen die Lobby (Bestenliste links, Einstellungen rechts) mit angezeigt wird */
const LOBBY: Screen[] = ['main', 'songs', 'detail', 'credits', 'qr', 'keyboard', 'calibrate'];

export class Menus {
  /** Mitte: Song-Auswahl, Song-Detail mit Starten, Pause, Ergebnis */
  panel = new Panel(1.5);
  /** links: Bestenliste zum gewaehlten Song */
  board = new Panel(1.05);
  /** rechts: Einstellungen in Gruppen */
  side = new Panel(1.3);
  private tab: Tab = 'aussehen';
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
  private result: { s: ScoreKeeper; song: Song; d: Difficulty; saved: boolean } | null = null;
  private qrUrl = '';
  private calibText = '';
  private backStack: Screen[] = [];

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
  loadBest() { const d = this.diff; api.best(d).then((b) => { if (this.diff === d) { this.best = b; this.refresh(); } }).catch(() => {}); }

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

  private visibleSongs(): Song[] {
    let l = this.songs.filter((s) => !s.hidden && (this.filter === 'all' || (this.filter === 'bundled' ? s.bundled : !s.bundled)));
    if (this.search) { const q = this.search.toLowerCase(); l = l.filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q)); }
    const cmp = { new: (a: Song, b: Song) => b.createdAt - a.createdAt, title: (a: Song, b: Song) => a.title.localeCompare(b.title, 'de'), bpm: (a: Song, b: Song) => (a.bpm ?? 999) - (b.bpm ?? 999) };
    return l.sort(cmp[this.sort]);
  }

  // ---------- Navigation ----------
  go(s: Screen, push = true) { if (s === 'main') s = 'songs'; if (push && this.screen !== s && !['loading', 'pause', 'results'].includes(this.screen)) this.backStack.push(this.screen); this.screen = s; this.refresh(); }
  back() { this.screen = this.backStack.pop() ?? 'songs'; this.refresh(); }
  show() { this.panel.visible = true; this.refresh(); }
  hide() { this.panel.hide(); this.board.hide(); this.side.hide(); if (this.screen === 'loading') this.screen = 'songs'; }
  get visible() { return this.panel.visible; }

  loading(text: string, p: number) { this.loadingText = text; this.loadingP = p; if (this.screen !== 'loading') { this.screen = 'loading'; } this.panel.visible = true; this.refresh(); }
  pause() { this.screen = 'pause'; this.show(); }
  results(s: ScoreKeeper, song: Song, d: Difficulty) { this.result = { s, song, d, saved: false }; this.scores = []; this.screen = 'results'; this.show(); api.scores(song.id, d).then((x) => { this.scores = x; this.refresh(); }).catch(() => {}); }
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
    return { title: 'Bestenliste', subtitle: `${s.title} · ${DIFFICULTY_LABEL[this.diff]}`, cols: 1, items: rows.length
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
      full('name', `Name: ${settings.name}`),
    ];
    else if (this.tab === 'aussehen') items = [
      half('cset', `Farben: ${currentSet().name} ⟳`), half('bskin', `Blöcke: ${blockName()} ⟳`),
      ...colorRow('cl', 'Links', colorPair()[0], !!settings.colorLeft),
      ...colorRow('cr', 'Rechts', colorPair()[1], !!settings.colorRight),
      ...(settings.colorLeft || settings.colorRight ? [full('creset', 'Eigene Farben zurücksetzen')] : []),
      full('sskin', `Schwert: ${saberName()} ⟳`),
      half('mapc', `Map: ${mapName()} ⟳`), half('wallc', `Wände: ${wallName().replace(' (passend zur Map)', '')} ⟳`),
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
    else if (id.startsWith('t:')) { const k = id.slice(2) as 'leftHanded' | 'comfort' | 'showFps' | 'missMute' | 'glow'; settings[k] = !settings[k]; }
    else if (id === 'arrows') settings.arrows = settings.arrows === 'pflicht' ? 'egal' : 'pflicht';
    else if (id === 'cset') { const sets = colorSets(), i = sets.findIndex((x) => x.id === currentSet().id); settings.colorSet = sets[(i + 1) % sets.length].id; settings.colorLeft = settings.colorRight = null; }
    else if (id === 'creset') settings.colorLeft = settings.colorRight = null;
    else if (id === 'mapc') { const ids = ['zufall', ...mapItems().map((x) => x.id)]; settings.mapChoice = ids[(ids.indexOf(settings.mapChoice) + 1) % ids.length]; }
    else if (id === 'wallc') { const ids = ['auto', ...wallItems().map((w) => w.id)]; settings.wallSkin = ids[(ids.indexOf(settings.wallSkin) + 1) % ids.length]; }
    else if (id === 'sskin') { const l = saberSkins(); if (l.length) { const i = l.findIndex((b) => b.id === currentSaber()?.id); settings.saberSkin = l[(i + 1) % l.length].id; } }
    else if (id === 'bskin') { const l = blockSkins(); if (l.length) { const i = l.findIndex((b) => b.id === currentBlock()?.id); settings.blockSkin = l[(i + 1) % l.length].id; } }
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
        return { title: 'Song wählen', subtitle: `${list.length} Songs · Bestwerte für ${DIFFICULTY_LABEL[this.diff]} · neue erscheinen automatisch`, cols: 3, items: items.map((i) => (i.type === 'button' && i.span === 2 ? { ...i, span: 3 } : i)) };
      }
      case 'detail': {
        const s = this.sel!; const img = this.cover(s);
        const diffs = DIFFICULTIES.filter((d) => s.difficulties.includes(d));
        if (!diffs.includes(this.diff)) this.diff = diffs.includes('normal') ? 'normal' : diffs[0];
        // klar gegliedert: Cover, Infos, Schwierigkeit gross, Modifikatoren, Starten
        const C = 60, dSpan = Math.floor(C / diffs.length);
        const mod = (id: string, label: string, on: boolean): Item => ({ type: 'button', id, label: `${label} ${on ? '✓' : ''}`, on, span: 20, h: 70 });
        const items: Item[] = [
          ...(img ? [{ type: 'image', img, h: 220 } as Item] : []),
          { type: 'text', text: `${s.artist || 'Unbekannt'} · ${fmtTime(s.duration)} · ${s.bpm ? Math.round(s.bpm) + ' BPM' : ''}${s.license ? ' · ' + s.license.split(' – ')[0] : ''}`, align: 'center', size: 28 },
          ...diffs.map((d) => ({ type: 'button', id: `d:${d}`, label: DIFFICULTY_LABEL[d], on: this.diff === d, span: dSpan, h: 84 }) as Item),
          { type: 'gap', h: 6 },
          mod('m:fastNotes', 'Schneller', settings.fastNotes), mod('m:noWalls', 'Keine Wände', settings.noWalls), mod('m:noBombs', 'Keine Bomben', settings.noBombs),
          { type: 'button', id: 'seed', label: `Variante ${this.seed ?? s.seed} ⟳`, span: 30, h: 70 },
          { type: 'button', id: 'back', label: 'Zurück', span: 30, h: 70 },
          { type: 'button', id: 'play', label: '▶  Starten', main: true, h: 120 },
        ];
        return { title: s.title, cols: C, items };
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
        const keys = 'QWERTZUIOPASDFGHJKLYXCVBNM0123456789'.split('');
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
      case 'pause': return { title: 'Pause', cols: 1, items: [
        { type: 'button', id: 'resume', label: '▶  Weiter (3 s Countdown)', main: true, h: 100 },
        { type: 'button', id: 'restart', label: 'Neu starten' }, { type: 'button', id: 'quit', label: 'Zum Menü' },
      ] };
      case 'results': {
        const r = this.result!; const s = r.s;
        return { title: `${s.rating.toFixed(1)} %  ${starString(s.stars)}`, subtitle: `${r.song.title} · ${DIFFICULTY_LABEL[r.d]}`, cols: 2, items: [
          { type: 'text', text: `Punkte ${s.score.toLocaleString('de-DE')}   ·   Sterne ${s.stars}/5   (5 ★ = 100 %, 4 ★ ab 90 %, 3 ★ ab 75 %, 2 ★ ab 50 %, 1 ★ ab 25 %)`, size: 26, align: 'center' },
          { type: 'text', text: `Max. Combo ${s.maxCombo}   ·   Treffer ${s.hits}/${s.total}   ·   Fehler ${s.misses + s.badCuts}   ·   Bomben ${s.bombs}`, size: 26, align: 'center', color: '#b8b0d6' },
          { type: 'text', text: `Verpasst ${s.misses}   ·   falsche Richtung ${s.badDir}   ·   falsche Farbe ${s.badColor}   ·   Zeit in Wänden ${s.wallTime.toFixed(1)} s`, size: 24, align: 'center', color: '#ff9db0' },
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
    if (id === 'back') return this.back();
    if (s === 'songs') {
      if (id.startsWith('f:')) { this.filter = id.slice(2) as typeof this.filter; this.page = 0; this.refresh(); }
      else if (id === 'sort') { this.sort = this.sort === 'new' ? 'title' : this.sort === 'title' ? 'bpm' : 'new'; this.refresh(); }
      else if (id === 'search') this.keyboard('Suche', this.search, (v) => { this.search = v.trim(); this.page = 0; });
      else if (id === 'prev') { this.page = Math.max(0, this.page - 1); this.refresh(); }
      else if (id === 'next') { this.page++; this.refresh(); }
      else if (id.startsWith('s:')) {
        this.sel = this.songs.find((x) => x.id === id.slice(2)) ?? null; this.seed = null; this.scores = [];
        if (this.sel) { this.go('detail'); this.loadScores(); }
      }
    } else if (s === 'detail' && this.sel) {
      if (id.startsWith('d:')) { this.diff = id.slice(2) as Difficulty; settings.difficulty = this.diff; saveSettings(); this.loadScores(); this.loadBest(); this.refresh(); }
      else if (id === 'arrows') { settings.arrows = settings.arrows === 'pflicht' ? 'egal' : 'pflicht'; saveSettings(); this.refresh(); }
      else if (id.startsWith('m:')) { const k = id.slice(2) as 'fastNotes' | 'noWalls' | 'noBombs' | 'missMute'; settings[k] = !settings[k]; saveSettings(); this.refresh(); }
      else if (id === 'seed') { this.seed = Math.floor(Math.random() * 999999) + 1; this.refresh(); }
      else if (id === 'play') this.act.play(this.sel, this.diff, this.seed ?? this.sel.seed);
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
        api.postScore(r.song.id, { difficulty: r.d, name: settings.name, score: r.s.score, accuracy: Math.round(r.s.rating * 100) / 100, rank: `${r.s.stars}★`, maxCombo: r.s.maxCombo, misses: r.s.misses + r.s.badCuts, modifiers: [settings.arrows === 'egal' && 'PE', settings.fastNotes && 'FN', settings.noWalls && 'NW', settings.noBombs && 'NB'].filter(Boolean).join(',') })
          .then((x) => { this.scores = x; this.loadBest(); this.refresh(); }).catch(() => { r.saved = false; this.refresh(); });
      }
    }
  }

  private keyboard(title: string, value: string, done: (v: string) => void) {
    this.kb = { title, value, done, back: this.screen }; this.screen = 'keyboard'; this.refresh();
  }

  private loadScores() { const s = this.sel; if (!s) return; api.scores(s.id, this.diff).then((x) => { if (this.sel?.id === s.id) { this.scores = x; this.refresh(); } }).catch(() => {}); }

  /** Seite blaettern per Thumbstick */
  scroll(dir: number) { if (this.screen === 'songs') { const pages = Math.ceil(this.visibleSongs().length / PER_PAGE); this.page = Math.max(0, Math.min(pages - 1, this.page + dir)); this.refresh(); } }
}
