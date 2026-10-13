// Isabella Minigolf – eigene Bahnen im echten Raum bauen und reihum spielen.
// Bauen: Element waehlen (Start, Loch, Rampe, Looping, Boost, Wand, Bumper, Sand) und mit Strahl/Pinch auf
//   Boden oder Moebel setzen; Elemente greifen = verschieben (Controller-Stick dreht), Drehen/Loeschen/Zufall.
// Spielen: Controller bzw. Hand ist der Schlaeger (nach unten halten), Schlagstaerke aus der Bewegung.
//   Handy/Bildschirm: von der Kugel weg wischen. Mehrere Spieler reihum, Schlaege je Loch.
import * as THREE from 'three';
import { RoomScan } from '/room-scan.js';
import { Course, TYPES, BALL_R } from '/golf-course.js';
import { initSound, cheer, hit } from '/sound.js';

const $ = (id) => document.getElementById(id);
const MAX_STROKES = 8;
const MAPS_KEY = 'isabella-golf-maps', MAP_KEY = 'isabella-golf-map', ANCHOR_KEY = 'isabella-golf-anchor', PLAYERS_KEY = 'lara-players';

const BUILD_TOOLS = [
  { id: 'move', label: 'Bewegen' }, { id: 'tee', label: 'Start' }, { id: 'cup', label: 'Loch' }, { id: 'ramp', label: 'Rampe' }, { id: 'loop', label: 'Looping' },
  { id: 'boost', label: 'Boost' }, { id: 'wall', label: 'Wand' }, { id: 'bumper', label: 'Bumper' }, { id: 'sand', label: 'Sand' }, { id: 'random', label: 'Zufall' },
  { id: 'rotate', label: 'Drehen' }, { id: 'delete', label: 'Löschen' }, { id: 'map', label: 'Karte ▸' }, { id: 'play', label: 'Spielen ▸' }, { id: 'exit', label: 'Beenden' },
];
const PLAY_TOOLS = [{ id: 'build', label: 'Bauen ▸' }, { id: 'ball', label: 'Kugel zurück' }, { id: 'skip', label: 'Loch aufgeben' }, { id: 'restart', label: 'Neue Runde' }, { id: 'exit', label: 'Beenden' }];
const COLS = 5, TW = 1000, ROW = 92, STATUS = 46;

/* ---------- Szene ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor'); renderer.xr.setFoveation?.(1);
$('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.02, 60);
camera.position.set(0, 1.5, 1.6); camera.lookAt(0, 0, -1);
scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 1.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(1, 4, 2); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 }); scene.add(sun);
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.3 }));
shadow.receiveShadow = true; scene.add(shadow);
// Bildschirm/VR: virtueller Teppich statt echtem Raum
const hall = new THREE.Group();
{ const g = new THREE.Mesh(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2f7a4a, roughness: 1 })); g.receiveShadow = true; hall.add(g);
  hall.add(new THREE.GridHelper(8, 16, 0x3f9a5a, 0x2f8a4a)); }
scene.add(hall); scene.background = new THREE.Color(0x15111d);

const scan = new RoomScan(scene);
const course = new Course(scene, scan);

/* ---------- Spieler und Runde ---------- */
let names = ['Spieler 1'];
try { const n = JSON.parse(localStorage.getItem(PLAYERS_KEY)); if (Array.isArray(n) && n.length) names = n.slice(0, 8); } catch {}
let mode = 'build', tool = 'move', note = '', selected = null;
let round = null;     // { holes, hi, cur, strokes: [[...]], over }
function newRound() {
  const holes = course.holes();
  if (!holes.length) { round = null; note = 'Erst Start und Loch setzen (Bauen)'; drawToolbar(); return false; }
  round = { holes, hi: 0, cur: 0, strokes: names.map(() => holes.map(() => null)), shots: 0, over: false };
  startTurn();
  return true;
}
function startTurn() {
  const h = round.holes[round.hi];
  round.shots = 0;
  course.ballTo(h.tee.obj.position);
  drawBoard(`${names[round.cur]} ist dran · Loch ${h.n}`);
  // Bildschirm: Kamera hinter den Start, Blick zum Loch
  if (!renderer.xr.isPresenting) {
    const d = h.cup.obj.position.clone().sub(h.tee.obj.position).setY(0).normalize();
    camera.position.copy(h.tee.obj.position).addScaledVector(d, -1.1).setY(h.tee.obj.position.y + 1.0);
    camera.lookAt(h.tee.obj.position.clone().lerp(h.cup.obj.position, 0.45));
  }
}
function finishTurn(strokes) {
  round.strokes[round.cur][round.hi] = strokes;
  // naechster Spieler am selben Loch, sonst naechstes Loch
  if (round.cur < names.length - 1) round.cur++;
  else { round.cur = 0; round.hi++; }
  if (round.hi >= round.holes.length) {
    round.over = true; course.hideBall();
    const tot = names.map((n, i) => [n, round.strokes[i].reduce((a, b) => a + (b || 0), 0)]).sort((a, b) => a[1] - b[1]);
    drawBoard(names.length > 1 ? `${tot[0][0]} gewinnt mit ${tot[0][1]} Schlägen!` : `Fertig: ${tot[0][1]} Schläge`); cheer(true);
    return;
  }
  setTimeout(startTurn, 900);
}

/* ---------- Anzeigetafel ---------- */
const bcanvas = document.createElement('canvas'); bcanvas.width = 1024; let btex = null;
const board = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false }));
board.renderOrder = 9; board.visible = false; scene.add(board);
let boardMsg = '';
function drawBoard(msg) {
  if (msg !== undefined) boardMsg = msg;
  const n = names.length, holes = round?.holes || course.holes(), H = 70 + n * 64 + 52;
  if (bcanvas.height !== H || !btex) {
    bcanvas.height = H; btex?.dispose(); btex = new THREE.CanvasTexture(bcanvas); btex.colorSpace = THREE.SRGBColorSpace;
    board.material.map = btex; board.material.needsUpdate = true; board.geometry.dispose(); board.geometry = new THREE.PlaneGeometry(0.9, 0.9 * H / 1024);
  }
  const c = bcanvas.getContext('2d'); c.clearRect(0, 0, 1024, H);
  c.fillStyle = 'rgba(20,16,30,0.9)'; c.beginPath(); c.roundRect ? c.roundRect(0, 0, 1024, H, 26) : c.rect(0, 0, 1024, H); c.fill();
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#ffb3d1'; c.font = '700 36px system-ui, sans-serif';
  c.fillText(boardMsg || (round ? `${names[round.cur]} · Loch ${round.holes[round.hi]?.n ?? '-'} · Schlag ${round.shots + 1}` : 'Minigolf'), 512, 34, 990);
  const cols = Math.max(1, holes.length), nameW = 170, cw = Math.min(80, (1024 - nameW - 130) / cols);
  c.font = '500 22px system-ui, sans-serif'; c.fillStyle = 'rgba(255,255,255,.6)';
  holes.forEach((h, k) => c.fillText(String(h.n), nameW + cw * (k + 0.5), 82));
  c.fillText('Summe', nameW + cw * cols + 60, 82);
  names.forEach((nm, i) => {
    const y = 120 + i * 64, on = round && !round.over && i === round.cur;
    if (on) { c.fillStyle = 'rgba(255,122,182,.18)'; c.fillRect(8, y - 28, 1008, 56); }
    c.textAlign = 'left'; c.fillStyle = on ? '#ff7ab6' : '#fbe9f2'; c.font = '700 28px system-ui, sans-serif'; c.fillText(nm, 20, y, nameW - 24);
    c.textAlign = 'center'; c.fillStyle = '#fff'; c.font = '700 28px system-ui, sans-serif';
    let sum = 0;
    holes.forEach((h, k) => { const s = round?.strokes[i]?.[k]; if (s != null) { sum += s; c.fillText(String(s), nameW + cw * (k + 0.5), y); } });
    c.fillStyle = '#ffd4e6'; c.font = '800 32px system-ui, sans-serif'; c.fillText(String(sum), nameW + cw * cols + 60, y);
  });
  btex.needsUpdate = true;
  $('gscore').textContent = round && !round.over ? `${names[round.cur]} · Loch ${round.holes[round.hi].n} · Schlag ${round.shots + 1}` : (boardMsg || 'Minigolf');
}

/* ---------- Werkzeugleiste ---------- */
const tools = () => (mode === 'play' ? PLAY_TOOLS : BUILD_TOOLS);
const tcanvas = document.createElement('canvas'); tcanvas.width = TW; tcanvas.height = STATUS + 3 * ROW;
const ttex = new THREE.CanvasTexture(tcanvas); ttex.colorSpace = THREE.SRGBColorSpace;
const toolbar = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85 * tcanvas.height / TW), new THREE.MeshBasicMaterial({ map: ttex, transparent: true, depthTest: false }));
toolbar.renderOrder = 10; toolbar.visible = false; scene.add(toolbar);
let toolHover = null;
function drawToolbar() {
  const c = tcanvas.getContext('2d'); c.clearRect(0, 0, TW, tcanvas.height);
  const w = TW / COLS;
  tools().forEach((t, k) => {
    const x = (k % COLS) * w, y = STATUS + Math.floor(k / COLS) * ROW;
    const on = toolHover === t.id || (mode === 'build' && tool === t.id);
    c.fillStyle = on ? 'rgba(255,122,182,0.95)' : 'rgba(24,18,34,0.88)';
    c.beginPath(); c.roundRect ? c.roundRect(x + 4, y + 4, w - 8, ROW - 8, 20) : c.rect(x + 4, y + 4, w - 8, ROW - 8); c.fill();
    if (TYPES[t.id]) { c.fillStyle = '#' + TYPES[t.id].color.toString(16).padStart(6, '0'); c.beginPath(); c.arc(x + 26, y + ROW / 2, 9, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = on ? '#2a0f1f' : '#fbe9f2'; c.font = '600 25px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(t.label, x + w / 2 + (TYPES[t.id] ? 8 : 0), y + ROW / 2);
  });
  const s = note || (mode === 'build'
    ? (tool === 'move' ? `Bauen · Karte ${mapIdx + 1} · Element greifen zum Verschieben${scan.scanned ? '' : ' · kein Raum-Scan: nur Boden'}` : `${TYPES[tool]?.label || ''}: auf Boden oder Tisch zielen und drücken`)
    : 'Controller/Hand nach unten halten = Schläger · durch die Kugel schwingen');
  c.font = '500 22px system-ui, sans-serif'; const sw = Math.min(TW - 10, c.measureText(s).width + 30);
  c.fillStyle = 'rgba(24,18,34,0.88)'; c.beginPath(); c.roundRect ? c.roundRect((TW - sw) / 2, 4, sw, 36, 18) : c.rect((TW - sw) / 2, 4, sw, 36); c.fill();
  c.fillStyle = '#fbe9f2'; c.fillText(s, TW / 2, 23, TW - 30);
  ttex.needsUpdate = true;
}
const toolAt = (uv) => {
  const x = uv.x * TW, y = (1 - uv.y) * tcanvas.height;
  if (y < STATUS) return null;
  return tools()[Math.floor((y - STATUS) / ROW) * COLS + Math.floor(x / (TW / COLS))]?.id || null;
};

/* ---------- Karten (gespeichert relativ zum Raum-Anker) ---------- */
let maps = [];
try { maps = JSON.parse(localStorage.getItem(MAPS_KEY)) || []; } catch {}
if (!maps.length) maps = [{ items: [] }];
let mapIdx = Math.min(+(localStorage.getItem(MAP_KEY) || 0), maps.length - 1);
let anchor = null, anchorM = new THREE.Matrix4(), anchored = false, loaded = false;
function saveMap() {
  if (!loaded) return;
  maps[mapIdx] = { items: course.toJSON(anchorM.clone().invert()), anchored };
  try { localStorage.setItem(MAPS_KEY, JSON.stringify(maps)); localStorage.setItem(MAP_KEY, String(mapIdx)); } catch {}
}
function loadMap() {
  const m = maps[mapIdx] || { items: [] };
  course.fromJSON(m.items, m.anchored && anchored ? anchorM : new THREE.Matrix4());
  selected = null; round = null; course.hideBall(); loaded = true;
  board.visible = false;
  drawBoard('');
}
function nextMap() {
  saveMap();
  mapIdx = (mapIdx + 1) % (maps.length + 1);
  if (mapIdx === maps.length) maps.push({ items: [] });
  // leere Karten am Ende nicht anhaeufen
  while (maps.length > 1 && !maps.at(-1).items.length && mapIdx < maps.length - 1) maps.pop();
  loadMap(); note = `Karte ${mapIdx + 1}${course.items.length ? '' : ' (leer)'}`; drawToolbar();
}
async function initAnchor(frame, session) {
  const ref = renderer.xr.getReferenceSpace(), id = localStorage.getItem(ANCHOR_KEY);
  try { if (id && session.restorePersistentAnchor) anchor = await session.restorePersistentAnchor(id); } catch { anchor = null; }
  if (!anchor && frame.createAnchor) {
    try {
      anchor = await frame.createAnchor(new XRRigidTransform(), ref);
      const h = await anchor.requestPersistentHandle?.();
      if (h) localStorage.setItem(ANCHOR_KEY, h);
    } catch { anchor = null; }
  }
}

/* ---------- Eingaben ---------- */
const raycaster = new THREE.Raycaster();
let pending = [], held = null;
const inputs = [0, 1].map((i) => {
  const ray = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i), hand = renderer.xr.getHand(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xff7ab6, transparent: true, opacity: 0.7 }));
  line.scale.z = 0.5; line.visible = false; ray.add(line);
  const inp = { i, ray, grip, hand, line, mode: null, hist: [] };
  ray.addEventListener('connected', (e) => { inp.mode = e.data.targetRayMode; inp.source = e.data; line.visible = inp.mode === 'tracked-pointer' && !e.data.hand; });
  ray.addEventListener('disconnected', () => { inp.mode = null; line.visible = false; if (held?.inp === inp) held = null; });
  ray.addEventListener('selectstart', () => pending.push({ inp, kind: 'select' }));
  ray.addEventListener('selectend', () => pending.push({ inp, kind: 'end' }));
  ray.addEventListener('squeezestart', () => pending.push({ inp, kind: 'squeeze' }));
  ray.addEventListener('squeezeend', () => pending.push({ inp, kind: 'end' }));
  scene.add(ray, grip, hand);
  return inp;
});
function setRay(inp) {
  raycaster.ray.origin.setFromMatrixPosition(inp.ray.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(inp.ray.matrixWorld));
}
// Treffer auf Boden/Moebel: Punkt + ob waagrecht
function surfaceHit() {
  const h = raycaster.intersectObjects(scan.targets, false)[0];
  if (!h) return null;
  const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
  return n.y > 0.7 && h.distance < 12 ? h.point : null;
}
const itemMeshes = () => { const a = []; course.group.traverse((o) => { if (o.isMesh) a.push(o); }); return a; };
const viewer = () => new THREE.Vector3().setFromMatrixPosition((renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).matrixWorld);
function yawToward(p) { const v = viewer(); return Math.atan2(p.x - v.x, p.z - v.z); }   // +Z zeigt vom Spieler weg

function press(inp, kind) {
  if (!inp.mode) return;
  setRay(inp);
  if (toolbar.visible) { const h = raycaster.intersectObject(toolbar)[0]; if (h) { useTool(toolAt(h.uv)); return; } }
  if (mode === 'play') { clubHand = inp; return; }        // die drueckende Hand haelt den Schlaeger
  // Bauen: vorhandenes Element greifen?
  const ih = raycaster.intersectObjects(itemMeshes(), false)[0];
  if (ih && (tool === 'move' || tool === 'rotate' || tool === 'delete')) {
    const it = course.items.find((x) => x.obj === ih.object.userData.item);
    if (!it) return;
    selected = it;
    if (tool === 'delete') { course.remove(it); selected = null; saveMap(); drawBoard(''); return; }
    if (tool === 'rotate') { course.move(it, it.obj.position, it.obj.rotation.y + Math.PI / 4); saveMap(); return; }
    held = { inp, it }; return;
  }
  if (kind !== 'select' || !TYPES[tool]) return;
  const p = surfaceHit(); if (!p) { note = 'Kein Boden/Möbel getroffen'; drawToolbar(); return; }
  const hole = tool === 'tee' || tool === 'cup' ? course.nextHoleNumber(tool) : undefined;
  selected = course.add(tool, p, yawToward(p), hole);
  if (tool === 'tee' || tool === 'cup') tool = tool === 'tee' ? 'cup' : 'move';   // nach Start gleich das Loch
  note = ''; drawToolbar(); saveMap(); drawBoard('');
}

function useTool(id) {
  if (!id) return;
  note = '';
  if (id === 'exit') { saveMap(); renderer.xr.getSession()?.end(); return; }
  if (id === 'play') { if (newRound()) { mode = 'play'; board.visible = true; placeBoard(); } }
  else if (id === 'build') { mode = 'build'; round = null; course.hideBall(); board.visible = false; tool = 'move'; }
  else if (id === 'ball') { if (round && !round.over) course.ballTo(course.lastRest); }
  else if (id === 'skip') { if (round && !round.over) { course.hideBall(); finishTurn(MAX_STROKES); } }
  else if (id === 'restart') { newRound(); }
  else if (id === 'random') randomCourse();
  else if (id === 'map') nextMap();
  else if (id === 'rotate' && selected && tool === 'rotate') { course.move(selected, selected.obj.position, selected.obj.rotation.y + Math.PI / 4); saveMap(); }
  else if (id === 'delete' && selected && tool === 'delete') { course.remove(selected); selected = null; saveMap(); }
  else tool = id;
  drawToolbar();
}

// Zufallsbahn: Start vor dir, Loch 2-3,5 m weiter, ein paar Hindernisse dazwischen (nur auf freiem Boden)
function randomCourse() {
  const v = viewer(), fwd = new THREE.Vector3(0, 0, -1).applyQuaternion((renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).quaternion);
  fwd.y = 0; fwd.normalize();
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x), y = scan.floorY;
  const free = (p) => scan.onFloor(p.x, p.z) && !scan.boxes.some((b) => p.clone().sub(b.center).setY(0).length() < Math.max(b.size.x, b.size.z) / 2 + 0.2);
  for (let tries = 0; tries < 30; tries++) {
    const tee = v.clone().addScaledVector(fwd, 0.6).setY(y), len = 2 + Math.random() * 1.5, ang = (Math.random() - 0.5) * 0.8;
    const dir = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ang), cup = tee.clone().addScaledVector(dir, len);
    if (!free(tee) || !free(cup)) continue;
    const n = course.nextHoleNumber('tee'), yaw = Math.atan2(dir.x, dir.z);
    course.add('tee', tee, yaw, n); course.add('cup', cup, yaw, n);
    const kinds = ['ramp', 'wall', 'bumper', 'sand', 'boost', 'bumper'];
    for (let k = 0; k < 3; k++) {
      const t = 0.3 + Math.random() * 0.5, p = tee.clone().lerp(cup, t).addScaledVector(side.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ang), (Math.random() - 0.5) * 0.6);
      if (free(p)) course.add(kinds[Math.floor(Math.random() * kinds.length)], p, yaw + (Math.random() - 0.5) * 1.2);
    }
    note = `Zufallsbahn: Loch ${n}`; saveMap(); drawBoard(''); return;
  }
  note = 'Kein freier Platz für eine Zufallsbahn gefunden';
}

/* ---------- Schlaeger ---------- */
const club = new THREE.Group();
{ const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.8, 8), new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.3 })); shaft.position.y = -0.4; club.add(shaft);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.03), new THREE.MeshStandardMaterial({ color: 0xff7ab6, metalness: 0.5, roughness: 0.3 })); head.position.y = -0.81; club.add(head); }
club.visible = false; scene.add(club);
let clubHand = null, clubHead = new THREE.Vector3(), clubPrev = null, clubVel = new THREE.Vector3(), hitCooldown = 0;
// Schlaegerhaltung: Controller/Hand zeigt nach unten -> Schaft folgt der Zeigerichtung
function updateClub(dt) {
  const inp = clubHand?.mode ? clubHand : inputs.find((x) => x.mode) || null;
  if (!inp || mode !== 'play') { club.visible = false; return; }
  let p, dir;
  const j = inp.hand.joints;
  if (j?.wrist?.visible && j['middle-finger-tip']) {
    p = j.wrist.getWorldPosition(new THREE.Vector3());
    dir = j['middle-finger-tip'].getWorldPosition(new THREE.Vector3()).sub(p).normalize();
  } else if (inp.mode === 'tracked-pointer') {
    p = (inp.grip.visible ? inp.grip : inp.ray).getWorldPosition(new THREE.Vector3());
    dir = new THREE.Vector3(0, 0, -1).applyQuaternion(inp.ray.getWorldQuaternion(new THREE.Quaternion()));
  } else { club.visible = false; return; }
  club.visible = true; club.position.copy(p);
  club.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
  clubHead.copy(p).addScaledVector(dir, 0.81);
  // Schlaegerkopf nie unter den Boden
  if (clubHead.y < scan.floorY + 0.015) clubHead.y = scan.floorY + 0.015;
  if (clubPrev && dt > 0) clubVel.copy(clubHead).sub(clubPrev).divideScalar(dt); clubPrev = clubHead.clone();
  hitCooldown -= dt;
  // Treffer: Kopf an der ruhenden Kugel und in Bewegung zu ihr hin
  if (round && !round.over && course.resting && hitCooldown <= 0) {
    const b = course.ball.position, d = clubHead.distanceTo(b);
    const toBall = b.clone().sub(clubHead).setY(0);
    if (d < BALL_R + 0.04 && clubVel.dot(toBall.normalize()) > 0.25) {
      const v = clubVel.clone().setY(0); if (v.length() > 6) v.setLength(6);
      strike(v); pulse(inp, 0.8, 60);
    }
  }
}
function pulse(inp, v, ms) { try { inp.source?.gamepad?.hapticActuators?.[0]?.pulse(v, ms); } catch {} }

function strike(v) {
  round.shots++; hitCooldown = 0.6;
  course.lastRest.copy(course.ball.position).setY(course.ball.position.y - BALL_R);
  course.shoot(v); hit(Math.min(6, v.length() * 1.5), 'ball');
  drawBoard('');
}

/* ---------- Handy / Bildschirm: von der Kugel weg wischen ---------- */
let swipe = null;
function swipeStart(x, y) { initSound(); swipe = { x, y, t: performance.now() }; }
function swipeEnd(x, y) {
  if (!swipe) return;
  const dx = x - swipe.x, dy = swipe.y - y, dt = (performance.now() - swipe.t) / 1000; swipe = null;
  if (mode !== 'play' || !round || round.over || !course.resting || Math.hypot(dx, dy) < 25) return;
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const dir = fwd.clone().multiplyScalar(dy).addScaledVector(right, dx).normalize();
  const speed = Math.min(5, Math.max(0.4, (Math.hypot(dx, dy) / innerHeight) / Math.max(dt, 0.05) * 2.2));
  strike(dir.multiplyScalar(speed));
}

/* ---------- Ablauf pro Frame ---------- */
let lastT = performance.now(), tYaw, phone = false, session = null, anchorStep = null, t0 = 0;
renderer.setAnimationLoop((t, frame) => {
  const now = performance.now(), dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const xr = renderer.xr.isPresenting;
  if (frame) {
    const ref = renderer.xr.getReferenceSpace();
    if (scan.update(frame, ref)) { course.syncRoom(); shadow.position.y = scan.floorY + 0.001; drawToolbar(); }
    // Anker holen, dann gespeicherte Karte an ihren Platz
    if (anchorStep === 'start') { anchorStep = 'busy'; initAnchor(frame, session).finally(() => { anchorStep = 'wait'; }); }
    if (anchor) { const pose = frame.getPose(anchor.anchorSpace, ref); if (pose) { anchorM.fromArray(pose.transform.matrix); anchored = true; } }
    if (anchorStep === 'wait' && (anchored || now - t0 > 2500)) { anchorStep = 'done'; loadMap(); drawToolbar(); }
  }
  const pend = pending; pending = [];
  for (const e of pend) {
    if (e.kind === 'end') { if (held?.inp === e.inp) { held = null; saveMap(); } }
    else if (!held && !(phone && mode === 'play')) press(e.inp, e.kind);
  }
  // gehaltenes Element folgt dem Strahl auf Boden/Moebeln, Stick dreht
  if (held) {
    setRay(held.inp);
    const it = held.it, hideMeshes = [];
    const p = surfaceHit();
    if (p) course.move(it, p);
    const ax = held.inp.source?.gamepad?.axes?.[2] || 0;
    if (Math.abs(ax) > 0.2) course.move(it, it.obj.position, it.obj.rotation.y - ax * dt * 2.5);
    void hideMeshes;
  }
  // Hervorheben und Strahl-Laenge
  let hover = null;
  if (xr) {
    for (const inp of inputs) {
      if (!inp.mode) continue;
      setRay(inp);
      const th = toolbar.visible && raycaster.intersectObject(toolbar)[0];
      if (th) hover = toolAt(th.uv);
      if (inp.line.visible) {
        const h = raycaster.intersectObjects([toolbar, ...itemMeshes(), ...scan.targets], false)[0];
        inp.line.scale.z = h ? h.distance : 3;
      }
    }
    if (hover !== toolHover) { toolHover = hover; drawToolbar(); }
    placeToolbar();
  }
  for (const it of course.items) it.obj.children.forEach((m) => { if (m.isMesh && m.material.emissive) m.material.emissive.setHex(it === selected && mode === 'build' ? 0x333333 : (it.type === 'boost' ? 0x332200 : it.type === 'bumper' ? 0x330010 : 0)); });
  updateClub(dt);
  // Kugel und Regeln
  if (mode === 'play' && round && !round.over) {
    const ev = course.step(dt, round.holes[round.hi].cup);
    if (ev === 'sunk') { cheer(round.shots === 1); drawBoard(round.shots === 1 ? `Hole in One, ${names[round.cur]}!` : `${names[round.cur]}: ${round.shots} Schläge`); setTimeout(() => { course.hideBall(); finishTurn(round.shots); }, 1200); round.shots = round.shots; }
    else if (ev === 'out') { round.shots++; course.ballTo(course.lastRest); drawBoard(`Aus! +1 Schlag`); setTimeout(() => drawBoard(''), 1500); }
    if (round && !round.over && !course.sunk && round.shots >= MAX_STROKES && course.resting) { course.hideBall(); drawBoard(`${names[round.cur]}: Maximum erreicht`); finishTurn(MAX_STROKES); }
  }
  renderer.render(scene, camera);
});

function placeToolbar() {
  if (phone) { toolbar.visible = false; return; }
  toolbar.visible = true;
  const cam = renderer.xr.getCamera(), pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); dir.y = 0;
  if (dir.lengthSq() < 1e-4) return;
  const yaw = Math.atan2(dir.x, dir.z);
  if (tYaw === undefined) tYaw = yaw;
  const d = Math.atan2(Math.sin(yaw - tYaw), Math.cos(yaw - tYaw)); if (Math.abs(d) > 0.6) tYaw += d * 0.08;
  toolbar.position.copy(pos).add(new THREE.Vector3(Math.sin(tYaw), 0, Math.cos(tYaw)).multiplyScalar(0.65)); toolbar.position.y = pos.y - 0.4;
  toolbar.lookAt(pos.x, toolbar.position.y + 0.25, pos.z);
  if (board.visible && round) placeBoard(true);
}
function placeBoard(soft) {
  const h = round?.holes[round.hi]; if (!h) return;
  const v = viewer(), p = h.cup.obj.position.clone().add(new THREE.Vector3(0, 0.95, 0));
  if (soft && board.position.distanceTo(p) < 0.05) return;
  board.position.copy(p); board.lookAt(v.x, p.y, v.z);
}

/* ---------- Start ---------- */
async function start(kind) {
  initSound();
  names = [...document.querySelectorAll('#gplayers input')].map((i, k) => i.value.trim() || `Spieler ${k + 1}`);
  try { localStorage.setItem(PLAYERS_KEY, JSON.stringify(names)); } catch {}
  if (kind === 'screen') {
    $('gstart').hidden = true; $('ghud').hidden = false; hall.visible = true; loaded = true;
    loadMap();
    if (!course.holes().length) randomCourse();
    mode = 'play'; newRound(); board.visible = true; placeBoard();
    return;
  }
  const init = { optionalFeatures: ['local-floor', 'hand-tracking', 'plane-detection', 'mesh-detection', 'anchors'] };
  if (kind === 'ar') { init.optionalFeatures.push('dom-overlay'); init.domOverlay = { root: $('goverlay') }; }
  session = await navigator.xr.requestSession(kind === 'ar' ? 'immersive-ar' : 'immersive-vr', init);
  try { await renderer.xr.setSession(session); } catch { renderer.xr.setReferenceSpaceType('local'); await renderer.xr.setSession(session); scan.setFloor(-1.5); course.syncRoom(); }
  phone = !!session.domOverlayState;
  hall.visible = kind === 'vr'; scene.background = kind === 'vr' ? new THREE.Color(0x15111d) : null;
  $('gstart').hidden = true; $('goverlay').hidden = !phone;
  mode = 'build'; tool = 'move'; tYaw = undefined; anchorStep = 'start'; t0 = performance.now(); loaded = false;
  drawToolbar();
  session.addEventListener('end', () => {
    saveMap(); session = null; anchor = null; anchored = false; anchorStep = null;
    $('gstart').hidden = false; $('goverlay').hidden = true; hall.visible = true; scene.background = new THREE.Color(0x15111d);
    toolbar.visible = false; club.visible = false; board.visible = false; course.hideBall(); held = null;
  });
}

// Spieler-Liste (gleich wie beim Bowling, gemeinsam gespeichert)
function renderPlayers() {
  const box = $('gplayers'); box.innerHTML = '';
  names.forEach((n, i) => {
    const row = document.createElement('div'); row.className = 'prow';
    const inp = document.createElement('input'); inp.value = n; inp.maxLength = 14;
    inp.addEventListener('input', () => { names[i] = inp.value; });
    const del = document.createElement('button'); del.className = 'pdel'; del.textContent = '✕'; del.disabled = names.length === 1;
    del.addEventListener('click', () => { names.splice(i, 1); renderPlayers(); });
    row.append(inp, del); box.append(row);
  });
  $('gp-add').disabled = names.length >= 8;
}
$('gp-add').addEventListener('click', () => { names.push(`Spieler ${names.length + 1}`); renderPlayers(); });
renderPlayers();

$('g-ar').addEventListener('click', () => start('ar').catch((e) => alert(`Mixed Reality ging nicht: ${e.message}`)));
$('g-vr').addEventListener('click', () => start('vr').catch((e) => alert(`VR ging nicht: ${e.message}`)));
$('g-screen').addEventListener('click', () => start('screen'));
for (const [id, t] of [['go-mode', null], ['go-random', 'random'], ['go-exit', 'exit'], ['gh-new', 'restart']]) {
  $(id).addEventListener('click', (e) => { e.stopPropagation(); if (id === 'go-mode') useTool(mode === 'play' ? 'build' : 'play'); else useTool(t); $('go-mode').textContent = mode === 'play' ? 'Bauen' : 'Spielen'; });
}
$('goverlay').addEventListener('beforexrselect', (e) => { if (e.target.closest('button') || mode === 'play') e.preventDefault(); });
for (const el of [$('goverlay'), renderer.domElement]) {
  el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) swipeStart(e.clientX, e.clientY); });
  el.addEventListener('pointerup', (e) => { if (!e.target.closest('button')) swipeEnd(e.clientX, e.clientY); });
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
(async () => {
  const ar = await navigator.xr?.isSessionSupported?.('immersive-ar').catch(() => false);
  const vr = await navigator.xr?.isSessionSupported?.('immersive-vr').catch(() => false);
  $('g-ar').hidden = !ar; $('g-vr').hidden = !vr;
  if (!ar && !vr) $('ghint').textContent = 'Dieses Gerät kann kein WebXR – zum Ausprobieren gibt es die Bildschirm-Version mit Zufallsbahn.';
})();
drawToolbar();
window.__golf = { course, scan, get round() { return round; }, useTool, strike, newRound, randomCourse };
