// Minigolf-Bahn im echten Raum: Physik (cannon-es) mit Boden, Waenden und Moebeln aus dem Scan,
// dazu frei platzierbare Elemente: Start, Loch, Rampe, Looping, Boost, Wand, Bumper, Sand.
// Element-Koordinaten: Ursprung auf der Standflaeche, +Z = Spielrichtung, y = oben.
import * as THREE from 'three';
import * as CANNON from '/vendor/cannon-es.js';
import { hit, rolling } from '/sound.js';

export const BALL_R = 0.025;
const BALL_MASS = 0.046;
// Rollwiderstand wie auf Minigolf-Kunstrasen: gleichmaessige Bremsung (m/s²) statt exponentieller Daempfung
const ROLL = 0.55, SAND_ROLL = 4.5, AIR_DAMP = 0.02;
export const CUP_R = 0.055;

export const TYPES = {
  tee: { label: 'Start', color: 0x7ee0b0 },
  cup: { label: 'Loch', color: 0x222222 },
  ramp: { label: 'Rampe', color: 0xff7ab6 },
  loop: { label: 'Looping', color: 0x8a3cff },
  boost: { label: 'Boost', color: 0xffd23c },
  wall: { label: 'Wand', color: 0x7cc4ff },
  bumper: { label: 'Bumper', color: 0xff5470 },
  sand: { label: 'Sand', color: 0xe8cf94, zone: true },
  water: { label: 'Wasser', color: 0x3aa0ff, zone: true },
  hill: { label: 'Hügel', color: 0x55c46a },
  spinner: { label: 'Drehkreuz', color: 0xffa94d },
  tunnel: { label: 'Tunnel', color: 0xb98cff },
};
export const ZONES = ['sand', 'water'];

const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, ...o });

function noiseTex(base, dots, n = 900, alpha = 0.35) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  x.fillStyle = base; x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < n; i++) { x.fillStyle = dots[i % dots.length]; x.globalAlpha = Math.random() * alpha; x.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4); t.colorSpace = THREE.SRGBColorSpace; return t;
}
let SAND_TEX = null, WATER_TEX = null, STRIPE_TEX = null;
function stripeTex() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
  x.fillStyle = '#ff7ab6'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#ffffff'; x.globalAlpha = 0.55;
  for (let i = -64; i < 128; i += 22) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 10, 0); x.lineTo(i + 74, 64); x.lineTo(i + 64, 64); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Rampe: Keil (Laenge L, halbe Breite W, Hoehe H)
function rampShape(L, W, H) {
  const v = [[-W, 0, -L / 2], [W, 0, -L / 2], [W, 0, L / 2], [-W, 0, L / 2], [-W, H, L / 2], [W, H, L / 2]].map((p) => new CANNON.Vec3(...p));
  const faces = [[0, 3, 2, 1], [0, 1, 5, 4], [2, 3, 4, 5], [0, 4, 3], [1, 2, 5]].map((f) => f.reverse());   // gegen den Uhrzeigersinn von aussen
  return { shape: new CANNON.ConvexPolyhedron({ vertices: v, faces }), verts: v, faces };
}

// Looping: Bahn als Band (Innenseite), seitlich versetzt, damit Ein- und Ausfahrt nebeneinander liegen
function loopGeometry(k = 1) {
  const R = 0.16 * k, W = 0.13 * Math.max(0.8, k), SHIFT = 0.15 * Math.max(0.8, k), N = 56, pos = [], idx = [], rail = 0.03;
  const ring = (t) => { const th = t * Math.PI * 2; return [SHIFT * t, R - R * Math.cos(th), R * Math.sin(th), th]; };   // Einfahrt bei x=0, Ausfahrt bei x=SHIFT
  for (let i = 0; i <= N; i++) {
    const [x, y, z, th] = ring(i / N), ny = Math.cos(th), nz = -Math.sin(th);
    for (const [dx, up] of [[-W / 2, rail], [-W / 2, 0], [W / 2, 0], [W / 2, rail]]) pos.push(x + dx, y + ny * up, z + nz * up);
  }
  for (let i = 0; i < N; i++) for (let q = 0; q < 3; q++) {
    const a = i * 4 + q, b = a + 1, c = a + 4, d = a + 5;
    idx.push(a, c, b, b, c, d);
  }
  return { pos, idx };
}

// Punkt in Polygon [[x,z]]
export function inPoly(P, x, z) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i], [xj, zj] = P[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// Standard-Form einer Zone (Ellipse), wenn nichts gezeichnet wurde
function ellipse(rx, rz, n = 28) { return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * rx, Math.sin(a) * rz]; }); }

export class Course {
  constructor(scene, scan) {
    this.scene = scene; this.scan = scan;
    const w = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    w.broadphase = new CANNON.SAPBroadphase(w);
    w.solver.iterations = 10;
    this.mBall = new CANNON.Material('ball'); this.mGround = new CANNON.Material('ground'); this.mBump = new CANNON.Material('bump');
    w.addContactMaterial(new CANNON.ContactMaterial(this.mBall, this.mGround, { friction: 0.08, restitution: 0.35 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.mBall, this.mBump, { friction: 0.02, restitution: 0.9 }));
    this.mBank = new CANNON.Material('bank');     // Banden/Waende: wie Gummi-Bande, verliert etwas Tempo
    w.addContactMaterial(new CANNON.ContactMaterial(this.mBall, this.mBank, { friction: 0.05, restitution: 0.68 }));
    // Rollbremse in jedem Physik-Schritt (nur wenn die Kugel am Boden rollt)
    this.decel = ROLL;
    w.addEventListener('preStep', () => {
      const b = this.ballBody; if (!this.ballIn) return;
      const v = b.velocity, h = Math.hypot(v.x, v.z), a = this.decel * w.dt;
      if (Math.abs(v.y) > 0.25) return;                  // in der Luft / steil auf der Rampe
      if (h <= a) { v.x = 0; v.z = 0; if (Math.abs(v.y) < 0.05) { b.angularVelocity.scale(0.9, b.angularVelocity); } return; }
      v.x -= (v.x / h) * a; v.z -= (v.z / h) * a;
    });
    this.roomBodies = [];
    this.items = [];          // { type, obj (Group), body?, hole? }
    this.group = new THREE.Group(); scene.add(this.group);

    // Kugel
    this.ballBody = new CANNON.Body({ mass: BALL_MASS, material: this.mBall, shape: new CANNON.Sphere(BALL_R), linearDamping: AIR_DAMP, angularDamping: 0.3 });
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
      const b = new CANNON.Body({ mass: 0, material: this.mBank, shape: new CANNON.Box(new CANNON.Vec3(len / 2, 1.2, 0.05)) });
      b.position.set((ax + bx) / 2, this.scan.floorY + 1.2, (az + bz) / 2); b.quaternion.setFromEuler(0, -Math.atan2(bz - az, bx - ax), 0); add(b);
    }
  }

  /* ---------- Elemente ---------- */
  // opts: { s: [breit, hoch, lang] (Faktoren), shape: [[x,z]] lokale Zonen-Form (Sand/Wasser) }
  add(type, pos, yaw, hole, opts = {}) {
    const g = new THREE.Group(); g.position.copy(pos); g.rotation.y = yaw;
    g.userData = { type, hole };
    const sc = (opts.s || [1, 1, 1]).map((v) => Math.min(4, Math.max(0.3, v)));
    const [sx, sy, sz] = sc;
    let body = null; const extra = {};
    const T = TYPES[type];
    if (type === 'tee') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.006, 32), mat(T.color, { transparent: true, opacity: 0.85 })); m.position.y = 0.003; g.add(m);
      const mk = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.03, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff })); mk.position.y = 0.007; g.add(mk);
      g.add(label(`Start ${hole}`, 0.18));
    } else if (type === 'cup') {
      const ring = new THREE.Mesh(new THREE.RingGeometry(CUP_R, CUP_R + 0.025, 40).rotateX(-Math.PI / 2), mat(0xffffff)); ring.position.y = 0.003; g.add(ring);
      const green = new THREE.Mesh(new THREE.RingGeometry(CUP_R + 0.025, 0.22, 48).rotateX(-Math.PI / 2), mat(0x3fa45a, { transparent: true, opacity: 0.55, roughness: 1 })); green.position.y = 0.002; g.add(green);
      const hole_ = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x050505 })); hole_.position.y = 0.0025; g.add(hole_);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.55, 8), mat(0xeeeeee)); pole.position.set(0, 0.275, 0); g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.09), mat(0xff7ab6, { side: THREE.DoubleSide })); flag.position.set(0.07, 0.5, 0); g.add(flag);
      extra.flag = flag;
      g.add(label(`Loch ${hole}`, 0.62));
    } else if (type === 'ramp') {
      const L = 0.5 * sz, W = 0.15 * sx, H = 0.1 * sy;
      const { shape, verts, faces } = rampShape(L, W, H);
      const geo = new THREE.BufferGeometry(), p = [], uv = [];
      for (const f of faces) for (let k = 1; k < f.length - 1; k++) for (const i of [f[0], f[k], f[k + 1]]) { p.push(verts[i].x, verts[i].y, verts[i].z); uv.push(verts[i].x * 6, verts[i].z * 6); }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals();
      STRIPE_TEX ??= stripeTex();
      const m = new THREE.Mesh(geo, mat(0xffffff, { map: STRIPE_TEX, side: THREE.DoubleSide })); m.castShadow = true; g.add(m);
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x5a1838 })));
      body = new CANNON.Body({ mass: 0, material: this.mGround }); body.addShape(shape);
    } else if (type === 'loop') {
      const { pos: P, idx } = loopGeometry(sx);
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setIndex(idx); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat(T.color, { side: THREE.DoubleSide, transparent: true, opacity: 0.9, metalness: 0.2 })); m.castShadow = true; g.add(m);
      body = new CANNON.Body({ mass: 0, material: this.mGround });
      body.addShape(new CANNON.Trimesh(P, idx));
    } else if (type === 'boost') {
      const w = 0.2 * sx, l = 0.3 * sz;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.006, l), mat(0x2a2236)); m.position.y = 0.003; g.add(m);
      extra.arrows = [];
      for (let k = 0; k < 3; k++) {
        const a = new THREE.Mesh(new THREE.ConeGeometry(0.045 * sx, 0.07, 3).rotateX(Math.PI / 2), mat(T.color, { emissive: 0xff7a00, emissiveIntensity: 0.5 }));
        a.position.set(0, 0.01, (-0.33 + k * 0.33) * l); a.scale.y = 0.25; g.add(a); extra.arrows.push(a);
      }
      extra.half = [w / 2, l / 2];
    } else if (type === 'wall') {
      const L = 0.5 * sx, H = 0.08 * sy;
      const m = new THREE.Mesh(new THREE.BoxGeometry(L, H, 0.04), mat(T.color)); m.position.y = H / 2; m.castShadow = true; g.add(m);
      for (const e of [-1, 1]) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, H + 0.01, 16), mat(0xffffff)); c.position.set(e * L / 2, (H + 0.01) / 2, 0); g.add(c); }
      body = new CANNON.Body({ mass: 0, material: this.mBank, shape: new CANNON.Box(new CANNON.Vec3(L / 2, H / 2, 0.02)) });
      body.shapeOffsets[0].set(0, H / 2, 0);
    } else if (type === 'bumper') {
      const r = 0.06 * sx, h = 0.08 * sy;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 28), mat(T.color, { emissive: 0x330010 })); m.position.y = h / 2; m.castShadow = true; g.add(m);
      const top = new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, 0.008, 8, 28).rotateX(Math.PI / 2), mat(0xffffff, { emissive: 0xff5470, emissiveIntensity: 0.6 })); top.position.y = h + 0.002; g.add(top);
      extra.glow = top;
      body = new CANNON.Body({ mass: 0, material: this.mBump, shape: new CANNON.Cylinder(r, r, h, 16) });
      body.shapeOffsets[0].set(0, h / 2, 0);
    } else if (type === 'sand' || type === 'water') {
      const base = opts.shape?.length >= 3 ? opts.shape : type === 'sand' ? ellipse(0.25, 0.2) : ellipse(0.3, 0.22);
      const P = base.map(([x, z]) => [x * sx, z * sz]);
      const sh = new THREE.Shape(P.map(([x, z]) => new THREE.Vector2(x, -z)));
      const geo = new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2);
      let m;
      if (type === 'sand') { SAND_TEX ??= noiseTex('#e8cf94', ['#b8935a', '#fff1cc', '#a0784a']); m = new THREE.Mesh(geo, mat(0xffffff, { map: SAND_TEX, roughness: 1 })); }
      else { WATER_TEX ??= noiseTex('#2f86d6', ['#9ed4ff', '#1b5fa8'], 500, 0.5); m = new THREE.Mesh(geo, mat(0xffffff, { map: WATER_TEX, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.85 })); extra.water = WATER_TEX; }
      m.position.y = type === 'water' ? 0.004 : 0.003; m.receiveShadow = true; g.add(m);
      const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(P.map(([x, z]) => new THREE.Vector3(x, 0.005, z))), new THREE.LineBasicMaterial({ color: type === 'sand' ? 0x9b7a48 : 0xd8f0ff }));
      g.add(edge);
      extra.poly = P; extra.shape = base;
    } else if (type === 'hill') {
      const r = 0.3 * sx, h = 0.06 * sy, R = (r * r + h * h) / (2 * h), th = Math.asin(Math.min(1, r / R));
      const m = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 16, 0, Math.PI * 2, 0, th), mat(T.color, { roughness: 0.9 }));
      m.position.y = h - R; m.receiveShadow = true; m.castShadow = true; g.add(m);
      body = new CANNON.Body({ mass: 0, material: this.mGround, shape: new CANNON.Sphere(R) });
      body.shapeOffsets[0].set(0, h - R, 0);
    } else if (type === 'spinner') {
      const L = 0.42 * sx, h = 0.05;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.12, 16), mat(0xffffff)); post.position.y = 0.06; g.add(post);
      const blades = new THREE.Group(); blades.position.y = 0;
      for (const a of [0, Math.PI / 2]) { const b = new THREE.Mesh(new THREE.BoxGeometry(L, h, 0.025), mat(T.color, { emissive: 0x331800 })); b.rotation.y = a; b.position.y = h / 2 + 0.004; b.castShadow = true; blades.add(b); }
      g.add(blades); extra.blades = blades; extra.angle = 0; extra.w = 1.4;
      body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.mBank });
      for (const a of [0, Math.PI / 2]) { const q = new CANNON.Quaternion(); q.setFromEuler(0, a, 0); body.addShape(new CANNON.Box(new CANNON.Vec3(L / 2, h / 2, 0.0125)), new CANNON.Vec3(0, h / 2 + 0.004, 0), q); }
    } else if (type === 'tunnel') {
      const L = 0.45 * sz, gap = 0.13 * sx, H = 0.09 * sy, t = 0.02;
      const m = mat(T.color, { transparent: true, opacity: 0.92 });
      for (const e of [-1, 1]) { const w = new THREE.Mesh(new THREE.BoxGeometry(t, H, L), m); w.position.set(e * (gap / 2 + t / 2), H / 2, 0); w.castShadow = true; g.add(w); }
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(gap / 2 + t, gap / 2 + t, L, 24, 1, true, Math.PI / 2, Math.PI).rotateX(Math.PI / 2), mat(T.color, { side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
      roof.position.y = H; g.add(roof);
      body = new CANNON.Body({ mass: 0, material: this.mBank });
      for (const e of [-1, 1]) body.addShape(new CANNON.Box(new CANNON.Vec3(t / 2, H / 2, L / 2)), new CANNON.Vec3(e * (gap / 2 + t / 2), H / 2, 0));
      body.addShape(new CANNON.Box(new CANNON.Vec3(gap / 2 + t, 0.01, L / 2)), new CANNON.Vec3(0, H + 0.02, 0));
    }
    g.traverse((o) => { if (o.isMesh || o.isLine) o.userData.item = g; });
    this.group.add(g);
    const it = { type, obj: g, body, hole, s: sc, ...extra };
    if (body) { body.updateBoundingRadius?.(); this.world.addBody(body); }
    this.items.push(it);
    this._place(it);
    return it;
  }

  // Element mit neuer Groesse neu bauen (gleiche Stelle, gleiche Drehung)
  resize(it, s) {
    const n = this.add(it.type, it.obj.position.clone(), it.obj.rotation.y, it.hole, { s, shape: it.shape });
    this.remove(it);
    return n;
  }

  _place(it) {
    if (!it.body) return;
    it.body.position.set(it.obj.position.x, it.obj.position.y, it.obj.position.z);
    it.body.quaternion.setFromEuler(0, it.obj.rotation.y + (it.angle || 0), 0);
    it.body.aabbNeedsUpdate = true;
  }

  move(it, pos, yaw) { it.obj.position.copy(pos); if (yaw !== undefined) it.obj.rotation.y = yaw; this._place(it); }

  remove(it) {
    this.group.remove(it.obj);
    it.obj.traverse((o) => { if (o.isMesh || o.isLine || o.isSprite) { o.geometry?.dispose(); if (o.isSprite) o.material.map?.dispose(); o.material.dispose(); } });
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

  // Bewegte Teile (Drehkreuz, Boost-Pfeile, Wasser, Fahne) – jedes Bild, auch ohne Kugel
  animate(dt) {
    const t = performance.now() / 1000;
    for (const it of this.items) {
      if (it.blades) { it.angle = (it.angle + it.w * dt) % (Math.PI * 2); it.blades.rotation.y = it.angle; this._place(it); it.body.angularVelocity.set(0, it.w, 0); }
      if (it.arrows) it.arrows.forEach((a, k) => { a.material.emissiveIntensity = 0.3 + 0.7 * Math.max(0, Math.sin(t * 6 - k * 1.2)); });
      if (it.flag) it.flag.rotation.y = Math.sin(t * 2) * 0.25;
      if (it.glow) it.glow.material.emissiveIntensity = 0.4 + 0.3 * Math.sin(t * 3);
    }
    if (WATER_TEX) WATER_TEX.offset.set(Math.sin(t * 0.4) * 0.05, t * 0.03);
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
    // Putter: Kugel rutscht kurz und rollt dann – etwas Vorwaertsdrall von Anfang an
    b.angularVelocity.set(v.z / BALL_R * 0.5, 0, -v.x / BALL_R * 0.5); b.wakeUp();
  }

  get speed() { return this.ballBody.velocity.length(); }
  get resting() { return this.ballIn && !this.sunk && this.speed < 0.03; }

  // ganzen Kurs verschieben (Raum-Anker hat sich bewegt, z. B. Brille ab- und wieder aufgesetzt)
  transform(d, yaw) {
    for (const it of this.items) { it.obj.position.applyMatrix4(d); it.obj.rotation.y += yaw; this._place(it); }
    const b = this.ballBody, p = new THREE.Vector3(b.position.x, b.position.y, b.position.z).applyMatrix4(d);
    b.position.set(p.x, p.y, p.z);
    const v = new THREE.Vector3(b.velocity.x, b.velocity.y, b.velocity.z).transformDirection(d).multiplyScalar(b.velocity.length());
    b.velocity.set(v.x, v.y, v.z);
    this.lastRest.applyMatrix4(d); this._sync();
  }

  // pro Frame; gibt Ereignisse zurueck: 'sunk' | 'out' | null
  step(dt, cup) {
    if (!this.ballIn) return null;
    const b = this.ballBody, p = b.position;
    // Zonen: Sand bremst, Wasser = Aus, Boost schiesst an
    let roll = ROLL, wet = false;
    for (const it of this.items) {
      if (!it.poly && !it.half) continue;
      const l = it.obj.worldToLocal(new THREE.Vector3(p.x, p.y, p.z));
      if (Math.abs(l.y) > 0.05) continue;
      if (it.poly && inPoly(it.poly, l.x, l.z)) { if (it.type === 'sand') roll = SAND_ROLL; else wet = true; }
      if (it.half && Math.abs(l.x) < it.half[0] && Math.abs(l.z) < it.half[1]) {
        const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(it.obj.quaternion);
        const along = b.velocity.x * dir.x + b.velocity.z * dir.z;
        if (along < 4) { b.velocity.x += dir.x * (4 - along); b.velocity.z += dir.z * (4 - along); hit(2, 'ball'); }
      }
    }
    if (wet && !this.sunk) return 'water';
    this.decel = roll;
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
      const o = { t: it.type, p: p.toArray().map((v) => +v.toFixed(4)), y: +new THREE.Euler().setFromQuaternion(q, 'YXZ').y.toFixed(4), h: it.hole };
      if (it.s.some((v) => v !== 1)) o.s = it.s.map((v) => +v.toFixed(3));
      if (it.shape) o.f = it.shape.map(([x, z]) => [+x.toFixed(3), +z.toFixed(3)]);
      return o;
    });
  }

  fromJSON(list, M) {
    this.clear();
    for (const o of list || []) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(o.p), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, o.y, 0)), new THREE.Vector3(1, 1, 1)).premultiply(M);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(); m.decompose(p, q, new THREE.Vector3());
      if (TYPES[o.t]) this.add(o.t, p, new THREE.Euler().setFromQuaternion(q, 'YXZ').y, o.h, { s: o.s, shape: o.f });
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
