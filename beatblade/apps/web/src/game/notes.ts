// Darstellung der Bloecke, Pfeile, Punkte, Bomben (InstancedMesh, wenige Draw Calls) und Waende (Pool).
import * as THREE from 'three';
import { Cut, cutVector } from '@beatblade/core';
import { COLORS, NOTE_SIZE, LANE_W } from './layout';
import { GLOW, glowMaterial } from './glow';
import { builtinBlock, type BlockSkin } from './blockskins';
import { settings } from '../settings';

const MAX = 160;
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const col = new THREE.Color(), I = new THREE.Quaternion();

/** Pfeil-Winkel um Z, sodass das Chevron (zeigt nach -Y) in Schnittrichtung zeigt */
export function cutAngle(d: Cut): number {
  const [vx, vy] = cutVector(d);
  return Math.atan2(vx, -vy);
}

export class NoteView {
  cubes: THREE.InstancedMesh;
  arrows: THREE.InstancedMesh;
  dots: THREE.InstancedMesh;
  bombs: THREE.InstancedMesh;
  /** Leuchten: Halo hinter dem Block, Leucht-Rand, Lichtfleck am Boden */
  halos: THREE.InstancedMesh; shells: THREE.InstancedMesh; pools: THREE.InstancedMesh;
  walls: THREE.Mesh[] = [];
  private wallGeo = new THREE.BoxGeometry(1, 1, 1);
  private wallMat: THREE.Material;
  private wallEdgeMat: THREE.LineBasicMaterial;
  /** bewegte Textur (Energiefeld) */
  private wallTex: THREE.Texture | null = null;
  private mr: boolean;
  nCubes = 0; nArrows = 0; nDots = 0; nBombs = 0; nWalls = 0;
  cubeGeo: THREE.BufferGeometry;
  cubeMat: THREE.MeshStandardMaterial;

  constructor(private root: THREE.Object3D, mr: boolean) {
    const skin = builtinBlock('neon-cube');
    this.cubeGeo = skin.geo; this.cubeMat = skin.mat;
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
    // Leuchten (instanziert: 3 Draw Calls fuer alle Bloecke)
    const inst = () => new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMaterial(GLOW.haloStrength), MAX); this.halos.instanceColor = inst();
    this.shells = new THREE.InstancedMesh(this.cubeGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: GLOW.shellStrength, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide }), MAX); this.shells.instanceColor = inst();
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), glowMaterial(GLOW.poolStrength), MAX); this.pools.instanceColor = inst();
    this.halos.renderOrder = 1; this.pools.renderOrder = 1;
    for (const m of [this.cubes, this.arrows, this.dots, this.bombs, this.halos, this.shells, this.pools]) { m.frustumCulled = false; m.count = 0; root.add(m); }
    this.mr = mr;
    [this.wallMat, this.wallEdgeMat] = this.wallMaterials('neon-glass');
  }

  private nGlow = 0;

  /** Wand-Skins: Neon-Glas (bisher), Energiefeld (bewegte Streifen), Stein/Metall */
  private wallMaterials(style: string): [THREE.Material, THREE.LineBasicMaterial] {
    this.wallTex = null;
    if (style === 'energy') {
      const c = document.createElement('canvas'); c.width = 8; c.height = 64;
      const g = c.getContext('2d')!;
      for (let y = 0; y < 64; y++) { const a = 0.25 + 0.75 * Math.pow(Math.sin((y / 64) * Math.PI * 4) * 0.5 + 0.5, 3); g.fillStyle = `rgba(80,220,255,${a})`; g.fillRect(0, y, 8, 1); }
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 3); this.wallTex = t;
      return [new THREE.MeshBasicMaterial({ map: t, color: 0xffffff, transparent: true, opacity: this.mr ? 0.4 : 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
        new THREE.LineBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.95 })];
    }
    if (style === 'stone-metal') {
      return [new THREE.MeshStandardMaterial({ color: 0x3a3f4a, metalness: 0.7, roughness: 0.45, emissive: 0x15171c, transparent: true, opacity: this.mr ? 0.65 : 0.72, depthWrite: false, side: THREE.DoubleSide }),
        new THREE.LineBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.95 })];
    }
    return [new THREE.MeshBasicMaterial({ color: 0xff5470, transparent: true, opacity: this.mr ? 0.28 : 0.22, depthWrite: false, side: THREE.DoubleSide }),
      new THREE.LineBasicMaterial({ color: 0xff8aa0, transparent: true, opacity: 0.9 })];
  }

  /** Wand-Skin wechseln (alle Waende im Pool) */
  setWallSkin(style: string) {
    this.wallMat.dispose(); this.wallEdgeMat.dispose();
    [this.wallMat, this.wallEdgeMat] = this.wallMaterials(style);
    for (const w of this.walls) { w.material = this.wallMat; (w.children[0] as THREE.LineSegments).material = this.wallEdgeMat; }
  }

  /** Block-Skin wechseln (Form + Material); Leucht-Rand folgt der Form */
  setSkin(skin: BlockSkin) {
    this.cubeGeo = skin.geo; this.cubeMat = skin.mat;
    this.cubes.geometry = skin.geo; this.cubes.material = skin.mat;
    this.shells.geometry = skin.geo;
  }
  begin() { this.nCubes = this.nArrows = this.nDots = this.nBombs = this.nWalls = this.nGlow = 0; }

  addNote(x: number, y: number, z: number, color: number, d: Cut, scale = 1, spin = 0) {
    if (this.nCubes >= MAX) return;
    q.setFromAxisAngle(Z, cutAngle(d) + spin); s.setScalar(scale); p.set(x, y, z);
    m4.compose(p, q, s);
    this.cubes.setMatrixAt(this.nCubes, m4);
    this.cubes.setColorAt(this.nCubes, new THREE.Color(color));
    this.nCubes++;
    if (d === Cut.Any) { this.dots.setMatrixAt(this.nDots++, m4); }
    else this.arrows.setMatrixAt(this.nArrows++, m4);
    if (settings.glow) {
      const i = this.nGlow++;
      // Leucht-Rand: gleiche Lage, etwas groesser
      s.setScalar(scale * GLOW.shellScale); this.shells.setMatrixAt(i, m4.compose(p, q, s));
      // Halo: knapp hinter dem Block, immer aufrecht
      s.set(NOTE_SIZE * GLOW.haloSize * scale, NOTE_SIZE * GLOW.haloSize * scale, 1); p.set(x, y, z - NOTE_SIZE * 0.6);
      this.halos.setMatrixAt(i, m4.compose(p, I, s));
      // Lichtfleck am Boden, schwaecher je hoeher der Block
      const k = Math.max(0, 1 - y / GLOW.poolFadeHeight) * scale;
      s.set(GLOW.poolSize * scale, 1, GLOW.poolSize * scale); p.set(x, 0.012, z);
      this.pools.setMatrixAt(i, m4.compose(p, I, s));
      col.setHex(color); this.halos.setColorAt(i, col); this.shells.setColorAt(i, col);
      this.pools.setColorAt(i, col.multiplyScalar(k));
    }
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
    this.halos.count = this.shells.count = this.pools.count = this.nGlow;
    for (const m of [this.cubes, this.arrows, this.dots, this.bombs, this.halos, this.shells, this.pools]) m.instanceMatrix.needsUpdate = true;
    for (const m of [this.halos, this.shells, this.pools]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (this.cubes.instanceColor) this.cubes.instanceColor.needsUpdate = true;
    for (let i = this.nWalls; i < this.walls.length; i++) this.walls[i].visible = false;
    if (this.wallTex) this.wallTex.offset.y = (this.wallTex.offset.y + 0.006) % 1;
  }
}
