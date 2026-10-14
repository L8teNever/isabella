// BeatBlade – Spiel (WebXR VR/MR, Desktop-Debugmodus).
import './style.css';
import * as THREE from 'three';
import type { Difficulty, Song } from '@beatblade/core';
import { api, subscribe } from './api';
import { mrSafeBlending } from './game/mrblend';
import { loadLook, loadBlockSkin, buildSaber, currentSaber, pickMap, mapStyle, wallFor, wallStyle, mapItems } from './look';
import { settings, saveSettings } from './settings';
import { AudioPlayer } from './audio/player';
import { loadAudio, loadBeatmap, loadOrbitMap, pruneSong } from './storage/cache';
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

type State = 'menu' | 'loading' | 'playing' | 'paused' | 'resuming' | 'results' | 'calibrating' | 'floor';
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
const root = new THREE.Group();            // Spielfeld (kalibrierbar: Richtung/Boden)
scene.add(root);

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
  slice: (v) => audio.slice(v),
  finished: () => finish(),
  muteNow: () => audio.muteNow(),
});
const orbit = new OrbitGame(root, view, slicer, sabers, {
  haptic: (hand, v, ms) => pulse(hand, v, ms),
  touch: (v) => audio.slice(v),
  finished: () => finish(),
  muteNow: () => audio.muteNow(),
});
/** laufender Spielmodus (Schnitt oder Orbit) */
let gm: GameMode = game;
// Modus per Adresse vorwaehlen (…/play.html?mode=orbit), sonst der zuletzt gespielte
{ const m = new URLSearchParams(location.search).get('mode'); if (m === 'orbit' || m === 'schnitt') { settings.gameMode = m; saveSettings(); } }


const menus = new Menus(root, {
  play: (s, d, seed) => startSong(s, d, seed),
  resume: () => { state = 'resuming'; resumeAt = performance.now() + 3000; menus.hide(); hud.show(true); if (renderer.xr.isPresenting) setDirection(); },
  restart: () => { if (current) { settings.gameMode = current.mode; startSong(current.song, current.d, current.seed); } },
  quitToMenu: () => { audio.stop(); toMenu(); },
  exitXR: () => renderer.xr.getSession()?.end(),
  calibrateLatency: () => calibrate(),
  setFloor: () => { state = 'floor'; floorMin = Infinity; floorUntil = performance.now() + 4000; },
  setDirection: () => setDirection(),
  isMR: () => mode === 'ar',
  inXR: () => renderer.xr.isPresenting,
  applySettings: () => { audio.setVolume(settings.volume); hud.fps.visible = settings.showFps; game.applyColors(); orbit.applyColors(); applyLook(); },
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
let saberKey = '';
/** Lobby-Hintergrund: immer eine zufaellige Map */
function lobbyMap() {
  const list = mapItems();
  if (env && list.length) env.setMap(mapStyle(list[Math.floor(Math.random() * list.length)]));
}
/** Map (gewaehlt oder zufaellig) und passende Waende setzen */
function applyMap() {
  const m = pickMap();
  env?.setMap(mapStyle(m));
  view.setWallSkin(wallStyle(wallFor(m)));
  // Themen-Maps (Halloween, Weihnachten) bringen eigene Bloecke und Farben mit
  const blockSkin = typeof m?.data.blockSkin === 'string' ? m.data.blockSkin : undefined;
  const colorSet = typeof m?.data.colorSet === 'string' ? m.data.colorSet : undefined;
  game.applyColors(colorSet); orbit.applyColors(colorSet);
  loadBlockSkin(blockSkin).then((s) => { view.setSkin(s); slicer.setSkin(s.geo, s.mat); });
}
function applyLook() {
  loadBlockSkin().then((s) => { view.setSkin(s); slicer.setSkin(s.geo, s.mat); });
  // Schwert nur neu bauen, wenn ein anderes gewaehlt wurde
  const key = currentSaber()?.id ?? '';
  if (key !== saberKey) { saberKey = key; for (const sb of sabers) buildSaber(sb.color).then((v) => { if ((currentSaber()?.id ?? '') === key) sb.setVisual(v); }); }
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
  audio.pause(); state = 'paused'; hud.message(''); menus.pause(); sendLog(`pause:${why}`);
}

function sendLog(reason: string) {
  const s = gm.score;
  api.debug({ reason, song: current?.song.title, d: current?.d, ua: navigator.userAgent, songT: Math.round(audio.songTime() * 100) / 100, rating: Math.round(s.rating * 10) / 10, hits: s.hits, misses: s.misses, badDir: s.badDir, badColor: s.badColor, bombs: s.bombs, wallTime: Math.round(s.wallTime * 100) / 100, outputLatency: audio.ctx.outputLatency, baseLatency: audio.ctx.baseLatency, latencyMs: settings.latencyMs, mode: gm.id, cuts: gm.debugLog() });
}

function finish() {
  sendLog('end');
  // Musik ausblenden, dann Ergebnis (kein Game Over – jeder Song laeuft bis zum Ende)
  const g = audio.gain.gain; g.setTargetAtTime(0, audio.ctx.currentTime, 0.4);
  setTimeout(() => { audio.stop(); audio.setVolume(settings.volume); }, 1500);
  state = 'results';
  setTimeout(() => { hud.show(false); if (current) menus.results(gm.score, current.song, current.d, gm.id); }, 800);
}

function toMenu() { orbit.stop(); gm = game; state = 'menu'; hud.show(false); for (const s of sabers) if (!renderer.xr.isPresenting && mode !== 'desktop') s.hide(); menus.go('songs', false); menus.show(); lobbyMap(); game.applyColors(); applyLook(); }

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
  const outLat = audio.ctx.outputLatency || audio.ctx.baseLatency || 0;
  const devs = tapTimes.slice(2).map((t) => { let best = Infinity; for (const c of clicks) { const d = t - (c + outLat); if (Math.abs(d) < Math.abs(best)) best = d; } return best; })
    .filter((d) => Math.abs(d) < spb / 2);
  if (devs.length < 8) return null;
  devs.sort((a, b) => a - b);
  return Math.round(devs[devs.length >> 1] * 1000);
}

// ---------- Kalibrierung Spielfeld (MR: Boden/Richtung) ----------
let floorMin = Infinity, floorUntil = 0;
function setDirection() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const p = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); fwd.y = 0; fwd.normalize();
  root.position.x = p.x; root.position.z = p.z;
  root.rotation.y = Math.atan2(-fwd.x, -fwd.z);
  placeMenu();
}
function placeMenu() { menus.place(); }

// ---------- Start ----------
async function startXR(m: 'vr' | 'ar') {
  const session = await navigator.xr!.requestSession(m === 'ar' ? 'immersive-ar' : 'immersive-vr', {
    requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'plane-detection', 'hit-test'],
  });
  setup(m);
  await renderer.xr.setSession(session);
  session.addEventListener('end', () => { audio.stop(); state = 'menu'; $('start').hidden = false; renderer.domElement.style.display = 'none'; });
  // 'visible-blurred' = Quest blendet kurz etwas ein (Spielbereich-Grenze, Benachrichtigung): weiterspielen.
  // Nur 'hidden' (Brille abgesetzt, Systemmenue offen) pausiert.
  session.addEventListener('visibilitychange', () => { if (session.visibilityState === 'hidden') pauseGame(`brille:${session.visibilityState}`); });
  if (m === 'ar') { renderer.setClearAlpha(0); scene.background = null; scene.fog = null; }
}

function setup(m: XRMode) {
  mode = m;
  $('start').hidden = true; renderer.domElement.style.display = 'block';
  if (!env) { env = new Environment(scene, m === 'ar'); lobbyMap(); }
  root.position.y = m === 'ar' ? settings.floorOffset : 0;
  hud.fps.visible = settings.showFps;
  audio.resume();
  menus.go('main', false); menus.show();
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
  root.updateMatrixWorld();
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
      if (floorMin < 1) { settings.floorOffset = Math.round((root.position.y - (floorMin - 0.025)) * 1000) / 1000; root.position.y = settings.floorOffset; saveSettings(); }
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
  else if (state === 'paused' || state === 'resuming') gm.update(songT, 0, headLocal, true);
  if (state === 'resuming') {
    const left = Math.ceil((resumeAt - performance.now()) / 1000);
    hud.message(String(Math.max(1, left)));
    if (performance.now() >= resumeAt) { hud.message(''); audio.resumeFrom(0); state = 'playing'; }
  }
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
(window as unknown as { __bb: unknown }).__bb = { game, orbit, get gm() { return gm; }, menus, audio, settings, sabers, camera, renderer, view, slicer, root, hud, get env() { return env; }, get state() { return state; } };
