// Partner im Duett: einfacher Avatar (leuchtender Kopf mit Namensschild, zwei Hand-Kugeln) auf einer virtuellen
// Nachbarspur, dazu optional die Noten seiner Stimme halbtransparent (ohne Treffer-Logik).
// Posen kommen mit ~15 Hz in Spielfeld-Koordinaten und werden mit PARTNER_DELAY Puffer weich interpoliert.
import * as THREE from 'three';
import type { Beatmap, MpPose, OrbitMap } from '@beatblade/core';
import { NoteView } from './notes';
import { Slicer } from './slicer';
import { Saber } from './sabers';
import { Game } from './game';
import { OrbitGame } from './orbit/orbit';
import type { GameMode } from './mode';

// ---------- Stellschrauben ----------
/** Nachbarspur: so weit rechts neben dem eigenen Spielfeld (m) */
export const PARTNER_OFFSET = 2.2;
/** leicht zu dir gedreht (rad) */
export const PARTNER_TURN = 0.3;
/** Interpolations-Puffer (ms) */
export const PARTNER_DELAY = 100;
/** Deckkraft der Partner-Noten */
export const PARTNER_NOTE_OPACITY = 0.3;
const COL_HEAD = 0xffe08a, COL_L = 0xff9d3d, COL_R = 0x7dffcf;

interface Sample { t: number; head: number[]; hands: number[] }

export class Partner {
  group = new THREE.Group();
  private avatar = new THREE.Group();
  private head: THREE.Mesh;
  private hands: [THREE.Mesh, THREE.Mesh];
  private tag: THREE.Sprite;
  private buf: Sample[] = [];
  private ghost: GameMode | null = null;
  private ghostRoot = new THREE.Group();
  private ghostSchnitt: Game;
  private ghostOrbit: OrbitGame;
  private name = '';

  constructor(root: THREE.Object3D) {
    this.group.position.set(PARTNER_OFFSET, 0, 0);
    this.group.rotation.y = PARTNER_TURN;
    root.add(this.group);
    const glow = (c: number, o = 0.85) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false });
    this.head = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.06, 6, 16), glow(COL_HEAD));
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.04), glow(0x1a1030, 0.9)); visor.position.set(0, 0.02, -0.1); this.head.add(visor);
    this.hands = [new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), glow(COL_L)), new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), glow(COL_R))];
    // kurze Klinge je Hand (vereinfachtes Schwert)
    for (const [i, h] of this.hands.entries()) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.7), glow(i ? COL_R : COL_L, 0.6)); b.position.z = -0.38; h.add(b); }
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    this.tag.scale.set(0.6, 0.15, 1);
    this.avatar.add(this.head, ...this.hands, this.tag);
    this.avatar.visible = false;
    this.group.add(this.avatar, this.ghostRoot);
    // Partner-Noten: eigene Spielmodi ohne Treffer (unsichtbare, inaktive Schwerter; Fehler-Funken aus)
    const view = new NoteView(this.ghostRoot, false);
    const slicer = new Slicer(this.ghostRoot, view.cubeGeo, view.arrows.geometry);
    slicer.error = () => {};
    const sabers: [Saber, Saber] = [new Saber(0, this.ghostRoot), new Saber(1, this.ghostRoot)];
    for (const s of sabers) s.hide();
    const noop = { haptic: () => {}, slice: () => {}, touch: () => {}, finished: () => {}, muteNow: () => {} };
    this.ghostSchnitt = new Game(this.ghostRoot, view, slicer, sabers, noop);
    this.ghostOrbit = new OrbitGame(this.ghostRoot, view, slicer, sabers, noop);
    this.ghostRoot.visible = false;
  }

  setName(name: string) {
    if (name === this.name) return;
    this.name = name;
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(20,12,40,0.75)'; g.beginPath(); g.roundRect?.(8, 8, 496, 112, 56); g.fill();
    g.fillStyle = '#ffe08a'; g.font = '700 64px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name.slice(0, 16), 256, 66);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    (this.tag.material as THREE.SpriteMaterial).map?.dispose();
    (this.tag.material as THREE.SpriteMaterial).map = t; (this.tag.material as THREE.SpriteMaterial).needsUpdate = true;
  }

  /** Noten der anderen Stimme zeigen (null = aus) */
  setGhost(map: Beatmap | OrbitMap | null) {
    if (this.ghost === this.ghostOrbit) this.ghostOrbit.stop();
    this.ghost = null; this.ghostRoot.visible = false;
    if (!map) return;
    if ('rails' in map) { this.ghostOrbit.start({ ...map, obstacles: [] }); this.ghost = this.ghostOrbit; }
    else { this.ghostSchnitt.start({ ...map, obstacles: [], bombs: [] }); this.ghost = this.ghostSchnitt; }
    this.ghostRoot.visible = true;
    // halbtransparent (einmal je Material)
    this.ghostRoot.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        if (mat.userData.ghost) continue;
        mat.userData.ghost = true; mat.transparent = true; mat.depthWrite = false;
        mat.opacity = (mat.opacity ?? 1) * PARTNER_NOTE_OPACITY;
      }
    });
  }

  push(p: MpPose) {
    this.buf.push({ t: performance.now(), head: p.head, hands: p.hands });
    if (this.buf.length > 30) this.buf.shift();
  }

  show(on: boolean) { this.avatar.visible = on && this.buf.length > 0; if (!on) this.buf = []; }
  clear() { this.buf = []; this.avatar.visible = false; this.setGhost(null); }

  update(songT: number, dt: number, head: THREE.Vector3, paused: boolean) {
    if (this.ghost) this.ghost.update(songT, dt, head, paused);
    if (!this.buf.length) return;
    const t = performance.now() - PARTNER_DELAY;
    let a = this.buf[0], b = this.buf[this.buf.length - 1];
    for (let i = 1; i < this.buf.length; i++) if (this.buf[i].t >= t) { a = this.buf[i - 1]; b = this.buf[i]; break; }
    const k = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 1;
    const pose = (o: THREE.Object3D, A: number[], B: number[], i: number) => {
      o.position.set(A[i] + (B[i] - A[i]) * k, A[i + 1] + (B[i + 1] - A[i + 1]) * k, A[i + 2] + (B[i + 2] - A[i + 2]) * k);
      o.quaternion.set(A[i + 3], A[i + 4], A[i + 5], A[i + 6]).slerp(new THREE.Quaternion(B[i + 3], B[i + 4], B[i + 5], B[i + 6]), k);
    };
    pose(this.head, a.head, b.head, 0);
    pose(this.hands[0], a.hands, b.hands, 0);
    pose(this.hands[1], a.hands, b.hands, 7);
    this.tag.position.copy(this.head.position).add(new THREE.Vector3(0, 0.3, 0));
    // keine Daten mehr seit 2 s: ausblenden
    this.avatar.visible = performance.now() - this.buf[this.buf.length - 1].t < 2000;
  }
}
