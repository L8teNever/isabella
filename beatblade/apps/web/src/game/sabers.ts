// Lichtschwerter: an die Controller gebunden (Griff-Position, Zeigerichtung), ~1 m, leuchtend.
// Pro Bild werden Griff und Spitze gespeichert (fuer Swept-Collision und Schwung-Bewertung).
import * as THREE from 'three';
import { COLORS, SABER_LEN } from './layout';
import { settings } from '../settings';
import { GLOW, glowMaterial } from './glow';
import { buildSaberVisual, type SaberVisual } from './sabervisuals';

export interface SaberSample { t: number; hilt: THREE.Vector3; tip: THREE.Vector3; dir: THREE.Vector3 }

const TRAIL = 14;

export class Saber {
  group = new THREE.Group();
  /** Aussehen (austauschbar) – Treffer-Logik bleibt hier und ist vom Aussehen unabhaengig */
  visual: SaberVisual;
  trail: THREE.Mesh;
  /** Lichtfleck am Boden */
  pool: THREE.Mesh;
  private boostLevel = 0;
  private trailPos: Float32Array;
  private trailPts: { hilt: THREE.Vector3; tip: THREE.Vector3 }[] = [];
  history: SaberSample[] = [];
  /** aktueller und vorheriger Stand in Spielfeld-Koordinaten */
  hilt = new THREE.Vector3(); tip = new THREE.Vector3(); dir = new THREE.Vector3(0, 0, -1);
  /** Controller-Griff ohne Schwert-Versatz (Orbit: Handkugel) */
  grip = new THREE.Vector3();
  prevHilt = new THREE.Vector3(); prevTip = new THREE.Vector3();
  active = false;
  color: number;

  constructor(public hand: 0 | 1, scene: THREE.Object3D) {
    this.color = hand === 0 ? COLORS.left : COLORS.right;
    this.visual = buildSaberVisual('classic', SABER_LEN, this.color);
    this.group.add(this.visual.group);
    this.pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), glowMaterial(GLOW.saberPoolStrength, this.color));
    this.pool.renderOrder = 1; this.pool.visible = false; scene.add(this.pool);
    // Leuchtspur (Band aus den letzten Positionen)
    this.trailPos = new Float32Array(TRAIL * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    const alpha = new Float32Array(TRAIL * 2); for (let i = 0; i < TRAIL; i++) { alpha[i * 2] = alpha[i * 2 + 1] = 1 - i / TRAIL; }
    g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    const idx: number[] = []; for (let i = 0; i < TRAIL - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.trail = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(this.color) }, boost: { value: 1 } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 color; uniform float boost; varying float vA; void main(){ gl_FragColor = vec4(color, min(1.0, vA * 0.35 * boost)); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.trail.frustumCulled = false;
    scene.add(this.group, this.trail);
    this.group.visible = false; this.trail.visible = false;
  }

  /** Combo-Effekt: Klinge leuchtet staerker, Spur wird heller (level 0..1) */
  setBoost(level: number) {
    this.boostLevel = level;
    this.visual.boost(level);
    (this.trail.material as THREE.ShaderMaterial).uniforms.boost.value = 1 + level * 1.6;
  }

  /** Aussehen wechseln (Stil oder fertiges Modell-Visual); Farbe und Combo-Leuchten bleiben */
  setVisual(v: SaberVisual) {
    this.group.remove(this.visual.group);
    this.visual = v; this.group.add(v.group);
    v.tint(this.color); v.boost(this.boostLevel); v.halo.visible = settings.glow;
  }

  setColor(c: number) { this.color = c; this.visual.tint(c); (this.pool.material as THREE.MeshBasicMaterial).color.setHex(c); (this.trail.material as THREE.ShaderMaterial).uniforms.color.value.setHex(c); }

  /**
   * Pose setzen. pos = Griff-Position, quat = Orientierung (Klinge entlang -Z), beides in Spielfeld-Koordinaten.
   * Griff-Offset und Neigung aus den Einstellungen.
   */
  setPose(pos: THREE.Vector3, quat: THREE.Quaternion, t: number) {
    this.active = true; this.group.visible = true; this.trail.visible = true;
    this.grip.copy(pos);
    const q = quat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (-settings.saberAngle * Math.PI) / 180));
    this.group.position.copy(pos).add(new THREE.Vector3(0, 0, -settings.saberOffsetCm / 100).applyQuaternion(q));
    this.group.quaternion.copy(q);
    this.prevHilt.copy(this.hilt); this.prevTip.copy(this.tip);
    this.dir.set(0, 0, -1).applyQuaternion(q);
    this.hilt.copy(this.group.position).addScaledVector(this.dir, 0.06);
    this.tip.copy(this.hilt).addScaledVector(this.dir, SABER_LEN);
    if (!this.history.length) { this.prevHilt.copy(this.hilt); this.prevTip.copy(this.tip); }
    // Lichtfleck unter der Klingenmitte, je naeher am Boden desto heller
    this.visual.halo.visible = settings.glow; this.pool.visible = settings.glow;
    if (settings.glow) {
      const mx = (this.hilt.x + this.tip.x) / 2, my = (this.hilt.y + this.tip.y) / 2, mz = (this.hilt.z + this.tip.z) / 2;
      this.pool.position.set(mx, 0.013, mz); this.pool.scale.setScalar(GLOW.saberPoolSize);
      (this.pool.material as THREE.MeshBasicMaterial).opacity = GLOW.saberPoolStrength * Math.max(0, 1 - my / GLOW.poolFadeHeight);
    }
    this.history.push({ t, hilt: this.hilt.clone(), tip: this.tip.clone(), dir: this.dir.clone() });
    while (this.history.length && t - this.history[0].t > 0.6) this.history.shift();
    // Spur aktualisieren
    this.trailPts.unshift({ hilt: this.hilt.clone().addScaledVector(this.dir, 0.25), tip: this.tip.clone() });
    if (this.trailPts.length > TRAIL) this.trailPts.pop();
    for (let i = 0; i < TRAIL; i++) {
      const p = this.trailPts[Math.min(i, this.trailPts.length - 1)];
      this.trailPos.set([p.hilt.x, p.hilt.y, p.hilt.z, p.tip.x, p.tip.y, p.tip.z], i * 6);
    }
    (this.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  hide() { this.active = false; this.group.visible = false; this.trail.visible = false; this.pool.visible = false; this.history = []; this.trailPts = []; }

  /** Spitzen-Geschwindigkeit (m/s) ueber die letzten ~30 ms */
  tipVelocity(): THREE.Vector3 {
    const h = this.history; if (h.length < 2) return new THREE.Vector3();
    const last = h[h.length - 1]; let first = h[h.length - 2];
    for (let i = h.length - 2; i >= 0; i--) { first = h[i]; if (last.t - h[i].t >= 0.05) break; }
    const dt = last.t - first.t; return dt > 0 ? last.tip.clone().sub(first.tip).divideScalar(dt) : new THREE.Vector3();
  }

  /**
   * Ausholwinkel (Grad): Drehung der Klinge seit Beginn des aktuellen Schwungs (Umkehr der Drehrichtung
   * oder max. 0,6 s), gemessen bis zum Treffer.
   */
  preSwingAngle(): number {
    const h = this.history; if (h.length < 3) return 0;
    let total = 0; let axis: THREE.Vector3 | null = null;
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1].dir, b = h[i].dir;
      const ang = a.angleTo(b); if (ang < 1e-4) continue;
      const ax = new THREE.Vector3().crossVectors(a, b).normalize();
      if (!axis) axis = ax; else if (ax.dot(axis) < -0.2) break;
      total += ang;
    }
    return (total * 180) / Math.PI;
  }
}

/** laufende Nachschwung-Messung nach einem Treffer */
export class FollowThrough {
  angle = 0; done = false; private axis: THREE.Vector3 | null = null; private last: THREE.Vector3;
  constructor(public saber: Saber, public t0: number, public onDone: (angleDeg: number) => void) { this.last = saber.dir.clone(); }
  update(t: number) {
    if (this.done) return;
    const d = this.saber.dir, ang = this.last.angleTo(d);
    if (ang > 1e-4) {
      const ax = new THREE.Vector3().crossVectors(this.last, d).normalize();
      if (!this.axis) this.axis = ax;
      if (ax.dot(this.axis) < -0.2) return this.finish();
      this.angle += ang;
    }
    this.last.copy(d);
    if (t - this.t0 > 0.35 || this.angle > Math.PI / 3) this.finish();
  }
  finish() { if (!this.done) { this.done = true; this.onDone((this.angle * 180) / Math.PI); } }
}
