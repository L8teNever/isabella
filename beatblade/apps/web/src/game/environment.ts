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

  private scene: THREE.Scene;
  /** weitere, kartenspezifische Teile, die sich langsam bewegen (Sterne, Sonne ...) */
  private spin: { o: THREE.Object3D; speed: number }[] = [];
  style = 'neon-runway';

  constructor(scene: THREE.Scene, public mr: boolean) {
    this.scene = scene;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x404060, mr ? 2.2 : 1.6);
    scene.add(this.hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.2); dir.position.set(0.5, 2, 1.5); scene.add(dir);
    this.floorMat = new THREE.MeshBasicMaterial({ color: 0x7a4dff, transparent: true, opacity: mr ? 0.25 : 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x7a4dff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    scene.add(this.group);
    this.build();
  }

  /** Map wechseln (VR); im MR gibt es keine Umgebung, nur die Bodenmarkierung */
  setMap(style: string) {
    if (style === this.style) return;
    this.style = style; this.build();
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mt = m.material as THREE.Material | THREE.Material[] | undefined;
        if (mt && mt !== this.floorMat && mt !== this.ringMat) (Array.isArray(mt) ? mt : [mt]).forEach((x) => x.dispose()); });
    }
    this.strips = []; this.lasers = []; this.laserMats = []; this.rings = []; this.spin = [];
  }

  private build() {
    this.clear();
    const g = this.group, scene = this.scene;
    if (this.mr) {
      // nur Bodenring um den Spieler und zwei Fuehrungslinien
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.45, 48).rotateX(-Math.PI / 2), this.floorMat); ring.position.y = 0.005;
      g.add(ring);
      for (const x of [-1.15, 1.15]) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 6).rotateX(-Math.PI / 2), this.floorMat);
        line.position.set(x, 0.006, -3.5); g.add(line);
      }
      return;
    }
    const additive = (color: number, opacity = 0.9) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    const runwayStrips = (xs: number[], len = 100) => {
      for (const x of xs) {
        const m = additive(0x7a4dff);
        const st = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x) > 2 ? 0.05 : 0.035, len).rotateX(-Math.PI / 2), m);
        st.position.set(x, 0.004, -len / 2 + 2); g.add(st); this.strips.push(m);
      }
    };
    const lasers = (dist: number, count: number, height = 40) => {
      for (const side of [-1, 1]) {
        const lg = new THREE.Group(); lg.position.set(side * dist, 0, -30);
        for (let i = 0; i < count; i++) {
          const m = additive(0x3db8ff, 0.55);
          const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, height, 6), m);
          beam.position.y = height / 2; const holder = new THREE.Group(); holder.add(beam); holder.position.z = -i * 6; holder.rotation.z = side * 0.4;
          lg.add(holder); this.laserMats.push(m);
        }
        this.lasers.push(lg); g.add(lg);
      }
    };

    if (this.style === 'space') {
      // Weltraum: Sternenfeld, Planet mit Ring, schwebende Glas-Bahn, Orbit-Ringe
      scene.background = new THREE.Color(0x020109); scene.fog = new THREE.Fog(0x020109, 30, 140);
      const n = 1800, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const v = new THREE.Vector3().randomDirection().multiplyScalar(80 + Math.random() * 60);
        if (v.y < -10) v.y = -v.y; pos.set([v.x, v.y, v.z], i * 3);
      }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.35, sizeAttenuation: true, fog: false }));
      g.add(stars); this.spin.push({ o: stars, speed: 0.004 });
      const planet = new THREE.Mesh(new THREE.SphereGeometry(14, 40, 24), new THREE.MeshStandardMaterial({ color: 0x3a2a6a, emissive: 0x140a30, roughness: 0.9, fog: false }));
      planet.position.set(-38, 18, -95); g.add(planet); this.spin.push({ o: planet, speed: 0.02 });
      const pr = new THREE.Mesh(new THREE.RingGeometry(18, 25, 64).rotateX(-Math.PI / 2.4), additive(0x7a4dff, 0.35));
      pr.position.copy(planet.position); g.add(pr); this.strips.push(pr.material as THREE.MeshBasicMaterial);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b0a1c, transparent: true, opacity: 0.85 }));
      glass.position.set(0, 0.002, -48); g.add(glass);
      runwayStrips([-1.3, 1.3]);
      for (let i = 0; i < 7; i++) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(7 + i * 0.6, 0.04, 6, 80), this.ringMat);
        r.position.set(0, 3, -24 - i * 7); r.rotation.x = 0.25; this.rings.push(r); g.add(r);
      }
      lasers(12, 2, 60);
    } else if (this.style === 'synthwave') {
      // Synthwave: Sonnenuntergang mit gestreifter Sonne, Neon-Gitterboden, Berg-Silhouetten
      scene.background = new THREE.Color(0x12051f); scene.fog = new THREE.Fog(0x12051f, 25, 110);
      const sky = document.createElement('canvas'); sky.width = 4; sky.height = 256;
      const sc = sky.getContext('2d')!, sgd = sc.createLinearGradient(0, 0, 0, 256);
      sgd.addColorStop(0, '#0b0320'); sgd.addColorStop(0.55, '#3a0b4a'); sgd.addColorStop(0.85, '#c2366e'); sgd.addColorStop(1, '#ff9a4a');
      sc.fillStyle = sgd; sc.fillRect(0, 0, 4, 256);
      const skyTex = new THREE.CanvasTexture(sky); skyTex.colorSpace = THREE.SRGBColorSpace;
      const skyM = new THREE.Mesh(new THREE.PlaneGeometry(400, 90), new THREE.MeshBasicMaterial({ map: skyTex, fog: false, depthWrite: false }));
      skyM.position.set(0, 35, -120); g.add(skyM);
      const sun = document.createElement('canvas'); sun.width = sun.height = 256;
      const uc = sun.getContext('2d')!, ug = uc.createLinearGradient(0, 0, 0, 256);
      ug.addColorStop(0, '#ffe36e'); ug.addColorStop(1, '#ff3d8a');
      uc.fillStyle = ug; uc.beginPath(); uc.arc(128, 128, 126, 0, Math.PI * 2); uc.fill();
      uc.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 7; i++) { const y = 150 + i * 15; uc.fillRect(0, y, 256, 3 + i * 1.3); }
      const sunTex = new THREE.CanvasTexture(sun); sunTex.colorSpace = THREE.SRGBColorSpace;
      const sunM = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, fog: false, depthWrite: false }));
      sunM.position.set(0, 14, -115); g.add(sunM);
      // Berge als Silhouette mit leuchtender Kante
      for (const side of [-1, 1]) {
        const shape = new THREE.Shape(); shape.moveTo(0, 0);
        let x = 0; while (x < 90) { x += 6 + Math.random() * 10; shape.lineTo(x, 4 + Math.random() * 14); }
        shape.lineTo(x, 0); shape.lineTo(0, 0);
        const mg = new THREE.ShapeGeometry(shape);
        const mtn = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ color: 0x0c0418, fog: false }));
        mtn.position.set(side < 0 ? -100 : 12, -0.5, -100); g.add(mtn);
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mg), new THREE.LineBasicMaterial({ color: 0xff3d8a, transparent: true, opacity: 0.8 }));
        edge.position.copy(mtn.position); edge.position.z += 0.1; g.add(edge);
      }
      // Gitterboden
      const lines: number[] = [];
      for (let x = -40; x <= 40; x += 2) lines.push(x, 0.003, 4, x, 0.003, -110);
      for (let z = 4; z >= -110; z -= 3) lines.push(-40, 0.003, z, 40, 0.003, z);
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      const gridMat = new THREE.LineBasicMaterial({ color: 0xff3d8a, transparent: true, opacity: 0.55 });
      g.add(new THREE.LineSegments(lg, gridMat)); this.strips.push(gridMat as unknown as THREE.MeshBasicMaterial);
      const run = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0d0617 }));
      run.position.set(0, 0.002, -48); g.add(run);
      runwayStrips([-1.3, 1.3]);
      lasers(9, 3, 30);
    } else {
      // Neon-Laufsteg (bisher)
      scene.background = new THREE.Color(0x05040a);
      scene.fog = new THREE.Fog(0x05040a, 12, 70);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 120).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x07060d }));
      floor.position.z = -40; g.add(floor);
      const run = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x100d1c }));
      run.position.set(0, 0.002, -48); g.add(run);
      runwayStrips([-1.3, 1.3, -3.2, 3.2]);
      lasers(7, 4);
      for (let i = 0; i < 9; i++) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(6 + i * 0.4, 0.05, 6, 64), this.ringMat);
        r.position.set(0, 4, -26 - i * 5); this.rings.push(r); g.add(r);
      }
    }
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
    for (const sp of this.spin) sp.o.rotation.y += dt * sp.speed;
  }

  /** aktuelle Akzentfarbe (fuer UI/Effekte) */
  accent(): THREE.Color { return this.colA; }
}
