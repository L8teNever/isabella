// Isabella – Bowling in Mixed Reality.
// Brille (WebXR immersive-ar, Quest): die Bahn wird automatisch in den gescannten Raum gelegt (laengste freie
// Strecke, Moebel werden umgangen), mit Foul-Linie. Die Kugel liegt automatisch in der Hand; geworfen wird
// mit einem Schwung nach vorn (oder Pinch/Abzug halten und loslassen). Handy (AR): Kegel auf den erkannten Boden tippen, Kugel per Wischen rollen.
// Ohne AR: VR mit virtueller Halle oder Bildschirm-Vorschau (Maus wischen).
import * as THREE from 'three';
import { Lane, BALL_R } from '/bowling.js';
import { Game, drawBoard, boardHeight, BOARD_W } from '/score.js';
import { initSound, cheer } from '/sound.js';
import { Panel, WristMenu, pokeAll } from '/ui-xr.js';
import { RoomScan } from '/room-scan.js';
import { RoomEdges } from '/room-edge.js';
import { findLanes } from '/lane-fit.js';

const $ = (id) => document.getElementById(id);
const UP = new THREE.Vector3(0, 1, 0);

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
  hall.add(new THREE.GridHelper(40, 40, 0x5a4a70, 0x3a3048));
}
scene.add(hall);
scene.background = new THREE.Color(0x15111d);

const lane = new Lane(scene);
const scan = new RoomScan(scene);
const edges = new RoomEdges(scene); edges.visible = false;
let lanes = [], laneIdx = 0, searchT = 0, foul = null, isFoul = false;
const HAND_KEY = 'isabella-hand';
let bowlHand = 'right';
try { bowlHand = localStorage.getItem(HAND_KEY) === 'left' ? 'left' : 'right'; } catch {}

// Sichtbare Bahn auf dem Boden: Anlauf, Foul-Linie, Bahn mit Pfeilen bis hinter die Kegel
const laneVis = new THREE.Group(); laneVis.visible = false; scene.add(laneVis);
function woodTex() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 1024; const x = c.getContext('2d');
  for (let i = 0; i < 16; i++) { x.fillStyle = `hsl(${30 + Math.random() * 6},${45 + Math.random() * 10}%,${52 + Math.random() * 10}%)`; x.fillRect(i * 16, 0, 16, 1024); }
  x.fillStyle = 'rgba(80,40,10,0.25)'; for (let i = 0; i <= 16; i++) x.fillRect(i * 16, 0, 1, 1024);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapT = THREE.RepeatWrapping; return t;
}
const laneMat = new THREE.MeshStandardMaterial({ map: woodTex(), roughness: 0.3, transparent: true, opacity: 0.85 });
const gutterMat = new THREE.MeshStandardMaterial({ color: 0x24202c, roughness: 0.6, transparent: true, opacity: 0.85 });
const foulMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const arrowMat = new THREE.MeshBasicMaterial({ color: 0x8a3cff });
function buildLaneVis(f, dir, dist) {
  for (const m of [...laneVis.children]) { laneVis.remove(m); m.geometry.dispose(); }
  const len = dist + 0.79 + 0.3;           // Foul-Linie bis hinter das Dreieck
  const y = lane.floorY + 0.002;
  const add = (geo, mat, along, side, h = 0) => {
    const m = new THREE.Mesh(geo, mat); m.receiveShadow = true;
    m.userData = { along, side, y: y + h };
    laneVis.add(m); return m;
  };
  laneMat.map.repeat.set(1, len / 2);
  add(new THREE.PlaneGeometry(1.05, len), laneMat, len / 2, 0);
  for (const sd of [-1, 1]) add(new THREE.PlaneGeometry(0.12, len), gutterMat, len / 2, sd * 0.585);
  add(new THREE.PlaneGeometry(1.4, 0.035), foulMat, 0, 0, 0.001).userData.foul = true;
  add(new THREE.PlaneGeometry(1.29, 0.9), gutterMat, -0.45, 0, -0.0005);      // Anlauf
  const ad = Math.min(4.6, dist * 0.35);
  for (let k = -3; k <= 3; k++) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.025, -0.05, 0), new THREE.Vector3(0.025, -0.05, 0), new THREE.Vector3(0, 0.05, 0)]);
    add(g, arrowMat, ad + Math.abs(k) * 0.08, k * 0.13, 0.001);
  }
  // in Bahn-Koordinaten (along = Richtung Kegel, side = rechts) legen
  const yaw = Math.atan2(-dir.x, -dir.z), side = new THREE.Vector3(-dir.z, 0, dir.x);
  for (const m of laneVis.children) {
    const { along, side: sd, y: my } = m.userData;
    m.position.copy(f).addScaledVector(dir, along).addScaledVector(side, sd).setY(my);
    m.rotation.set(-Math.PI / 2, yaw, 0, 'YXZ');   // flach auf den Boden, Laengsachse zur Bahn
  }
  laneVis.visible = true;
}
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

// Schritt-Tafel (Einrichtung nacheinander), Uhr-Menue am Handgelenk, kurze Hinweise
const wizard = new Panel(0.56); scene.add(wizard);
const toastP = new Panel(0.42); scene.add(toastP);
const wrist = new WristMenu(scene);
let step = null, toastT = 0, startStep = null;
const WRIST_ITEMS = [{ id: 'reset', label: 'Neu aufstellen' }, { id: 'place', label: 'Bahn ändern' }, { id: 'new', label: 'Neues Spiel' },
  { id: 'players', label: 'Spieler' }, { id: 'hand', label: 'Andere Hand' }, { id: 'exit', label: 'Beenden', main: true }];
wrist.setItems(WRIST_ITEMS);
function toast(msg, sec = 3) {
  if (!renderer.xr.isPresenting || phone) return;
  toastP.show({ text: msg, buttons: [] }); toastP.place(renderer.xr.getCamera(), 0.7); toastP.position.y -= 0.18; toastT = sec;
}
function showStep(id) {
  step = id; placing = id === 'place';
  if (id === 'search') searchT = 0;
  if (phone || !renderer.xr.isPresenting) { wizard.hide(); return; }
  if (id === 'players') wizard.show({ title: 'Wer spielt?', text: names.join(', ') + `\n(Namen änderst du auf der Startseite)`,
    buttons: [{ id: 'minus', label: '– Spieler' }, { id: 'plus', label: '+ Spieler' }, { id: 'next', label: 'Weiter', main: true }], cols: 2 });
  else if (id === 'search') wizard.show({ title: 'Bahn suchen …', text: 'Ich suche in deinem Raum die längste freie Strecke – Möbel und Wände werden umgangen.', buttons: [{ id: 'manual', label: 'Selbst aufstellen' }] });
  else if (id === 'place') wizard.show({ title: 'Kegel aufstellen', text: 'Zeig mit dem Strahl auf den Boden, wo der erste Kegel stehen soll, und drück (Daumen + Zeigefinger oder Abzug). Die Foul-Linie kommt kurz vor dich.',
    buttons: [{ id: 'auto', label: 'Automatisch suchen' }, { id: 'back', label: 'Zurück' }], cols: 2 });
  else if (id === 'confirm') wizard.show({ title: 'Passt die Bahn?', text: `${lane.headPos.distanceTo(foul || lane.headPos).toFixed(1)} m bis zum ersten Kegel. Stell dich hinter die weiße Foul-Linie – nicht drübertreten!`,
    buttons: [{ id: 'go', label: "Los geht's!", main: true }, ...(lanes.length > 1 ? [{ id: 'other', label: 'Andere Bahn' }] : []), { id: 'again', label: 'Selbst setzen' }], cols: 2 });
  else { wizard.hide(); }
  if (wizard.visible) wizard.place(renderer.xr.getCamera(), 0.75);
}
function stepButton(id) {
  if (step === 'players') {
    if (id === 'minus' && names.length > 1) { names.pop(); savePlayers(); showStep('players'); }
    else if (id === 'plus' && names.length < 8) { names.push(`Spieler ${names.length + 1}`); savePlayers(); showStep('players'); }
    else if (id === 'next') showStep(lane.placed ? null : 'search');
  } else if (step === 'search' && id === 'manual') showStep('place');
  else if (step === 'place') { if (id === 'back') showStep('players'); else if (id === 'auto') showStep('search'); }
  else if (step === 'confirm') {
    if (id === 'go') { showStep(null); toast('Die Kugel liegt in deiner Hand: ausholen und nach vorn schwingen – unten loslassen geht von selbst.\nMenü: Handrücken links anschauen oder X/Y drücken.', 7); }
    else if (id === 'other') { laneIdx = (laneIdx + 1) % lanes.length; useLane(lanes[laneIdx]); showStep('confirm'); }
    else if (id === 'again') showStep('place');
  }
}
function useLane(c) { placePins(c.foul.clone().addScaledVector(c.dir, c.dist), c.foul); }
function savePlayers() { try { localStorage.setItem(PLAYERS_KEY, JSON.stringify(names)); } catch {} newGame(); }
function wristButton(id) {
  wrist.close();
  if (id === 'place') { dropBall(); showStep('search'); return; }
  if (id === 'players') { dropBall(); showStep('players'); return; }
  if (id === 'hand') { bowlHand = bowlHand === 'right' ? 'left' : 'right'; try { localStorage.setItem(HAND_KEY, bowlHand); } catch {} dropBall(); toast(`Kugel jetzt in der ${bowlHand === 'right' ? 'rechten' : 'linken'} Hand`); return; }
  tool(id);
}
function drawToolbar() { if (note) { toast(note); note = ''; } }

// Ziel-Ring auf dem Boden (Kegel aufstellen)
const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff7ab6, transparent: true, opacity: 0.9, depthTest: false }));
ring.renderOrder = 9; ring.visible = false; scene.add(ring);

let placing = false, note = '';

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

// Die Kugel liegt automatisch in der Wurfhand (kein Greifen noetig).
// Hand-Tracking: in der Handflaeche; Controller: unter dem Controller.
function ballInHand(inp) {
  const j = inp.hand.joints, palm = j?.['middle-finger-metacarpal'];
  if (inp.source?.hand) {
    if (!palm?.visible) return null;
    const q = palm.getWorldQuaternion(new THREE.Quaternion());
    const n = new THREE.Vector3(0, -1, 0).applyQuaternion(q);              // Handflaechen-Normale
    return palm.getWorldPosition(new THREE.Vector3()).addScaledVector(n, BALL_R + 0.012);
  }
  if (inp.mode === 'tracked-pointer') {
    const o = inp.grip.visible ? inp.grip : inp.ray;
    return o.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, -(BALL_R + 0.035), 0));
  }
  return null;
}
function bowlInput() {
  const act = inputs.filter((i) => i.mode && i.source);
  return act.find((i) => i.source.handedness === bowlHand) || (act.length === 1 ? act[0] : null);
}
function dropBall() { if (held) { held = null; lane.ballToHome(ballHome()); } }

function press(inp, kind) {
  if (!inp.mode) return;
  setRay(inp);
  for (const [pn, fn] of [[wizard, stepButton], [wrist.panel, wristButton]]) {
    const i = pn.pick(raycaster); if (i >= 0) { fn(pn.idAt(i)); return; }
  }
  // Kugel in dieser Hand: Pinch/Abzug halten = festhalten, loslassen = werfen
  if (held?.inp === inp) { held.pinch = true; return; }
  // Kegel selbst aufstellen
  if ((placing || (phone && !lane.placed)) && kind === 'select') {
    const p = arHit || floorHit(raycaster.ray);
    if (p) placePins(p);
  }
}

// Wurfgeschwindigkeit aus den letzten ~90 ms der Kugelbewegung
function handVel(h) {
  if (h.length < 2) return new THREE.Vector3();
  const last = h[h.length - 1];
  let first = h[0];
  for (const s of h) if (last.t - s.t <= 90) { first = s; break; }
  const dt = (last.t - first.t) / 1000;
  return dt > 0.01 ? last.p.clone().sub(first.p).divideScalar(dt) : new THREE.Vector3();
}

function release() {
  if (!held) return;
  const inp = held.inp, v = handVel(held.hist);
  if (v.length() < 0.5) { held.pinch = false; return; }   // ohne Schwung losgelassen: bleibt in der Hand
  held = null;
  v.multiplyScalar(1.15);                                 // Wuerfe fuehlen sich sonst zu schwach an
  if (v.y > 0.5) v.y = 0.5;
  // Foul: Kopf ueber der Foul-Linie beim Loslassen
  isFoul = false;
  if (foul && renderer.xr.isPresenting) isFoul = viewerPos().sub(foul).setY(0).dot(lane.dir) > 0.03;
  lane.throw(v, new THREE.Vector3(v.z, 0, -v.x).multiplyScalar(1 / BALL_R * 0.6));   // Vorwaertsdrall (Rollen ohne Rutschen)
  pulse(inp, 0.8, 60);
  if (isFoul) drawScore(`${players[cur].name}: Übertreten! Foul`);
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

// p = Kopfkegel; f = Foul-Linie (ohne: kurz vor dem Spieler)
function placePins(p, f) {
  const v = viewerPos();
  const from = f ? f.clone() : v.clone();
  const dir = p.clone().sub(from).setY(0);
  if (dir.lengthSq() < 0.01) dir.set(0, 0, -1);
  dir.normalize();
  lane.place(p, dir);
  foul = f ? f.clone().setY(lane.floorY) : v.clone().addScaledVector(dir, Math.min(0.3, Math.max(0, p.clone().sub(v).setY(0).length() - 1))).setY(lane.floorY);
  buildLaneVis(foul, dir, p.clone().sub(foul).setY(0).length());
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
  if (id === 'place') { if (placing) showStep(null); else showStep(phone ? 'place' : 'search'); ring.visible = false; }
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
  const foulRoll = isFoul; isFoul = false;
  const down = foulRoll ? 0 : before - lane.standing();
  const r = g.add(down);
  let msg = foulRoll ? `${p.name}: Foul – übergetreten, 0 Punkte` : down === 0 ? `${p.name}: daneben!` : `${p.name}: ${down} Kegel`;
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
      if (r.reset) lane.resetPins(); else if (foulRoll && lane.preMask) lane.restorePins(lane.preMask); else lane.clearDown();
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
    // gescannter Raum (Quest-Raumeinrichtung): Waende fuer die Physik, Moebel fuer die Bahnsuche
    if (scan.update(frame, ref)) { lane.setRoom(scan); edges.build(scan); }
  }
  const head = viewerPos();
  edges.visible = xr && !phone && scan.scanned; if (edges.visible) edges.update();
  // Bahn automatisch suchen (wartet kurz, bis der Raum-Scan da ist)
  if (step === 'search' && xr) {
    searchT += dt;
    if (scan.scanned && searchT > 0.8 || searchT > 4) {
      const cam = renderer.xr.getCamera();
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
      lanes = scan.scanned ? findLanes(scan, head, fwd) : []; laneIdx = 0;
      if (lanes.length) { useLane(lanes[0]); showStep('confirm'); }
      else {
        showStep('place');
        toast(scan.scanned ? 'Im Raum ist keine freie Strecke ab 1,2 m – stell die Kegel selbst auf.'
          : 'Kein Raum-Scan gefunden. Einmalig in den Quest-Einstellungen „Raumeinrichtung“ machen, dann klappt es automatisch.', 7);
      }
    }
  }
  // Druecke
  const pend = pending; pending = [];
  for (const e of pend) { if (e.kind === 'end') { if (held?.inp === e.inp && held.pinch) release(); } else press(e.inp, e.kind); }
  // Kugel automatisch in die Wurfhand legen
  const playing = xr && !phone && lane.placed && !step;
  if (playing && !held && lane.ballState === 'rest') {
    const inp = bowlInput(), p = inp && ballInHand(inp);
    if (p) { lane.grab(); held = { inp, hist: [], t0: now, lost: 0, pinch: false }; }
  }
  if (held && !playing) dropBall();
  if (held) {
    const p = ballInHand(held.inp);
    if (p) {
      held.lost = 0;
      lane.hold(p);
      held.hist.push({ p, t: now });
      while (held.hist.length > 12) held.hist.shift();
      // Wurf von selbst: schneller Schwung nach vorn (Richtung Kegel), Kugel unten, Bogen am Tiefpunkt
      const v = handVel(held.hist), fwdSpeed = v.x * lane.dir.x + v.z * lane.dir.z;
      if (!held.pinch && !wrist.visible && now - held.t0 > 600 && fwdSpeed > 1.3 && v.y > -0.6 && p.y < head.y - 0.6) release();
    } else if ((held.lost += dt) > 0.5) dropBall();     // Hand nicht mehr erkannt: Kugel schwebt neben dir
  }
  // Foul-Linie leuchtet rot, wenn du drueber stehst
  if (foul && laneVis.visible) {
    const over = xr && head.clone().sub(foul).setY(0).dot(lane.dir) > 0.03;
    foulMat.color.setHex(over ? 0xff2244 : 0xffffff);
  }
  // Ziel-Ring beim Aufstellen, Hervorheben der Tafeln
  if (xr) {
    let ringAt = null;
    for (const inp of inputs) {
      if (!inp.mode) continue;
      setRay(inp);
      for (const pn of [wizard, wrist.panel]) pn.setHover(pn.pick(raycaster));
      if (placing && !ringAt) ringAt = floorHit(raycaster.ray);
      if (inp.line.visible) { const h = raycaster.intersectObjects([wizard, wrist.panel].filter((o) => o.visible))[0]; inp.line.scale.z = h ? h.distance : placing ? 4 : 0.5; }
    }
    if (arHit && placing) ringAt = arHit;
    ring.visible = !!ringAt; if (ringAt) ring.position.copy(ringAt).setY(lane.floorY + 0.005);
    if (startStep) { showStep(startStep); startStep = null; }
    const cam = renderer.xr.getCamera();
    wrist.enabled = !step && !phone;
    wrist.update(inputs, head, dt, cam);
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
  lane.ball.material.emissive.setHex(0x000000);
  lane.step(dt);
  if (lane.rollDone()) { lane.ballState = 'scored'; scoreRoll(); }
  renderer.render(scene, camera);
});


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
  const init = { optionalFeatures: ['local-floor', 'hand-tracking', 'hit-test', 'plane-detection', 'mesh-detection'] };
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
  note = '';
  if (phone) showStep('place'); else { step = null; startStep = 'players'; }
  lane.setVisible(lane.placed);
  drawToolbar(); drawScore('');
  session.addEventListener('end', () => { hitSource = null; $('start').hidden = false; $('overlay').hidden = true; hall.visible = true; scene.background = new THREE.Color(0x15111d); ring.visible = false; laneVis.visible = false; lane.placed = false; lane.setVisible(false); foul = null; held = null; wizard.hide(); toastP.hide(); wrist.panel.hide(); step = null; });
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
