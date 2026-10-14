// Menues im Headset: Hauptmenue, Song-Auswahl (Cover, Suche, Filter, Live-Status), Song-Detail
// (Schwierigkeit, Seed, Modifikatoren, Highscores), Einstellungen, Credits, QR-Upload, Kalibrierung,
// Pause und Ergebnis. Bedienung per Laserpointer, Trigger/Pinch = Klick.
import * as THREE from 'three';
import qrcode from 'qrcode-generator';
import { BUILD_INFO } from '../version';
import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty, type Highscore, type Song } from '@beatblade/core';
import { Panel, type Item, type Spec } from './panel';
import { api, STATUS_LABEL, playable, fmtTime, type Credit } from '../api';
import { settings, saveSettings } from '../settings';
import { starString, type ScoreKeeper } from '../game/score';

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

export class Menus {
  panel = new Panel(1.5);
  screen: Screen = 'main';
  songs: Song[] = [];
  private page = 0;
  private filter: 'all' | 'bundled' | 'uploaded' = 'all';
  private sort: 'new' | 'title' | 'bpm' = 'new';
  private search = '';
  private sel: Song | null = null;
  private diff: Difficulty = settings.difficulty;
  private seed: number | null = null;
  private scores: Highscore[] = [];
  private covers = new Map<string, HTMLImageElement>();
  private credits: Credit[] = [];
  private kb: { title: string; value: string; done: (v: string) => void; back: Screen } | null = null;
  private loadingText = ''; private loadingP = 0;
  private result: { s: ScoreKeeper; song: Song; d: Difficulty; saved: boolean } | null = null;
  private qrUrl = '';
  private calibText = '';
  private backStack: Screen[] = [];

  constructor(parent: THREE.Object3D, private act: MenuActions) {
    this.panel.position.set(0, 1.45, -1.6);
    parent.add(this.panel);
  }

  // ---------- Daten ----------
  setSongs(list: Song[]) { this.songs = list; if (this.sel) this.sel = list.find((s) => s.id === this.sel!.id) ?? this.sel; this.refresh(); }
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
  go(s: Screen, push = true) { if (push && this.screen !== s && !['loading', 'pause', 'results'].includes(this.screen)) this.backStack.push(this.screen); this.screen = s; this.refresh(); }
  back() { this.screen = this.backStack.pop() ?? 'main'; this.refresh(); }
  show() { this.panel.visible = true; this.refresh(); }
  hide() { this.panel.hide(); }
  get visible() { return this.panel.visible; }

  loading(text: string, p: number) { this.loadingText = text; this.loadingP = p; if (this.screen !== 'loading') { this.screen = 'loading'; } this.panel.visible = true; this.refresh(); }
  pause() { this.screen = 'pause'; this.show(); }
  results(s: ScoreKeeper, song: Song, d: Difficulty) { this.result = { s, song, d, saved: false }; this.scores = []; this.screen = 'results'; this.show(); api.scores(song.id, d).then((x) => { this.scores = x; this.refresh(); }).catch(() => {}); }
  calibration(text: string) { this.calibText = text; this.screen = 'calibrate'; this.show(); }

  refresh() {
    if (!this.panel.visible && this.screen !== 'loading') return;
    const spec = this.build();
    this.panel.show(spec);
  }

  private build(): Spec {
    switch (this.screen) {
      case 'main': return {
        title: 'BeatBlade', subtitle: `${this.songs.filter(playable).length} Songs spielbereit${this.act.isMR() ? ' · Mixed Reality' : ''}`, cols: 2,
        items: [
          { type: 'button', id: 'songs', label: '▶  Spielen', main: true, h: 110 },
          { type: 'button', id: 'settings', label: 'Einstellungen' }, { type: 'button', id: 'qr', label: 'Upload vom Handy' },
          { type: 'button', id: 'credits', label: 'Credits' }, { type: 'button', id: 'calib', label: 'Latenz kalibrieren' },
          ...(this.act.inXR() ? [{ type: 'button', id: 'exit', label: 'Beenden', main: true } as Item] : []),
          { type: 'text', text: BUILD_INFO, align: 'center', size: 20, color: '#8a84a8', span: 2 } as Item,
        ] as Item[] };
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
          const status = ok ? `${s.artist || 'Unbekannt'} · ${fmtTime(s.duration)}${s.bpm ? ` · ${Math.round(s.bpm)} BPM` : ''}` : `${STATUS_LABEL[s.status]}${['ready', 'error'].includes(s.status) ? '' : ` ${Math.round(s.progress * 100)} %`}`;
          items.push({ type: 'button', id: `s:${s.id}`, label: s.title, sub: status, img: this.cover(s), disabled: !ok, span: 2, h: 110 });
        }
        if (!list.length) items.push({ type: 'text', text: this.songs.length ? 'Keine Treffer.' : 'Noch keine Songs. Über „Upload vom Handy“ welche hinzufügen.', align: 'center' });
        items.push({ type: 'button', id: 'prev', label: '◀', disabled: this.page === 0 }, { type: 'button', id: 'back', label: 'Zurück' }, { type: 'button', id: 'next', label: '▶', disabled: this.page >= pages - 1 });
        return { title: 'Songs', subtitle: `Seite ${this.page + 1}/${pages} · ${list.length} Songs · neue erscheinen automatisch`, cols: 3, items: items.map((i) => (i.type === 'button' && i.span === 2 ? { ...i, span: 3 } : i)) };
      }
      case 'detail': {
        const s = this.sel!; const img = this.cover(s);
        const diffs = DIFFICULTIES.filter((d) => s.difficulties.includes(d));
        if (!diffs.includes(this.diff)) this.diff = diffs.includes('normal') ? 'normal' : diffs[0];
        const items: Item[] = [
          ...(img ? [{ type: 'image', img, h: 220 } as Item] : []),
          { type: 'text', text: `${s.artist || 'Unbekannt'} · ${fmtTime(s.duration)} · ${s.bpm ? Math.round(s.bpm) + ' BPM' : ''}${s.license ? ' · ' + s.license.split(' – ')[0] : ''}`, align: 'center', size: 28 },
          ...diffs.map((d) => ({ type: 'button', id: `d:${d}`, label: DIFFICULTY_LABEL[d], on: this.diff === d, h: 70 }) as Item),
          { type: 'gap', h: 4 },
          { type: 'button', id: 'arrows', label: `Pfeile: ${settings.arrows === 'pflicht' ? 'Pflicht' : 'egal'}`, on: settings.arrows === 'egal', h: 64 },
          { type: 'button', id: 'm:missMute', label: `Verfehlt = stumm ${settings.missMute ? '✓' : ''}`, on: settings.missMute, h: 64 },
          { type: 'button', id: 'm:fastNotes', label: `Schneller ${settings.fastNotes ? '✓' : ''}`, on: settings.fastNotes, h: 64 },
          { type: 'button', id: 'm:noWalls', label: `Keine Wände ${settings.noWalls ? '✓' : ''}`, on: settings.noWalls, h: 64 },
          { type: 'button', id: 'm:noBombs', label: `Keine Bomben ${settings.noBombs ? '✓' : ''}`, on: settings.noBombs, h: 64 },
          { type: 'button', id: 'seed', label: `Seed: ${this.seed ?? s.seed}  ⟳`, h: 64 },
          { type: 'text', text: this.scores.length ? 'Highscores: ' + this.scores.slice(0, 5).map((h, i) => `${i + 1}. ${h.name} ${h.accuracy.toFixed(1)} % (${h.rank})`).join('   ') : 'Noch keine Highscores', size: 24, color: '#b8b0d6' },
          { type: 'button', id: 'back', label: 'Zurück' },
          { type: 'button', id: 'play', label: '▶  Spielen', main: true, h: 100 },
        ];
        return { title: s.title, cols: Math.max(2, Math.min(5, diffs.length)), items: items.map((i) => (i.type === 'button' && i.id === 'back' ? { ...i, span: 1 } : i)) };
      }
      case 'settings': {
        const row = (id: string, label: string, value: string): Item[] => [
          { type: 'button', id: `${id}-`, label: '−', h: 70 }, { type: 'text', text: `${label}: ${value}`, align: 'center', size: 28, span: 2 }, { type: 'button', id: `${id}+`, label: '+', h: 70 },
        ];
        const tog = (id: keyof typeof settings, label: string): Item => ({ type: 'button', id: `t:${id}`, label: `${label} ${settings[id] ? '✓' : '✗'}`, on: !!settings[id], span: 2, h: 70 });
        return { title: 'Einstellungen', cols: 4, items: [
          ...row('lat', 'Latenz', `${settings.latencyMs} ms`),
          ...row('off', 'Schwert-Offset', `${settings.saberOffsetCm} cm`),
          ...row('ang', 'Schwert-Winkel', `${settings.saberAngle}°`),
          ...row('hgt', 'Spielergröße', `${settings.playerHeight.toFixed(2)} m`),
          ...row('vol', 'Lautstärke', `${Math.round(settings.volume * 100)} %`),
          ...row('lgt', 'Lichteffekte', `${Math.round(settings.lightIntensity * 100)} %`),
          { type: 'button', id: 'arrows', label: `Pfeile: ${settings.arrows === 'pflicht' ? 'Pflicht (Richtung zählt)' : 'egal (nur treffen)'}`, on: settings.arrows === 'egal', span: 4, h: 70 },
          tog('missMute', 'Verfehlt = stumm'), tog('glow', 'Leuchten'), tog('leftHanded', 'Linkshänder'), tog('comfort', 'Komfortmodus'), tog('showFps', 'FPS-Anzeige'),
          { type: 'button', id: 'name', label: `Name: ${settings.name}`, span: 2, h: 70 },
          ...(this.act.isMR() ? [{ type: 'button', id: 'floor', label: 'Boden setzen', span: 2, h: 70 } as Item, { type: 'button', id: 'dir', label: 'Richtung setzen', span: 2, h: 70 } as Item]
            : [{ type: 'button', id: 'dir', label: 'Spielfeld zentrieren', span: 4, h: 70 } as Item]),
          { type: 'button', id: 'calib', label: 'Latenz kalibrieren', span: 2 }, { type: 'button', id: 'back', label: 'Zurück', span: 2, main: true },
        ] };
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
    const s = this.screen;
    if (id === 'back') return this.back();
    if (s === 'main') {
      if (id === 'songs') { this.page = 0; this.go('songs'); }
      else if (id === 'settings') this.go('settings');
      else if (id === 'credits') this.go('credits');
      else if (id === 'qr') this.go('qr');
      else if (id === 'calib') this.go('calibrate');
      else if (id === 'exit') this.act.exitXR();
    } else if (s === 'songs') {
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
      if (id.startsWith('d:')) { this.diff = id.slice(2) as Difficulty; settings.difficulty = this.diff; saveSettings(); this.loadScores(); this.refresh(); }
      else if (id === 'arrows') { settings.arrows = settings.arrows === 'pflicht' ? 'egal' : 'pflicht'; saveSettings(); this.refresh(); }
      else if (id.startsWith('m:')) { const k = id.slice(2) as 'fastNotes' | 'noWalls' | 'noBombs' | 'missMute'; settings[k] = !settings[k]; saveSettings(); this.refresh(); }
      else if (id === 'seed') { this.seed = Math.floor(Math.random() * 999999) + 1; this.refresh(); }
      else if (id === 'play') this.act.play(this.sel, this.diff, this.seed ?? this.sel.seed);
    } else if (s === 'settings') {
      const step = (k: string, d: number) => {
        if (k === 'lat') settings.latencyMs = Math.max(-300, Math.min(500, settings.latencyMs + d * 5));
        if (k === 'off') settings.saberOffsetCm = Math.max(-20, Math.min(30, settings.saberOffsetCm + d));
        if (k === 'ang') settings.saberAngle = Math.max(-45, Math.min(60, settings.saberAngle + d * 5));
        if (k === 'hgt') settings.playerHeight = Math.round(Math.max(1.2, Math.min(2.2, settings.playerHeight + d * 0.05)) * 100) / 100;
        if (k === 'vol') settings.volume = Math.round(Math.max(0, Math.min(1, settings.volume + d * 0.1)) * 10) / 10;
        if (k === 'lgt') settings.lightIntensity = Math.round(Math.max(0, Math.min(1, settings.lightIntensity + d * 0.1)) * 10) / 10;
      };
      const m = id.match(/^(\w+)([+-])$/);
      if (m) step(m[1], m[2] === '+' ? 1 : -1);
      else if (id.startsWith('t:')) { const k = id.slice(2) as 'leftHanded' | 'comfort' | 'showFps' | 'missMute' | 'glow'; settings[k] = !settings[k]; }
      else if (id === 'arrows') settings.arrows = settings.arrows === 'pflicht' ? 'egal' : 'pflicht';
      else if (id === 'name') return this.keyboard('Spielername', settings.name, (v) => { settings.name = v.trim().slice(0, 20) || 'Spieler'; saveSettings(); });
      else if (id === 'floor') this.act.setFloor();
      else if (id === 'dir') this.act.setDirection();
      else if (id === 'calib') return this.go('calibrate');
      saveSettings(); this.act.applySettings(); this.refresh();
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
          .then((x) => { this.scores = x; this.refresh(); }).catch(() => { r.saved = false; this.refresh(); });
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
