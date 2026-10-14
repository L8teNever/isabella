// Darstellung der Bloecke, Pfeile, Punkte, Bomben (InstancedMesh, wenige Draw Calls) und Waende (Pool).
import * as THREE from 'three';
import { Cut, cutVector } from '@beatblade/core';
import { COLORS, NOTE_SIZE, LANE_W } from './layout';

const MAX = 160;
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

/** Pfeil-Winkel um Z, sodass das Chevron (zeigt nach -Y) in Schnittrichtung zeigt */
export function cutAngle(d: Cut): number {
  const [vx, vy] = cutVector(d);
  return Math.atan2(vx, -vy);
}

function roundedBox(size: number, r: number): THREE.BufferGeometry {
  // Box mit abgeschraegten Kanten: BoxGeometry mit Segmenten, Ecken auf eine kleinere Box projiziert
  const g = new THREE.BoxGeometry(size, size, size, 4, 4, 4);
  const pos = g.attributes.position as THREE.BufferAttribute, h = size / 2 - r, v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    c.set(Math.max(-h, Math.min(h, v.x)), Math.max(-h, Math.min(h, v.y)), Math.max(-h, Math.min(h, v.z)));
    const d = v.clone().sub(c); if (d.lengthSq() > 0) d.setLength(r);
    pos.setXYZ(i, c.x + d.x, c.y + d.y, c.z + d.z);
  }
  g.computeVertexNormals();
  return g;
}

export class NoteView {
  cubes: THREE.InstancedMesh;
  arrows: THREE.InstancedMesh;
  dots: THREE.InstancedMesh;
  bombs: THREE.InstancedMesh;
  walls: THREE.Mesh[] = [];
  private wallGeo = new THREE.BoxGeometry(1, 1, 1);
  private wallMat: THREE.MeshBasicMaterial;
  private wallEdgeMat: THREE.LineBasicMaterial;
  nCubes = 0; nArrows = 0; nDots = 0; nBombs = 0; nWalls = 0;
  readonly cubeGeo: THREE.BufferGeometry;
  readonly cubeMat: THREE.MeshStandardMaterial;

  constructor(private root: THREE.Object3D, mr: boolean) {
    this.cubeGeo = roundedBox(NOTE_SIZE, 0.06);
    this.cubeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.15, emissive: 0x111111 });
    this.cubes = new THREE.InstancedMesh(this.cubeGeo, this.cubeMat, MAX);
    this.cubes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    // Pfeil (Chevron) auf der Vorderseite
    const sh = new THREE.Shape();
    const w = NOTE_SIZE * 0.36, hgt = NOTE_SIZE * 0.2;
    sh.moveTo(-w, hgt * 0.4); sh.lineTo(w, hgt * 0.4); sh.lineTo(0, -hgt); sh.lineTo(-w, hgt * 0.4);
    const ag = new THREE.ShapeGeometry(sh); ag.translate(0, -NOTE_SIZE * 0.05, NOTE_SIZE / 2 + 0.003);
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.arrows = new THREE.InstancedMesh(ag, white, MAX);
    const dg = new THREE.CircleGeometry(NOTE_SIZE * 0.13, 20); dg.translate(0, 0, NOTE_SIZE / 2 + 0.003);
    this.dots = new THREE.InstancedMesh(dg, white, MAX);
    // Bombe: dunkle Kugel mit Stacheln
    const bg = new THREE.IcosahedronGeometry(NOTE_SIZE * 0.38, 1);
    const bpos = bg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < bpos.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(bpos, i); const spike = (i % 3 === 0 ? 1.25 : 1); v.multiplyScalar(spike); bpos.setXYZ(i, v.x, v.y, v.z); }
    bg.computeVertexNormals();
    this.bombs = new THREE.InstancedMesh(bg, new THREE.MeshStandardMaterial({ color: COLORS.bomb, roughness: 0.5, metalness: 0.6, emissive: 0x330a14 }), 64);
    for (const m of [this.cubes, this.arrows, this.dots, this.bombs]) { m.frustumCulled = false; m.count = 0; root.add(m); }
    this.wallMat = new THREE.MeshBasicMaterial({ color: 0xff5470, transparent: true, opacity: mr ? 0.28 : 0.22, depthWrite: false, side: THREE.DoubleSide });
    this.wallEdgeMat = new THREE.LineBasicMaterial({ color: 0xff8aa0, transparent: true, opacity: 0.9 });
  }

  begin() { this.nCubes = this.nArrows = this.nDots = this.nBombs = this.nWalls = 0; }

  addNote(x: number, y: number, z: number, color: number, d: Cut, scale = 1, spin = 0) {
    if (this.nCubes >= MAX) return;
    q.setFromAxisAngle(Z, cutAngle(d) + spin); s.setScalar(scale); p.set(x, y, z);
    m4.compose(p, q, s);
    this.cubes.setMatrixAt(this.nCubes, m4);
    this.cubes.setColorAt(this.nCubes, new THREE.Color(color));
    this.nCubes++;
    if (d === Cut.Any) { this.dots.setMatrixAt(this.nDots++, m4); }
    else this.arrows.setMatrixAt(this.nArrows++, m4);
  }

  addBomb(x: number, y: number, z: number, rot: number) {
    if (this.nBombs >= 64) return;
    q.setFromEuler(new THREE.Euler(rot, rot * 0.7, 0)); s.setScalar(1); p.set(x, y, z);
    this.bombs.setMatrixAt(this.nBombs++, m4.compose(p, q, s));
  }

  /** Wand von Spalte x (Breite w) zwischen zFront und zBack; crouch = nur oben */
  addWall(x: number, w: number, zFront: number, zBack: number, crouch: boolean, rowBase: number) {
    let m = this.walls[this.nWalls];
    if (!m) {
      m = new THREE.Mesh(this.wallGeo, this.wallMat);
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.wallGeo), this.wallEdgeMat));
      m.renderOrder = 5; this.root.add(m); this.walls.push(m);
    }
    const x0 = (x - 1.5) * LANE_W - LANE_W / 2, x1 = (x + w - 1 - 1.5) * LANE_W + LANE_W / 2;
    const y0 = crouch ? rowBase + 0.75 : 0, y1 = crouch ? 3 : 3;
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (zFront + zBack) / 2);
    m.scale.set(x1 - x0 - 0.04, y1 - y0, Math.max(0.05, zFront - zBack));
    m.visible = true; this.nWalls++;
  }

  end() {
    this.cubes.count = this.nCubes; this.arrows.count = this.nArrows; this.dots.count = this.nDots; this.bombs.count = this.nBombs;
    for (const m of [this.cubes, this.arrows, this.dots, this.bombs]) m.instanceMatrix.needsUpdate = true;
    if (this.cubes.instanceColor) this.cubes.instanceColor.needsUpdate = true;
    for (let i = this.nWalls; i < this.walls.length; i++) this.walls[i].visible = false;
  }
}
