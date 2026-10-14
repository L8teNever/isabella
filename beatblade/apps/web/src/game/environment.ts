// Umgebung und Lichtshow.
// VR: Neon-Laufsteg, Laser, Ringe, Nebel – reagieren auf Licht-Events (Flash, Farbe, Laser, Burst).
// MR: keine Umgebung, nur dezente Bodenmarkierung und Akzentlicht (echter Raum bleibt sichtbar).
import * as THREE from 'three';
import type { LightEvent } from '@beatblade/core';
import { settings } from '../settings';

/** Paletten je Abschnitt (Index aus SECTION_PALETTE): [Hauptfarbe, Zweitfarbe] */
const PALETTE: [number, number][] = [
  [0x7a4dff, 0x3db8ff],   // intro/outro
  [0x2f7bff, 0x30e3c8],   // strophe
  [0xffb347, 0xff3d6e],   // build-up
  [0xff2a7a, 0x3db8ff],   // drop
  [0x31d39b, 0x7a4dff],   // breakdown
];

export class Environment {
  group = new THREE.Group();
  private strips: THREE.MeshBasicMaterial[] = [];
  private lasers: THREE.Group[] = [];
  private laserMats: THREE.MeshBasicMaterial[] = [];
  private rings: THREE.Mesh[] = [];
  private ringMat: THREE.MeshBasicMaterial;
  private floorMat: THREE.MeshBasicMaterial;
  private flash = 0; private burst = 0; private off = 0;
  private laserSpeed = 0.3; private laserAngle = 0;
  private colA = new THREE.Color(PALETTE[0][0]); private colB = new THREE.Color(PALETTE[0][1]);
  private target = [new THREE.Color(PALETTE[0][0]), new THREE.Color(PALETTE[0][1])];
  private evIdx = 0;
  /** Combo-Effekt 0..1: mehr Helligkeit und Tempo der Lichtshow */
  boost = 0;
  hemi: THREE.HemisphereLight;

  constructor(scene: THREE.Scene, public mr: boolean) {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x404060, mr ? 2.2 : 1.6);
    scene.add(this.hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.2); dir.position.set(0.5, 2, 1.5); scene.add(dir);
    this.floorMat = new THREE.MeshBasicMaterial({ color: 0x7a4dff, transparent: true, opacity: mr ? 0.25 : 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x7a4dff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    if (mr) {
      // nur Bodenring um den Spieler und zwei Fuehrungslinien
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.45, 48).rotateX(-Math.PI / 2), this.floorMat); ring.position.y = 0.005;
      this.group.add(ring);
      for (const x of [-1.15, 1.15]) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 6).rotateX(-Math.PI / 2), this.floorMat);
        line.position.set(x, 0.006, -3.5); this.group.add(line);
      }
    } else {
      scene.background = new THREE.Color(0x05040a);
      scene.fog = new THREE.Fog(0x05040a, 12, 70);
      // Boden + Laufsteg
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 120).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x07060d }));
      floor.position.z = -40; this.group.add(floor);
      const run = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x100d1c }));
      run.position.set(0, 0.002, -48); this.group.add(run);
      for (const x of [-1.3, 1.3, -3.2, 3.2]) {
        const m = new THREE.MeshBasicMaterial({ color: 0x7a4dff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
        const st = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x) > 2 ? 0.05 : 0.035, 100).rotateX(-Math.PI / 2), m);
        st.position.set(x, 0.004, -48); this.group.add(st); this.strips.push(m);
      }
      // Laser links/rechts
      for (const side of [-1, 1]) {
        const g = new THREE.Group(); g.position.set(side * 7, 0, -30);
        for (let i = 0; i < 4; i++) {
          const m = new THREE.MeshBasicMaterial({ color: 0x3db8ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
          const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 40, 6), m);
          beam.position.y = 20; const holder = new THREE.Group(); holder.add(beam); holder.position.z = -i * 6; holder.rotation.z = side * 0.4;
          g.add(holder); this.laserMats.push(m);
        }
        this.lasers.push(g); this.group.add(g);
      }
      // Ringe im Hintergrund
      for (let i = 0; i < 9; i++) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(6 + i * 0.4, 0.05, 6, 64), this.ringMat);
        r.position.set(0, 4, -26 - i * 5); this.rings.push(r); this.group.add(r);
      }
    }
    scene.add(this.group);
  }

  /** kurzer Licht-Stoss (Combo-Meilenstein) */
  pulse(strength = 1) { this.burst = Math.max(this.burst, (settings.comfort ? 0.3 : 1) * strength); }

  reset() { this.evIdx = 0; this.flash = 0; this.burst = 0; this.off = 0; }

  /** Licht-Events bis Songzeit t abarbeiten und Effekte animieren */
  update(t: number, dt: number, events: LightEvent[]) {
    const k = settings.lightIntensity, calm = settings.comfort;
    while (this.evIdx < events.length && events[this.evIdx].t <= t) {
      const e = events[this.evIdx++];
      if (t - e.t > 0.5 && e.type !== 'color' && e.type !== 'laser') continue;    // nach Sprung nicht nachholen
      if (e.type === 'flash') this.flash = Math.max(this.flash, e.v * (calm ? 0.25 : 1));
      else if (e.type === 'color') { const p = PALETTE[e.v] ?? PALETTE[0]; this.target[0].setHex(p[0]); this.target[1].setHex(p[1]); }
      else if (e.type === 'laser') this.laserSpeed = 0.15 + e.v * (calm ? 0.4 : 1.6);
      else if (e.type === 'burst') { this.burst = calm ? 0.3 : 1; this.off = 0; }
      else if (e.type === 'off') this.off = 1;
    }
    this.flash = Math.max(0, this.flash - dt * 5); this.burst = Math.max(0, this.burst - dt * 1.2); this.off = Math.max(0, this.off - dt * 3);
    this.colA.lerp(this.target[0], Math.min(1, dt * 3)); this.colB.lerp(this.target[1], Math.min(1, dt * 3));
    const glow = Math.max(0.1, (0.45 + this.flash * 0.55 + this.burst * 0.6 + this.boost * 0.5) * (1 - this.off * 0.85)) * k;
    for (const m of this.strips) { m.color.copy(this.colA).multiplyScalar(glow * 1.3); }
    this.laserAngle += dt * this.laserSpeed * (1 + this.boost * (calm ? 0.3 : 1.2));
    this.lasers.forEach((g, i) => { g.children.forEach((h, j) => { h.rotation.z = (i ? 1 : -1) * (0.3 + Math.sin(this.laserAngle * (1 + j * 0.3) + j) * 0.5); }); });
    for (const m of this.laserMats) { m.color.copy(this.colB).multiplyScalar(glow * 1.5); m.opacity = 0.35 + 0.4 * glow; }
    this.ringMat.color.copy(this.colA).multiplyScalar(glow);
    this.rings.forEach((r, i) => { r.rotation.z = this.laserAngle * 0.3 * (i % 2 ? 1 : -1); r.scale.setScalar(1 + this.burst * 0.25 * Math.sin(i + t * 4)); });
    this.floorMat.color.copy(this.colA).multiplyScalar(this.mr ? 0.6 + this.flash * 0.6 : glow);
  }

  /** aktuelle Akzentfarbe (fuer UI/Effekte) */
  accent(): THREE.Color { return this.colA; }
}
