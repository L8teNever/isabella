// Bowling-Bahn: Physik (cannon-es) fuer Kugel und 10 Kegel in Originalgroesse, Erkennen umgefallener
// Kegel, Ablauf eines Wurfs. Alles in Metern, y = oben, Boden auf floorY.
import * as THREE from 'three';
import * as CANNON from '/vendor/cannon-es.js';
import { hit, rolling } from '/sound.js';

export const BALL_R = 0.108;              // 21,6 cm Durchmesser
const BALL_MASS = 6;
const PIN_MASS = 1.55;
const PIN_COM = 0.14;                      // Schwerpunkt ueber der Standflaeche
const SPACING = 0.3048;                    // 12 Zoll zwischen den Kegeln
const ROW = SPACING * Math.sqrt(3) / 2;

// Kegel-Umriss (Radius, Hoehe) in Metern, Originalform (38,1 cm hoch)
const PROFILE = [[0, 0], [0.026, 0], [0.03, 0.01], [0.045, 0.05], [0.057, 0.1], [0.0605, 0.14], [0.058, 0.18],
  [0.048, 0.22], [0.034, 0.26], [0.024, 0.285], [0.022, 0.3], [0.026, 0.325], [0.031, 0.345], [0.03, 0.365],
  [0.022, 0.377], [0.01, 0.381], [0, 0.381]];

function pinGeometry() {
  const g = new THREE.LatheGeometry(PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 24);
  g.translate(0, -PIN_COM, 0);
  // zwei rote Streifen am Hals
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) + PIN_COM;
    const red = (y > 0.262 && y < 0.276) || (y > 0.286 && y < 0.3);
    col.set(red ? [0.85, 0.08, 0.12] : [0.97, 0.97, 0.95], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function ballTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  const gr = x.createLinearGradient(0, 0, 512, 256);
  gr.addColorStop(0, '#ff4f9a'); gr.addColorStop(0.5, '#8a3cff'); gr.addColorStop(1, '#ff4f9a');
  x.fillStyle = gr; x.fillRect(0, 0, 512, 256);
  for (let k = 0; k < 40; k++) {           // Marmor-Schlieren
    x.strokeStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.08})`; x.lineWidth = 2 + Math.random() * 6;
    x.beginPath(); let px = Math.random() * 512, py = Math.random() * 256; x.moveTo(px, py);
    for (let s = 0; s < 6; s++) { px += (Math.random() - 0.5) * 120; py += (Math.random() - 0.5) * 60; x.lineTo(px, py); }
    x.stroke();
  }
  x.fillStyle = '#1a1024';                 // drei Fingerloecher
  for (const [hx, hy, r] of [[250, 70, 11], [272, 70, 11], [261, 112, 13]]) { x.beginPath(); x.arc(hx, hy, r, 0, Math.PI * 2); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Lane {
  constructor(scene) {
    this.scene = scene;
    this.floorY = 0;
    const w = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    w.broadphase = new CANNON.SAPBroadphase(w);
    w.allowSleep = true;
    w.solver.iterations = 12;
    const floorM = new CANNON.Material('floor'), pinM = new CANNON.Material('pin'), ballM = new CANNON.Material('ball');
    w.addContactMaterial(new CANNON.ContactMaterial(floorM, ballM, { friction: 0.04, restitution: 0.1 }));
    w.addContactMaterial(new CANNON.ContactMaterial(floorM, pinM, { friction: 0.35, restitution: 0.15 }));
    w.addContactMaterial(new CANNON.ContactMaterial(pinM, pinM, { friction: 0.15, restitution: 0.5 }));
    w.addContactMaterial(new CANNON.ContactMaterial(ballM, pinM, { friction: 0.05, restitution: 0.45 }));
    const wallM = new CANNON.Material('wall');
    w.addContactMaterial(new CANNON.ContactMaterial(wallM, ballM, { friction: 0.1, restitution: 0.45 }));
    w.addContactMaterial(new CANNON.ContactMaterial(wallM, pinM, { friction: 0.2, restitution: 0.4 }));
    this.mats = { floorM, pinM, ballM, wallM };

    this.floor = new CANNON.Body({ mass: 0, material: floorM, shape: new CANNON.Plane() });
    this.floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    w.addBody(this.floor);
    this.walls = [];

    // Schattenfaenger: zeigt Schatten der Kegel/Kugel auf dem echten Boden
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.35 }));
    this.shadow.receiveShadow = true; this.shadow.renderOrder = -1;
    scene.add(this.shadow);

    // Kegel
    const pg = pinGeometry(), pmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.0, transparent: true });
    this.pins = [];
    for (let i = 0; i < 10; i++) {
      const body = new CANNON.Body({ mass: PIN_MASS, material: pinM, allowSleep: true, sleepSpeedLimit: 0.08, sleepTimeLimit: 0.6, angularDamping: 0.15, linearDamping: 0.05 });
      const add = (shape, y) => body.addShape(shape, new CANNON.Vec3(0, y - PIN_COM, 0));
      add(new CANNON.Cylinder(0.05, 0.028, 0.06, 10), 0.03);
      add(new CANNON.Cylinder(0.06, 0.05, 0.09, 10), 0.105);
      add(new CANNON.Cylinder(0.04, 0.06, 0.1, 10), 0.2);
      add(new CANNON.Cylinder(0.026, 0.035, 0.07, 8), 0.285);
      add(new CANNON.Sphere(0.031), 0.345);
      body.addEventListener('collide', (e) => this._onCollide(e, 'pin'));
      const mesh = new THREE.Mesh(pg, pmat.clone()); mesh.castShadow = true;
      scene.add(mesh);
      this.pins.push({ body, mesh, spot: new THREE.Vector3(), active: true, fade: 0 });
    }

    // Kugel
    this.ballBody = new CANNON.Body({ mass: BALL_MASS, material: ballM, shape: new CANNON.Sphere(BALL_R), linearDamping: 0.04, angularDamping: 0.05, allowSleep: false });
    this.ballBody.addEventListener('collide', (e) => this._onCollide(e, 'ball'));
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 20), new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.15, metalness: 0.1 }));
    this.ball.castShadow = true;
    scene.add(this.ball);
    this.ballState = 'rest';     // rest (schwebt an der Rueckgabe) | held | rolling
    this.ballHome = new THREE.Vector3(0.35, 0.9, -0.4);
    this.placed = false;
    this.headPos = new THREE.Vector3(); this.dir = new THREE.Vector3(0, 0, -1);
    this.setVisible(false);
  }

  setVisible(on) { for (const p of this.pins) p.mesh.visible = on && p.active; this.ball.visible = on; this.shadow.visible = on; }

  setFloor(y) {
    this.floorY = y;
    this.floor.position.set(0, y, 0);
    this.shadow.position.y = y + 0.001;
  }

  // erkannte Waende als feste Kisten (die Kugel prallt ab statt durchzurollen)
  setWalls(segs) {
    for (const b of this.walls) this.world.removeBody(b);
    this.walls = segs.map(([[ax, az], [bx, bz]]) => {
      const len = Math.hypot(bx - ax, bz - az);
      const b = new CANNON.Body({ mass: 0, material: this.mats.wallM, shape: new CANNON.Box(new CANNON.Vec3(len / 2 + 0.05, 1.5, 0.08)) });
      b.position.set((ax + bx) / 2, this.floorY + 1.5, (az + bz) / 2);
      b.quaternion.setFromEuler(0, -Math.atan2(bz - az, bx - ax), 0);
      this.world.addBody(b); return b;
    });
  }

  // ganzer Raum: Waende, Rand des gescannten Bodens und Moebel – die Kugel bleibt im Raum und prallt ab
  setRoom(scan) {
    const segs = [...scan.walls];
    const F = scan.floorPoly;
    if (F) for (let i = 0; i < F.length; i++) segs.push([F[i], F[(i + 1) % F.length]]);
    this.setWalls(segs);
    for (const b of this.boxes || []) this.world.removeBody(b);
    this.boxes = scan.boxes.map((bx) => {
      const b = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(bx.size.x / 2, bx.size.y / 2, bx.size.z / 2)) });
      b.position.set(bx.center.x, bx.center.y, bx.center.z); b.quaternion.setFromEuler(0, bx.yaw, 0);
      this.world.addBody(b); return b;
    });
  }

  // Dreieck aufstellen: Kopfkegel an pos, Dreieck zeigt weg vom Spieler (dir = Richtung Spieler -> Kegel)
  place(pos, dir) {
    this.headPos.copy(pos).setY(this.floorY);
    this.dir.copy(dir).setY(0).normalize();
    const side = new THREE.Vector3(-this.dir.z, 0, this.dir.x);
    let k = 0;
    for (let row = 0; row < 4; row++) for (let i = 0; i <= row; i++) {
      this.pins[k++].spot.copy(this.headPos).addScaledVector(this.dir, row * ROW).addScaledVector(side, (i - row / 2) * SPACING);
    }
    this.placed = true;
    this.resetPins();
    this.setVisible(true);
  }

  resetPins() {
    for (const p of this.pins) {
      const b = p.body;
      if (!p.inWorld) { this.world.addBody(b); p.inWorld = true; }
      b.position.set(p.spot.x, this.floorY + PIN_COM + 0.002, p.spot.z);
      b.quaternion.set(0, 0, 0, 1);
      b.velocity.setZero(); b.angularVelocity.setZero();
      b.sleep();
      p.active = true; p.fade = 0;
      p.mesh.visible = true; p.mesh.material.opacity = 1;
    }
    this._sync();
  }

  // nur die Kegel aus mask wieder hinstellen (Foul: Stand vor dem Wurf)
  restorePins(mask) {
    this.resetPins();
    this.pins.forEach((p, i) => { if (!mask[i]) { p.active = false; p.fade = 0; p.mesh.visible = false; this.world.removeBody(p.body); p.inWorld = false; } });
  }

  // umgefallene Kegel wegraeumen (nach dem ersten Wurf eines Frames)
  clearDown() {
    for (const p of this.pins) if (p.active && this.isDown(p)) { p.active = false; p.fade = 1; }
  }

  isDown(p) {
    const up = p.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    const dx = p.body.position.x - p.spot.x, dz = p.body.position.z - p.spot.z;
    return up.y < 0.8 || Math.hypot(dx, dz) > 0.12 || p.body.position.y < this.floorY - 0.1;
  }

  standing() { return this.pins.filter((p) => p.active && !this.isDown(p)).length; }

  /* ---------- Kugel ---------- */
  ballToHome(home) {
    if (home) this.ballHome.copy(home);
    this.ballState = 'rest';
    if (this.ballInWorld) { this.world.removeBody(this.ballBody); this.ballInWorld = false; }
    this.ball.position.copy(this.ballHome);
    this.ballBody.velocity.setZero(); this.ballBody.angularVelocity.setZero();
  }

  grab() { this.ballState = 'held'; if (this.ballInWorld) { this.world.removeBody(this.ballBody); this.ballInWorld = false; } }

  // Halten: Kugel folgt der Hand
  hold(pos, quat) { this.ball.position.copy(pos); if (quat) this.ball.quaternion.copy(quat); }

  // Loslassen mit Geschwindigkeit (m/s) -> Wurf
  throw(vel, spin) {
    const b = this.ballBody;
    b.position.set(this.ball.position.x, Math.max(this.ball.position.y, this.floorY + BALL_R + 0.005), this.ball.position.z);
    b.quaternion.set(this.ball.quaternion.x, this.ball.quaternion.y, this.ball.quaternion.z, this.ball.quaternion.w);
    const v = vel.clone(); if (v.length() > 12) v.setLength(12);
    b.velocity.set(v.x, v.y, v.z);
    b.angularVelocity.set(spin?.x || 0, spin?.y || 0, spin?.z || 0);
    if (!this.ballInWorld) { this.world.addBody(b); this.ballInWorld = true; }
    b.wakeUp();
    for (const p of this.pins) if (p.active) p.body.wakeUp();
    this.preMask = this.pins.map((p) => p.active && !this.isDown(p));
    this.ballState = 'rolling';
    this.throwT = performance.now();
    this.settleT = null;
  }

  // Wurf vorbei? (Kugel ruhig oder weit weg, Kegel ruhig)
  rollDone() {
    if (this.ballState !== 'rolling') return false;
    const now = performance.now(), b = this.ballBody;
    const far = b.position.distanceTo(new CANNON.Vec3(this.headPos.x, this.floorY, this.headPos.z)) > 4
      && (b.position.x - this.headPos.x) * this.dir.x + (b.position.z - this.headPos.z) * this.dir.z > 1.0;
    const ballQuiet = b.velocity.length() < 0.15 || far || b.position.y < this.floorY - 1 || now - this.throwT > 12000;
    const pinsQuiet = this.pins.every((p) => !p.active || p.body.sleepState === CANNON.Body.SLEEPING || p.body.velocity.length() < 0.05);
    if (ballQuiet && pinsQuiet) { this.settleT ??= now; return now - this.settleT > 700; }
    this.settleT = null;
    return now - this.throwT > 15000;
  }

  _onCollide(e, kind) {
    const other = e.body === this.floor ? 'floor' : e.target === this.ballBody || e.body === this.ballBody ? 'ball' : 'pin';
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (other === 'floor' && kind === 'ball') { if (v > 1) hit(v * 0.5, 'ball'); return; }
    hit(v, kind === 'ball' || other === 'ball' ? 'ball' : 'pin');
  }

  step(dt) {
    // schlafende Kegel zaehlen fuer die Physik als unbeweglich: vor dem Aufprall aufwecken
    if (this.ballState === 'rolling') for (const p of this.pins) {
      if (p.active && p.body.sleepState === CANNON.Body.SLEEPING && p.body.position.distanceTo(this.ballBody.position) < 1.2) p.body.wakeUp();
    }
    this.world.step(1 / 240, Math.min(dt, 0.05), 12);   // kleine Schritte: schnelle Kugel tunnelt nicht durch Kegel
    // umgefallene Kegel ausblenden und aus der Physik nehmen
    for (const p of this.pins) if (!p.active && p.fade > 0) {
      p.fade = Math.max(0, p.fade - dt * 1.5);
      p.mesh.material.opacity = p.fade;
      if (p.fade === 0) { p.mesh.visible = false; if (p.inWorld) { this.world.removeBody(p.body); p.inWorld = false; } }
    }
    const b = this.ballBody;
    if (this.ballState === 'rolling') rolling(b.velocity.length(), b.position.y < this.floorY + BALL_R + 0.02); else rolling(0, false);
    if (this.ballState === 'rest') {            // schwebt leicht an der Rueckgabe
      this.ball.position.copy(this.ballHome); this.ball.position.y += Math.sin(performance.now() / 500) * 0.01;
      this.ball.rotation.y += dt * 0.6;
    }
    this._sync();
  }

  _sync() {
    for (const p of this.pins) { p.mesh.position.copy(p.body.position); p.mesh.quaternion.copy(p.body.quaternion); }
    if (this.ballState === 'rolling') { this.ball.position.copy(this.ballBody.position); this.ball.quaternion.copy(this.ballBody.quaternion); }
  }
}
