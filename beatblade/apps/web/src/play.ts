// BeatBlade – Spiel (WebXR VR/MR, Desktop-Debugmodus).
import './style.css';
import * as THREE from 'three';
import type { Beatmap, Difficulty, MpLook, MpPlayEvent, MpServerMsg, MpSharedModifiers, OrbitMap, Song } from '@beatblade/core';
import { api, subscribe } from './api';
import { mrSafeBlending } from './game/mrblend';
import { loadLook, loadBlockSkin, buildSaber, currentSaber, currentBlock, currentOrb, currentOrbNote, colorPair, toHex, pickMap, mapStyle, wallFor, wallStyle, mapItems, loadOrbNoteSkin, orbStyle, orbModel } from './look';
import { handOrbFromModel } from './game/orbit/orbskins';
import { settings, saveSettings, runtime } from './settings';
import { AudioPlayer } from './audio/player';
import { loadAudio, loadBeatmap, loadOrbitMap, loadDuet, pruneSong } from './storage/cache';
import { Mp, guessDevice } from './net/mp';
import { Partner } from './game/partner';
import { Environment } from './game/environment';
import { NoteView } from './game/notes';
import { Slicer } from './game/slicer';
import { Saber } from './game/sabers';
import { Game, prepareMap } from './game/game';
import type { GameMode, ModeId } from './game/mode';
import { OrbitGame, prepareOrbit, ORB_HIT_Z } from './game/orbit/orbit';
import { HIT_Z, lookahead } from './game/layout';
import { Menus } from './ui3d/menus';
import { Hud } from './ui3d/hud';
import { COMBO_MILESTONES, COMBO_BREAK_MIN, comboLevel, comboColor } from './game/combo';

/** mpready = Duett geladen, wartet auf den gemeinsamen Start */
type State = 'menu' | 'loading' | 'playing' | 'paused' | 'resuming' | 'results' | 'calibrating' | 'floor' | 'mpready';
type XRMode = 'vr' | 'ar' | 'desktop';

const app = document.getElementById('app')!;
app.innerHTML = `
<div id="start" style="min-height:100vh;display:grid;place-items:center;padding:16px">
  <div class="card" style="max-width:560px;width:100%;text-align:center">
    <div class="logo" style="font-size:40px">Beat<b>Blade</b></div>
    <p class="hint">Blöcke im Takt in Pfeilrichtung zerschneiden – rot links, blau rechts.</p>
    <div style="display:grid;gap:10px;margin:18px 0">
      <button id="b-vr" class="primary" hidden>VR starten</button>
      <button id="b-ar" class="primary" hidden>MR starten (Passthrough)</button>
      <button id="b-desk">Am Bildschirm testen (Debug)</button>
    </div>
    <p id="hint" class="hint"></p>
    <p class="hint"><a href="./">Bibliothek & Upload</a></p>
  </div>
</div>`;
const $ = (id: string) => document.getElementById(id)!;

// ---------- Renderer / Szene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.localClippingEnabled = true;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation?.(1);
renderer.domElement.style.cssText = 'position:fixed;inset:0;display:none';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.03, 150);
camera.position.set(0, 1.6, 0.25);
scene.add(camera);
// Buehne: Map UND Spielfeld haengen daran und werden nur gemeinsam ausgerichtet (Richtung, Position, MR-Boden).
// So laufen die Noten immer exakt auf der Spur der Map. Am Bildschirm bleibt sie die Identitaet.
const stage = new THREE.Group();
scene.add(stage);
const root = new THREE.Group();            // Spielfeld (Noten, Schwerter, Menues) – immer Identitaet relativ zur Buehne
stage.add(root);

const audio = new AudioPlayer();
let mode: XRMode = 'desktop';
let mrFixT = 1;
let env: Environment | null = null;
const view = new NoteView(root, false);
const slicer = new Slicer(root, view.cubeGeo, view.arrows.geometry);
const sabers: [Saber, Saber] = [new Saber(0, root), new Saber(1, root)];
const hud = new Hud(root, camera);
let state: State = 'menu';
let current: { song: Song; d: Difficulty; seed: number; mode: ModeId } | null = null;
let resumeAt = 0;
let lastCombo = 0;

const game = new Game(root, view, slicer, sabers, {
  haptic: (hand, v, ms) => pulse(hand, v, ms),
  slice: (v, noteT) => audio.slice(v, noteT),
  finished: () => finish(),
  muteNow: () => audio.muteNow(),
});
const orbit = new OrbitGame(root, view, slicer, sabers, {
  haptic: (hand, v, ms) => pulse(hand, v, ms),
  touch: (v, noteT) => audio.slice(v, noteT),
  finished: () => finish(),
  muteNow: () => audio.muteNow(),
});
/** laufender Spielmodus (Schnitt oder Orbit) */
let gm: GameMode = game;

// ---------- Zusammen spielen ----------
const mp = new Mp(guessDevice());
const partner = new Partner(stage);
/** laufendes Duett (null = Solo) */
let duet: {
  song: Song; d: Difficulty; seed: number; mode: ModeId; part: 1 | 2; partnerName: string;
  resumeAt?: number; pausedT?: number; lastScore: number; lastSync: number; partnerCombo: number;
  solo: boolean;
} | null = null;
// Modus per Adresse vorwaehlen (…/play.html?mode=orbit), sonst der zuletzt gespielte
{ const m = new URLSearchParams(location.search).get('mode'); if (m === 'orbit' || m === 'schnitt') { settings.gameMode = m; saveSettings(); } }


const menus = new Menus(root, {
  play: (s, d, seed) => startSong(s, d, seed),
  // nach der Pause nicht neu ausrichten: Map und Noten sollen mitten im Song nicht springen
  resume: () => {
    if (duet && mp.lobby) { mp.send({ t: 'resume' }); menus.loading('Warte auf deinen Partner …', 1); return; }
    state = 'resuming'; resumeAt = performance.now() + 3000; menus.hide(); hud.show(true);
  },
  restart: () => {
    if (duet && mp.lobby) { if (mp.isHost) mp.send({ t: 'restart' }); return; }
    if (current) { settings.gameMode = current.mode; startSong(current.song, current.d, current.seed); }
  },
  quitToMenu: () => { if (duet && mp.lobby) mp.send({ t: 'lobby.leave' }); duetEnd(); audio.stop(); toMenu(); },
  toLobby: () => { if (duet) { duetEnd(); audio.stop(); orbit.stop(); gm = game; state = 'menu'; hud.show(false); menus.show(); } },
  exitXR: () => renderer.xr.getSession()?.end(),
  calibrateLatency: () => calibrate(),
  setFloor: () => { state = 'floor'; floorMin = Infinity; floorUntil = performance.now() + 4000; },
  setDirection: () => setDirection(),
  isMR: () => mode === 'ar',
  inXR: () => renderer.xr.isPresenting,
  applySettings: () => {
    if (settings.name !== mp.name) mp.setName(settings.name); setTimeout(sendLook, 0);
    if (mp.isHost && mp.lobby?.state === 'waiting' && mp.lobby.map !== settings.mapChoice) mp.send({ t: 'lobby.update', map: settings.mapChoice }); audio.setVolume(settings.volume); hud.fps.visible = settings.showFps; game.applyColors(); orbit.applyColors(); applyLook(); },
});

// ---------- Eingaben (Controller / Haende / Maus) ----------
interface Input { i: number; ray: THREE.Group; grip: THREE.Group; line: THREE.Line; source: XRInputSource | null; prevButtons: boolean[]; scrollT: number }
const inputs: Input[] = [0, 1].map((i) => {
  const ray = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
  line.scale.z = 2; ray.add(line);
  const inp: Input = { i, ray, grip, line, source: null, prevButtons: [], scrollT: 0 };
  ray.addEventListener('connected', (e) => { inp.source = (e as unknown as { data: XRInputSource }).data; });
  ray.addEventListener('disconnected', () => { inp.source = null; });
  ray.addEventListener('selectstart', () => onSelect(inp));
  scene.add(ray, grip);
  return inp;
});
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2(); let mouseIn = false;

function setRayFrom(o: THREE.Object3D) {
  const m = new THREE.Matrix4().extractRotation(o.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(o.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
}

function onSelect(inp: Input) {
  tapTimes.push(audio.ctx.currentTime);
  if (!menus.visible) return;
  setRayFrom(inp.ray);
  const id = menus.pick(raycaster);
  if (id) { pulse(inp.source?.handedness === 'left' ? 0 : 1, 0.3, 20); menus.click(id); }
}

function pulse(hand: 0 | 1, v: number, ms: number) {
  const src = inputs.find((x) => x.source?.handedness === (hand === 0 ? 'left' : 'right'))?.source;
  const act = src?.gamepad?.hapticActuators?.[0] as unknown as { pulse?: (v: number, ms: number) => void } | undefined;
  try { act?.pulse?.(v, ms); } catch { /* keine Haptik */ }
}

// Maus (Desktop)
renderer.domElement.addEventListener('pointermove', (e) => { mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); mouseIn = true; });
renderer.domElement.addEventListener('pointerdown', () => {
  tapTimes.push(audio.ctx.currentTime);
  if (!menus.visible) return;
  raycaster.setFromCamera(mouse, camera);
  const id = menus.pick(raycaster); if (id) menus.click(id);
});
renderer.domElement.addEventListener('wheel', (e) => { if (menus.visible) menus.scroll(e.deltaY > 0 ? 1 : -1); });
addEventListener('keydown', (e) => {
  if (mode !== 'desktop') return;
  if (e.key === 'Escape' && state === 'playing') pauseGame('esc');
  if (e.key === 'a') autoplay = !autoplay;
  if (e.key === 'o' && state !== 'playing') { settings.gameMode = settings.gameMode === 'orbit' ? 'schnitt' : 'orbit'; saveSettings(); hud.message(''); console.info('Spielmodus', settings.gameMode); }
  if (e.key === ' ') tapTimes.push(audio.ctx.currentTime);
});
let autoplay = true;

/** Block-Skin auf Bloecke und geschnittene Haelften anwenden */
const saberKeys = ['', ''];
/** Lobby-Hintergrund: immer eine zufaellige Map */
function lobbyMap() {
  const list = mapItems();
  if (env && list.length) env.setMap(mapStyle(list[Math.floor(Math.random() * list.length)]));
}
/** Map (gewaehlt oder zufaellig) und passende Waende setzen */
/** mapId: im Duett die Map des Hosts (fuer beide gleich) */
function applyMap(mapId?: string) {
  const m = pickMap(mapId);
  env?.setMap(mapStyle(m));
  view.setWallSkin(wallStyle(wallFor(m)));
  // Themen-Maps (Halloween, Weihnachten) bringen eigene Bloecke und Farben mit
  const blockSkin = typeof m?.data.blockSkin === 'string' ? m.data.blockSkin : undefined;
  const colorSet = typeof m?.data.colorSet === 'string' ? m.data.colorSet : undefined;
  game.applyColors(colorSet); orbit.applyColors(colorSet);
  loadBlockSkin(blockSkin).then((s) => { view.setSkin(s); slicer.setSkin(s.geo, s.mat); });
  // Orbit: Themen-Maps bringen eigene Notenkugeln mit (orbNoteSkin)
  const orbNotes = typeof m?.data.orbNoteSkin === 'string' ? m.data.orbNoteSkin : undefined;
  loadOrbNoteSkin(orbNotes).then((s) => orbit.setNoteSkin(s));
  applyHandOrb();
}
/** Orbit-Handkugel: eigenes Modell oder eingebauter Stil */
function applyHandOrb() {
  const m = orbModel();
  if (m) orbit.setHandOrbModel(m.key, (c) => handOrbFromModel(m.url, c), orbStyle());
  else orbit.setHandOrb(orbStyle());
}
function applyLook() {
  loadBlockSkin().then((s) => { view.setSkin(s); slicer.setSkin(s.geo, s.mat); });
  loadOrbNoteSkin().then((s) => orbit.setNoteSkin(s));
  applyHandOrb();
  // Schwert je Hand nur neu bauen, wenn ein anderes gewaehlt wurde (links und rechts koennen verschieden sein)
  for (const sb of sabers) {
    const h = sb.hand, key = currentSaber(h)?.id ?? '';
    if (key === saberKeys[h]) continue;
    saberKeys[h] = key;
    buildSaber(sb.color, h).then((v) => { if ((currentSaber(h)?.id ?? '') === key) sb.setVisual(v); });
  }
}

// ---------- Ablauf ----------
// Jeder Start bekommt eine Nummer: ein aelterer, noch ladender Start (z. B. doppelt ausgeloest) darf
// weder den Lade-Bildschirm ueber ein laufendes Spiel legen noch das Spiel neu starten.
let startRun = 0;
async function startSong(song: Song, d: Difficulty, seed: number) {
  if (state === 'loading') return;                       // laeuft schon ein Start: zweiten Klick ignorieren
  const run = ++startRun;
  const live = () => run === startRun && state === 'loading';
  const progress = (text: string, p: number) => { if (live()) menus.loading(text, p); };
  const modeId: ModeId = settings.gameMode === 'orbit' ? 'orbit' : 'schnitt';
  current = { song, d, seed, mode: modeId };
  audio.stop(); hud.show(false); slicer.clear();
  state = 'loading'; menus.loading('Audio laden …', 0);
  try {
    await audio.resume();
    const data = await loadAudio(song, (p) => progress('Audio laden …', p * 0.7));
    if (!live()) return;
    progress('Dekodieren …', 0.75);
    await audio.decode(data);
    if (!live()) return;
    progress('Level laden …', 0.9);
    let lead: number;
    if (modeId === 'orbit') {
      if (!(song.orbitDifficulties ?? []).includes(d)) throw new Error('Orbit-Level wird noch erzeugt – gleich nochmal versuchen');
      const om = prepareOrbit(await loadOrbitMap(song, d, seed));
      if (!live()) return;
      orbit.start(om); gm = orbit;
      lead = Math.max(1.5, lookahead(om.speed) - (om.notes[0]?.t ?? 3) + 0.5);
    } else {
      const bm = prepareMap(await loadBeatmap(song, d, seed));
      if (!live()) return;
      orbit.stop(); game.start(bm); gm = game;
      lead = Math.max(1.5, lookahead(bm.njs, bm.bpm, bm.offset) - (bm.notes[0]?.t ?? 3) + 0.5);
    }
    applyMap();
    // Bahn direkt vor dir ausrichten: Mitte unter dem Kopf, Richtung = Blickrichtung (Hoehe/Boden bleibt)
    if (renderer.xr.isPresenting) setDirection();
    lastCombo = 0;
    env?.reset();
    menus.hide(); hud.show(true); hud.message('');
    // Vorlauf: Noten der ersten Sekunden sind schon unterwegs, bevor die Musik einsetzt
    audio.play(0, lead);
    state = 'playing';
    presence();
  } catch (e) {
    if (run !== startRun) return;
    state = 'menu';
    menus.loading(`Fehler: ${(e as Error).message}`, 0);
    setTimeout(() => toMenu(), 3000);
  }
}

/** Pause; why landet im Debug-Protokoll (Knopf, Brille abgesetzt, Esc ...) */
function pauseGame(why = 'knopf') {
  if (state !== 'playing') return;
  if (duet && mp.lobby) mp.send({ t: 'pause', songTime: audio.songTime() });   // Partner pausiert mit
  audio.pause(); state = 'paused'; hud.message(''); menus.pause(); sendLog(`pause:${why}`);
}

function sendLog(reason: string) {
  const s = gm.score;
  api.debug({ reason, song: current?.song.title, d: current?.d, ua: navigator.userAgent, songT: Math.round(audio.songTime() * 100) / 100, rating: Math.round(s.rating * 10) / 10, hits: s.hits, misses: s.misses, badDir: s.badDir, badColor: s.badColor, bombs: s.bombs, wallTime: Math.round(s.wallTime * 100) / 100, outputLatency: audio.ctx.outputLatency, baseLatency: audio.ctx.baseLatency, outputDelay: Math.round(audio.outputDelay() * 10000) / 10000, latencyMs: settings.latencyMs, mode: gm.id, cuts: gm.debugLog() });
}

function finish() {
  sendLog('end');
  if (duet) return duetFinish();
  // Musik ausblenden, dann Ergebnis (kein Game Over – jeder Song laeuft bis zum Ende)
  const g = audio.gain.gain; g.setTargetAtTime(0, audio.ctx.currentTime, 0.4);
  setTimeout(() => { audio.stop(); audio.setVolume(settings.volume); }, 1500);
  state = 'results';
  setTimeout(() => { hud.show(false); if (current) menus.results(gm.score, current.song, current.d, gm.id); }, 800);
}

function toMenu() { orbit.stop(); gm = game; state = 'menu'; partner.clear(); hud.setPartner(''); presence(); hud.show(false); for (const s of sabers) if (!renderer.xr.isPresenting && mode !== 'desktop') s.hide(); menus.go('songs', false); menus.show(); lobbyMap(); game.applyColors(); applyLook(); }

// ---------- Zusammen spielen: Ablauf ----------
// Stellschrauben (Senderaten)
const MP_POSE_HZ = 15, MP_SCORE_EVERY = 500, MP_SYNC_EVERY = 2000;

/** eigenen Status an alle (Presence): im Menue, spielt Song X, abwesend */
function presence(away = document.visibilityState === 'hidden') {
  const playing = state === 'playing' || state === 'paused' || state === 'resuming' || state === 'mpready';
  mp.send({ t: 'status', status: away ? 'away' : playing ? 'playing' : 'menu', song: playing && current ? { id: current.song.id, title: current.song.title } : undefined, device: mp.device });
}
document.addEventListener('visibilitychange', () => presence());

function duetEnd() { duet = null; runtime.arrows = null; partner.setGhost(null); hud.setPartner(''); restoreColors(); }

// ---------- Duett: Aussehen, Farben ----------
/** eigenes Aussehen (Skins + eigene Farben) fuer den Partner */
function myLook(): MpLook {
  const [l, r] = savedColors ? [savedColors[0] ?? colorPair()[0], savedColors[1] ?? colorPair()[1]].map((c) => (typeof c === 'string' ? parseInt(c.slice(1), 16) : c)) : colorPair();
  return { saberSkin: currentSaber(0)?.id ?? '', saberSkinRight: settings.saberSkinRight ? currentSaber(1)?.id ?? '' : '', blockSkin: currentBlock()?.id ?? '',
    orbSkin: currentOrb()?.id ?? '', orbNoteSkin: currentOrbNote()?.id ?? '', colors: [toHex(l as number), toHex(r as number)] };
}
let lastLook = '';
function sendLook() { const l = myLook(), k = JSON.stringify(l); if (k !== lastLook || !mp.lobby) { lastLook = k; mp.send({ t: 'look', ...l }); } }
/** Duett-Farben (vom Server zugeteilt) voruebergehend als eigene Farben setzen – nicht gespeichert */
let savedColors: [string | null, string | null] | null = null;
function useDuetColors(c: [string, string]) {
  if (!savedColors) savedColors = [settings.colorLeft, settings.colorRight];
  settings.colorLeft = c[0]; settings.colorRight = c[1];
  game.applyColors(); orbit.applyColors(); applyLook();
}
function restoreColors() {
  if (!savedColors) return;
  [settings.colorLeft, settings.colorRight] = savedColors; savedColors = null;
  game.applyColors(); orbit.applyColors(); applyLook();
}
/** Partner-Charakter aus dem Lobby-Zustand (Name, Farben, Skins, Modus) */
function syncPartner() {
  const l = mp.lobby, p = mp.partner;
  // Map bekommt im Duett eine zweite Bahn fuer den Partner
  env?.setDuet(!!(l && p));
  if (!l || !p) { partner.hideChar(); return; }
  partner.setInfo(p.name, p.colors, p.look, l.mode);
}

/** gemeinsame Modifikatoren (Host) gelten fuer beide; persoenliche Einstellungen bleiben lokal */
function withShared<T>(m: MpSharedModifiers, fn: () => T): T {
  const keep = { noWalls: settings.noWalls, noBombs: settings.noBombs, fastNotes: settings.fastNotes };
  Object.assign(settings, { noWalls: m.noWalls, noBombs: m.noBombs, fastNotes: m.fastNotes });
  try { return fn(); } finally { Object.assign(settings, keep); }
}

/** Partner-Noten: ohne meine Linkshaender-Spiegelung (er spielt seine Seiten) */
function unmirrored<T>(fn: () => T): T {
  const lh = settings.leftHanded; settings.leftHanded = false;
  try { return fn(); } finally { settings.leftHanded = lh; }
}

async function duetPrepare(m: Extract<MpServerMsg, { t: 'prepare' }>) {
  audio.stop(); hud.show(false); slicer.clear(); partner.clear();
  const run = ++startRun;
  const live = () => run === startRun && state === 'loading';
  state = 'loading';
  let lastSent = 0;
  const progress = (text: string, p: number) => {
    if (!live()) return;
    const others = mp.lobby?.members.filter((x) => x.clientId !== mp.me).map((x) => `${x.name}: ${x.loaded ? 'fertig ✓' : `${Math.round(x.progress * 100)} %`}`).join(' · ') ?? '';
    menus.loading(`${text}${others ? `\n${others}` : ''}`, p);
    if (performance.now() - lastSent > 300) { lastSent = performance.now(); mp.send({ t: 'loading', p: Math.round(p * 100) / 100 }); }
  };
  try {
    const song = menus.songs.find((x) => x.id === m.song.id) ?? await api.song(m.song.id);
    const partnerM = mp.lobby?.members.find((x) => x.clientId !== mp.me);
    // Pfeile wie in der Lobby eingestellt (Host)
    runtime.arrows = m.sharedModifiers.anyDirection ? 'egal' : 'pflicht';
    duet = { song, d: m.difficulty, seed: m.seed, mode: m.mode, part: m.part, partnerName: partnerM?.name ?? 'Partner', lastScore: 0, lastSync: 0, partnerCombo: 0, solo: false };
    current = { song, d: m.difficulty, seed: m.seed, mode: m.mode };
    presence();
    await audio.resume();
    const data = await loadAudio(song, (p) => progress('Audio laden …', p * 0.7));
    if (!live()) return;
    progress('Dekodieren …', 0.75);
    await audio.decode(data);
    if (!live()) return;
    progress('Duett-Level laden …', 0.85);
    const dm = await loadDuet<Beatmap | OrbitMap>(song, m.mode, m.difficulty, m.seed, m.duetVersion);
    if (!live()) return;
    const mine = dm.parts[m.part - 1], other = dm.parts[2 - m.part];
    if (m.mode === 'orbit') {
      const [om, ghost] = withShared(m.sharedModifiers, () => [prepareOrbit(mine as OrbitMap), unmirrored(() => prepareOrbit(other as OrbitMap))]);
      orbit.start(om); gm = orbit;
      partner.setGhost(settings.partnerNotes ? ghost : null);
    } else {
      const [bm, ghost] = withShared(m.sharedModifiers, () => [prepareMap(mine as Beatmap), unmirrored(() => prepareMap(other as Beatmap))]);
      orbit.stop(); game.start(bm); gm = game;
      partner.setGhost(settings.partnerNotes ? ghost : null);
    }
    syncPartner();
    const meM = mp.myMember; if (meM) useDuetColors(meM.colors);
    applyMap(m.map);
    if (renderer.xr.isPresenting) setDirection();
    lastCombo = 0; env?.reset();
    state = 'mpready';
    menus.loading(`Bereit – Stimme ${m.part}. Warte auf ${duet.partnerName} …`, 1);
    mp.send({ t: 'loaded', ok: true });
  } catch (e) {
    if (run !== startRun) return;
    mp.send({ t: 'loaded', ok: false, error: (e as Error).message });
    duetEnd(); state = 'menu'; menus.go('lobby', false); menus.show();
  }
}

/** gemeinsamer Start (auch Wiedereinstieg mitten im Song): Serverzeit -> eigene Audio-Uhr */
function duetStart(at: number, from: number) {
  if (!duet || !['mpready', 'playing', 'paused', 'resuming'].includes(state)) return;
  audio.playAt(mp.toLocal(at), from);
  state = 'playing';
  menus.hide(); hud.show(true); hud.message('');
  presence();
}

function duetFinish() {
  const s = gm.score;
  const result = { accuracy: Math.round(s.rating * 100) / 100, score: s.score, maxCombo: s.maxCombo, hits: s.hits, misses: s.misses + s.badCuts, notes: s.total, rank: `${s.stars}★` };
  const g = audio.gain.gain; g.setTargetAtTime(0, audio.ctx.currentTime, 0.4);
  setTimeout(() => { audio.stop(); audio.setVolume(settings.volume); }, 1500);
  state = 'results';
  if (mp.lobby && !duet!.solo) { mp.send({ t: 'finished', result }); setTimeout(() => { if (state === 'results' && duet && menus.screen !== 'duetresults') { hud.show(false); menus.loading(`Warte auf das Ergebnis von ${duet.partnerName} …`, 1); } }, 800); }
  else {
    // ohne Lobby (Server-Neustart, Partner weg): eigenes Ergebnis, ohne Bestenliste
    const d = duet!; const me = { ...result, clientId: mp.me, name: settings.name, part: d.part };
    setTimeout(() => { hud.show(false); menus.duetResults({ results: [me], team: { accuracy: result.accuracy, score: result.score }, ranked: false }, d.song, d.d, d.mode); }, 800);
  }
  presence();
}

/** pro Bild: Partner bewegen, eigene Pose/Wertung/Songzeit senden */
let lastPoseLobby = 0;
/** Lobby (auch ohne Song): Partner-Charakter bewegen, eigene Pose senden, Raumklang ausrichten */
function lobbyFrame(songT: number, dt: number, cam: THREE.Camera) {
  const d = duet;
  partner.update(d && state === 'resuming' ? d.pausedT ?? songT : songT, state === 'playing' ? dt : 0, headLocal, state !== 'playing');
  // Raumklang: ich hoere den Partner von seiner Position (rechts)
  const q = new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld).premultiply(root.getWorldQuaternion(new THREE.Quaternion()).invert());
  audio.setSpatial(headLocal, new THREE.Vector3(0, 0, -1).applyQuaternion(q), new THREE.Vector3(0, 1, 0).applyQuaternion(q), partner.headPos(new THREE.Vector3()));
  if (!mp.lobby || mp.lobby.members.length < 2) return;
  const now = performance.now();
  if (now - lastPoseLobby >= 1000 / MP_POSE_HZ) {
    lastPoseLobby = now;
    const rq = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const hq = new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld).premultiply(rq);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const hand = (sb: Saber) => [sb.grip.x, sb.grip.y, sb.grip.z, sb.group.quaternion.x, sb.group.quaternion.y, sb.group.quaternion.z, sb.group.quaternion.w].map(r3);
    // Haende ohne aktuelle Pose (Menue am Bildschirm): locker neben dem Koerper
    const rest = (h: 0 | 1) => [headLocal.x + (h ? 0.3 : -0.3), headLocal.y - 0.6, headLocal.z - 0.2, 0, 0, 0, 1].map(r3);
    mp.send({ t: 'pose', head: [headLocal.x, headLocal.y, headLocal.z, hq.x, hq.y, hq.z, hq.w].map(r3), hands: [...(sabers[0].active ? hand(sabers[0]) : rest(0)), ...(sabers[1].active ? hand(sabers[1]) : rest(1))] });
  }
  if (d) duetFrame(songT);
}

/** eigene Spiel-Ereignisse (aus den Zaehlern der Wertung) an den Partner */
let evPrev: { hits: number; misses: number; bad: number; bombs: number; rails: number; wall: boolean; combo: number } | null = null;
function sendEvents(songT: number) {
  const s = gm.score as typeof gm.score & { railsLost?: number };
  const cur = { hits: s.hits, misses: s.misses - (s.railsLost ?? 0), bad: s.badCuts, bombs: s.bombs, rails: s.railsLost ?? 0, wall: gm.inWall, combo: s.combo };
  const p = evPrev; evPrev = cur;
  if (!p || cur.hits < p.hits) return;          // neuer Song: nur merken
  const send = (kind: MpPlayEvent, n: number, value = 0) => { for (let i = 0; i < Math.min(n, 4); i++) mp.send({ t: 'play.event', kind, at: Math.round(songT * 1000) / 1000, hand: -1, value }); };
  send('hit', cur.hits - p.hits); send('miss', cur.misses - p.misses); send('badcut', cur.bad - p.bad);
  send('bomb', cur.bombs - p.bombs); send('railLost', cur.rails - p.rails);
  if (cur.wall && !p.wall) send('wall', 1);
  const ms = COMBO_MILESTONES.find((x) => p.combo < x && cur.combo >= x); if (ms) send('combo', 1, ms);
}

function duetFrame(songT: number) {
  const d = duet!;
  if (!mp.lobby || !['playing', 'resuming', 'paused'].includes(state)) { evPrev = null; return; }
  const now = performance.now();
  if (state === 'playing') sendEvents(songT);
  if (now - d.lastScore >= MP_SCORE_EVERY) {
    d.lastScore = now;
    const s = gm.score;
    mp.send({ t: 'score', rating: Math.round(s.rating * 10) / 10, score: s.score, combo: s.combo, hits: s.hits, misses: s.misses + s.badCuts });
  }
  if (state === 'playing' && now - d.lastSync >= MP_SYNC_EVERY) { d.lastSync = now; mp.send({ t: 'sync', songTime: Math.round(audio.songTime() * 1000) / 1000 }); }
}

// Nachrichten vom Server
mp.on('prepare', (m) => { duetPrepare(m); });
mp.on('start', (m) => duetStart(m.at, m.from));
mp.on('pause', (m) => {
  if (!duet) return;
  duet.pausedT = m.songTime;
  if (state === 'playing' || state === 'resuming') { audio.pause(); state = 'paused'; hud.message(''); }
  if (state === 'paused') menus.pause();
  if (m.by !== mp.me) for (const h of [0, 1] as const) pulse(h, 0.5, 80);
});
mp.on('resume', (m) => {
  if (!duet || (state !== 'paused' && state !== 'playing')) return;
  duet.resumeAt = mp.toLocal(m.at); duet.pausedT = m.songTime;
  audio.playAt(duet.resumeAt, m.songTime);
  state = 'resuming'; menus.hide(); hud.show(true);
});
mp.on('pose', (m) => partner.push(m));
mp.on('play.event', (m) => {
  if (!duet) return;
  partner.event(m.kind, m.hand);
  // Musik bleibt an: „Verfehlt = stumm“ gilt nur fuer eigene Fehler
  audio.partnerSound(m.kind, m.at, settings.partnerVolume);
});
mp.on('score', (m) => {
  if (!duet) return;
  hud.setPartner(`${duet.partnerName}: ${m.rating.toFixed(1)} % · ${m.combo}er Combo`);
  const ms = COMBO_MILESTONES.find((x) => duet!.partnerCombo < x && m.combo >= x);
  if (ms && state === 'playing') hud.popup(`${duet.partnerName}: ${ms}er Combo!`, '#ffe08a', 1.2);
  duet.partnerCombo = m.combo;
});
mp.on('partner', (m) => {
  const txt = m.event === 'lost' ? `${m.name}: Verbindung verloren` : m.event === 'back' ? `${m.name} ist zurück` : `${m.name} hat die Lobby verlassen`;
  if (state === 'playing' || state === 'resuming') hud.popup(txt, m.event === 'back' ? '#9fe8c4' : '#ff9db0', 2);
  else { menus.mpNote = txt; menus.refresh(); }
  if (m.event !== 'back') { partner.hideChar(); hud.setPartner(''); }
  if (m.event === 'left' && duet) partner.setGhost(null);
});
mp.on('results', (m) => {
  if (!duet) return;
  const d = duet;
  hud.show(false);
  menus.duetResults(m, d.song, d.d, d.mode);
});
mp.on('lobby.state', (m) => {
  const l = m.lobby;
  syncPartner();
  // als Host gelten meine Einstellungen automatisch fuer die Party (auch wenn das Menue gerade zu ist)
  if (l && mp.isHost) menus.syncLobby();
  if (l && !m.lobby?.members.some((x) => x.clientId === mp.me && x.look)) sendLook();
  // Host hat zurueck zur Lobby geschickt, oder Laden abgebrochen: Spiel beenden
  if (duet && l && l.state === 'waiting' && ['loading', 'mpready', 'playing', 'paused', 'resuming'].includes(state)) {
    duetEnd(); audio.stop(); orbit.stop(); gm = game; state = 'menu'; hud.show(false); menus.go('lobby', false); menus.show(); presence();
  }
  // Lobby weg mitten im Song: lokal zu Ende spielen
  if (!l && duet && ['playing', 'paused', 'resuming', 'mpready'].includes(state)) {
    duet.solo = true;
    if (state === 'mpready') { duetEnd(); state = 'menu'; menus.go('songs', false); menus.show(); }
    else if (state === 'paused') menus.pause(); else hud.popup('Lobby beendet – du spielst allein weiter', '#ffd9a0', 2.5);
  }
  if (!l && m.reason && !['verlassen', 'neue Lobby', 'gewechselt'].includes(m.reason)) menus.mpNote = `Lobby beendet (${m.reason})`;
  if (menus.visible && !['loading'].includes(menus.screen)) menus.refresh();
});
mp.on('presence', () => { if (menus.visible && ['online', 'lobby', 'songs'].includes(menus.screen)) menus.refresh(); });
mp.on('invite', (m) => {
  const busy = m.quiet || ['playing', 'paused', 'resuming', 'mpready', 'loading'].includes(state);
  menus.addInvite({ from: m.from, lobbyId: m.lobbyId, expiresAt: m.expiresAt }, !busy);
  if (!busy) { pulse(0, 0.6, 120); pulse(1, 0.6, 120); }
  else if (state === 'playing') hud.popup(`✉ ${m.from.name} lädt dich ein`, '#ffe08a', 1.6);
});
mp.on('invite.gone', (m) => menus.dropInvite(m.lobbyId));
mp.on('error', (m) => { menus.mpNote = m.message; if (state === 'playing') hud.popup(m.message, '#ff9db0', 2); else if (menus.visible) menus.refresh(); });
mp.on('outdated', () => { menus.mpNote = 'Bitte Seite neu laden (neue Version)'; $('hint').textContent = 'Zusammen spielen: Bitte Seite neu laden (neue Version).'; menus.refresh(); });
mp.on('welcome', () => {
  presence(); lastLook = ''; sendLook();
  // Lobby nach Neuverbindung weg (Server-Neustart)?
  const had = mp.hadLobby;
  if (had) setTimeout(() => { if (!mp.lobby) { menus.mpNote = 'Lobby wurde beendet'; if (duet && state === 'mpready') { duetEnd(); state = 'menu'; menus.go('songs', false); menus.show(); } menus.refresh(); } }, 1200);
  // Link mit ?lobby=CODE oder ?invite=<clientId> (aus der Bibliothek)
  const q = new URLSearchParams(location.search);
  const code = q.get('lobby'), inv = q.get('invite');
  if (code && !mp.lobby) { mp.send({ t: 'lobby.join', code }); history.replaceState(null, '', location.pathname); if (menus.visible) menus.go('lobby'); }
  if (inv) { mp.send({ t: 'lobby.invite', to: inv }); history.replaceState(null, '', location.pathname); if (menus.visible) menus.go('lobby'); }
});
menus.mp = mp;
mp.start();

// ---------- Latenz-Kalibrierung ----------
let tapTimes: number[] = [];
async function calibrate(): Promise<number | null> {
  await audio.resume();
  state = 'calibrating';
  const bpm = 100, n = 20, start = audio.ctx.currentTime + 1, spb = 60 / bpm;
  const clicks: number[] = [];
  for (let k = 0; k < n; k++) { const t = start + k * spb; clicks.push(t); audio.click(t, k % 4 === 0 ? 1500 : 1000, 0.5); }
  tapTimes = [];
  await new Promise((r) => setTimeout(r, (1 + n * spb + 0.5) * 1000));
  state = 'menu';
  // Abweichung jedes Drucks zum gehoerten Klick (Klick erklingt erst nach der Ausgabe-Latenz)
  // dieselbe Latenz-Quelle wie das Spiel (songTime)
  const outLat = audio.outputDelay();
  const devs = tapTimes.slice(2).map((t) => { let best = Infinity; for (const c of clicks) { const d = t - (c + outLat); if (Math.abs(d) < Math.abs(best)) best = d; } return best; })
    .filter((d) => Math.abs(d) < spb / 2);
  if (devs.length < 8) return null;
  devs.sort((a, b) => a - b);
  return Math.round(devs[devs.length >> 1] * 1000);
}

// ---------- Kalibrierung Spielfeld (MR: Boden/Richtung) ----------
let floorMin = Infinity, floorUntil = 0;
/** Referenzraum wurde neu zentriert: im naechsten Bild neu ausrichten */
let recenter = false;
function setDirection() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const p = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); fwd.y = 0; fwd.normalize();
  // nur die Buehne bewegen: Map und Spielfeld bleiben deckungsgleich (nur Gier-Drehung, keine Neigung)
  stage.position.x = p.x; stage.position.z = p.z;
  stage.rotation.y = Math.atan2(-fwd.x, -fwd.z);
  placeMenu();
}
function placeMenu() { menus.place(); }

// ---------- Start ----------
async function startXR(m: 'vr' | 'ar') {
  const session = await navigator.xr!.requestSession(m === 'ar' ? 'immersive-ar' : 'immersive-vr', {
    requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'plane-detection', 'hit-test'],
  });
  setup(m);
  mp.device = m === 'ar' ? 'mr' : 'vr'; presence();
  await renderer.xr.setSession(session);
  // Neu-Zentrieren (Meta-Taste halten) verschiebt den Referenzraum: im naechsten Bild Map und Spielfeld gemeinsam neu vor den Spieler stellen
  renderer.xr.getReferenceSpace()?.addEventListener('reset', () => { recenter = true; });
  session.addEventListener('end', () => { audio.stop(); state = 'menu'; $('start').hidden = false; renderer.domElement.style.display = 'none'; });
  // 'visible-blurred' = Quest blendet kurz etwas ein (Spielbereich-Grenze, Benachrichtigung): weiterspielen.
  // Nur 'hidden' (Brille abgesetzt, Systemmenue offen) pausiert.
  session.addEventListener('visibilitychange', () => { if (session.visibilityState === 'hidden') pauseGame(`brille:${session.visibilityState}`); presence(session.visibilityState === 'hidden'); });
  if (m === 'ar') { renderer.setClearAlpha(0); scene.background = null; scene.fog = null; }
}

function setup(m: XRMode) {
  mode = m;
  partner.desktop = m === 'desktop';
  $('start').hidden = true; renderer.domElement.style.display = 'block';
  if (!env) { env = new Environment(scene, stage, m === 'ar'); lobbyMap(); }
  // MR-Bodenkorrektur auf der Buehne: Bodenmarkierung der Map und Spielfeld liegen auf demselben Boden
  stage.position.y = m === 'ar' ? settings.floorOffset : 0;
  hud.fps.visible = settings.showFps;
  audio.resume();
  menus.go('main', false); menus.show();
  if (mp.lobby) menus.go('lobby', false);
  else if (menus.invites.length) menus.go('invite', false);
}

$('b-vr').addEventListener('click', () => startXR('vr').catch((e) => alert(`VR ging nicht: ${e.message}`)));
$('b-ar').addEventListener('click', () => startXR('ar').catch((e) => alert(`MR ging nicht: ${e.message}`)));
$('b-desk').addEventListener('click', () => { setup('desktop'); camera.position.set(0, 1.6, 0.3); camera.lookAt(0, 1.3, -3); });
(async () => {
  const xr = navigator.xr;
  const [vr, ar] = await Promise.all([xr?.isSessionSupported('immersive-vr').catch(() => false), xr?.isSessionSupported('immersive-ar').catch(() => false)]);
  $('b-vr').hidden = !vr; $('b-ar').hidden = !ar;
  if (!vr && !ar) $('hint').textContent = 'Dieses Gerät kann kein WebXR. Für VR/MR die Seite im Meta-Quest-Browser öffnen (HTTPS nötig). Hier geht nur der Debug-Modus.';
})();

// Songs + Live-Updates
(async () => {
  const info = await api.info().catch(() => null);
  menus.setQr(info?.publicUrl ? `${info.publicUrl}/` : location.href.replace(/play\.html.*$/, ''));
  await loadLook(); game.applyColors(); applyLook();
  menus.setSongs(await api.songs().catch(() => []));
  const want = new URLSearchParams(location.search).get('song');
  if (want) { const s = menus.songs.find((x) => x.id === want); if (s) { menus.click('songs'); menus.click(`s:${s.id}`); } }
  subscribe({
    song: (s) => { const old = menus.songs.find((x) => x.id === s.id); if (old && old.updatedAt !== s.updatedAt) pruneSong(s.id, s.updatedAt); menus.upsertSong(s); },
    deleted: (id) => menus.removeSong(id),
    open: async () => menus.setSongs(await api.songs().catch(() => menus.songs)),
    yt: (s) => menus.ytUpdate(s),
  });
})();

// ---------- Bild-Schleife ----------
const clock = new THREE.Clock();
let fpsN = 0, fpsT = 0;
const headLocal = new THREE.Vector3();
renderer.setAnimationLoop((_t, frame) => {
  const dt = Math.min(0.05, clock.getDelta());
  const xr = renderer.xr.isPresenting;
  const cam = xr ? renderer.xr.getCamera() : camera;
  // erst im Bild nach dem Neu-Zentrieren ist die Kopfpose aktuell
  if (recenter && xr) { recenter = false; setDirection(); }
  stage.updateMatrixWorld();
  // Kopf in Spielfeld-Koordinaten
  headLocal.setFromMatrixPosition(cam.matrixWorld); root.worldToLocal(headLocal);
  const songT = audio.songTime();

  // Schwerter: Controller-Pose -> Spielfeld
  const playingLike = state === 'playing' || state === 'resuming' || state === 'paused';
  if (xr) {
    for (const inp of inputs) {
      const src = inp.source; const hand = src?.handedness === 'left' ? 0 : src?.handedness === 'right' ? 1 : -1;
      const gp = src?.gamepad;
      if (hand < 0 || !gp || src?.hand) continue;
      const pos = new THREE.Vector3().setFromMatrixPosition(inp.grip.matrixWorld); root.worldToLocal(pos);
      const q = new THREE.Quaternion().setFromRotationMatrix(inp.ray.matrixWorld).premultiply(root.getWorldQuaternion(new THREE.Quaternion()).invert());
      const sb = sabers[hand as 0 | 1];
      sb.setPose(pos, q, performance.now() / 1000);
      // Pause: B/Y
      const b = !!gp.buttons[5]?.pressed;
      if (b && !inp.prevButtons[5] && state === 'playing') pauseGame('knopf-by');
      inp.prevButtons[5] = b;
      // Menue blaettern: Stick
      const ay = gp.axes[3] ?? 0;
      if (menus.visible && Math.abs(ay) > 0.7 && performance.now() > inp.scrollT) { menus.scroll(ay > 0 ? 1 : -1); inp.scrollT = performance.now() + 400; }
    }
  } else if (mode === 'desktop' && playingLike) desktopSabers(songT);
  if (state === 'floor') {
    for (const inp of inputs) if (inp.source) { const y = new THREE.Vector3().setFromMatrixPosition(inp.grip.matrixWorld).y; floorMin = Math.min(floorMin, y); }
    const left = Math.ceil((floorUntil - performance.now()) / 1000);
    menus.loading(`Controller auf den Boden legen … ${Math.max(0, left)}`, 1 - left / 4);
    if (performance.now() > floorUntil) {
      if (floorMin < 1) { settings.floorOffset = Math.round((stage.position.y - (floorMin - 0.025)) * 1000) / 1000; stage.position.y = settings.floorOffset; saveSettings(); }
      state = 'menu'; menus.go('settings', false);
    }
  }

  // Menue-Laser: nur sichtbar, wenn Menue offen
  let hover: string | null = null;
  for (const inp of inputs) {
    inp.line.visible = xr && menus.visible && !!inp.source;
    if (!inp.line.visible) continue;
    setRayFrom(inp.ray);
    const id = menus.pick(raycaster); if (id) hover = id;
    const d = menus.hits(raycaster); inp.line.scale.z = d ?? 2;
  }
  if (!xr && mouseIn && menus.visible) { raycaster.setFromCamera(mouse, camera); hover = menus.pick(raycaster); }
  if (menus.visible) menus.setHover(hover);

  // Spiel
  if (state === 'playing') gm.update(songT, dt, headLocal, false);
  else if (state === 'paused' || state === 'resuming') gm.update(duet && state === 'resuming' ? duet.pausedT ?? songT : songT, 0, headLocal, true);
  if (state === 'resuming' && duet) {
    // Duett: Audio ist schon fuer resumeAt eingeplant (playAt), hier nur Countdown
    const left = Math.ceil(((duet.resumeAt ?? 0) - performance.now()) / 1000);
    hud.message(String(Math.max(1, left)));
    if (performance.now() >= (duet.resumeAt ?? 0)) { hud.message(''); state = 'playing'; }
  } else if (state === 'resuming') {
    const left = Math.ceil((resumeAt - performance.now()) / 1000);
    hud.message(String(Math.max(1, left)));
    if (performance.now() >= resumeAt) { hud.message(''); audio.resumeFrom(0); state = 'playing'; }
  }
  if (duet || mp.lobby) lobbyFrame(songT, dt, cam);
  if (state === 'playing' || state === 'resuming') hud.update(gm.score, dt, gm.inWall);
  // Combo-Effekte: Staerke waechst mit der Serie, Meilensteine feiern, Fehler beendet sie sofort
  if (state === 'playing') {
    const c = gm.score.combo;
    if (c < lastCombo && lastCombo >= COMBO_BREAK_MIN) { hud.popup('Combo vorbei', '#ff4d6d', 1.1); audio.comboBreak(); }
    const m = COMBO_MILESTONES.find((x) => lastCombo < x && c >= x);
    if (m) {
      hud.popup(`${m}er COMBO!`, comboColor(c), 1.6);
      audio.chime(comboLevel(c));
      pulse(0, 0.8, 120); pulse(1, 0.8, 120);
      env?.pulse(0.5 + comboLevel(c) * 0.5);
      const col = new THREE.Color(comboColor(c)).getHex();
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; slicer.burst(headLocal.clone().add(new THREE.Vector3(Math.cos(a) * 0.9, -0.3 + (k % 2) * 0.5, -0.8 + Math.sin(a) * 0.4)), col, 25); }
    }
    lastCombo = c;
    const lvl = comboLevel(c);
    for (const s of sabers) s.setBoost(lvl);
    if (env) env.boost = lvl;
  } else if (state !== 'paused' && state !== 'resuming') { for (const s of sabers) s.setBoost(0); if (env) env.boost = 0; }
  slicer.update(dt);
  // MR: neue Leucht-Materialien (Map-Wechsel, Skins, Funken) regelmaessig passthrough-tauglich machen
  if (mode === 'ar' && (mrFixT += dt) > 0.5) { mrFixT = 0; mrSafeBlending(scene); }
  env?.update(state === 'playing' ? songT : -1, dt, state === 'playing' ? gm.lights : []);
  // Schwerter im Menue ausblenden (Laser), im Spiel zeigen
  if (xr) for (const s of sabers) { s.group.visible = playingLike && s.active && gm.id === 'schnitt'; s.trail.visible = s.group.visible; }

  // FPS
  fpsN++; fpsT += dt;
  if (fpsT >= 1) { if (settings.showFps) hud.setFps(fpsN / fpsT); fpsN = 0; fpsT = 0; }
  void frame;
  renderer.render(scene, camera);
});

// ---------- Desktop-Debug: Autoplay (Taste A) oder Maus fuehrt das rechte Schwert ----------
function desktopSabers(t: number) {
  for (const hand of [0, 1] as const) {
    const sb = sabers[hand];
    if (gm.id === 'orbit') {
      // Orbit: Handkugel direkt am Ziel (Autoplay) bzw. rechte Hand folgt der Maus auf der Trefferebene
      let p = new THREE.Vector3(hand === 0 ? -0.32 : 0.32, 1.15, ORB_HIT_Z + 0.1);
      const target = autoplay ? gm.autoTarget(hand, t) : null;
      if (target) p = target;
      else if (!autoplay && hand === 1 && mouseIn) {
        raycaster.setFromCamera(mouse, camera);
        const tt = (ORB_HIT_Z - raycaster.ray.origin.z) / raycaster.ray.direction.z;
        p = raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, tt);
      }
      // weich nachfuehren (wie eine echte Hand)
      const cur = sb.active ? sb.grip.clone() : p.clone();
      cur.lerp(p, autoplay ? 0.6 : 0.5);
      sb.setPose(cur, new THREE.Quaternion(), performance.now() / 1000);
      continue;
    }
    const restHilt = new THREE.Vector3(hand === 0 ? -0.3 : 0.3, 1.0, -0.2);
    let tipTarget = new THREE.Vector3(hand === 0 ? -0.4 : 0.4, 1.3, -1.1);
    if (autoplay) {
      const target = gm.autoTarget(hand, t);
      if (target) tipTarget = target;
    } else if (hand === 1 && mouseIn) {
      raycaster.setFromCamera(mouse, camera);
      const tt = (HIT_Z - raycaster.ray.origin.z) / raycaster.ray.direction.z;
      tipTarget = raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, tt);
    }
    const dir = tipTarget.clone().sub(restHilt).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    const hilt = tipTarget.clone().addScaledVector(dir, -1.06);
    sb.setPose(hilt, q, performance.now() / 1000);
  }
}

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
(window as unknown as { __bb: unknown }).__bb = { mp, get duet() { return duet; }, partner, game, orbit, get gm() { return gm; }, menus, audio, settings, sabers, camera, renderer, view, slicer, root, stage, hud, get env() { return env; }, get state() { return state; } };
