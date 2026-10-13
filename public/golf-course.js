// Minigolf-Bahn im echten Raum: Physik (cannon-es) mit Boden, Waenden und Moebeln aus dem Scan,
// dazu frei platzierbare Elemente: Start, Loch, Rampe, Looping, Boost, Wand, Bumper, Sand.
// Element-Koordinaten: Ursprung auf der Standflaeche, +Z = Spielrichtung, y = oben.
import * as THREE from 'three';
import * as CANNON from '/vendor/cannon-es.js';
import { hit, rolling } from '/sound.js';

export const BALL_R = 0.025;
const BALL_MASS = 0.046;
const DAMP = 0.32, SAND_DAMP = 0.92;     // Rollwiderstand Teppich/Boden bzw. Sand
export const CUP_R = 0.055;

export const TYPES = {
  tee: { label: 'Start', color: 0x7ee0b0 },
  cup: { label: 'Loch', color: 0x222222 },
  ramp: { label: 'Rampe', color: 0xff7ab6 },
  loop: { label: 'Looping', color: 0x8a3cff },
  boost: { label: 'Boost', color: 0xffd23c },
  wall: { label: 'Wand', color: 0x7cc4ff },
  bumper: { label: 'Bumper', color: 0xff5470 },
  sand: { label: 'Sand', color: 0xe8cf94 },
};

const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, ...o });

// Rampe: Keil 0.5 lang, 0.3 breit, hinten 0.1 hoch
function rampShape() {
  const L = 0.5, W = 0.15, H = 0.1;
  const v = [[-W, 0, -L / 2], [W, 0, -L / 2], [W, 0, L / 2], [-W, 0, L / 2], [-W, H, L / 2], [W, H, L / 2]].map((p) => new CANNON.Vec3(...p));
  const faces = [[0, 3, 2, 1], [0, 1, 5, 4], [2, 3, 4, 5], [0, 4, 3], [1, 2, 5]].map((f) => f.reverse());   // gegen den Uhrzeigersinn von aussen
  return { shape: new CANNON.ConvexPolyhedron({ vertices: v, faces }), verts: v, faces };
}

// Looping: Bahn als Band (Innenseite), seitlich versetzt, damit Ein- und Ausfahrt nebeneinander liegen
function loopGeometry() {
  const R = 0.16, W = 0.13, SHIFT = 0.15, N = 56, pos = [], idx = [], rail = 0.03;
  const ring = (t) => { const th = t * Math.PI * 2; return [SHIFT * t, R - R * Math.cos(th), R * Math.sin(th), th]; };   // Einfahrt bei x=0, Ausfahrt bei x=SHIFT
  // Querschnitt: Lippe links, Bahn, Lippe rechts (U-Form), Normale zeigt zur Kreismitte
  for (let i = 0; i <= N; i++) {
    const [x, y, z, th] = ring(i / N), nx = 0, ny = Math.cos(th), nz = -Math.sin(th);
    for (const [dx, up] of [[-W / 2, rail], [-W / 2, 0], [W / 2, 0], [W / 2, rail]]) pos.push(x + dx, y + ny * up, z + nz * up);
  }
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) {
    const a = i * 4 + k, b = a + 1, c = a + 4, d = a + 5;
    idx.push(a, c, b, b, c, d);
  }
  // Einfahrt und Ausfahrt: flache Zungen
  return { pos, idx };
}

export class Course {
  constructor(scene, scan) {
    this.scene = scene; this.scan = scan;
    const w = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    w.broadphase = new CANNON.SAPBroadphase(w);
    w.solver.iterations = 10;
    this.mBall = new CANNON.Material('ball'); this.mGround = new CANNON.Material('ground'); this.mBump = new CANNON.Material('bump');
    w.addContactMaterial(new CANNON.ContactMaterial(this.mBall, this.mGround, { friction: 0.08, restitution: 0.35 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.mBall, this.mBump, { friction: 0.02, restitution: 0.95 }));
    this.roomBodies = [];
    this.items = [];          // { type, obj (Group), body?, hole? }
    this.group = new THREE.Group(); scene.add(this.group);

    // Kugel
    this.ballBody = new CANNON.Body({ mass: BALL_MASS, material: this.mBall, shape: new CANNON.Sphere(BALL_R), linearDamping: DAMP, angularDamping: 0.4 });
    this.ballBody.addEventListener('collide', (e) => { const v = Math.abs(e.contact.getImpactVelocityAlongNormal()); if (v > 0.6) hit(v * 0.6, 'pin'); });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), mat(0xffffff, { roughness: 0.3, emissive: 0x000000 }));
    this.ball.castShadow = true; this.ball.visible = false; scene.add(this.ball);
    this.ballIn = false;
    this.lastRest = new THREE.Vector3();
    this.syncRoom();
  }

  /* ---------- Raum ---------- */
  syncRoom() {
    for (const b of this.roomBodies) this.world.removeBody(b);
    this.roomBodies = [];
    const add = (b) => { this.world.addBody(b); this.roomBodies.push(b); };
    const floor = new CANNON.Body({ mass: 0, material: this.mGround, shape: new CANNON.Plane() });
    floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0); floor.position.y = this.scan.floorY; add(floor);
    for (const bx of this.scan.boxes) {
      const b = new CANNON.Body({ mass: 0, material: this.mGround, shape: new CANNON.Box(new CANNON.Vec3(bx.size.x / 2, bx.size.y / 2, bx.size.z / 2)) });
      b.position.set(bx.center.x, bx.center.y, bx.center.z); b.quaternion.setFromEuler(0, bx.yaw, 0); add(b);
    }
    for (const [[ax, az], [bx, bz]] of this.scan.walls) {
      const len = Math.hypot(bx - ax, bz - az);
      const b = new CANNON.Body({ mass: 0, material: this.mBump, shape: new CANNON.Box(new CANNON.Vec3(len / 2, 1.2, 0.05)) });
      b.position.set((ax + bx) / 2, this.scan.floorY + 1.2, (az + bz) / 2); b.quaternion.setFromEuler(0, -Math.atan2(bz - az, bx - ax), 0); add(b);
    }
  }

  /* ---------- Elemente ---------- */
  add(type, pos, yaw, hole) {
    const g = new THREE.Group(); g.position.copy(pos); g.rotation.y = yaw;
    g.userData = { type, hole };
    let body = null;
    const T = TYPES[type];
    if (type === 'tee') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.006, 32), mat(T.color, { transparent: true, opacity: 0.85 })); m.position.y = 0.003; g.add(m);
      g.add(label(`Start ${hole}`, 0.18));
    } else if (type === 'cup') {
      const ring = new THREE.Mesh(new THREE.RingGeometry(CUP_R, CUP_R + 0.025, 40).rotateX(-Math.PI / 2), mat(0xffffff)); ring.position.y = 0.003; g.add(ring);
      const hole_ = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x050505 })); hole_.position.y = 0.002; g.add(hole_);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.55, 8), mat(0xeeeeee)); pole.position.set(0, 0.275, 0); g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.09), mat(0xff7ab6, { side: THREE.DoubleSide })); flag.position.set(0.07, 0.5, 0); g.add(flag);
      g.add(label(`Loch ${hole}`, 0.62));
    } else if (type === 'ramp') {
      const { shape, verts, faces } = rampShape();
      const geo = new THREE.BufferGeometry(), p = [];
      for (const f of faces) for (let k = 1; k < f.length - 1; k++) for (const i of [f[0], f[k], f[k + 1]]) p.push(verts[i].x, verts[i].y, verts[i].z);
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat(T.color, { side: THREE.DoubleSide })); m.castShadow = true; g.add(m);
      body = new CANNON.Body({ mass: 0, material: this.mGround }); body.addShape(shape);
    } else if (type === 'loop') {
      const { pos: P, idx } = loopGeometry();
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setIndex(idx); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat(T.color, { side: THREE.DoubleSide, transparent: true, opacity: 0.9 })); m.castShadow = true; g.add(m);
      body = new CANNON.Body({ mass: 0, material: this.mGround });
      body.addShape(new CANNON.Trimesh(P, idx));
    } else if (type === 'boost') {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.006, 0.3), mat(T.color, { emissive: 0x332200 })); m.position.y = 0.003; g.add(m);
      for (let k = 0; k < 3; k++) {
        const a = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.06, 3).rotateX(Math.PI / 2), mat(0xff7a00)); a.position.set(0, 0.012, -0.08 + k * 0.08); a.scale.y = 0.3; g.add(a);
      }
    } else if (type === 'wall') {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.04), mat(T.color)); m.position.y = 0.04; m.castShadow = true; g.add(m);
      body = new CANNON.Body({ mass: 0, material: this.mBump, shape: new CANNON.Box(new CANNON.Vec3(0.25, 0.04, 0.02)) });
      body.shapeOffsets[0].set(0, 0.04, 0);
    } else if (type === 'bumper') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 24), mat(T.color, { emissive: 0x330010 })); m.position.y = 0.04; m.castShadow = true; g.add(m);
      body = new CANNON.Body({ mass: 0, material: this.mBump, shape: new CANNON.Cylinder(0.06, 0.06, 0.08, 16) });
      body.shapeOffsets[0].set(0, 0.04, 0);
    } else if (type === 'sand') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.006, 40), mat(T.color, { roughness: 1 })); m.position.y = 0.003; m.scale.z = 0.8; g.add(m);
    }
    g.traverse((o) => { if (o.isMesh) o.userData.item = g; });
    this.group.add(g);
    const it = { type, obj: g, body, hole };
    if (body) { body.updateBoundingRadius?.(); this.world.addBody(body); }
    this.items.push(it);
    this._place(it);
    return it;
  }

  _place(it) {
    if (!it.body) return;
    it.body.position.set(it.obj.position.x, it.obj.position.y, it.obj.position.z);
    it.body.quaternion.setFromEuler(0, it.obj.rotation.y, 0);
    it.body.aabbNeedsUpdate = true;
  }

  move(it, pos, yaw) { it.obj.position.copy(pos); if (yaw !== undefined) it.obj.rotation.y = yaw; this._place(it); }

  remove(it) {
    this.group.remove(it.obj);
    it.obj.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
    if (it.body) this.world.removeBody(it.body);
    this.items = this.items.filter((x) => x !== it);
  }

  clear() { [...this.items].forEach((it) => this.remove(it)); }

  // Loecher: [{ n, tee, cup }] nur vollstaendige, nach Nummer
  holes() {
    const m = new Map();
    for (const it of this.items) if (it.type === 'tee' || it.type === 'cup') {
      const h = m.get(it.hole) || { n: it.hole }; h[it.type] = it; m.set(it.hole, h);
    }
    return [...m.values()].filter((h) => h.tee && h.cup).sort((a, b) => a.n - b.n);
  }

  nextHoleNumber(type) {
    // Start ohne Loch bzw. Loch ohne Start zuerst auffuellen
    const m = new Map();
    for (const it of this.items) if (it.type === 'tee' || it.type === 'cup') { const h = m.get(it.hole) || {}; h[it.type] = 1; m.set(it.hole, h); }
    for (const [n, h] of [...m].sort((a, b) => a[0] - b[0])) if (!h[type]) return n;
    return (Math.max(0, ...m.keys())) + 1;
  }

  /* ---------- Kugel ---------- */
  ballTo(p) {
    const b = this.ballBody;
    if (!this.ballIn) { this.world.addBody(b); this.ballIn = true; }
    b.position.set(p.x, p.y + BALL_R + 0.003, p.z);
    b.velocity.setZero(); b.angularVelocity.setZero(); b.wakeUp();
    this.ball.visible = true; this.ball.scale.setScalar(1);
    this.lastRest.copy(p); this.sunk = false; this.sinkT = 0;
    this._sync();
  }

  hideBall() { if (this.ballIn) { this.world.removeBody(this.ballBody); this.ballIn = false; } this.ball.visible = false; }

  shoot(v) {
    const b = this.ballBody;
    b.velocity.set(v.x, Math.max(0, v.y) * 0.3, v.z);
    b.angularVelocity.setZero(); b.wakeUp();
  }

  get speed() { return this.ballBody.velocity.length(); }
  get resting() { return this.ballIn && !this.sunk && this.speed < 0.04; }

  // pro Frame; gibt Ereignisse zurueck: 'sunk' | 'out' | null
  step(dt, cup) {
    if (!this.ballIn) return null;
    const b = this.ballBody, p = b.position;
    // Zonen: Sand bremst, Boost schiesst an
    let damp = DAMP;
    for (const it of this.items) {
      if (it.type !== 'sand' && it.type !== 'boost') continue;
      const l = it.obj.worldToLocal(new THREE.Vector3(p.x, p.y, p.z));
      if (Math.abs(l.y) > 0.05) continue;
      if (it.type === 'sand' && (l.x / 0.25) ** 2 + (l.z / 0.2) ** 2 < 1) damp = SAND_DAMP;
      if (it.type === 'boost' && Math.abs(l.x) < 0.1 && Math.abs(l.z) < 0.15) {
        const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(it.obj.quaternion);
        const along = b.velocity.x * dir.x + b.velocity.z * dir.z;
        if (along < 4) { b.velocity.x += dir.x * (4 - along); b.velocity.z += dir.z * (4 - along); hit(2, 'ball'); }
      }
    }
    b.linearDamping = damp;
    this.world.step(1 / 240, Math.min(dt, 0.05), 12);
    rolling(this.speed, true);
    this._sync();
    // Loch: nah an der Mitte, auf Hoehe, nicht zu schnell
    if (cup && !this.sunk) {
      const c = cup.obj.position, d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d < CUP_R - BALL_R * 0.3 && Math.abs(p.y - BALL_R - c.y) < 0.03 && this.speed < 1.6) { this.sunk = true; this.sinkT = 0; return 'sunk'; }
      if (d < CUP_R * 1.6 && this.speed < 1.6) {     // Rand zieht die Kugel leicht hinein
        b.velocity.x += (c.x - p.x) * 3 * dt; b.velocity.z += (c.z - p.z) * 3 * dt;
      }
    }
    if (this.sunk) {
      this.sinkT += dt;
      b.velocity.setZero(); const c = cup.obj.position; b.position.set(c.x, c.y + BALL_R - this.sinkT * 0.2, c.z);
      this.ball.scale.setScalar(Math.max(0.01, 1 - this.sinkT * 2));
      return null;
    }
    // Aus: runtergefallen, ausserhalb des gescannten Bodens oder viel zu weit weg
    const fell = p.y < this.scan.floorY - 0.3;
    const offFloor = p.y < this.scan.floorY + 0.05 && !this.scan.onFloor(p.x, p.z);
    if (fell || offFloor || p.distanceTo(new CANNON.Vec3(this.lastRest.x, this.lastRest.y, this.lastRest.z)) > 12) return 'out';
    return null;
  }

  _sync() { this.ball.position.copy(this.ballBody.position); this.ball.quaternion.copy(this.ballBody.quaternion); }

  /* ---------- Speichern ---------- */
  toJSON(inv) {
    return this.items.map((it) => {
      const m = new THREE.Matrix4().compose(it.obj.position, it.obj.quaternion, new THREE.Vector3(1, 1, 1)).premultiply(inv);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(); m.decompose(p, q, new THREE.Vector3());
      return { t: it.type, p: p.toArray().map((v) => +v.toFixed(4)), y: +new THREE.Euler().setFromQuaternion(q, 'YXZ').y.toFixed(4), h: it.hole };
    });
  }

  fromJSON(list, M) {
    this.clear();
    for (const o of list || []) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(o.p), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, o.y, 0)), new THREE.Vector3(1, 1, 1)).premultiply(M);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(); m.decompose(p, q, new THREE.Vector3());
      if (TYPES[o.t]) this.add(o.t, p, new THREE.Euler().setFromQuaternion(q, 'YXZ').y, o.h);
    }
  }
}

// kleines Schild ueber Start/Loch
function label(text, y) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(24,18,34,0.85)'; x.beginPath(); x.roundRect ? x.roundRect(0, 0, 256, 64, 24) : x.rect(0, 0, 256, 64); x.fill();
  x.fillStyle = '#fbe9f2'; x.font = '700 34px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 128, 33);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  s.scale.set(0.16, 0.04, 1); s.position.y = y; s.renderOrder = 8;
  return s;
}
