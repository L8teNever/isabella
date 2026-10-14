// Sichtbare Raum-Kanten: ein paar Zentimeter hohe, leuchtende Barriere unten an Waenden und Moebeln
// (dort prallt die Kugel ab) und eine rote Linie am Rand des gescannten Bodens (dahinter ist "aus").
import * as THREE from 'three';

function gradTex() {
  const c = document.createElement('canvas'); c.width = 4; c.height = 64; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 64, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 4, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class RoomEdges {
  constructor(scene, { height = 0.06 } = {}) {
    this.group = new THREE.Group(); scene.add(this.group);
    this.h = height;
    const map = gradTex();
    const m = (color) => new THREE.MeshBasicMaterial({ color, map, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    this.wallMat = m(0x5fe0ff);
    this.edgeMat = new THREE.MeshBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: 0.8, depthWrite: false });
    this.lineMat = new THREE.MeshBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.9, depthWrite: false });
    this.version = -1;
  }

  // Streifen zwischen zwei Bodenpunkten, leicht in den Raum versetzt (n = Richtung in den Raum)
  _strip(ax, az, bx, bz, y, h, mat) {
    const len = Math.hypot(bx - ax, bz - az); if (len < 0.05) return;
    const s = new THREE.Mesh(new THREE.PlaneGeometry(len, h), mat);
    s.position.set((ax + bx) / 2, y + h / 2, (az + bz) / 2);
    s.rotation.y = -Math.atan2(bz - az, bx - ax);
    s.renderOrder = 3; this.group.add(s);
    // kraeftige Linie am Fuss
    const l = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.006), this.lineMat);
    l.position.set(s.position.x, y + 0.003, s.position.z); l.rotation.y = s.rotation.y; l.renderOrder = 4; this.group.add(l);
  }

  build(scan) {
    if (scan.version === this.version) return;
    this.version = scan.version;
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry.dispose(); }
    const y = scan.floorY + 0.002, h = this.h;
    // Waende
    for (const [[ax, az], [bx, bz]] of scan.walls) this._strip(ax, az, bx, bz, y, h, this.wallMat);
    // Moebel: rundherum am Fuss, und an der Oberkante (dort faellt die Kugel runter)
    for (const b of scan.boxes) {
      const c = Math.cos(b.yaw), sn = Math.sin(b.yaw), hx = b.size.x / 2, hz = b.size.z / 2;
      const P = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([u, w]) => [b.center.x + u * c + w * sn, b.center.z - u * sn + w * c]);
      const y0 = b.center.y - b.size.y / 2, y1 = b.center.y + b.size.y / 2;
      for (let i = 0; i < 4; i++) {
        const [ax, az] = P[i], [bx, bz] = P[(i + 1) % 4];
        if (y0 < scan.floorY + 0.3) this._strip(ax, az, bx, bz, Math.max(y, y0), h, this.wallMat);
        if (y1 - scan.floorY > 0.15) this._strip(ax, az, bx, bz, y1 + 0.002, h * 0.5, this.wallMat);
      }
    }
    // Rand des gescannten Bodens (dahinter: aus)
    const F = scan.floorPoly;
    const nearWall = (x, z) => scan.walls.some(([[ax, az], [bx, bz]]) => {
      const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)) : 0;
      return Math.hypot(x - ax - vx * t, z - az - vz * t) < 0.15;
    });
    if (F) for (let i = 0; i < F.length; i++) {
      const [ax, az] = F[i], [bx, bz] = F[(i + 1) % F.length];
      if (nearWall(ax, az) && nearWall(bx, bz) && nearWall((ax + bx) / 2, (az + bz) / 2)) continue;   // dort steht schon eine Wand
      const len = Math.hypot(bx - ax, bz - az); if (len < 0.05) continue;
      const l = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.015).rotateX(-Math.PI / 2), this.edgeMat);
      l.position.set((ax + bx) / 2, y + 0.001, (az + bz) / 2); l.rotation.y = -Math.atan2(bz - az, bx - ax);
      this.group.add(l);
    }
  }

  // sanftes Pulsieren
  update() {
    const k = 0.75 + 0.25 * Math.sin(performance.now() / 600);
    this.wallMat.opacity = k; this.lineMat.opacity = 0.6 + 0.35 * k; this.edgeMat.opacity = 0.5 + 0.3 * k;
  }

  set visible(v) { this.group.visible = v; }
  get visible() { return this.group.visible; }
}
