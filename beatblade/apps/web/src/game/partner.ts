// Partner im Duett: Charakter (Kopf, Oberkoerper, zwei Haende mit seinen Schwertern bzw. Handkugeln) immer RECHTS
// neben mir – in VR und MR, in der Lobby und im Song. Seine Noten laufen halbtransparent auf seiner eigenen,
// verkleinerten Spur (nie ueberlappend mit meiner), in seinen Farben und mit seinen Skins.
// Posen kommen mit ~15 Hz in Spielfeld-Koordinaten und werden mit PARTNER_DELAY Puffer weich interpoliert.
import * as THREE from 'three';
import type { Beatmap, GameModeId, MpLook, MpPlayEvent, MpPose, OrbitMap } from '@beatblade/core';
import { NoteView } from './notes';
import { Slicer } from './slicer';
import { Saber } from './sabers';
import { Game } from './game';
import { OrbitGame } from './orbit/orbit';
import { HIT_Z, rowY, LANE_W, DUET_LANE_X, FIELD_HALF, DUET_GAP, SABER_LEN } from './layout';
import { buildSaberVisual, type SaberVisual } from './sabervisuals';
import type { HandOrbVisual } from './orbit/orbskins';
import { buildSaberFor, buildHandOrbFor, loadBlockSkin, loadOrbNoteSkin } from '../look';

// ---------- Stellschrauben ----------
/** Mitte der Partnerspur: so weit rechts neben meiner Spielfeld-Mitte (m) – eigene, volle Bahn in der Map */
export const PARTNER_OFFSET = DUET_LANE_X;
/** Charakter leicht zu mir gedreht (rad) */
export const PARTNER_YAW = 0.35;
/** seitliche Bewegung des Partners: auf seiner Spur gehalten (m) */
export const PARTNER_SIDE_MAX = 0.6;
/** Haende nie naeher an meine Spur als das (x in m): Mitte der Luecke zwischen beiden Spielfeldern */
export const PARTNER_HAND_MIN_X = FIELD_HALF + DUET_GAP / 2;
/** Partnerspur in voller Groesse auf seiner eigenen Bahn (kleiner als 1 = verkleinert) */
export const PARTNER_LANE_SCALE = 1;
/** Bildschirm-Debug: Charakter nach vorn ins Bild holen (m) */
export const PARTNER_DESKTOP_FORWARD = 1.4;
/** Interpolations-Puffer (ms) */
export const PARTNER_DELAY = 100;
/** Deckkraft der Partner-Noten */
export const PARTNER_NOTE_OPACITY = 0.35;

/** Abstand der Partner-Klingenspitze zu meinem Spielfeldrand (m) */
export const PARTNER_BLADE_MARGIN = 0.15;
const TMP_Q = new THREE.Quaternion(), TMP_Q2 = new THREE.Quaternion(), TMP_F = new THREE.Quaternion(), TMP_E = new THREE.Euler();
const TMP_P = new THREE.Vector3(), TMP_D = new THREE.Vector3(), TMP_N = new THREE.Vector3();

interface Sample { t: number; head: number[]; hands: number[] }
const parseHex = (c: string) => parseInt(c.slice(1), 16);

/** Schrift-Schild (Name, „Verpasst“) */
function label(text: string, color: string, w = 512): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = w; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20,12,40,0.75)'; g.beginPath(); g.roundRect?.(8, 8, w - 16, 112, 56); g.fill();
  g.fillStyle = color; g.font = '800 64px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text.slice(0, 18), w / 2, 66, w - 40);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set((0.6 * w) / 512, 0.15, 1);
  return s;
}

export class Partner {
  /** haengt an stage: wandert bei setDirection()/Neu-Zentrieren mit */
  group = new THREE.Group();
  private char = new THREE.Group();
  private head: THREE.Mesh;
  private torso: THREE.Mesh;
  private hands: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private handVis: [THREE.Object3D | null, THREE.Object3D | null] = [null, null];
  private orbVis: [HandOrbVisual | null, HandOrbVisual | null] = [null, null];
  private tag: THREE.Sprite | null = null;
  private missTag: THREE.Sprite;
  private missT = 0;
  private flash: THREE.Mesh;
  private flashT = 0;
  private buf: Sample[] = [];
  private lane = new THREE.Group();
  private ghost: Game | OrbitGame | null = null;
  private ghostSchnitt: Game;
  private ghostOrbit: OrbitGame;
  private view: NoteView;
  private slicer: Slicer;
  private key = '';
  private skinKey = '';
  private fadeT = 0;
  name = '';
  colors: [number, number] = [0xff8a1a, 0x3dff7a];
  mode: GameModeId = 'schnitt';
  /** Bildschirm-Debug (Charakter weiter vorn, damit er im Bild ist) */
  desktop = false;

  constructor(stage: THREE.Object3D) {
    stage.add(this.group);
    const glow = (c: number, o = 0.85) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false });
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), glow(0xffffff, 0.9));
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.05), glow(0x140a28, 0.95)); visor.position.set(0, 0.015, -0.1); this.head.add(visor);
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.32, 6, 16), glow(0xffffff, 0.45));
    this.char.add(this.head, this.torso, ...this.hands);
    this.missTag = label('Verpasst', '#ff6b8a'); this.missTag.visible = false; this.char.add(this.missTag);
    this.char.visible = false;
    // Partnerspur: rechts, verkleinert um die Trefferebene (gleiche Hoehe/Tiefe wie meine)
    const k = PARTNER_LANE_SCALE;
    this.lane.position.set(PARTNER_OFFSET, rowY(1) * (1 - k), HIT_Z * (1 - k));
    this.lane.scale.setScalar(k);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W * 4.4, 30).rotateX(-Math.PI / 2).translate(0, 0.01, -15), new THREE.MeshBasicMaterial({ color: 0xff2040, transparent: true, opacity: 0, depthWrite: false }));
    this.flash.visible = false; this.lane.add(this.flash);
    this.group.add(this.char, this.lane);
    // Partner-Noten: eigene Spielmodi ohne Treffer (unsichtbare, inaktive Schwerter; Fehler-Funken aus)
    this.view = new NoteView(this.lane, false);
    this.slicer = new Slicer(this.lane, this.view.cubeGeo, this.view.arrows.geometry);
    this.slicer.error = () => {};
    const sabers: [Saber, Saber] = [new Saber(0, this.lane), new Saber(1, this.lane)];
    for (const s of sabers) s.hide();
    const noop = { haptic: () => {}, slice: () => {}, touch: () => {}, finished: () => {}, muteNow: () => {} };
    this.ghostSchnitt = new Game(this.lane, this.view, this.slicer, sabers, noop);
    this.ghostOrbit = new OrbitGame(this.lane, this.view, this.slicer, sabers, noop);
    this.lane.visible = false;
    this.setColors(this.colors);
  }

  /** Name, Farben, Skins und Modus des Partners; baut nur neu, was sich geaendert hat */
  setInfo(name: string, colors: [string, string], look: MpLook | undefined, mode: GameModeId) {
    const cols: [number, number] = [parseHex(colors[0]), parseHex(colors[1])];
    if (name !== this.name) {
      this.name = name;
      if (this.tag) { this.char.remove(this.tag); this.tag.material.map?.dispose(); }
      this.tag = label(name || 'Partner', '#ffffff'); this.char.add(this.tag);
    }
    const key = `${mode}|${cols.join(',')}|${look?.saberSkin}|${look?.saberSkinRight}|${look?.orbSkin}`;
    if (key !== this.key) {
      this.key = key; this.mode = mode;
      this.setColors(cols);
      this.buildHands(look);
    }
    const sk = `${look?.blockSkin}|${look?.orbNoteSkin}`;
    if (sk !== this.skinKey) { this.skinKey = sk; this.loadNoteSkins(look); }
  }

  private setColors(c: [number, number]) {
    this.colors = c;
    (this.head.material as THREE.MeshBasicMaterial).color.setHex(new THREE.Color(c[0]).lerp(new THREE.Color(0xffffff), 0.55).getHex());
    (this.torso.material as THREE.MeshBasicMaterial).color.setHex(new THREE.Color(c[0]).lerp(new THREE.Color(c[1]), 0.5).getHex());
    this.ghostSchnitt.colorsOverride = c; this.ghostOrbit.colorsOverride = c;
    this.ghostSchnitt.applyColors(); this.ghostOrbit.applyColors();
  }

  /** Haende: Schwerter (Schnitt) bzw. Handkugeln (Orbit) des Partners; erst Standard, dann seine Skins, wenn geladen */
  private buildHands(look: MpLook | undefined) {
    const key = this.key;
    for (const h of [0, 1] as const) {
      if (this.handVis[h]) this.hands[h].remove(this.handVis[h]!);
      this.handVis[h] = null; this.orbVis[h] = null;
      const color = this.colors[h];
      if (this.mode === 'orbit') {
        buildHandOrbFor(look?.orbSkin ?? '', color).then((v) => { if (this.key !== key) return; this.orbVis[h] = v; this.put(h, v.group); }).catch(() => {});
      } else {
        const std = buildSaberVisual('classic', 1, color); this.put(h, std.group);
        const id = h === 1 && look?.saberSkinRight ? look.saberSkinRight : look?.saberSkin ?? '';
        buildSaberFor(id, color).then((v: SaberVisual) => { if (this.key === key) this.put(h, v.group); }).catch(() => {});
      }
    }
  }
  private put(h: 0 | 1, o: THREE.Object3D) {
    if (this.handVis[h]) this.hands[h].remove(this.handVis[h]!);
    this.handVis[h] = o; this.hands[h].add(o);
  }

  /** Block- bzw. Notenkugel-Skin des Partners fuer seine Noten (eigene Materialien, meine bleiben unberuehrt) */
  private loadNoteSkins(look: MpLook | undefined) {
    loadBlockSkin(look?.blockSkin || undefined).then((s) => {
      const own = { geo: s.geo, mat: s.mat.clone() };
      this.view.setSkin(own); this.slicer.setSkin(own.geo, own.mat); this.fade();
    }).catch(() => {});
    loadOrbNoteSkin(look?.orbNoteSkin || undefined).then((s) => {
      const mat = Array.isArray(s.mat) ? s.mat.map((m) => m.clone()) : s.mat.clone();
      this.ghostOrbit.setNoteSkin({ ...s, mat } as typeof s); this.fade();
    }).catch(() => {});
  }

  /** Noten der anderen Stimme zeigen (null = aus) */
  setGhost(map: Beatmap | OrbitMap | null) {
    if (this.ghost === this.ghostOrbit) this.ghostOrbit.stop();
    this.ghost = null; this.lane.visible = false;
    if (!map) return;
    if ('rails' in map) { this.ghostOrbit.start({ ...map, obstacles: [] }); this.ghost = this.ghostOrbit; }
    else { this.ghostSchnitt.start({ ...map, obstacles: [], bombs: [] }); this.ghost = this.ghostSchnitt; }
    this.lane.visible = true;
    this.fade();
  }

  /** halbtransparent: jedes Material der Spur einmal kopieren und abschwaechen (meine Materialien bleiben) */
  private fade() {
    this.lane.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.material || o === this.flash) return;
      const conv = (m: THREE.Material) => {
        if (m.userData.ghost) return m;
        const c = m.clone(); c.userData.ghost = true; c.transparent = true; c.depthWrite = false; c.opacity = (m.opacity ?? 1) * PARTNER_NOTE_OPACITY;
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material);
    });
  }

  push(p: MpPose) {
    this.buf.push({ t: performance.now(), head: p.head, hands: p.hands });
    if (this.buf.length > 30) this.buf.shift();
  }

  clear() { this.buf = []; this.char.visible = false; this.setGhost(null); }
  hideChar() { this.buf = []; this.char.visible = false; }

  /** Ereignis des Partners sichtbar machen: Fehler -> Spur blinkt rot, „Verpasst“ ueber dem Kopf; Treffer -> Funken */
  event(kind: MpPlayEvent, hand: number) {
    if (kind === 'hit') {
      const c = this.colors[hand === 1 ? 1 : 0];
      this.slicer.burst(new THREE.Vector3((hand === 1 ? 0.4 : hand === 0 ? -0.4 : 0), rowY(1), HIT_Z), c, 18);
    } else if (kind !== 'combo') {
      this.flashT = 0.45; this.missT = 0.9;
    }
  }

  /** Kopf des Partner-Charakters in Buehnen-Koordinaten (fuer den Raumklang) */
  /** Klinge nie in mein Spielfeld: zeigt sie zu weit nach links, wird sie bis zur Kante (FIELD_HALF + Rand) hochgedreht */
  private keepBladeOut(h: THREE.Object3D) {
    const qc = TMP_Q.setFromEuler(TMP_E.set(0, PARTNER_YAW, 0));
    const p = TMP_P.copy(h.position).applyQuaternion(qc); p.x += PARTNER_OFFSET;
    const q = TMP_Q2.copy(qc).multiply(h.quaternion);
    const d = TMP_D.set(0, 0, -1).applyQuaternion(q);
    const lim = FIELD_HALF + PARTNER_BLADE_MARGIN;
    if (d.x >= 0 || p.x + d.x * SABER_LEN >= lim) return;
    const nx = Math.max(-1, Math.min(0, (lim - p.x) / SABER_LEN)), r = Math.hypot(d.y, d.z), s = Math.sqrt(1 - nx * nx);
    const nd = r > 1e-4 ? TMP_N.set(nx, (d.y / r) * s, (d.z / r) * s) : TMP_N.set(nx, s, 0);
    const fix = TMP_F.setFromUnitVectors(d, nd);
    h.quaternion.copy(qc.invert().multiply(fix).multiply(q));
  }

  headPos(out: THREE.Vector3): THREE.Vector3 { return out.copy(this.head.position).applyMatrix4(this.char.matrix).applyMatrix4(this.group.matrix); }
  get visible() { return this.char.visible; }

  update(songT: number, dt: number, head: THREE.Vector3, paused: boolean) {
    if (this.ghost && this.lane.visible) {
      this.ghost.update(songT, dt, head, paused);
      this.slicer.update(dt);
      if ((this.fadeT += dt) > 1) { this.fadeT = 0; this.fade(); }   // dynamisch entstandene Teile (Rails, Labels)
    }
    // Fehler-Hinweise abklingen lassen
    this.flashT = Math.max(0, this.flashT - dt); this.missT = Math.max(0, this.missT - dt);
    (this.flash.material as THREE.MeshBasicMaterial).opacity = this.flashT * 0.5; this.flash.visible = this.flashT > 0;
    this.missTag.visible = this.missT > 0;
    for (const v of this.orbVis) v?.update(dt);
    if (!this.buf.length) { this.char.visible = false; return; }
    const t = performance.now() - PARTNER_DELAY;
    let a = this.buf[0], b = this.buf[this.buf.length - 1];
    for (let i = 1; i < this.buf.length; i++) if (this.buf[i].t >= t) { a = this.buf[i - 1]; b = this.buf[i]; break; }
    const k = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 1;
    const lerp = (A: number[], B: number[], i: number, o: THREE.Object3D) => {
      o.position.set(A[i] + (B[i] - A[i]) * k, A[i + 1] + (B[i + 1] - A[i + 1]) * k, A[i + 2] + (B[i + 2] - A[i + 2]) * k);
      o.quaternion.set(A[i + 3], A[i + 4], A[i + 5], A[i + 6]).slerp(new THREE.Quaternion(B[i + 3], B[i + 4], B[i + 5], B[i + 6]), k);
    };
    lerp(a.head, b.head, 0, this.head);
    lerp(a.hands, b.hands, 0, this.hands[0]);
    lerp(a.hands, b.hands, 7, this.hands[1]);
    // auf seiner Spur halten: Kopf seitlich begrenzt, Haende nie Richtung meiner Spur
    const hx = this.head.position.x, cx = Math.max(-PARTNER_SIDE_MAX, Math.min(PARTNER_SIDE_MAX, hx)), dx = cx - hx;
    this.head.position.x = cx;
    const fwd = this.desktop ? -PARTNER_DESKTOP_FORWARD : 0;
    for (const h of this.hands) { h.position.x = Math.max(PARTNER_HAND_MIN_X - PARTNER_OFFSET, h.position.x + dx); h.position.z += fwd; this.keepBladeOut(h); }
    this.head.position.z += fwd;
    // Oberkoerper haengt unter dem Kopf und dreht sich nur um die Hochachse mit
    const e = new THREE.Euler().setFromQuaternion(this.head.quaternion, 'YXZ');
    this.torso.position.set(this.head.position.x, this.head.position.y - 0.42, this.head.position.z + 0.05);
    this.torso.rotation.set(0, e.y, 0);
    if (this.tag) this.tag.position.copy(this.head.position).add(new THREE.Vector3(0, 0.3, 0));
    this.missTag.position.copy(this.head.position).add(new THREE.Vector3(0, 0.48, 0));
    // Charakter rechts auf seiner Spur, leicht zu mir gedreht (Drehung um seine Spurmitte)
    this.char.position.set(PARTNER_OFFSET, 0, 0);
    this.char.rotation.y = PARTNER_YAW;
    this.char.visible = performance.now() - this.buf[this.buf.length - 1].t < 2000;
  }
}
