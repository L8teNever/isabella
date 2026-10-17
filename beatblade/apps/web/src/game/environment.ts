// Umgebung und Lichtshow.
// VR: Neon-Laufsteg, Laser, Ringe, Nebel – reagieren auf Licht-Events (Flash, Farbe, Laser, Burst).
// MR: keine Umgebung, nur dezente Bodenmarkierung und Akzentlicht (echter Raum bleibt sichtbar).
import * as THREE from 'three';
import { DUET_LANE_X } from './layout';
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
  /** weitere Animationen der Map (Schnee, Blasen, Funken ...) */
  private anim: ((dt: number) => void)[] = [];
  /** Lichter mit eigener Farbe (Kuerbisse, Baumlichter, Korallen): pulsieren mit der Lichtshow, Farbe bleibt */
  private keep: { m: THREE.MeshBasicMaterial; c: THREE.Color }[] = [];
  style = 'neon-runway';
  /** Duett: zweite Bahn rechts, Deko auf der rechten Seite rueckt nach aussen */
  duet = false;

  /** scene: Lichter, Nebel, Hintergrund; parent: alles Sichtbare der Map (gemeinsame Buehne mit dem Spielfeld) */
  constructor(scene: THREE.Scene, parent: THREE.Object3D, public mr: boolean) {
    this.scene = scene;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x404060, mr ? 2.2 : 1.6);
    scene.add(this.hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.2); dir.position.set(0.5, 2, 1.5); scene.add(dir);
    this.floorMat = new THREE.MeshBasicMaterial({ color: 0x7a4dff, transparent: true, opacity: mr ? 0.25 : 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x7a4dff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    parent.add(this.group);
    this.build();
  }

  /** Map wechseln (VR); im MR gibt es keine Umgebung, nur die Bodenmarkierung */
  setMap(style: string) {
    if (style === this.style) return;
    this.style = style; this.build();
  }

  /** Duett an/aus: Map mit zweiter Bahn fuer den Partner neu aufbauen */
  setDuet(on: boolean) {
    if (on === this.duet) return;
    this.duet = on; this.build();
  }

  /**
   * Duett: Bahn-Teile (Bahnflaeche, Leuchtstreifen, Ringe ueber der Bahn) fuer die Partnerbahn bei DUET_LANE_X verdoppeln,
   * alles rechts neben der Bahn um diese Breite nach aussen schieben – so steht keine Deko auf seiner Bahn.
   */
  private widen() {
    const off = DUET_LANE_X;
    for (const c of [...this.group.children]) {
      const x = c.position.x;
      const geo = (c as THREE.Mesh).geometry as THREE.BufferGeometry & { parameters?: { width?: number } } | undefined;
      // Ringe sind gross genug fuer beide Bahnen: nur in die Mitte zwischen beide ruecken
      if (this.rings.includes(c as THREE.Mesh)) { c.position.x = x + off / 2; continue; }
      const laneLike = c.userData.lane === true || geo?.parameters?.width === 2.6;
      if (laneLike && Math.abs(x) <= 1.5) {
        const k = c.clone(); k.position.x = x + off; this.group.add(k);
      } else if (x > 1.5) c.position.x += off;
    }
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mt = m.material as THREE.Material | THREE.Material[] | undefined;
        if (mt && mt !== this.floorMat && mt !== this.ringMat) (Array.isArray(mt) ? mt : [mt]).forEach((x) => x.dispose()); });
    }
    this.strips = []; this.lasers = []; this.laserMats = []; this.rings = []; this.spin = []; this.anim = []; this.keep = [];
  }

  private build() {
    this.buildMap();
    if (this.duet) this.widen();
  }

  private buildMap() {
    this.clear();
    const g = this.group, scene = this.scene;
    if (this.mr) {
      // nur Bodenring um den Spieler und zwei Fuehrungslinien
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.45, 48).rotateX(-Math.PI / 2), this.floorMat); ring.position.y = 0.005;
      g.add(ring);
      for (const x of [-1.15, 1.15]) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 6).rotateX(-Math.PI / 2), this.floorMat);
        line.position.set(x, 0.006, -3.5); line.userData.lane = true; g.add(line);
      }
      // MR: die Map-Deko (Schnee, Baeume, Kuerbisse, Mond ...) erscheint im echten Raum;
      // Himmel, Nebel, Boden und Bahn bleiben weg, damit das Zimmer sichtbar bleibt
      scene.background = null; scene.fog = null;
    }
    const mr = this.mr;
    /** Himmel + Nebel (nur VR) */
    const skyFog = (bg: number, fog: number, near: number, far: number) => { if (mr) return; scene.background = new THREE.Color(bg); scene.fog = new THREE.Fog(fog, near, far); };
    const additive = (color: number, opacity = 0.9) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    const runwayStrips = (xs: number[], len = 100) => {
      for (const x of xs) {
        const m = additive(0x7a4dff);
        const st = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x) > 2 ? 0.05 : 0.035, len).rotateX(-Math.PI / 2), m);
        st.position.set(x, 0.004, -len / 2 + 2); st.userData.lane = true; g.add(st); this.strips.push(m);
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

    // Teilchen (Schnee, Blasen, Glut): steigen/fallen in einem Kasten und kommen am anderen Ende wieder
    const particles = (n: number, box: [number, number, number, number, number, number], color: number, size: number, vy: number, drift = 0.3) => {
      const [x0, x1, y0, y1, z0, z1] = box, pos = new Float32Array(n * 3), ph = new Float32Array(n);
      for (let i = 0; i < n; i++) { pos.set([x0 + Math.random() * (x1 - x0), y0 + Math.random() * (y1 - y0), z0 + Math.random() * (z1 - z0)], i * 3); ph[i] = Math.random() * 6.3; }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
      g.add(pts);
      let t = 0;
      this.anim.push((dt) => {
        t += dt;
        for (let i = 0; i < n; i++) {
          let y = pos[i * 3 + 1] + vy * dt;
          if (vy < 0 && y < y0) y = y1; if (vy > 0 && y > y1) y = y0;
          pos[i * 3 + 1] = y; pos[i * 3] += Math.sin(t + ph[i]) * drift * dt;
        }
        (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      });
    };
    const ground = (color: number, w = 120, d = 140) => { if (mr) return null; const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color })); m.position.z = -d / 2 + 10; g.add(m); return m; };
    const runway = (color: number) => { if (mr) return; const r = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color })); r.position.set(0, 0.002, -48); g.add(r); };
    const sprite = (draw: (c: CanvasRenderingContext2D) => void, w: number, h: number, size = 256) => {
      const cv = document.createElement('canvas'); cv.width = size; cv.height = size; draw(cv.getContext('2d')!);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false }));
    };
    const sides = (fn: (x: number, z: number, i: number) => void, count: number, zStep: number, xMin: number, xMax: number) => {
      for (let i = 0; i < count; i++) for (const side of [-1, 1]) fn(side * (xMin + Math.random() * (xMax - xMin)), -6 - i * zStep - Math.random() * zStep * 0.5, i);
    };

    if (this.style === 'halloween') {
      // Halloween: Vollmond, kahle Baeume, Grabsteine, leuchtende Kuerbisse am Rand, gruenlicher Nebel, Glutfunken
      skyFog(0x0a0614, 0x120a1c, 14, 80);
      ground(0x0c0a10); runway(0x150d1c); runwayStrips([-1.3, 1.3]);
      const moon = sprite((c) => { const gr = c.createRadialGradient(128, 128, 60, 128, 128, 128); gr.addColorStop(0, '#fff6d8'); gr.addColorStop(0.45, '#ffe7a0'); gr.addColorStop(0.5, 'rgba(255,220,140,0.35)'); gr.addColorStop(1, 'rgba(255,200,120,0)'); c.fillStyle = gr; c.fillRect(0, 0, 256, 256);
        c.fillStyle = 'rgba(200,180,120,0.35)'; for (const [x, y, r] of [[105, 110, 14], [150, 140, 10], [125, 160, 7]]) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); } }, 34, 34);
      moon.position.set(18, 30, -100); g.add(moon);
      const branchMat = new THREE.LineBasicMaterial({ color: 0x1a1022 });
      const tree = (x: number, z: number) => {
        const pts: number[] = [];
        const grow = (x0: number, y0: number, a: number, len: number, d: number) => {
          const x1 = x0 + Math.sin(a) * len, y1 = y0 + Math.cos(a) * len; pts.push(x0, y0, 0, x1, y1, 0);
          if (d > 0) { grow(x1, y1, a - 0.5 - Math.random() * 0.3, len * 0.7, d - 1); grow(x1, y1, a + 0.4 + Math.random() * 0.3, len * 0.68, d - 1); }
        };
        grow(0, 0, (Math.random() - 0.5) * 0.2, 2.2 + Math.random(), 5);
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const t = new THREE.LineSegments(geo, branchMat); t.position.set(x, 0, z); t.rotation.y = Math.random() * 3; t.scale.setScalar(1.6); g.add(t);
      };
      sides((x, z) => tree(x, z), 8, 9, 6, 16);
      const stone = new THREE.MeshStandardMaterial({ color: 0x3a3a46, roughness: 0.9 });
      sides((x, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.18), stone); m.position.set(x, 0.45, z); m.rotation.set(0, Math.random() - 0.5, (Math.random() - 0.5) * 0.2); g.add(m); }, 10, 6, 3, 9);
      // Kuerbis-Laternen am Rand: kleine Kugeln, die im Takt der Lichtshow mitleuchten
      sides((x, z) => { const mat = additive(0xff8a1a, 0.95); const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), mat); m.scale.y = 0.8; m.position.set(x, 0.2, z); g.add(m); this.keep.push({ m: mat, c: mat.color.clone() }); }, 8, 7, 2.2, 4);
      particles(160, [-20, 20, 0, 10, -80, 0], 0xff9a3a, 0.08, 0.6, 0.4);
      lasers(9, 2, 30);
    } else if (this.style === 'christmas') {
      // Weihnachten: Schnee faellt, verschneiter Boden, Tannen mit Lichterketten, Sternenhimmel
      skyFog(0x0a1426, 0x16233a, 16, 90);
      ground(0x7d8ca3); runway(0x1b2840); runwayStrips([-1.3, 1.3]);
      const n = 600, sp = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(110); if (v.y < 5) v.y = 5 + Math.random() * 40; sp.set([v.x, v.y, v.z], i * 3); }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
      g.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.4, fog: false })));
      const needle = new THREE.MeshStandardMaterial({ color: 0x1d5a34, roughness: 0.8 }), snowTop = new THREE.MeshStandardMaterial({ color: 0xf2f6ff, roughness: 0.9 });
      const lightCols = [0xff3d3d, 0xffd23c, 0x3db8ff, 0x4be3a0];
      sides((x, z) => {
        const t = new THREE.Group(); const h = 2.5 + Math.random() * 2;
        for (let k = 0; k < 3; k++) { const cone = new THREE.Mesh(new THREE.ConeGeometry(h * (0.42 - k * 0.1), h * 0.45, 9), k === 2 ? snowTop : needle); cone.position.y = h * (0.25 + k * 0.22); t.add(cone); }
        for (let k = 0; k < 8; k++) { const mat = additive(lightCols[k % 4], 1); const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), mat); const a = k * 2.1, yy = h * (0.15 + (k / 8) * 0.6), rr = h * 0.38 * (1 - (k / 8) * 0.7);
          b.position.set(Math.cos(a) * rr, yy, Math.sin(a) * rr); t.add(b); this.keep.push({ m: mat, c: mat.color.clone() }); }
        t.position.set(x, 0, z); g.add(t);
      }, 8, 9, 4, 14);
      // Lichterkette ueber der Bahn
      for (let i = 0; i < 14; i++) { const mat = additive(lightCols[i % 4], 1); const b = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), mat); b.position.set(Math.sin(i * 0.9) * 1.6, 3.2 + Math.cos(i * 0.7) * 0.2, -4 - i * 4); g.add(b); this.keep.push({ m: mat, c: mat.color.clone() }); }
      particles(700, [-25, 25, 0, 14, -90, 4], 0xffffff, 0.07, -1.1, 0.5);
    } else if (this.style === 'underwater') {
      // Unterwasser: blaues Licht, Lichtstrahlen von oben, aufsteigende Blasen, Tang, Korallen
      skyFog(0x02223a, 0x033a5c, 6, 60);
      ground(0x0a3a4a); runway(0x0c2c3c); runwayStrips([-1.3, 1.3]);
      for (let i = 0; i < 9; i++) {
        const mat = additive(0x9fe8ff, 0.08); const ray = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 40), mat);
        ray.position.set(-20 + i * 5, 18, -20 - i * 6); ray.rotation.z = 0.35; g.add(ray);
        let t = Math.random() * 6; this.anim.push((dt) => { t += dt; mat.opacity = 0.05 + 0.05 * Math.sin(t * 0.7); });
      }
      const kelpMat = new THREE.MeshBasicMaterial({ color: 0x1f7a4a, side: THREE.DoubleSide });
      sides((x, z) => { const h = 3 + Math.random() * 4; const k = new THREE.Mesh(new THREE.PlaneGeometry(0.35, h, 1, 8), kelpMat); k.position.set(x, h / 2, z); g.add(k);
        const base = (k.geometry.attributes.position as THREE.BufferAttribute).array.slice(); let t = Math.random() * 6;
        this.anim.push((dt) => { t += dt; const p = k.geometry.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) { const y = base[i * 3 + 1] + h / 2; p.setX(i, base[i * 3] + Math.sin(t * 1.3 + y * 0.8) * 0.12 * y); } p.needsUpdate = true; }); }, 10, 6, 3, 12);
      const coralCols = [0xff6b8a, 0xffa94d, 0xb07dff];
      sides((x, z, i) => { const mat = additive(coralCols[i % 3], 0.85); const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5 + Math.random() * 0.5, 0), mat); c.position.set(x, 0.3, z); c.scale.y = 0.7; g.add(c); this.keep.push({ m: mat, c: mat.color.clone() }); }, 9, 7, 2.5, 8);
      particles(260, [-12, 12, 0, 12, -60, 2], 0xcff6ff, 0.09, 1.2, 0.3);
      for (let i = 0; i < 6; i++) { const r = new THREE.Mesh(new THREE.TorusGeometry(5 + i * 0.5, 0.04, 6, 64), this.ringMat); r.position.set(0, 3.5, -24 - i * 7); this.rings.push(r); g.add(r); }
    } else if (this.style === 'neon-city') {
      // Neon-Stadt: Hochhaeuser mit leuchtenden Fenstern links und rechts, Neon-Bänder, Laser
      skyFog(0x05030c, 0x0a0618, 18, 100);
      ground(0x07060c); runway(0x0f0c1c); runwayStrips([-1.3, 1.3, -3.2, 3.2]);
      const win = document.createElement('canvas'); win.width = 64; win.height = 128;
      const wc = win.getContext('2d')!; wc.fillStyle = '#0a0a14'; wc.fillRect(0, 0, 64, 128);
      for (let y = 4; y < 128; y += 8) for (let x = 4; x < 64; x += 8) if (Math.random() < 0.45) { wc.fillStyle = ['#ffd27a', '#7ad8ff', '#ff7ad8', '#ffffff'][Math.floor(Math.random() * 4)]; wc.fillRect(x, y, 4, 4); }
      const winTex = new THREE.CanvasTexture(win); winTex.colorSpace = THREE.SRGBColorSpace; winTex.wrapS = winTex.wrapT = THREE.RepeatWrapping;
      sides((x, z) => {
        const w = 3 + Math.random() * 4, h = 10 + Math.random() * 30, d = 3 + Math.random() * 4;
        const tex = winTex.clone(); tex.needsUpdate = true; tex.repeat.set(w / 4, h / 8);
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ map: tex, color: 0x9a9aa8 })); b.position.set(x + Math.sign(x) * 4, h / 2, z); g.add(b);
        const edge = additive(0x7a4dff, 0.9); const e = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, 0.12, d + 0.05), edge); e.position.set(b.position.x, h, z); g.add(e); this.strips.push(edge);
      }, 10, 9, 6, 14);
      lasers(8, 4, 50);
      for (let i = 0; i < 8; i++) { const r = new THREE.Mesh(new THREE.TorusGeometry(5 + i * 0.3, 0.05, 4, 4), this.ringMat); r.rotation.z = Math.PI / 4; r.position.set(0, 4, -22 - i * 6); this.rings.push(r); g.add(r); }
    } else if (this.style === 'volcano') {
      // Vulkan: roter Himmel, gluehender Vulkan, Lava-Fluss neben der Bahn, aufsteigende Glut, dunkle Felsen
      skyFog(0x1a0504, 0x2a0806, 15, 90);
      ground(0x140806); runway(0x1c0c0a); runwayStrips([-1.3, 1.3]);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(30, 28, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x0e0605, fog: false }));
      cone.position.set(-10, 13, -110); g.add(cone);
      const crater = sprite((c) => { const gr = c.createRadialGradient(128, 128, 10, 128, 128, 128); gr.addColorStop(0, '#fff2a0'); gr.addColorStop(0.3, '#ff8a1a'); gr.addColorStop(1, 'rgba(255,60,0,0)'); c.fillStyle = gr; c.fillRect(0, 0, 256, 256); }, 30, 22);
      crater.position.set(-10, 28, -109); g.add(crater);
      for (const side of [-1, 1]) {
        const mat = additive(0xff5a1a, 0.45); const lava = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 110).rotateX(-Math.PI / 2), mat);
        lava.position.set(side * 5.5, 0.01, -45); g.add(lava); this.keep.push({ m: mat, c: mat.color.clone() });
      }
      const rock = new THREE.MeshStandardMaterial({ color: 0x2a1c1a, roughness: 1, flatShading: true });
      sides((x, z) => { const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.8 + Math.random() * 1.6, 0), rock); m.position.set(x, 0.4, z); m.rotation.set(Math.random(), Math.random(), 0); g.add(m); }, 12, 6, 6.5, 16);
      particles(300, [-20, 20, 0, 18, -90, 2], 0xff7a2a, 0.09, 1.6, 0.6);
      lasers(10, 2, 30);
    } else if (this.style === 'space') {
      // Weltraum: Sternenfeld, Planet mit Ring, schwebende Glas-Bahn, Orbit-Ringe
      skyFog(0x020109, 0x020109, 30, 140);
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
      glass.position.set(0, 0.002, -48); if (!mr) g.add(glass);
      runwayStrips([-1.3, 1.3]);
      for (let i = 0; i < 7; i++) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(7 + i * 0.6, 0.04, 6, 80), this.ringMat);
        r.position.set(0, 3, -24 - i * 7); r.rotation.x = 0.25; this.rings.push(r); g.add(r);
      }
      lasers(12, 2, 60);
    } else if (this.style === 'synthwave') {
      // Synthwave: Sonnenuntergang mit gestreifter Sonne, Neon-Gitterboden, Berg-Silhouetten
      skyFog(0x12051f, 0x12051f, 25, 110);
      const sky = document.createElement('canvas'); sky.width = 4; sky.height = 256;
      const sc = sky.getContext('2d')!, sgd = sc.createLinearGradient(0, 0, 0, 256);
      sgd.addColorStop(0, '#0b0320'); sgd.addColorStop(0.55, '#3a0b4a'); sgd.addColorStop(0.85, '#c2366e'); sgd.addColorStop(1, '#ff9a4a');
      sc.fillStyle = sgd; sc.fillRect(0, 0, 4, 256);
      const skyTex = new THREE.CanvasTexture(sky); skyTex.colorSpace = THREE.SRGBColorSpace;
      const skyM = new THREE.Mesh(new THREE.PlaneGeometry(400, 90), new THREE.MeshBasicMaterial({ map: skyTex, fog: false, depthWrite: false }));
      skyM.position.set(0, 35, -120); if (!mr) g.add(skyM);
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
      run.position.set(0, 0.002, -48); if (!mr) g.add(run);
      runwayStrips([-1.3, 1.3]);
      lasers(9, 3, 30);
    } else {
      // Neon-Laufsteg (bisher)
      skyFog(0x05040a, 0x05040a, 12, 70);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 120).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x07060d }));
      floor.position.z = -40; if (!mr) g.add(floor);
      const run = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x100d1c }));
      run.position.set(0, 0.002, -48); if (!mr) g.add(run);
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
    for (const a of this.anim) a(dt);
    for (const k of this.keep) k.m.color.copy(k.c).multiplyScalar(0.55 + glow * 0.9);
  }

  /** aktuelle Akzentfarbe (fuer UI/Effekte) */
  accent(): THREE.Color { return this.colA; }
}
