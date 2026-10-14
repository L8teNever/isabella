// Geschnittene Bloecke: zwei Haelften, entlang der Schnittebene abgeschnitten (Clipping-Planes),
// fliegen physikalisch weg. Funken als Partikel. Alles aus Objekt-Pools (keine Allokation im Spiel).
import * as THREE from 'three';
import type { Cut } from '@beatblade/core';
import { cutAngle } from './notes';

interface Half { mesh: THREE.Mesh; arrow: THREE.Mesh; local: THREE.Plane; vel: THREE.Vector3; spin: THREE.Vector3; life: number }
interface Spark { pos: THREE.Vector3; vel: THREE.Vector3; life: number; color: THREE.Color }

const PAIRS = 12, SPARKS = 400, MARKS = 16;

// ---------- Rueckmeldung Richtig/Fehler ----------
export const ERROR_COLOR = 0xff2a2a;   // Fehler: rotes X + rote Partikel
export const HIT_RING_COLOR = 0xffffff; // Treffer: kurzer heller Ring
const MARK_LIFE = 0.6;                  // Sekunden, die ein X / Ring sichtbar ist

interface Mark { mesh: THREE.Object3D; mats: THREE.MeshBasicMaterial[]; life: number; grow: number }

export class Slicer {
  private halves: Half[] = [];
  private next = 0;
  private sparks: Spark[] = [];
  private points: THREE.Points;
  private sp = 0;
  private marks: Mark[] = [];
  private mk = 0;

  constructor(private root: THREE.Object3D, cubeGeo: THREE.BufferGeometry, arrowGeo: THREE.BufferGeometry) {
    for (let i = 0; i < PAIRS * 2; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.15, emissive: 0x222222, clippingPlanes: [new THREE.Plane()], side: THREE.DoubleSide, transparent: true });
      const mesh = new THREE.Mesh(cubeGeo, mat);
      const arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, clippingPlanes: [mat.clippingPlanes![0]], transparent: true }));
      mesh.add(arrow); mesh.visible = false; root.add(mesh);
      this.halves.push({ mesh, arrow, local: new THREE.Plane(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.025, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.points.frustumCulled = false; root.add(this.points);
    for (let i = 0; i < SPARKS; i++) this.sparks.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, color: new THREE.Color() });
    // Marker: rotes X (Fehler) und Ring (Treffer), abwechselnd im Pool
    const bar = new THREE.PlaneGeometry(0.42, 0.07), ring = new THREE.RingGeometry(0.2, 0.24, 40);
    for (let i = 0; i < MARKS; i++) {
      const isX = i % 2 === 0;
      const mk = () => new THREE.MeshBasicMaterial({ color: isX ? ERROR_COLOR : HIT_RING_COLOR, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const g = new THREE.Group(); const mats: THREE.MeshBasicMaterial[] = [];
      if (isX) for (const r of [Math.PI / 4, -Math.PI / 4]) { const m = mk(); const b = new THREE.Mesh(bar, m); b.rotation.z = r; b.renderOrder = 20; g.add(b); mats.push(m); }
      else { const m = mk(); const r = new THREE.Mesh(ring, m); r.renderOrder = 20; g.add(r); mats.push(m); }
      g.visible = false; root.add(g); this.marks.push({ mesh: g, mats, life: 0, grow: 0 });
    }
  }

  private mark(pos: THREE.Vector3, x: boolean, color?: number) {
    for (let k = 0; k < MARKS; k++) {
      const i = (this.mk + k) % MARKS; if ((i % 2 === 0) !== x) continue;
      const m = this.marks[i]; this.mk = (i + 1) % MARKS;
      m.mesh.position.copy(pos); m.mesh.visible = true; m.life = MARK_LIFE; m.grow = x ? 0.6 : 1.6;
      if (color !== undefined) for (const mat of m.mats) mat.color.setHex(color);
      return;
    }
  }

  /** Fehler sichtbar machen: rotes X + rote Partikel an der Stelle */
  error(pos: THREE.Vector3, n = 30) { this.mark(pos, true); this.burst(pos, ERROR_COLOR, n); }

  /** Treffer: kurzer Ring in der Blockfarbe */
  good(pos: THREE.Vector3, color = HIT_RING_COLOR) { this.mark(pos, false, color); }

  /**
   * Block an pos zerschneiden. normal = Normale der Schnittebene (Spielfeld-Koordinaten),
   * vel = Bewegung des Blocks, color = Farbe.
   */
  cut(pos: THREE.Vector3, d: Cut, color: number, normal: THREE.Vector3, vel: THREE.Vector3, sparks = 18) {
    const n = normal.clone().normalize();
    for (const side of [1, -1]) {
      const h = this.halves[this.next]; this.next = (this.next + 1) % this.halves.length;
      h.mesh.position.copy(pos); h.mesh.rotation.set(0, 0, cutAngle(d));
      h.mesh.updateMatrix();
      // Ebene in lokalen Koordinaten der Haelfte merken (bewegt sich mit); pos/normal sind Spielfeld-Koordinaten
      const inv = h.mesh.matrix.clone().invert();
      const worldPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.clone().multiplyScalar(side), pos);
      h.local.copy(worldPlane).applyMatrix4(inv);
      (h.mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      (h.mesh.material as THREE.MeshStandardMaterial).opacity = 1;
      (h.arrow.material as THREE.MeshBasicMaterial).opacity = 1;
      h.vel.copy(vel).multiplyScalar(0.25).addScaledVector(n, -side * 1.6).add(new THREE.Vector3(0, 0.6, 0));
      h.spin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
      h.life = 0.9; h.mesh.visible = true;
      h.arrow.visible = true;
    }
    const c = new THREE.Color(color);
    for (let i = 0; i < sparks; i++) {
      const s = this.sparks[this.sp]; this.sp = (this.sp + 1) % SPARKS;
      s.pos.copy(pos); s.life = 0.35 + Math.random() * 0.3; s.color.copy(c).lerp(new THREE.Color(0xffffff), Math.random() * 0.6);
      s.vel.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(1.5 + Math.random() * 2.5);
    }
  }

  burst(pos: THREE.Vector3, color: number, n = 40) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const s = this.sparks[this.sp]; this.sp = (this.sp + 1) % SPARKS;
      s.pos.copy(pos); s.life = 0.5 + Math.random() * 0.4; s.color.copy(c);
      s.vel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3);
    }
  }

  /** Block-Skin fuer die Haelften uebernehmen (Form, Glanz, Textur) – Farbe kommt weiter pro Schnitt */
  setSkin(geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial) {
    for (const h of this.halves) {
      h.mesh.geometry = geo;
      const m = h.mesh.material as THREE.MeshStandardMaterial;
      m.roughness = mat.roughness; m.metalness = mat.metalness; m.flatShading = mat.flatShading; m.map = mat.map;
      m.emissive.copy(mat.emissive); m.needsUpdate = true;
    }
  }

  update(dt: number) {
    for (const m of this.marks) {
      if (!m.mesh.visible) continue;
      m.life -= dt; if (m.life <= 0) { m.mesh.visible = false; continue; }
      const p = 1 - m.life / MARK_LIFE;
      m.mesh.scale.setScalar(0.7 + p * m.grow);
      const o = p < 0.1 ? p / 0.1 : 1 - (p - 0.1) / 0.9;
      for (const mat of m.mats) mat.opacity = Math.max(0, o);
    }
    for (const h of this.halves) {
      if (!h.mesh.visible) continue;
      h.life -= dt;
      if (h.life <= 0) { h.mesh.visible = false; continue; }
      h.vel.y -= 9.8 * dt * 0.6;
      h.mesh.position.addScaledVector(h.vel, dt);
      h.mesh.rotation.x += h.spin.x * dt; h.mesh.rotation.y += h.spin.y * dt; h.mesh.rotation.z += h.spin.z * dt;
      h.mesh.updateMatrixWorld();
      const plane = (h.mesh.material as THREE.MeshStandardMaterial).clippingPlanes![0];
      plane.copy(h.local).applyMatrix4(h.mesh.matrixWorld);
      const o = Math.min(1, h.life / 0.4);
      (h.mesh.material as THREE.MeshStandardMaterial).opacity = o; (h.arrow.material as THREE.MeshBasicMaterial).opacity = o;
    }
    const pos = this.points.geometry.attributes.position as THREE.BufferAttribute, col = this.points.geometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < SPARKS; i++) {
      const s = this.sparks[i];
      if (s.life > 0) { s.life -= dt; s.vel.y -= 4 * dt; s.pos.addScaledVector(s.vel, dt); }
      const k = Math.max(0, Math.min(1, s.life * 2.5));
      pos.setXYZ(i, s.pos.x, s.pos.y, s.pos.z);
      col.setXYZ(i, s.color.r * k, s.color.g * k, s.color.b * k);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
  }

  clear() { for (const m of this.marks) m.mesh.visible = false; for (const h of this.halves) h.mesh.visible = false; for (const s of this.sparks) s.life = 0; }
}
