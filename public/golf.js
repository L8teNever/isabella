// Isabella Minigolf – eigene Bahnen im echten Raum bauen und reihum spielen.
// Bauen: Element waehlen (Start, Loch, Rampe, Looping, Boost, Wand, Bumper, Sand) und mit Strahl/Pinch auf
//   Boden oder Moebel setzen; Elemente greifen = verschieben (Controller-Stick dreht), Drehen/Loeschen/Zufall.
// Spielen: Controller bzw. Hand ist der Schlaeger (nach unten halten), Schlagstaerke aus der Bewegung.
//   Handy/Bildschirm: von der Kugel weg wischen. Mehrere Spieler reihum, Schlaege je Loch.
import * as THREE from 'three';
import { RoomScan } from '/room-scan.js';
import { RoomEdges } from '/room-edge.js';
import { Course, TYPES, BALL_R, ZONES } from '/golf-course.js';
import { clearanceField } from '/lane-fit.js';
import { generateCourse, virtualField } from '/golf-random.js';
import { deltaYaw } from '/anchor.js';
import { initSound, cheer, hit } from '/sound.js';
import { Panel, WristMenu, pokeAll } from '/ui-xr.js';

const $ = (id) => document.getElementById(id);
const MAX_STROKES = 8;
const MAPS_KEY = 'isabella-golf-maps', MAP_KEY = 'isabella-golf-map', ANCHOR_KEY = 'isabella-golf-anchor', PLAYERS_KEY = 'lara-players';


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
const edges = new RoomEdges(scene, { height: 0.04 }); edges.visible = false;

/* ---------- Spieler und Runde ---------- */
let names = ['Spieler 1'];
try { const n = JSON.parse(localStorage.getItem(PLAYERS_KEY)); if (Array.isArray(n) && n.length) names = n.slice(0, 8); } catch {}
let mode = 'build', tool = 'move', note = '';
const sel = new Set();          // ausgewaehlte Elemente (mehrere moeglich)
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

function drawToolbar() { if (note) { toast(note); note = ''; } }

/* ---------- Schritt-Tafel und Uhr-Menue ---------- */
const wizard = new Panel(0.6); scene.add(wizard);
const toastP = new Panel(0.42); scene.add(toastP);
const wrist = new WristMenu(scene);
wrist.setItems([{ id: 'club', label: 'Schläger kippen' }, { id: 'ball', label: 'Kugel zurück' }, { id: 'skip', label: 'Loch aufgeben' }, { id: 'restart', label: 'Neue Runde' },
  { id: 'edit', label: 'Bahn bearbeiten' }, { id: 'map', label: 'Andere Bahn' }, { id: 'players', label: 'Spieler' }, { id: 'exit', label: 'Beenden', main: true }]);
let step = null, startStep = null, toastT = 0, editHole = 1;
const OBST = ['ramp', 'loop', 'boost', 'wall', 'bumper', 'sand', 'water', 'hill', 'spinner', 'tunnel'];
function toast(msg, sec = 3) {
  if (!renderer.xr.isPresenting || phone) { $('gscore').textContent = msg; return; }
  toastP.show({ text: msg, buttons: [] }); toastP.place(renderer.xr.getCamera(), 0.7); toastP.position.y -= 0.2; toastT = sec;
}
const holeCount = (m) => new Set((m.items || []).filter((o) => o.t === 'tee').map((o) => o.h)).size;
function showStep(id) {
  step = id;
  if (id === 'tee') tool = 'tee'; else if (id === 'cup') tool = 'cup'; else if (id === 'obst' || id === 'sel') { if (!OBST.includes(tool)) tool = 'ramp'; } else tool = 'move';
  if (id !== 'sel' && id !== 'obst') clearSel();
  if (phone || !renderer.xr.isPresenting) { wizard.hide(); return; }
  const n = course.holes().length;
  if (id === 'players') wizard.show({ title: 'Wer spielt?', text: names.join(', ') + '\n(Namen änderst du auf der Startseite)',
    buttons: [{ id: 'minus', label: '– Spieler' }, { id: 'plus', label: '+ Spieler' }, { id: 'next', label: 'Weiter', main: true }], cols: 2 });
  else if (id === 'map') {
    const b = maps.map((m, i) => ({ id: 'm' + i, label: `Bahn ${i + 1} · ${holeCount(m)} Löcher` })).filter((x, i) => holeCount(maps[i]) > 0).slice(-6);
    wizard.show({ title: 'Welche Bahn?', text: b.length ? 'Eine gespeicherte Bahn spielen oder eine neue bauen.' : 'Noch keine Bahn gespeichert – bau eine oder lass eine zufällig erstellen.',
      buttons: [...b, { id: 'new', label: 'Neue Bahn bauen' }, { id: 'random', label: 'Zufallsbahn (3 Löcher)' }, ...(b.length ? [{ id: 'del', label: 'Bahn löschen …' }] : [])], cols: 2 });
  } else if (id === 'delmap') {
    const b = maps.map((m, i) => ({ id: 'd' + i, label: `✕ Bahn ${i + 1} · ${holeCount(m)} Löcher` })).filter((x, i) => holeCount(maps[i]) > 0 || maps[i].items?.length);
    wizard.show({ title: 'Welche Bahn löschen?', text: 'Antippen zum Löschen – danach fragt die Tafel noch einmal nach.', buttons: [...b, { id: 'back', label: 'Zurück', main: true }], cols: 2 });
  } else if (id === 'delok') {
    wizard.show({ title: `Bahn ${delIdx + 1} löschen?`, text: 'Das lässt sich nicht rückgängig machen.', buttons: [{ id: 'yes', label: 'Ja, löschen' }, { id: 'no', label: 'Nein' }], cols: 2 });
  } else if (id === 'tee') wizard.show({ title: `Loch ${editHole}: Start`, text: 'Zeig auf den Boden oder einen Tisch, wo der Ball starten soll, und drück (Daumen + Zeigefinger oder Abzug).',
    buttons: [{ id: 'back', label: 'Zurück' }, ...(n ? [{ id: 'play', label: 'Doch gleich spielen' }] : [])], cols: 2 });
  else if (id === 'cup') wizard.show({ title: `Loch ${editHole}: Loch`, text: 'Jetzt das Loch setzen – dort muss der Ball rein.', buttons: [{ id: 'undo', label: 'Start neu setzen' }] });
  else if (id === 'obst') wizard.show({ title: `Loch ${editHole}: Hindernisse`,
    text: ZONES.includes(tool) ? `${TYPES[tool].label}: Abzug/Pinch halten und die Form auf den Boden malen – die Fläche wird gefüllt. Kurz drücken = runde Fläche.`
      : 'Element wählen und auf Boden/Tisch setzen. Element antippen = auswählen (mehrere möglich), festhalten = verschieben.',
    buttons: [...OBST.map((t) => ({ id: t, label: TYPES[t].label, on: tool === t })), { id: 'random', label: 'Zufällig' },
      { id: 'done', label: `Fertig mit Loch ${editHole}`, main: true }], cols: 4 });
  else if (id === 'sel') wizard.show({ title: `${sel.size} ausgewählt`, text: 'Weitere Elemente antippen = dazu wählen. Festhalten = verschieben, Stick: drehen (links/rechts) und Größe (hoch/runter).',
    buttons: [{ id: 'rl', label: '⟲ Drehen' }, { id: 'rr', label: 'Drehen ⟳' }, { id: 'big', label: 'Größer' }, { id: 'small', label: 'Kleiner' },
      { id: 'wide', label: 'Breiter' }, { id: 'narrow', label: 'Schmaler' }, { id: 'long', label: 'Länger' }, { id: 'short', label: 'Kürzer' },
      { id: 'high', label: 'Höher' }, { id: 'flat', label: 'Flacher' }, { id: 'all', label: 'Alle wählen' }, { id: 'del', label: `${sel.size} löschen` },
      { id: 'none', label: 'Fertig', main: true }], cols: 4 });
  else if (id === 'more') wizard.show({ title: 'Noch ein Loch?', text: `Die Bahn hat ${n} Loch${n === 1 ? '' : 'er'}.`,
    buttons: [{ id: 'yes', label: 'Ja, noch eins' }, { id: 'play', label: 'Nein – spielen!', main: true }], cols: 2 });
  else if (id === 'ready') wizard.show({ title: `Bahn ${mapIdx + 1}`, text: `${n} Loch${n === 1 ? '' : 'er'} · ${names.length} Spieler`,
    buttons: [{ id: 'edit', label: 'Bearbeiten' }, { id: 'map', label: 'Andere Bahn' }, { id: 'play', label: "Los geht's!", main: true }], cols: 2 });
  else wizard.hide();
  if (wizard.visible) wizard.place(renderer.xr.getCamera(), 0.8);
}
function startPlay() {
  if (!newRound()) { showStep('tee'); return; }
  mode = 'play'; board.visible = true; placeBoard(); showStep(null);
  toast('Schläger: Controller oder Hand nach unten halten und durch den Ball schwingen.\nMenü: Handrücken links anschauen oder X/Y drücken.', 6);
}
function editCourse() {
  mode = 'build'; round = null; course.hideBall(); board.visible = false;
  editHole = Math.max(1, ...course.holes().map((h) => h.n));
  showStep(course.holes().length ? 'obst' : 'tee');
}
function stepButton(id) {
  const n = course.holes().length;
  if (step === 'players') {
    if (id === 'minus' && names.length > 1) { names.pop(); savePlayers(); showStep('players'); }
    else if (id === 'plus' && names.length < 8) { names.push(`Spieler ${names.length + 1}`); savePlayers(); showStep('players'); }
    else if (id === 'next') { if (round && !round.over && mode === 'play') { newRound(); showStep(null); } else showStep(n ? 'ready' : 'map'); }
  } else if (step === 'map') {
    if (id.startsWith('m')) { saveMap(); mapIdx = +id.slice(1); loadMap(); showStep(course.holes().length ? 'ready' : 'tee'); }
    else if (id === 'new') { saveMap(); maps.push({ items: [] }); mapIdx = maps.length - 1; loadMap(); editHole = 1; showStep('tee'); }
    else if (id === 'random') { saveMap(); maps.push({ items: [] }); mapIdx = maps.length - 1; loadMap(); randomCourse(3); showStep(course.holes().length ? 'ready' : 'map'); }
    else if (id === 'del') showStep('delmap');
  } else if (step === 'delmap') {
    if (id.startsWith('d')) { delIdx = +id.slice(1); showStep('delok'); } else showStep('map');
  } else if (step === 'delok') {
    if (id === 'yes') deleteMap(delIdx);
    showStep(maps.some((m) => holeCount(m)) ? 'delmap' : 'map');
  } else if (step === 'tee') { if (id === 'back') showStep(n ? 'more' : 'map'); else if (id === 'play') startPlay(); }
  else if (step === 'cup') { if (id === 'undo') { const t = course.items.find((x) => x.type === 'tee' && x.hole === editHole); if (t) course.remove(t); saveMap(); showStep('tee'); } }
  else if (step === 'obst') {
    if (OBST.includes(id)) { tool = id; showStep('obst'); }
    else if (id === 'random') randomObstacles();
    else if (id === 'done') showStep('more');
  } else if (step === 'sel') {
    const S = { big: [1.15, 1.15, 1.15], small: [1 / 1.15, 1 / 1.15, 1 / 1.15], wide: [1.2, 1, 1], narrow: [1 / 1.2, 1, 1], long: [1, 1, 1.2], short: [1, 1, 1 / 1.2], high: [1, 1.25, 1], flat: [1, 1 / 1.25, 1] }[id];
    if (S) { scaleSel(S); saveMap(); }
    else if (id === 'rl' || id === 'rr') { for (const it of sel) course.move(it, it.obj.position, it.obj.rotation.y + (id === 'rl' ? 1 : -1) * Math.PI / 8); saveMap(); }
    else if (id === 'all') { for (const it of course.items) if (it.type !== 'tee' && it.type !== 'cup') sel.add(it); markSel(); showStep('sel'); }
    else if (id === 'del') { for (const it of sel) course.remove(it); clearSel(); saveMap(); drawBoard(''); showStep('obst'); }
    else if (id === 'none') { clearSel(); showStep('obst'); }
  } else if (step === 'more') { if (id === 'yes') { editHole = course.nextHoleNumber('tee'); showStep('tee'); } else if (id === 'play') startPlay(); }
  else if (step === 'ready') { if (id === 'play') startPlay(); else if (id === 'edit') editCourse(); else if (id === 'map') showStep('map'); }
}
function wristButton(id) {
  wrist.close();
  if (id === 'edit') editCourse();
  else if (id === 'map') { useTool('build'); showStep('map'); }
  else if (id === 'players') showStep('players');
  else if (id === 'club') { const a = CLUB_ANGLES[(CLUB_ANGLES.indexOf(clubAngle) + 1) % CLUB_ANGLES.length]; setClubAngle(a); toast(`Schläger: ${a === 0 ? 'hängt nach unten' : a === 90 ? 'zeigt nach vorn' : a + '°'}`); }
  else useTool(id);
}
function savePlayers() { try { localStorage.setItem(PLAYERS_KEY, JSON.stringify(names)); } catch {} }
// ein paar Hindernisse zwischen Start und Loch des aktuellen Lochs
function randomObstacles() {
  const h = course.holes().find((x) => x.n === editHole); if (!h) return;
  const a = h.tee.obj.position, b = h.cup.obj.position, dir = b.clone().sub(a).setY(0).normalize(), side = new THREE.Vector3(-dir.z, 0, dir.x);
  const yaw = Math.atan2(dir.x, dir.z);
  const sets = [['ramp', 'sand'], ['bumper', 'bumper', 'bumper'], ['spinner'], ['tunnel', 'bumper'], ['hill', 'water'], ['boost', 'loop'], ['wall', 'sand', 'bumper']];
  const set = sets[Math.floor(Math.random() * sets.length)];
  set.forEach((type, k) => {
    const t = 0.3 + (k + 0.5) * (0.45 / set.length);
    const off = type === 'water' ? 0.35 : type === 'bumper' ? (k % 2 ? -0.11 : 0.11) : type === 'wall' ? 0.15 : 0;
    course.add(type, a.clone().lerp(b, t).addScaledVector(side, off), yaw + (type === 'wall' ? Math.PI / 2 + 0.6 : 0));
  });
  saveMap();
}

// Auswahl: hervorheben, leeren, skalieren
function markSel() {
  for (const it of course.items) it.obj.traverse((o) => {
    if (!o.isMesh || !o.material.emissive) return;
    if (o.userData.e0 === undefined) o.userData.e0 = o.material.emissive.getHex();
    o.material.emissive.setHex(sel.has(it) ? 0x666622 : o.userData.e0);
  });
}
function clearSel() { sel.clear(); markSel(); }
function scaleSel(f) {
  const next = [...sel].map((it) => course.resize(it, it.s.map((v, k) => v * f[k])));
  sel.clear(); next.forEach((it) => sel.add(it)); markSel();
  return next;
}
let delIdx = 0;
function deleteMap(i) {
  if (i === mapIdx) { course.clear(); clearSel(); }
  maps.splice(i, 1);
  if (!maps.length) maps.push({ items: [] });
  if (mapIdx >= i && mapIdx > 0 && i !== mapIdx) mapIdx--;
  if (i === mapIdx) { mapIdx = Math.min(mapIdx, maps.length - 1); loadMap(); }
  try { localStorage.setItem(MAPS_KEY, JSON.stringify(maps)); localStorage.setItem(MAP_KEY, String(mapIdx)); } catch {}
  toast('Bahn gelöscht');
}

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
  sel.clear(); round = null; course.hideBall(); loaded = true;
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
  for (const [pn, fn] of [[wizard, stepButton], [wrist.panel, wristButton]]) { const i = pn.pick(raycaster); if (i >= 0) { fn(pn.idAt(i)); return; } }
  if (mode === 'play') { clubHand = inp; return; }
  if (!['tee', 'cup', 'obst'].includes(step) && !phone) return;        // die drueckende Hand haelt den Schlaeger
  // Bauen: vorhandenes Element antippen (auswaehlen) oder festhalten (verschieben)
  const ih = raycaster.intersectObjects(itemMeshes(), false)[0];
  if (ih && step !== 'tee' && step !== 'cup') {
    const it = course.items.find((x) => x.obj === ih.object.userData.item);
    if (!it) return;
    held = { inp, it, at: ih.point.clone(), off: it.obj.position.clone().sub(ih.point).setY(0), moved: false, sc: 0 };
    return;
  }
  if (!TYPES[tool]) return;
  const p = surfaceHit(); if (!p) { if (kind === 'select') { note = 'Kein Boden/Möbel getroffen'; drawToolbar(); } return; }
  // Sand/Wasser: Form auf den Boden malen
  if (ZONES.includes(tool)) { drawing = { inp, type: tool, pts: [p.clone()] }; drawLine.visible = true; return; }
  if (kind !== 'select') return;
  if (tool === 'tee' || tool === 'cup') {
    const old = course.items.find((x) => x.type === tool && x.hole === editHole); if (old) course.remove(old);
    let yaw = yawToward(p);
    if (tool === 'cup') { const t = course.items.find((x) => x.type === 'tee' && x.hole === editHole); if (t) { yaw = Math.atan2(p.x - t.obj.position.x, p.z - t.obj.position.z); t.obj.rotation.y = yaw; } }
    course.add(tool, p, yaw, editHole);
    saveMap(); drawBoard('');
    showStep(tool === 'tee' ? 'cup' : 'obst');
    return;
  }
  course.add(tool, p, yawToward(p));
  note = ''; saveMap(); drawBoard('');
}

// Vorschau: halb durchsichtiges Element dort, wo der Strahl gerade hinzeigt
let ghost = null;
function dropGhost() {
  if (!ghost) return;
  scene.remove(ghost.obj);
  ghost.obj.traverse((o) => { if (o.material) { o.geometry?.dispose(); o.material.dispose(); } });
  ghost = null;
}
function ghostYaw(p) {
  if (tool === 'cup') { const t = course.items.find((x) => x.type === 'tee' && x.hole === editHole); if (t) return Math.atan2(p.x - t.obj.position.x, p.z - t.obj.position.z); }
  return yawToward(p);
}
function updateGhost() {
  let p = null;
  const want = renderer.xr.isPresenting && !phone && mode === 'build' && !held && !drawing && ['tee', 'cup', 'obst'].includes(step) && TYPES[tool] && !ZONES.includes(tool);
  if (want) {
    const inp = inputs.find((i) => i.mode && i.source && !i.source.hand) || inputs.find((i) => i.mode);
    if (inp) {
      setRay(inp);
      if (wizard.pick(raycaster) < 0 && !raycaster.intersectObjects(itemMeshes(), false)[0]) p = surfaceHit();
    }
  }
  if (!p) { if (ghost) ghost.obj.visible = false; return; }
  if (!ghost || ghost.type !== tool) {
    dropGhost();
    ghost = course.add(tool, p, 0, editHole);
    course.items = course.items.filter((x) => x !== ghost);
    if (ghost.body) { course.world.removeBody(ghost.body); ghost.body = null; }
    course.group.remove(ghost.obj); scene.add(ghost.obj);
    ghost.obj.traverse((o) => { delete o.userData.item; if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.45; o.material.depthWrite = false; } });
  }
  ghost.obj.visible = true; ghost.obj.position.copy(p); ghost.obj.rotation.y = ghostYaw(p);
}

// gemalte Zone fertig: Punkte ausduennen, Mitte bestimmen, als Flaeche anlegen
let drawing = null;
const drawLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
drawLine.renderOrder = 12; drawLine.visible = false; scene.add(drawLine);
function finishDrawing() {
  const d = drawing; drawing = null; drawLine.visible = false;
  const pts = [];
  for (const q of d.pts) if (!pts.length || pts.at(-1).distanceTo(q) > 0.04) pts.push(q);
  let len = 0; for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  const y = d.pts[0].y;
  if (pts.length < 5 || len < 0.3) { course.add(d.type, d.pts[0], yawToward(d.pts[0])); saveMap(); return; }
  const c = pts.reduce((a, q) => a.add(q), new THREE.Vector3()).divideScalar(pts.length).setY(y);
  course.add(d.type, c, 0, undefined, { shape: pts.map((q) => [q.x - c.x, q.z - c.z]) });
  saveMap(); drawBoard('');
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
  else if (id === 'random') randomCourse(phone ? 1 : 3);
  else if (id === 'map') nextMap();
  else tool = id;
  drawToolbar();
}

// Zufallsbahn: mehrere Loecher, passend in den freien Raum (ohne Scan: 6 x 6 m um dich)
function randomCourse(holes = 3) {
  const v = viewer(), fwd = new THREE.Vector3(0, 0, -1).applyQuaternion((renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).quaternion);
  fwd.y = 0; fwd.normalize();
  const field = (scan.scanned && clearanceField(scan)) || virtualField(v.clone().addScaledVector(fwd, 2).setY(0), 6);
  const n = generateCourse(course, field, { viewer: v.clone().setY(0), fwd, floorY: scan.floorY, holes });
  note = n ? `Zufallsbahn: ${n} Loch${n === 1 ? '' : 'er'}` : 'Kein freier Platz für eine Zufallsbahn gefunden';
  saveMap(); drawBoard(''); drawToolbar();
}

/* ---------- Schlaeger ---------- */
// Fest am Controller: der Schaft verlaengert die Zeigerichtung, Drehen des Controllers dreht den Kopf mit.
const CLUB_LEN = 0.85;
const club = new THREE.Group();
{
  const metal = new THREE.MeshStandardMaterial({ color: 0xd8d8e0, metalness: 0.85, roughness: 0.25 });
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.011, 0.16, 12), new THREE.MeshStandardMaterial({ color: 0x2a2236, roughness: 0.8 })); grip.position.y = -0.06; club.add(grip);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, CLUB_LEN - 0.12, 8), metal); shaft.position.y = -0.14 - (CLUB_LEN - 0.12) / 2 + 0.02; club.add(shaft);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.05, 8), metal); neck.position.set(0.01, -CLUB_LEN + 0.03, 0); neck.rotation.z = 0.4; club.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.028, 0.035), new THREE.MeshStandardMaterial({ color: 0xff7ab6, metalness: 0.6, roughness: 0.3 }));
  head.position.set(0.03, -CLUB_LEN, 0); club.add(head);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.022), new THREE.MeshBasicMaterial({ color: 0xffffff })); face.position.set(0.03, -CLUB_LEN, -0.0176); face.rotation.y = Math.PI; club.add(face);
}
club.visible = false; scene.add(club);
const TIP = new THREE.Vector3(0.03, -CLUB_LEN, 0), FACE = new THREE.Vector3(0, 0, -1);
// Winkel zwischen Controller und Schaft: 0° = haengt nach unten, wenn man den Controller normal haelt;
// 90° = verlaengert die Zeigerichtung. Im Uhr-Menue umschaltbar ("Schläger kippen").
const CLUB_KEY = 'isabella-club-angle', CLUB_ANGLES = [0, 45, 90, -45];
let clubAngle = 0;
try { const a = +localStorage.getItem(CLUB_KEY); if (CLUB_ANGLES.includes(a)) clubAngle = a; } catch {}
const SHAFT_FIX = new THREE.Quaternion();
const setClubAngle = (a) => { clubAngle = a; SHAFT_FIX.setFromAxisAngle(new THREE.Vector3(1, 0, 0), a * Math.PI / 180); try { localStorage.setItem(CLUB_KEY, String(a)); } catch {} };
setClubAngle(clubAngle);
let clubHand = null, clubHead = new THREE.Vector3(), clubPrev = null, clubVel = new THREE.Vector3(), hitCooldown = 0;
function updateClub(dt) {
  const inp = clubHand?.mode ? clubHand : inputs.find((x) => x.mode && x.source?.handedness === 'right') || inputs.find((x) => x.mode) || null;
  if (!inp || mode !== 'play') { club.visible = false; clubPrev = null; return; }
  const j = inp.hand.joints, q = new THREE.Quaternion();
  let p;
  if (inp.source?.hand) {
    if (!j?.wrist?.visible) { club.visible = false; clubPrev = null; return; }
    p = j.wrist.getWorldPosition(new THREE.Vector3()); j.wrist.getWorldQuaternion(q);       // -Z zeigt zu den Fingern
  } else if (inp.mode === 'tracked-pointer') {
    p = (inp.grip.visible ? inp.grip : inp.ray).getWorldPosition(new THREE.Vector3());
    inp.ray.getWorldQuaternion(q);
  } else { club.visible = false; return; }
  club.visible = true; club.position.copy(p); club.quaternion.copy(q).multiply(SHAFT_FIX);
  club.updateMatrixWorld();
  clubHead.copy(TIP).applyMatrix4(club.matrixWorld);
  if (clubHead.y < scan.floorY + BALL_R) clubHead.y = scan.floorY + BALL_R;        // auf Balloehe, nie unter dem Boden
  const prev = clubPrev || clubHead.clone();
  if (clubPrev && dt > 0) clubVel.copy(clubHead).sub(clubPrev).divideScalar(dt);
  clubPrev = clubHead.clone();
  hitCooldown -= dt;
  // Treffer: Weg des Kopfes seit dem letzten Bild (auch bei schnellem Schwung) beruehrt die ruhende Kugel
  if (round && !round.over && course.resting && hitCooldown <= 0) {
    const b = course.ball.position;
    const seg = clubHead.clone().sub(prev).setY(0), rel = b.clone().sub(prev).setY(0);
    const u = seg.lengthSq() > 1e-8 ? Math.max(0, Math.min(1, rel.dot(seg) / seg.lengthSq())) : 1;
    const closest = prev.clone().addScaledVector(clubHead.clone().sub(prev), u);
    const d = Math.hypot(b.x - closest.x, b.z - closest.z), dy = Math.abs(closest.y - b.y);
    const v = clubVel.clone().setY(0);
    if (d < BALL_R + 0.055 && dy < 0.08 && v.length() > 0.15 && v.dot(b.clone().sub(closest).setY(0)) > 0) {
      // Richtung: halb Schwungrichtung, halb Schlagflaeche (so zaehlt, wie du den Schlaeger drehst)
      const n = FACE.clone().applyQuaternion(club.quaternion).setY(0);
      if (n.lengthSq() > 1e-4) { n.normalize(); if (n.dot(v) < 0) n.negate(); }
      const dir = v.clone().normalize().multiplyScalar(0.55).addScaledVector(n, 0.45).normalize();
      strike(dir.multiplyScalar(Math.min(6, v.length() * 1.3))); pulse(inp, 0.8, 60);   // Putter: Kugel ~1,3x so schnell wie der Kopf
    }
  }
}
// Markierung: Ring um die Kugel, sobald man schlagen darf
const ready = new THREE.Group();
{
  const r = new THREE.Mesh(new THREE.RingGeometry(BALL_R + 0.012, BALL_R + 0.022, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7ee0b0, transparent: true, depthTest: false }));
  r.renderOrder = 7; ready.add(r);
  const o = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 1.25, 20, 12), new THREE.MeshBasicMaterial({ color: 0x7ee0b0, side: THREE.BackSide, transparent: true, opacity: 0.6 }));
  o.position.y = BALL_R; ready.add(o);
}
ready.visible = false; scene.add(ready);
function updateReady() {
  const on = mode === 'play' && round && !round.over && course.resting && course.ball.visible;
  ready.visible = !!on; if (!on) return;
  const b = course.ball.position;
  ready.position.set(b.x, b.y - BALL_R + 0.002, b.z);
  const near = club.visible && Math.hypot(clubHead.x - b.x, clubHead.z - b.z) < 0.25;
  const k = 0.75 + 0.25 * Math.sin(performance.now() / 180);
  ready.children.forEach((m) => { m.material.color.setHex(near ? 0xffd23c : 0x7ee0b0); m.material.opacity = (m.material.side === THREE.BackSide ? 0.5 : 1) * k; });
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
  const speed = Math.min(3.5, Math.max(0.3, (Math.hypot(dx, dy) / innerHeight) / Math.max(dt, 0.05) * 1.6));
  strike(dir.multiplyScalar(speed));
}

/* ---------- Ablauf pro Frame ---------- */
let lastT = performance.now(), tYaw, phone = false, session = null, anchorStep = null, t0 = 0;
renderer.setAnimationLoop((t, frame) => {
  const now = performance.now(), dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const xr = renderer.xr.isPresenting;
  if (frame) {
    const ref = renderer.xr.getReferenceSpace();
    if (scan.update(frame, ref)) { course.syncRoom(); edges.build(scan); shadow.position.y = scan.floorY + 0.001; drawToolbar(); }
    // Anker holen, dann gespeicherte Karte an ihren Platz
    if (anchorStep === 'start') { anchorStep = 'busy'; initAnchor(frame, session).finally(() => { anchorStep = 'wait'; }); }
    if (anchor) {
      const pose = frame.getPose(anchor.anchorSpace, ref);
      if (pose) {
        const M = new THREE.Matrix4().fromArray(pose.transform.matrix);
        // Anker verschoben (Brille ab-/aufgesetzt, Tracking neu): Bahn mitnehmen, damit sie im Raum stehen bleibt
        if (anchored && loaded) {
          const d = new THREE.Matrix4().multiplyMatrices(M, anchorM.clone().invert());
          const dp = new THREE.Vector3().setFromMatrixPosition(d), yaw = deltaYaw(d);
          if (dp.length() > 0.01 || Math.abs(yaw) > 0.01) { course.transform(d, yaw); if (board.visible) placeBoard(); }
        }
        anchorM.copy(M); anchored = true;
      }
    }
    if (anchorStep === 'wait' && (anchored || now - t0 > 2500)) { anchorStep = 'done'; loadMap(); startStep = 'players'; }
  }
  const pend = pending; pending = [];
  for (const e of pend) {
    if (e.kind === 'end') {
      if (drawing?.inp === e.inp) finishDrawing();
      if (held?.inp === e.inp) {
        const h = held; held = null;
        // nur angetippt: Auswahl umschalten (Start/Loch nicht), sonst verschoben -> speichern
        if (!h.moved && h.it.type !== 'tee' && h.it.type !== 'cup' && course.items.includes(h.it)) {
          if (sel.has(h.it)) sel.delete(h.it); else sel.add(h.it);
          markSel(); if (!phone) showStep(sel.size ? 'sel' : 'obst');
        }
        saveMap();
      }
    }
    else if (!held && !drawing && !(phone && mode === 'play')) press(e.inp, e.kind);
  }
  // Zone malen: Strahl auf dem Boden sammelt Punkte
  if (drawing) {
    setRay(drawing.inp);
    const p = surfaceHit();
    if (p && p.distanceTo(drawing.pts.at(-1)) > 0.02) drawing.pts.push(p.clone());
    drawLine.geometry.dispose();
    drawLine.geometry = new THREE.BufferGeometry().setFromPoints([...drawing.pts, drawing.pts[0]].map((q) => q.clone().setY(q.y + 0.01)));
    drawLine.material.color.setHex(drawing.type === 'water' ? 0x7cc4ff : 0xffe2a0);
  }
  // festgehaltenes Element folgt dem Strahl auf Boden/Moebeln; Stick: links/rechts dreht, hoch/runter skaliert
  if (held) {
    setRay(held.inp);
    let it = held.it;
    const p = surfaceHit();
    if (p && (held.moved || p.distanceTo(held.at) > 0.04)) { held.moved = true; course.move(it, p.clone().add(held.off)); }
    const ax = held.inp.source?.gamepad?.axes || [];
    if (Math.abs(ax[2] || 0) > 0.2) { held.moved = true; course.move(it, it.obj.position, it.obj.rotation.y - ax[2] * dt * 2.5); }
    held.sc += -(ax[3] || 0) * dt;
    if (Math.abs(held.sc) > 0.12 && it.type !== 'tee' && it.type !== 'cup') {
      const f = held.sc > 0 ? 1.1 : 1 / 1.1; held.sc = 0; held.moved = true;
      const wasSel = sel.has(it); sel.delete(it);
      it = held.it = course.resize(it, it.s.map((v) => v * f));
      if (wasSel) sel.add(it); markSel();
    }
  }
  // Hervorheben und Strahl-Laenge
  let hover = null;
  if (xr) {
    for (const inp of inputs) {
      if (!inp.mode) continue;
      setRay(inp);
      for (const pn of [wizard, wrist.panel]) pn.setHover(pn.pick(raycaster));
      if (inp.line.visible) {
        const h = raycaster.intersectObjects([...[wizard, wrist.panel].filter((o) => o.visible), ...(mode === 'build' ? itemMeshes() : []), ...scan.targets], false)[0];
        inp.line.scale.z = h ? h.distance : 3;
      }
    }
    void hover;
    if (startStep) { showStep(startStep); startStep = null; }
    const cam = renderer.xr.getCamera(), head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    wrist.enabled = !step && !phone && mode === 'play';
    wrist.update(inputs, head, dt, cam);
    if (wizard.visible) wizard.place(cam, 0.8, true);
    if (toastP.visible) { toastT -= dt; if (toastT <= 0) toastP.hide(); }
    const pk = pokeAll([wizard, wrist.panel], inputs, {});
    if (pk) (pk.panel === wizard ? stepButton : wristButton)(pk.id);
  }
  course.animate(dt); updateGhost();
  edges.visible = xr && scan.scanned; if (edges.visible) edges.update();
  updateClub(dt); updateReady();
  // Kugel und Regeln
  if (mode === 'play' && round && !round.over) {
    const ev = course.step(dt, round.holes[round.hi].cup);
    if (ev === 'sunk') { cheer(round.shots === 1); drawBoard(round.shots === 1 ? `Hole in One, ${names[round.cur]}!` : `${names[round.cur]}: ${round.shots} Schläge`); setTimeout(() => { course.hideBall(); finishTurn(round.shots); }, 1200); round.shots = round.shots; }
    else if (ev === 'out' || ev === 'water') { round.shots++; course.ballTo(course.lastRest); drawBoard(ev === 'water' ? 'Platsch – Wasser! +1 Schlag' : 'Aus! +1 Schlag'); if (ev === 'water') hit(3, 'ball'); setTimeout(() => drawBoard(''), 1500); }
    if (round && !round.over && !course.sunk && round.shots >= MAX_STROKES && course.resting) { course.hideBall(); drawBoard(`${names[round.cur]}: Maximum erreicht`); finishTurn(MAX_STROKES); }
  }
  renderer.render(scene, camera);
});

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
  mode = 'build'; tool = 'move'; anchorStep = 'start'; t0 = performance.now(); loaded = false;
  drawToolbar();
  session.addEventListener('end', () => {
    saveMap(); session = null; anchor = null; anchored = false; anchorStep = null;
    $('gstart').hidden = false; $('goverlay').hidden = true; hall.visible = true; scene.background = new THREE.Color(0x15111d);
    club.visible = false; dropGhost(); drawing = null; drawLine.visible = false; clearSel(); board.visible = false; course.hideBall(); held = null; wizard.hide(); toastP.hide(); wrist.panel.hide(); step = null;
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
window.__golf = { course, scan, camera, sel, markSel, get round() { return round; }, useTool, strike, newRound, randomCourse };
