// Isabella – Bowling in Mixed Reality.
// Brille (WebXR immersive-ar, Quest): Kegel per Strahl auf den echten Boden stellen, Kugel mit der Hand
// (Pinch) oder dem Controller (Grifftaste/Abzug) greifen und werfen – die Wurfgeschwindigkeit kommt aus der
// Handbewegung. Handy (AR): Kegel auf den erkannten Boden tippen, Kugel per Wischen rollen.
// Ohne AR: VR mit virtueller Halle oder Bildschirm-Vorschau (Maus wischen).
import * as THREE from 'three';
import { Lane, BALL_R } from '/bowling.js';
import { Game, drawBoard, boardHeight, BOARD_W } from '/score.js';
import { initSound, cheer } from '/sound.js';
import { Panel, WristMenu, pokeAll } from '/ui-xr.js';

const $ = (id) => document.getElementById(id);
const UP = new THREE.Vector3(0, 1, 0);
const TOOLS = [
  { id: 'place', label: 'Kegel hier' },
  { id: 'reset', label: 'Neu aufstellen' },
  { id: 'new', label: 'Neues Spiel' },
  { id: 'ball', label: 'Kugel holen' },
  { id: 'exit', label: 'Beenden' },
];
const TW = 1000, TH = 120;

/* ---------- Szene ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation?.(1);
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.02, 60);
camera.position.set(0, 1.55, 0.6);
scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 1.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 12 });
scene.add(sun, sun.target);

// Virtuelle Halle (nur VR/Bildschirm, in Mixed Reality sieht man den echten Raum)
const hall = new THREE.Group();
{
  const g = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2236, roughness: 0.9 }));
  g.receiveShadow = true; hall.add(g);
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc89b62, roughness: 0.35 }));
  lane.position.set(0, 0.001, -6); lane.receiveShadow = true; hall.add(lane);
  hall.add(new THREE.GridHelper(40, 40, 0x5a4a70, 0x3a3048));
}
scene.add(hall);
scene.background = new THREE.Color(0x15111d);

const lane = new Lane(scene);
// unsichtbare, groessere Kugel: leichter mit dem Strahl zu treffen
const grabProxy = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
lane.ball.add(grabProxy);
// Mehrere Spieler mit einem Geraet: reihum, jeder spielt einen ganzen Frame
const PLAYERS_KEY = 'lara-players';
let names = ['Spieler 1'];
try { const n = JSON.parse(localStorage.getItem(PLAYERS_KEY)); if (Array.isArray(n) && n.length) names = n.slice(0, 8); } catch {}
let players = [], cur = 0;
function newGame() {
  players = names.map((name) => ({ name, game: new Game() }));
  cur = 0;
  buildBoard();
}

// Anzeigetafel ueber den Kegeln
const bcanvas = document.createElement('canvas'); bcanvas.width = BOARD_W;
let btex = null;
const board = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true }));
board.visible = false; scene.add(board);
let boardMsg = '';
// Tafel an die Spielerzahl anpassen (je Spieler eine Zeile)
function buildBoard() {
  bcanvas.height = boardHeight(players.length);
  btex?.dispose();
  btex = new THREE.CanvasTexture(bcanvas); btex.colorSpace = THREE.SRGBColorSpace;
  board.material.map = btex; board.material.needsUpdate = true;
  board.geometry.dispose();
  const w = 1.5, h = w * bcanvas.height / BOARD_W;
  board.geometry = new THREE.PlaneGeometry(w, h);
  board.userData.h = h;
  if (lane.placed) board.position.y = lane.floorY + 0.75 + h / 2;
  drawScore('');
}
function drawScore(msg) {
  if (msg !== undefined) boardMsg = msg;
  if (!btex) return;
  drawBoard(bcanvas.getContext('2d'), players, cur, boardMsg); btex.needsUpdate = true;
  const p = players[cur];
  const line = `${p.name} · Frame ${Math.min(p.game.frame + 1, 10)} · Wurf ${p.game.ball + 1} · ${p.game.total} Punkte`;
  $('score').textContent = line; $('turn').textContent = `${p.name} ist dran – nach oben wischen zum Rollen`;
}

// Werkzeugleiste (Brille)
const tcanvas = document.createElement('canvas'); tcanvas.width = TW; tcanvas.height = TH;
const ttex = new THREE.CanvasTexture(tcanvas); ttex.colorSpace = THREE.SRGBColorSpace;
const toolbar = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8 * TH / TW), new THREE.MeshBasicMaterial({ map: ttex, transparent: true, depthTest: false }));
toolbar.renderOrder = 10; toolbar.visible = false; scene.add(toolbar);
let toolHover = null, placing = false, note = '';
// Schritt-Tafel (Einrichtung nacheinander), Uhr-Menue am Handgelenk, kurze Hinweise
const wizard = new Panel(0.56); scene.add(wizard);
const toastP = new Panel(0.42); scene.add(toastP);
const wrist = new WristMenu(scene);
let step = null, toastT = 0, startStep = null;
const WRIST_ITEMS = [{ id: 'reset', label: 'Neu aufstellen' }, { id: 'place', label: 'Kegel versetzen' }, { id: 'new', label: 'Neues Spiel' },
  { id: 'players', label: 'Spieler' }, { id: 'ball', label: 'Kugel holen' }, { id: 'exit', label: 'Beenden' }];
wrist.setItems(WRIST_ITEMS);
function toast(msg, sec = 3) {
  if (!renderer.xr.isPresenting || phone) return;
  toastP.show({ text: msg, buttons: [] }); toastP.place(renderer.xr.getCamera(), 0.7); toastP.position.y -= 0.18; toastT = sec;
}
function showStep(id) {
  step = id; placing = id === 'place';
  if (phone || !renderer.xr.isPresenting) { wizard.hide(); return; }
  if (id === 'players') wizard.show({ title: 'Wer spielt?', text: names.join(', ') + `\n(Namen änderst du auf der Startseite)`,
    buttons: [{ id: 'minus', label: '– Spieler' }, { id: 'plus', label: '+ Spieler' }, { id: 'next', label: 'Weiter', main: true }], cols: 2 });
  else if (id === 'place') wizard.show({ title: 'Kegel aufstellen', text: 'Zeig mit dem Strahl auf den Boden, wo der erste Kegel stehen soll, und drück (Daumen + Zeigefinger oder Abzug).',
    buttons: [{ id: 'back', label: 'Zurück' }] });
  else if (id === 'confirm') wizard.show({ title: 'Passt das so?', text: 'Das Dreieck zeigt von dir weg. Du kannst die Kegel später über das Uhr-Menü versetzen.',
    buttons: [{ id: 'go', label: "Los geht's!", main: true }, { id: 'again', label: 'Neu setzen' }] });
  else { wizard.hide(); }
  if (wizard.visible) wizard.place(renderer.xr.getCamera(), 0.75);
}
function stepButton(id) {
  if (step === 'players') {
    if (id === 'minus' && names.length > 1) { names.pop(); savePlayers(); showStep('players'); }
    else if (id === 'plus' && names.length < 8) { names.push(`Spieler ${names.length + 1}`); savePlayers(); showStep('players'); }
    else if (id === 'next') showStep(lane.placed ? null : 'place');
  } else if (step === 'place' && id === 'back') showStep('players');
  else if (step === 'confirm') {
    if (id === 'go') { showStep(null); toast('Kugel greifen: Hand an die leuchtende Kugel, Daumen + Zeigefinger zusammen, schwingen, loslassen.\nMenü: auf dein linkes Handgelenk schauen.', 6); }
    else if (id === 'again') showStep('place');
  }
}
function savePlayers() { try { localStorage.setItem(PLAYERS_KEY, JSON.stringify(names)); } catch {} newGame(); }
function wristButton(id) {
  if (id === 'place') { showStep('place'); return; }
  if (id === 'players') { showStep('players'); return; }
  tool(id);
}
function drawToolbar() {
  if (note) { toast(note); note = ''; }
  return;
  const c = tcanvas.getContext('2d'); c.clearRect(0, 0, TW, TH);
  const w = TW / TOOLS.length;
  TOOLS.forEach((t, k) => {
    const on = toolHover === t.id || (t.id === 'place' && placing);
    c.fillStyle = on ? 'rgba(255,122,182,0.95)' : 'rgba(24,18,34,0.88)';
    c.beginPath(); c.roundRect ? c.roundRect(k * w + 5, 40, w - 10, 76, 22) : c.rect(k * w + 5, 40, w - 10, 76); c.fill();
    c.fillStyle = on ? '#2a0f1f' : '#fbe9f2'; c.font = '600 26px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(t.label, k * w + w / 2, 78);
  });
  const s = note || (placing ? 'Auf den Boden zielen und drücken: dort steht der erste Kegel' : 'Kugel greifen (Pinch / Grifftaste) und werfen');
  c.font = '500 22px system-ui, sans-serif'; c.fillStyle = 'rgba(24,18,34,0.88)';
  const sw = Math.min(TW - 10, c.measureText(s).width + 30);
  c.beginPath(); c.roundRect ? c.roundRect((TW - sw) / 2, 2, sw, 32, 16) : c.rect((TW - sw) / 2, 2, sw, 32); c.fill();
  c.fillStyle = '#fbe9f2'; c.fillText(s, TW / 2, 19);
  ttex.needsUpdate = true;
}

// Ziel-Ring auf dem Boden (Kegel aufstellen)
const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff7ab6, transparent: true, opacity: 0.9, depthTest: false }));
ring.renderOrder = 9; ring.visible = false; scene.add(ring);

/* ---------- Eingaben (Brille) ---------- */
const raycaster = new THREE.Raycaster();
const inputs = [0, 1].map((i) => {
  const ray = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i), hand = renderer.xr.getHand(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xff7ab6, transparent: true, opacity: 0.7 }));
  line.scale.z = 0.5; line.visible = false; ray.add(line);
  const inp = { i, ray, grip, hand, line, mode: null, hist: [] };
  ray.addEventListener('connected', (e) => { inp.mode = e.data.targetRayMode; inp.source = e.data; line.visible = inp.mode === 'tracked-pointer' && !e.data.hand; });
  ray.addEventListener('disconnected', () => { inp.mode = null; line.visible = false; if (held?.inp === inp) release(); });
  ray.addEventListener('selectstart', () => pending.push({ inp, kind: 'select' }));
  ray.addEventListener('selectend', () => pending.push({ inp, kind: 'end' }));
  ray.addEventListener('squeezestart', () => pending.push({ inp, kind: 'squeeze' }));
  ray.addEventListener('squeezeend', () => pending.push({ inp, kind: 'end' }));
  scene.add(ray, grip, hand);
  return inp;
});
let pending = [], held = null;

// Greifpunkt: Hand = zwischen Daumen und Zeigefinger, Controller = Griff
function point(inp) {
  const j = inp.hand.joints;
  if (j && j['index-finger-tip']?.visible && j['thumb-tip']) {
    const a = j['index-finger-tip'].getWorldPosition(new THREE.Vector3()), b = j['thumb-tip'].getWorldPosition(new THREE.Vector3());
    return { pos: a.add(b).multiplyScalar(0.5), hand: true };
  }
  if (inp.mode === 'tracked-pointer') {
    const o = inp.grip.visible ? inp.grip : inp.ray;
    return { pos: o.getWorldPosition(new THREE.Vector3()), hand: false };
  }
  return null;
}

function setRay(inp) {
  const m = new THREE.Matrix4().extractRotation(inp.ray.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(inp.ray.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
  return raycaster;
}

function floorHit(ray) {
  if (ray.direction.y > -0.03) return null;
  const t = (lane.floorY - ray.origin.y) / ray.direction.y;
  return t > 0 && t < 15 ? ray.origin.clone().addScaledVector(ray.direction, t) : null;
}

function viewerPos() { return new THREE.Vector3().setFromMatrixPosition(renderer.xr.isPresenting ? renderer.xr.getCamera().matrixWorld : camera.matrixWorld); }

// Kann man die Kugel gerade greifen? (Hand/Controller nah dran oder Strahl zielt drauf)
const GRAB_NEAR = 0.2;                      // Abstand von der Kugeloberflaeche (grosszuegig)
function grabTarget(inp) {
  if (!lane.ball.visible || lane.ballState === 'rolling' || lane.ballState === 'scored') return null;
  const pt = point(inp);
  if (pt && pt.pos.distanceTo(lane.ball.position) < BALL_R + GRAB_NEAR) return { near: true, pt };
  setRay(inp);
  if (raycaster.intersectObject(grabProxy)[0]) return { near: false, pt };
  return null;
}

function press(inp, kind) {
  if (!inp.mode) return;
  setRay(inp);
  for (const [pn, fn] of [[wizard, stepButton], [wrist.panel, wristButton]]) {
    const i = pn.pick(raycaster); if (i >= 0) { fn(pn.idAt(i)); return; }
  }
  // 1) Kugel greifen hat Vorrang (sonst faengt die Werkzeugleiste den Griff ab)
  const g = !placing && grabTarget(inp);
  if (g) {
    lane.grab();
    held = { inp, offset: g.near ? lane.ball.position.clone().sub(g.pt.pos).clampLength(0, BALL_R * 0.6) : new THREE.Vector3(0, -0.02, 0) };
    inp.hist = [];
    pulse(inp, 0.6, 40);
    note = ''; drawToolbar();
    return;
  }
  setRay(inp);
  // 2) Werkzeugleiste
  if (toolbar.visible) {
    const h = raycaster.intersectObject(toolbar)[0];
    if (h) { tool(TOOLS[Math.floor(h.uv.x * TOOLS.length)]?.id); return; }
  }
  // 3) Kegel aufstellen
  if ((placing || !lane.placed) && kind === 'select') {
    const p = arHit || floorHit(raycaster.ray);
    if (p) placePins(p);
    return;
  }
  // 4) daneben gegriffen: Hinweis
  if (lane.placed && lane.ballState === 'rest') { note = 'Hand an die Kugel (sie leuchtet) und Daumen + Zeigefinger zusammen'; drawToolbar(); }
}

function release() {
  if (!held) return;
  const h = held.inp.hist;
  held = null;
  // Wurfgeschwindigkeit aus den letzten ~90 ms der Handbewegung
  let v = new THREE.Vector3();
  if (h.length >= 2) {
    const last = h[h.length - 1];
    let first = h[0];
    for (const s of h) if (last.t - s.t <= 90) { first = s; break; }
    const dt = (last.t - first.t) / 1000;
    if (dt > 0.01) v = last.p.clone().sub(first.p).divideScalar(dt);
  }
  if (v.length() < 0.4) { lane.ballToHome(); return; }   // nur losgelassen: zurueck zur Rueckgabe
  v.multiplyScalar(1.15);                                 // Wuerfe fuehlen sich sonst zu schwach an
  if (v.y > 0.5) v.y = 0.5;
  lane.throw(v, new THREE.Vector3(v.z, 0, -v.x).multiplyScalar(1 / BALL_R * 0.6));   // Vorwaertsdrall (Rollen ohne Rutschen)
  note = ''; drawToolbar();
}

function pulse(inp, v, ms) { try { inp.source?.gamepad?.hapticActuators?.[0]?.pulse(v, ms); } catch {} }

/* ---------- Spiel ---------- */
function ballHome() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const p = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  return p.addScaledVector(fwd, 0.4).addScaledVector(right, 0.3).setY(Math.max(lane.floorY + 0.8, p.y - 0.65));   // rechts vor dir, etwa Hüfthöhe
}

function placePins(p) {
  const v = viewerPos();
  const dir = p.clone().sub(v).setY(0);
  if (dir.lengthSq() < 0.01) dir.set(0, 0, -1);
  lane.place(p, dir.normalize());
  ring.visible = false; if (!phone && renderer.xr.isPresenting) showStep('confirm'); else showStep(null);
  // Tafel ueber den hinteren Kegeln, zum Spieler gedreht
  board.position.copy(p).addScaledVector(dir, 1.3).setY(lane.floorY + 0.75 + (board.userData.h || 0.4) / 2);
  board.lookAt(v.x, board.position.y, v.z); board.visible = true;
  sun.position.copy(p).add(new THREE.Vector3(1.5, 4, 1)); sun.target.position.copy(p);
  lane.ballToHome(ballHome());
  note = ''; drawToolbar(); drawScore('');
  try { localStorage.setItem('lara-dist', String(p.distanceTo(v))); } catch {}
}

function tool(id) {
  if (!id) return;
  if (id === 'place') { if (placing) showStep(null); else showStep('place'); ring.visible = false; }
  else if (id === 'reset') { if (lane.placed) lane.resetPins(); }
  else if (id === 'new') { newGame(); if (lane.placed) lane.resetPins(); }
  else if (id === 'ball') lane.ballToHome(ballHome());
  else if (id === 'exit') renderer.xr.getSession()?.end();
  drawToolbar();
}

// Wurf auswerten, wenn alles ruhig ist
function scoreRoll() {
  if (players.every((pl) => pl.game.over)) newGame();   // nach Spielende: naechster Wurf startet ein neues Spiel
  const p = players[cur], g = p.game, f0 = g.frame;
  const before = lane.pins.filter((q) => q.active).length;
  const down = before - lane.standing();
  const r = g.add(down);
  let msg = down === 0 ? `${p.name}: daneben!` : `${p.name}: ${down} Kegel`;
  if (r.strike) { msg = `STRIKE, ${p.name}!`; cheer(true); } else if (r.spare) { msg = `Spare, ${p.name}!`; cheer(false); }
  const turnOver = g.frame !== f0 || r.over;
  drawScore(msg);
  setTimeout(() => {
    if (turnOver) {
      lane.resetPins();
      if (players.every((pl) => pl.game.over)) {
        const best = players.reduce((a, b) => (b.game.total > a.game.total ? b : a));
        drawScore(players.length > 1 ? `${best.name} gewinnt mit ${best.game.total}! · Neues Spiel` : `Fertig: ${best.game.total} Punkte · Neues Spiel`);
        cheer(true);
      } else {
        do cur = (cur + 1) % players.length; while (players[cur].game.over);
        drawScore(players.length > 1 ? `${players[cur].name} ist dran!` : '');
        if (players.length > 1) setTimeout(() => drawScore(''), 2500);
      }
    } else {
      if (r.reset) lane.resetPins(); else lane.clearDown();
      drawScore('');
    }
    lane.ballToHome(ballHome());
  }, 1400);
}

/* ---------- Handy: Wischen zum Rollen, Tippen zum Aufstellen ---------- */
let swipe = null, arHit = null, hitSource = null;
function swipeStart(x, y) { initSound(); swipe = { x, y, t: performance.now() }; }
function swipeEnd(x, y) {
  if (!swipe) return;
  const dt = (performance.now() - swipe.t) / 1000, dx = x - swipe.x, dy = swipe.y - y;
  swipe = null;
  if (placing || !lane.placed) { const p = arHit || screenFloor(x, y); if (p) placePins(p); return; }
  if (lane.ballState === 'rolling' || dy < 30 || dt <= 0) return;
  // Kugel vor der Kamera loslassen, Richtung nach dem Wisch
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const speed = Math.min(9, Math.max(3, (dy / innerHeight) / dt * 5));
  const dir = fwd.clone().addScaledVector(right, (dx / Math.max(dy, 1)) * 0.5).normalize();
  const start = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).addScaledVector(fwd, 0.4).setY(lane.floorY + BALL_R + 0.01);
  lane.grab(); lane.hold(start);
  lane.throw(dir.clone().multiplyScalar(speed), new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(speed / BALL_R * 0.6));
}
function screenFloor(x, y) {
  const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return floorHit(raycaster.ray);
}

/* ---------- Ablauf pro Frame ---------- */
let lastT = performance.now();
renderer.setAnimationLoop((t, frame) => {
  const now = performance.now(), dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const xr = renderer.xr.isPresenting;
  if (frame) {
    const ref = renderer.xr.getReferenceSpace();
    // Handy: Ziel auf erkannter Flaeche
    if (hitSource) {
      const r = frame.getHitTestResults(hitSource)[0]?.getPose(ref);
      arHit = r ? new THREE.Vector3(r.transform.position.x, r.transform.position.y, r.transform.position.z) : null;
    }
    // erkannte Waende (Quest-Raumeinrichtung)
    if (frame.detectedPlanes && now - (wallsT || 0) > 2000) {
      wallsT = now;
      const segs = [];
      frame.detectedPlanes.forEach((p) => {
        if (p.orientation !== 'vertical') return;
        const pose = frame.getPose(p.planeSpace, ref); if (!pose) return;
        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        const pts = p.polygon.map((q) => new THREE.Vector3(q.x, q.y, q.z).applyMatrix4(m));
        let a = pts[0], b = pts[0], best = -1;
        for (const u of pts) for (const w of pts) { const d = (u.x - w.x) ** 2 + (u.z - w.z) ** 2; if (d > best) { best = d; a = u; b = w; } }
        segs.push([[a.x, a.z], [b.x, b.z]]);
      });
      if (segs.length !== wallsN) { wallsN = segs.length; lane.setWalls(segs); }
    }
  }
  // Druecke
  const pend = pending; pending = [];
  for (const e of pend) { if (e.kind === 'end') { if (held?.inp === e.inp) release(); } else if (!held) press(e.inp, e.kind); }
  // gehaltene Kugel folgt der Hand, Bewegung fuer den Wurf merken
  if (held) {
    const pt = point(held.inp);
    if (pt) {
      const p = pt.pos.clone().add(held.offset);
      lane.hold(p);
      held.inp.hist.push({ p, t: now });
      while (held.inp.hist.length > 12) held.inp.hist.shift();
    }
  }
  // Ziel-Ring beim Aufstellen, Hervorheben der Werkzeugleiste
  let hover = null;
  if (xr) {
    let ringAt = null;
    for (const inp of inputs) {
      if (!inp.mode) continue;
      setRay(inp);
      for (const pn of [wizard, wrist.panel]) pn.setHover(pn.pick(raycaster));
      if (placing && !ringAt) ringAt = floorHit(raycaster.ray);
      if (inp.line.visible) { const h = raycaster.intersectObjects([wizard, wrist.panel, lane.ball].filter((o) => o.visible))[0]; inp.line.scale.z = h ? h.distance : placing ? 4 : 0.5; }
    }
    if (arHit && placing) ringAt = arHit;
    ring.visible = !!ringAt; if (ringAt) ring.position.copy(ringAt).setY(lane.floorY + 0.005);
    void hover;
    if (startStep) { showStep(startStep); startStep = null; }
    const cam = renderer.xr.getCamera(), head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    wrist.enabled = !step && !phone;
    wrist.update(inputs, head, dt);
    if (wizard.visible) wizard.place(cam, 0.75, true);
    if (toastP.visible) { toastT -= dt; if (toastT <= 0) toastP.hide(); }
    const pk = pokeAll([wizard, wrist.panel], inputs, {});
    if (pk) (pk.panel === wizard ? stepButton : wristButton)(pk.id);
  }
  // wartende Kugel bleibt in Reichweite, auch wenn man herumlaeuft
  if (xr && lane.ballState === 'rest' && lane.placed) {
    const want = ballHome();
    if (want.distanceTo(lane.ballHome) > 0.5) lane.ballHome.lerp(want, Math.min(1, dt * 2));
  }
  // Kugel leuchtet, wenn man sie greifen kann
  if (xr && !held) {
    const can = inputs.some((inp) => inp.mode && grabTarget(inp));
    lane.ball.material.emissive.setHex(can ? 0x552244 : 0x000000);
  } else lane.ball.material.emissive.setHex(held ? 0x331122 : 0x000000);
  lane.step(dt);
  if (lane.rollDone()) { lane.ballState = 'scored'; scoreRoll(); }
  renderer.render(scene, camera);
});
let wallsT = 0, wallsN = -1;

// Werkzeugleiste schwebt unten vor dem Spieler und folgt der Blickrichtung langsam
let tYaw;
function placeToolbar() {
  if (phone) { toolbar.visible = false; return; }
  toolbar.visible = true;
  const cam = renderer.xr.getCamera();
  const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); dir.y = 0;
  if (dir.lengthSq() < 1e-4) return;
  const yaw = Math.atan2(dir.x, dir.z);
  if (tYaw === undefined) tYaw = yaw;
  const d = Math.atan2(Math.sin(yaw - tYaw), Math.cos(yaw - tYaw));
  if (Math.abs(d) > 0.6) tYaw += d * 0.08;
  toolbar.position.copy(pos).add(new THREE.Vector3(Math.sin(tYaw), 0, Math.cos(tYaw)).multiplyScalar(0.7));
  toolbar.position.y = pos.y - 0.45;
  toolbar.lookAt(pos.x, toolbar.position.y + 0.25, pos.z);
}

/* ---------- Spieler-Einstellung (Startseite) ---------- */
function renderPlayers() {
  const box = $('players'); box.innerHTML = '';
  names.forEach((n, i) => {
    const row = document.createElement('div'); row.className = 'prow';
    const inp = document.createElement('input'); inp.value = n; inp.maxLength = 14; inp.placeholder = `Spieler ${i + 1}`;
    inp.addEventListener('input', () => { names[i] = inp.value; });
    const del = document.createElement('button'); del.className = 'pdel'; del.textContent = '✕'; del.title = 'Entfernen';
    del.disabled = names.length === 1;
    del.addEventListener('click', () => { readPlayers(); names.splice(i, 1); renderPlayers(); });
    row.append(inp, del); box.append(row);
  });
  $('p-add').disabled = names.length >= 8;
}
function readPlayers() {
  names = names.map((n, i) => (n || '').trim() || `Spieler ${i + 1}`);
  try { localStorage.setItem(PLAYERS_KEY, JSON.stringify(names)); } catch {}
  if (players.length !== names.length || players.some((p, i) => p.name !== names[i])) newGame();
}
$('p-add').addEventListener('click', () => { readPlayers(); names.push(`Spieler ${names.length + 1}`); renderPlayers(); });
renderPlayers();

/* ---------- Start ---------- */
let phone = false;
async function start(mode) {
  initSound();
  readPlayers();
  if (mode === 'screen') {
    $('start').hidden = true; $('hud').hidden = false; hall.visible = true;
    scene.background = new THREE.Color(0x15111d);
    lane.setFloor(0); lane.setVisible(true);
    placePins(new THREE.Vector3(0, 0, -5.5));
    return;
  }
  const init = { optionalFeatures: ['local-floor', 'hand-tracking', 'hit-test', 'plane-detection'] };
  if (mode === 'ar') { init.optionalFeatures.push('dom-overlay'); init.domOverlay = { root: $('overlay') }; }
  const session = await navigator.xr.requestSession(mode === 'ar' ? 'immersive-ar' : 'immersive-vr', init);
  try { await renderer.xr.setSession(session); }
  catch { renderer.xr.setReferenceSpaceType('local'); await renderer.xr.setSession(session); lane.setFloor(-1.5); }
  phone = !!session.domOverlayState;
  hall.visible = mode === 'vr';
  scene.background = mode === 'vr' ? new THREE.Color(0x15111d) : null;
  $('start').hidden = true; $('overlay').hidden = !phone;
  try {
    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource?.({ space: viewer }) || null;
  } catch { hitSource = null; }
  tYaw = undefined; note = ''; toolbar.visible = false;
  if (phone) showStep('place'); else { step = null; startStep = 'players'; }
  lane.setVisible(lane.placed);
  drawToolbar(); drawScore('');
  session.addEventListener('end', () => { hitSource = null; $('start').hidden = false; $('overlay').hidden = true; hall.visible = true; scene.background = new THREE.Color(0x15111d); toolbar.visible = false; ring.visible = false; held = null; wizard.hide(); toastP.hide(); wrist.panel.hide(); step = null; });
}

$('btn-ar').addEventListener('click', () => start('ar').catch((e) => alert(`Mixed Reality ging nicht: ${e.message}`)));
$('btn-vr').addEventListener('click', () => start('vr').catch((e) => alert(`VR ging nicht: ${e.message}`)));
$('btn-screen').addEventListener('click', () => start('screen'));
for (const [id, t] of [['o-place', 'place'], ['o-reset', 'reset'], ['o-new', 'new'], ['o-exit', 'exit'], ['h-reset', 'reset'], ['h-new', 'new']]) {
  $(id).addEventListener('click', (e) => { e.stopPropagation(); tool(t); $('o-place').classList.toggle('on', placing); });
}
$('overlay').addEventListener('beforexrselect', (e) => e.preventDefault());   // Handy: Tippen nicht als XR-Druck werten
for (const el of [$('overlay'), renderer.domElement]) {
  el.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; swipeStart(e.clientX, e.clientY); });
  el.addEventListener('pointerup', (e) => { if (e.target.closest('button')) return; swipeEnd(e.clientX, e.clientY); });
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// Was kann das Geraet?
(async () => {
  const xr = navigator.xr;
  const ar = await xr?.isSessionSupported?.('immersive-ar').catch(() => false);
  const vr = await xr?.isSessionSupported?.('immersive-vr').catch(() => false);
  $('btn-ar').hidden = !ar; $('btn-vr').hidden = !vr;
  if (!ar && !vr) $('hint').textContent = 'Dieses Gerät kann kein WebXR – zum Ausprobieren gibt es die Bildschirm-Version. Für Mixed Reality die Seite in der Meta Quest öffnen (HTTPS nötig).';
})();
newGame(); drawToolbar();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.__lara = { lane, get players() { return players; }, get cur() { return cur; }, placePins, tool, scoreRoll };   // fuer Tests
