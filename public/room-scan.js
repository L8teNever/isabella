// Gescannter Raum (Quest-Raumeinrichtung ueber WebXR plane-/mesh-detection):
// Boden-Umriss, Waende, Moebel als Kisten (Tisch, Bett, Sofa ...). Daraus entstehen
// - unsichtbare Flaechen zum Zielen/Platzieren (Strahl trifft Boden oder Moebel-Oberseite)
// - feste Physik-Koerper (Kugel rollt auf dem Tisch, prallt an Waenden und Moebeln ab)
import * as THREE from 'three';

const SKIP_MESH = new Set(['global mesh', 'wall', 'ceiling', 'floor', 'door frame', 'window frame', 'wall art']);

export class RoomScan {
  constructor(scene) {
    this.floorY = 0;
    this.floorPoly = null;       // [[x,z]] erkannter Boden
    this.walls = [];             // [[[ax,az],[bx,bz]]]
    this.boxes = [];             // { center:Vector3, size:Vector3, yaw }  Moebel
    this.version = 0;
    this.src = new Map();
    this.group = new THREE.Group(); scene.add(this.group);
    this.hide = new THREE.MeshBasicMaterial({ visible: false });
    this.showMat = new THREE.MeshBasicMaterial({ color: 0x7ee0b0, wireframe: true, transparent: true, opacity: 0.35 });
    this.floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), this.hide);
    this.group.add(this.floorMesh);
    this.targets = [this.floorMesh];   // Strahl-Ziele zum Platzieren
    this.show = false;
  }

  setFloor(y) { this.floorY = y; this.floorMesh.position.y = y; }

  get scanned() { return this.boxes.length > 0 || this.walls.length > 0 || !!this.floorPoly; }

  // Punkt auf dem gescannten Boden? (ohne Scan: ueberall)
  onFloor(x, z) {
    const P = this.floorPoly;
    if (!P) return true;
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, zi] = P[i], [xj, zj] = P[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  update(frame, ref) {
    if (!frame) return false;
    const seen = new Set(); let dirty = false;
    const take = (o, space, fn) => {
      seen.add(o);
      const e = this.src.get(o);
      if (e && e.t === o.lastChangedTime) return;
      const pose = frame.getPose(space, ref); if (!pose) return;
      this.src.set(o, { t: o.lastChangedTime, s: fn(o, new THREE.Matrix4().fromArray(pose.transform.matrix)) });
      dirty = true;
    };
    frame.detectedPlanes?.forEach((p) => take(p, p.planeSpace, (p, m) => this._plane(p, m)));
    frame.detectedMeshes?.forEach((x) => take(x, x.meshSpace, (x, m) => this._mesh(x, m)));
    for (const k of [...this.src.keys()]) if (!seen.has(k)) { this.src.delete(k); dirty = true; }
    if (dirty) this._rebuild();
    return dirty;
  }

  _plane(p, m) {
    const label = (p.semanticLabel || '').toLowerCase();
    const pts = p.polygon.map((q) => new THREE.Vector3(q.x, q.y, q.z).applyMatrix4(m));
    if (p.orientation === 'vertical' || label === 'wall') {
      let a = pts[0], b = pts[0], best = -1;
      for (const u of pts) for (const w of pts) { const d = (u.x - w.x) ** 2 + (u.z - w.z) ** 2; if (d > best) { best = d; a = u; b = w; } }
      return { wall: [[a.x, a.z], [b.x, b.z]] };
    }
    if (label === 'floor') return { floor: pts.map((v) => [v.x, v.z]), y: pts.reduce((s, v) => s + v.y, 0) / pts.length };
    if (label === 'ceiling') return null;
    // waagrechte Moebel-Flaeche ohne Volumen: als flache Kiste bis zum Boden
    const y = pts.reduce((s, v) => s + v.y, 0) / pts.length;
    return { top: this._obb(pts.map((v) => [v.x, v.z])), y };
  }

  _mesh(x, m) {
    const label = (x.semanticLabel || '').toLowerCase();
    if (SKIP_MESH.has(label) || x.vertices.length > 3 * 3000) return null;
    const v = x.vertices, pts = [];
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < v.length; k += 3) {
      const t = new THREE.Vector3(v[k], v[k + 1], v[k + 2]).applyMatrix4(m);
      pts.push([t.x, t.z]); lo = Math.min(lo, t.y); hi = Math.max(hi, t.y);
    }
    if (hi - lo < 0.03) return null;
    return { box: { ...this._obb(pts), y0: lo, y1: hi } };
  }

  // gedrehtes Rechteck um Punkte (xz): Mitte, Laenge/Breite, Drehung
  _obb(pts) {
    const n = pts.length, cx = pts.reduce((s, p) => s + p[0], 0) / n, cz = pts.reduce((s, p) => s + p[1], 0) / n;
    let xx = 0, xz = 0, zz = 0;
    for (const [x, z] of pts) { xx += (x - cx) ** 2; xz += (x - cx) * (z - cz); zz += (z - cz) ** 2; }
    const a = 0.5 * Math.atan2(2 * xz, xx - zz), ax = [Math.cos(a), Math.sin(a)], bx = [-ax[1], ax[0]];
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const [x, z] of pts) {
      const u = (x - cx) * ax[0] + (z - cz) * ax[1], w = (x - cx) * bx[0] + (z - cz) * bx[1];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
    }
    return { cx: cx + ax[0] * (u0 + u1) / 2 + bx[0] * (w0 + w1) / 2, cz: cz + ax[1] * (u0 + u1) / 2 + bx[1] * (w0 + w1) / 2, sx: u1 - u0, sz: w1 - w0, yaw: -a };
  }

  _rebuild() {
    const all = [...this.src.values()].map((e) => e.s).filter(Boolean);
    this.walls = all.filter((s) => s.wall).map((s) => s.wall);
    const f = all.find((s) => s.floor);
    this.floorPoly = f ? f.floor : null;
    if (f) this.setFloor(Math.min(f.y, this.floorY + 0.05));
    const boxes = all.filter((s) => s.box).map((s) => s.box);
    // waagrechte Flaechen ohne passende Kiste ergaenzen (bis zum Boden)
    for (const s of all.filter((t) => t.top)) {
      if (s.y - this.floorY < 0.1 || s.y - this.floorY > 1.6) continue;
      if (boxes.some((b) => Math.hypot(b.cx - s.top.cx, b.cz - s.top.cz) < 0.3 && Math.abs(b.y1 - s.y) < 0.08)) continue;
      boxes.push({ ...s.top, y0: this.floorY, y1: s.y });
    }
    this.boxes = boxes.filter((b) => b.sx > 0.05 && b.sz > 0.05).map((b) => ({
      center: new THREE.Vector3(b.cx, (b.y0 + b.y1) / 2, b.cz), size: new THREE.Vector3(b.sx, b.y1 - b.y0, b.sz), yaw: b.yaw }));
    // Strahl-Ziele: Boden + Moebel
    for (const m of this.targets.slice(1)) { this.group.remove(m); m.geometry.dispose(); }
    this.targets = [this.floorMesh];
    for (const b of this.boxes) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z), this.show ? this.showMat : this.hide);
      m.position.copy(b.center); m.rotation.y = b.yaw; m.userData.furniture = true;
      this.group.add(m); this.targets.push(m);
    }
    this.version++;
  }

  setShow(on) { this.show = on; for (const m of this.targets.slice(1)) m.material = on ? this.showMat : this.hide; }
}
