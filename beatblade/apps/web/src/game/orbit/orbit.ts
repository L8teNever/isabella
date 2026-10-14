// Orbit-Modus: Kugeln an den Haenden, Notenkugeln auf einer freien Flaeche beruehren, Rails folgen.
// Gold = beide Haende, Gruen = eine Hand nach Wahl. Wertung Perfekt/Gut/Schlecht nach Abstand beim Beruehren.
// Alle Noten als InstancedMesh (wenige Draw Calls); Rails als Roehren, deren gespielter Teil abgeschnitten wird.
import * as THREE from 'three';
import { ORBIT, railAt, type LightEvent, type OrbitMap, type OrbitNote, type OrbitRail } from '@beatblade/core';
import type { GameMode } from '../mode';
import { lookahead, rowY, smooth, COLORS } from '../layout';
import type { NoteView } from '../notes';
import type { Slicer } from '../slicer';
import type { Saber } from '../sabers';
import { GLOW, glowMaterial } from '../glow';
import { comboLevel } from '../combo';
import { settings } from '../../settings';
import { colorPair } from '../../look';
import { builtinOrbNote, buildHandOrb, DEFAULT_RAIL, NOTE_R, type HandOrbVisual, type OrbNoteSkin, type RailLook } from './orbskins';
import { GOLD_WINDOW, GRADE_COLOR, RAIL_DIST, TOUCH_DIST, gradeFor, OrbitScore, type Grade } from './orbitscore';

// ---------- Stellschrauben der Darstellung ----------
/** Ebene, an der die Kugeln "auf dem Beat" sind (m vor dem Spieler) */
export const ORB_HIT_Z = -0.45;
export const GOLD_SCALE = 1.45;      // Gold-Kugel groesser
/** Hoehe der Generator-Positionen bezieht sich auf diese Spielergroesse */
const REF_HEIGHT = 1.75;
/** Tiefe zaehlt beim Beruehren nur halb (man trifft die Kugel auch etwas vor/hinter der Ebene) */
const Z_WEIGHT = 0.5;
/** Zeitfenster (s) um den Notenzeitpunkt, in dem beruehrt werden kann */
const WIN_EARLY = 0.22, WIN_LATE = 0.16;
const GOLD_COLOR = 0xffd65a, GREEN_COLOR = 0x4be3a0;
const MAX = 128;

export interface OrbitEvents {
  haptic(hand: 0 | 1, intensity: number, ms: number): void;
  /** Treffer-Sound; noteT = Songzeit der Note (erklingt mit der Musik) */
  touch(intensity: number, noteT?: number): void;
  finished(): void;
  muteNow(): void;
}

/** Modifikatoren, Spielergroesse und Linkshaender-Spiegelung anwenden */
export function prepareOrbit(om: OrbitMap): OrbitMap {
  const m: OrbitMap = JSON.parse(JSON.stringify(om));
  const hs = settings.playerHeight / REF_HEIGHT;
  if (settings.noWalls) m.obstacles = [];
  if (settings.fastNotes) m.speed *= 1.25;
  const fix = (p: { x: number; y: number }) => { p.y *= hs; if (settings.leftHanded) p.x = -p.x; };
  for (const n of m.notes) { fix(n); if (settings.leftHanded) n.hand = (1 - n.hand) as 0 | 1; }
  for (const r of m.rails) { r.points.forEach(fix); if (settings.leftHanded) r.hand = (1 - r.hand) as 0 | 1; }
  if (settings.leftHanded) for (const o of m.obstacles) o.x = 4 - o.x - o.w;
  return m;
}

interface NoteState {
  n: OrbitNote; done: boolean;
  /** kleinster Abstand je Hand waehrend des Fensters (Infinity = nicht beruehrt) und Zeit der Beruehrung */
  best: [number, number]; at: [number, number];
}
interface RailState { r: OrbitRail; mesh: THREE.Mesh; seg: number; held: number; total: number; done: boolean; on: [boolean, boolean] }

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3(), col = new THREE.Color();

export class OrbitGame implements GameMode {
  readonly id = 'orbit' as const;
  map: OrbitMap | null = null;
  score = new OrbitScore();
  inWall = false;
  ended = false;
  colors: [number, number] = [COLORS.left, COLORS.right];
  private notes: NoteState[] = [];
  private rails: RailState[] = [];
  private i0 = 0;
  private look = 2; private speed = 9;
  private wallFx = 0;
  private log: Record<string, unknown>[] = [];
  /** Wegpunkte je Hand fuer Autoplay */
  private paths: [{ t: number; x: number; y: number }[], { t: number; x: number; y: number }[]] = [[], []];
  private group = new THREE.Group();
  private orbs: THREE.InstancedMesh; private halos: THREE.InstancedMesh; private rings: THREE.InstancedMesh;
  private hands: HandOrbVisual[] = [];
  private railMat: THREE.MeshBasicMaterial[] = [];
  private railLook: RailLook = DEFAULT_RAIL;
  private handStyle = '';
  private handPos = [new THREE.Vector3(), new THREE.Vector3()];
  private prevHand = [new THREE.Vector3(), new THREE.Vector3()];

  constructor(public root: THREE.Object3D, public view: NoteView, public slicer: Slicer, public sabers: [Saber, Saber], public ev: OrbitEvents) {
    const skin = builtinOrbNote('neon');
    this.orbs = new THREE.InstancedMesh(skin.geo, skin.mat, MAX);
    this.halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMaterial(GLOW.haloStrength), MAX);
    this.rings = new THREE.InstancedMesh(new THREE.TorusGeometry(NOTE_R * 1.25, 0.012, 6, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }), MAX);
    for (const m of [this.orbs, this.halos, this.rings]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color()); m.count = 0; m.frustumCulled = false;
      this.group.add(m);
    }
    this.halos.renderOrder = 2;
    this.setHandOrb('leuchten');
    for (const c of [this.colors[0], this.colors[1], GOLD_COLOR]) this.railMat.push(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: DEFAULT_RAIL.opacity, depthWrite: false }));
    this.group.visible = false;
    root.add(this.group);
  }

  /** Notenkugel-Skin (Form, Material, Rail-Aussehen) */
  setNoteSkin(skin: OrbNoteSkin) {
    this.orbs.geometry = skin.geo; this.orbs.material = skin.mat;
    const rebuild = skin.rail.width !== this.railLook.width;
    this.railLook = skin.rail;
    if (rebuild) for (const rs of this.rails) { rs.mesh.geometry.dispose(); rs.mesh.geometry = this.railGeo(rs.r); }
    for (const m of this.railMat) { m.opacity = skin.rail.opacity; m.blending = skin.rail.glow ? THREE.AdditiveBlending : THREE.NormalBlending; m.needsUpdate = true; }
  }

  /** Handkugel-Stil (eingebaut: leuchten, ring, kristall) */
  setHandOrb(style: string) {
    if (style === this.handStyle) return;
    this.handStyle = style;
    for (const h of this.hands) this.group.remove(h.group);
    this.hands = [0, 1].map((h) => { const v = buildHandOrb(style, this.colors[h]); this.group.add(v.group); return v; });
  }

  start(om: OrbitMap) {
    this.stop();
    this.map = om;
    this.speed = om.speed;
    this.look = lookahead(om.speed);
    this.notes = om.notes.slice().sort((a, b) => a.t - b.t).map((n) => ({ n, done: false, best: [Infinity, Infinity], at: [0, 0] }));
    this.rails = om.rails.map((r) => this.buildRail(r));
    this.score = new OrbitScore();
    this.score.total = this.notes.length + this.rails.length;
    this.i0 = 0; this.ended = false; this.inWall = false; this.log = [];
    // Autoplay-Pfade
    this.paths = [[], []];
    for (const n of this.notes.map((s) => s.n)) {
      if (n.kind === 'gold') { this.paths[0].push({ t: n.t, x: n.x - ORBIT.goldHandOffset, y: n.y }); this.paths[1].push({ t: n.t, x: n.x + ORBIT.goldHandOffset, y: n.y }); }
      else if (n.rail === undefined) this.paths[n.hand].push({ t: n.t, x: n.x, y: n.y });
    }
    for (const r of om.rails) this.paths[r.hand].push(...r.points);
    for (const p of this.paths) p.sort((a, b) => a.t - b.t);
    this.applyColors();
    this.slicer.clear();
    this.group.visible = true;
  }

  /** Modus verlassen: Kugeln/Rails weg, Schwerter zurueck */
  stop() {
    for (const r of this.rails) { this.group.remove(r.mesh); r.mesh.geometry.dispose(); }
    this.rails = [];
    this.group.visible = false;
  }

  /** Rail als Roehre in eigener Zeit-Achse bauen (z = -(t - t0) * speed); bewegt wird das ganze Mesh */
  private buildRail(r: OrbitRail): RailState {
    const seg = this.railSegs(r);
    const mesh = new THREE.Mesh(this.railGeo(r), this.railMat[r.kind === 'gold' ? 2 : r.hand]);
    mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 3;
    this.group.add(mesh);
    return { r, mesh, seg, held: 0, total: 0, done: false, on: [false, false] };
  }

  private railSegs(r: OrbitRail) { return Math.max(8, r.points.length * 3); }
  private railGeo(r: OrbitRail): THREE.BufferGeometry {
    const pts = r.points.map((p) => new THREE.Vector3(p.x, p.y, -(p.t - r.t0) * this.speed));
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), this.railSegs(r), this.railLook.width, 6, false);
  }

  get lights(): LightEvent[] { return this.map?.lights ?? []; }
  debugLog(): unknown[] { return this.log.slice(-60); }

  applyColors(setOverride?: string) {
    const [l, r] = colorPair(setOverride);
    this.colors = settings.leftHanded ? [r, l] : [l, r];
    for (const h of [0, 1] as const) {
      this.hands[h].tint(this.colors[h]);
      this.railMat[h].color.setHex(this.colors[h]);
      this.sabers[h].setColor(this.colors[h]);
    }
  }

  private z(tt: number, t: number) { return ORB_HIT_Z - (tt - t) * this.speed; }

  get endTime(): number {
    const lastN = this.notes.length ? this.notes[this.notes.length - 1].n.t : 0;
    const lastR = this.rails.reduce((m, r) => Math.max(m, r.r.t1), 0);
    const lastW = (this.map?.obstacles ?? []).reduce((m, o) => Math.max(m, o.t + o.dur), 0);
    return Math.max(lastN, lastR, lastW) + 1.5;
  }

  /** Autoplay: Hand gleitet zwischen ihren Wegpunkten (Noten, Rail-Punkte) */
  autoTarget(hand: 0 | 1, t: number): THREE.Vector3 | null {
    const p = this.paths[hand]; if (!p.length) return null;
    let i = 0; while (i < p.length && p[i].t <= t) i++;
    const a = p[i - 1], b = p[i];
    if (!b) return a && t - a.t < 0.6 ? new THREE.Vector3(a.x, a.y, ORB_HIT_Z) : null;
    if (!a) return b.t - t < 1 ? new THREE.Vector3(b.x, b.y, ORB_HIT_Z) : null;
    if (b.t - a.t > 2.5 && b.t - t > 1 && t - a.t > 0.6) return null;
    const u = smooth((t - a.t) / Math.max(1e-3, b.t - a.t));
    return new THREE.Vector3(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, ORB_HIT_Z);
  }

  update(t: number, dt: number, head: THREE.Vector3, paused: boolean) {
    // Handkugeln an den Controllern; Schwerter bleiben unsichtbar
    for (const h of [0, 1] as const) {
      const sb = this.sabers[h];
      this.prevHand[h].copy(this.handPos[h]);
      this.handPos[h].copy(sb.grip);
      this.hands[h].group.position.copy(sb.grip);
      this.hands[h].group.visible = sb.active;
      this.hands[h].halo.visible = settings.glow;
      this.hands[h].update(dt || 0.016);
      sb.group.visible = false; sb.trail.visible = false; sb.pool.visible = false;
    }
    const lvl = comboLevel(this.score.combo);
    for (const h of [0, 1]) this.hands[h].boost(lvl);

    // ---------- Noten zeichnen und werten ----------
    let n = 0;
    while (this.i0 < this.notes.length && this.notes[this.i0].done) this.i0++;
    for (let i = this.i0; i < this.notes.length; i++) {
      const s = this.notes[i], nt = s.n;
      const dtn = nt.t - t;
      if (dtn > this.look) break;
      if (s.done) continue;
      const z = this.z(nt.t, t);
      if (!paused) {
        if (dtn <= WIN_EARLY) this.track(s, t, z);
        if (dtn < -WIN_LATE || this.ready(s, t)) { this.judge(s, z, t); continue; }
      }
      if (n >= MAX) continue;
      // Einflug: klein auftauchen, wachsen
      const e = smooth((1 - dtn / this.look) / 0.35);
      const size = (nt.kind === 'gold' ? GOLD_SCALE : 1) * (0.25 + 0.75 * e);
      const c = nt.kind === 'gold' ? GOLD_COLOR : nt.kind === 'green' ? GREEN_COLOR : this.colors[nt.hand];
      pv.set(nt.x, nt.y, z); q.identity(); sc.setScalar(size);
      this.orbs.setMatrixAt(n, m4.compose(pv, q, sc)); this.orbs.setColorAt(n, col.setHex(c));
      sc.setScalar(size * NOTE_R * GLOW.haloSize * 2.2);
      this.halos.setMatrixAt(n, m4.compose(pv, q, sc)); this.halos.setColorAt(n, col.setHex(c));
      // Ring zeigt "auf einer Rail" (weiss) bzw. Gruen/Gold
      sc.setScalar(nt.rail !== undefined || nt.kind !== 'normal' ? size : 0);
      this.rings.setMatrixAt(n, m4.compose(pv, q, sc)); this.rings.setColorAt(n, col.setHex(nt.kind === 'normal' ? 0xffffff : c));
      n++;
    }
    for (const m of [this.orbs, this.halos, this.rings]) { m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    this.halos.visible = settings.glow;

    // ---------- Rails ----------
    for (const rs of this.rails) {
      const r = rs.r;
      const vis = !rs.done && r.t0 - t < this.look && r.t1 > t - 0.2;
      rs.mesh.visible = vis;
      if (!vis) continue;
      rs.mesh.position.z = this.z(r.t0, t);
      // gespielten Teil (hinter der Trefferebene) abschneiden
      const played = Math.max(0, Math.min(1, (t - r.t0) / Math.max(1e-3, r.t1 - r.t0)));
      const idx = rs.mesh.geometry.index!;
      const per = idx.count / rs.seg, cut = Math.floor(played * rs.seg) * per;
      rs.mesh.geometry.setDrawRange(cut, idx.count - cut);
      if (paused || t < r.t0) continue;
      const p = railAt(r, t), hp = this.handPos[r.hand];
      const d = Math.hypot(hp.x - p.x, hp.y - p.y, (hp.z - ORB_HIT_Z) * Z_WEIGHT);
      const on = d <= RAIL_DIST;
      rs.total += dt; if (on) rs.held += dt;
      if (on !== rs.on[0]) { rs.on[0] = on; (rs.mesh.material as THREE.MeshBasicMaterial).opacity = on ? Math.min(1, this.railLook.opacity + 0.25) : this.railLook.opacity; }
      if (on && Math.random() < dt * 20) this.slicer.burst(pv.set(p.x, p.y, ORB_HIT_Z).clone(), r.kind === 'gold' ? GOLD_COLOR : this.colors[r.hand], 3);
      if (on) this.ev.haptic(r.hand, 0.15, 16);
      if (t >= r.t1) {
        rs.done = true; rs.mesh.visible = false;
        const share = rs.total > 0 ? rs.held / rs.total : 0;
        this.score.rail(share, r.t1 - r.t0);
        this.log.push({ t: Math.round(t * 1000) / 1000, rail: Math.round(share * 100) });
        if (share < 0.8) { this.slicer.error(new THREE.Vector3(p.x, p.y, ORB_HIT_Z), 20); if (settings.missMute) this.ev.muteNow(); }
      }
    }

    // ---------- Waende (gleiche Darstellung/Skins wie Schnitt) ----------
    const v = this.view; v.begin();
    this.inWall = false;
    for (const o of this.map?.obstacles ?? []) {
      if (o.t - t > this.look + 0.5 || o.t + o.dur - t < -1.5) continue;
      const zf = Math.min(this.z(o.t, t), 3), zb = this.z(o.t + o.dur, t);
      if (zb > 3) continue;
      v.addWall(o.x, o.w, zf, zb, o.kind === 'crouch', rowY(0));
      const x0 = (o.x - 1.5) * 0.55 - 0.275, x1 = (o.x + o.w - 1 - 1.5) * 0.55 + 0.275;
      const yMin = o.kind === 'crouch' ? rowY(0) + 0.75 : -1, mg = 0.08;
      if (head.x > x0 + mg && head.x < x1 - mg && head.y > yMin + mg && head.z < zf && head.z > zb) this.inWall = true;
    }
    v.end();
    if (paused) return;
    if (this.inWall) {
      this.score.wall(dt);
      this.wallFx -= dt;
      if (this.wallFx <= 0) { this.wallFx = 0.12; this.slicer.error(new THREE.Vector3(head.x, head.y, head.z - 0.35), 14); }
    }
    if (!this.ended && t > this.endTime) { this.ended = true; this.ev.finished(); }
  }

  /** Abstand der Hand zur Note (Tiefe halb gewichtet), auch zwischen zwei Bildern (schnelle Bewegungen) */
  private dist(h: 0 | 1, x: number, y: number, z: number): number {
    const a = this.prevHand[h], b = this.handPos[h];
    let best = Infinity;
    for (let k = 0; k <= 4; k++) {
      const u = k / 4;
      const px = a.x + (b.x - a.x) * u, py = a.y + (b.y - a.y) * u, pz = a.z + (b.z - a.z) * u;
      best = Math.min(best, Math.hypot(px - x, py - y, (pz - z) * Z_WEIGHT));
    }
    return best;
  }

  private handsFor(n: OrbitNote): (0 | 1)[] { return n.kind === 'normal' ? [n.hand] : [0, 1]; }

  /** kleinsten Abstand je Hand im Fenster merken */
  private track(s: NoteState, t: number, z: number) {
    for (const h of this.handsFor(s.n)) {
      if (!this.sabers[h].active) continue;
      // Gold beruehrt man mit beiden Haenden links/rechts der Mitte
      const x = s.n.kind === 'gold' ? s.n.x + (h === 0 ? -1 : 1) * ORBIT.goldHandOffset : s.n.x;
      const d = this.dist(h, x, s.n.y, z);
      if (d <= TOUCH_DIST && d < s.best[h]) { if (s.best[h] === Infinity) s.at[h] = t; s.best[h] = d; }
    }
  }

  /** frueh werten, sobald klar ist: beruehrt und Hand entfernt sich wieder */
  private ready(s: NoteState, t: number): boolean {
    const n = s.n;
    if (n.kind === 'gold') return s.best[0] < Infinity && s.best[1] < Infinity && t - Math.max(s.at[0], s.at[1]) > 0.06;
    const hs = this.handsFor(n);
    return hs.some((h) => s.best[h] < Infinity && t - s.at[h] > 0.08);
  }

  private judge(s: NoteState, z: number, t: number) {
    s.done = true;
    const n = s.n, pos = new THREE.Vector3(n.x, n.y, Math.min(z, ORB_HIT_Z + 0.2));
    let g: Grade | null = null, d = Infinity;
    if (n.kind === 'gold') {
      const both = s.best[0] < Infinity && s.best[1] < Infinity;
      d = Math.max(s.best[0], s.best[1]);
      if (both) g = Math.abs(s.at[0] - s.at[1]) <= GOLD_WINDOW ? gradeFor(d) : 'schlecht';
      else if (s.best[0] < Infinity || s.best[1] < Infinity) g = 'schlecht';
    } else {
      d = Math.min(...this.handsFor(n).map((h) => s.best[h]));
      if (d < Infinity) g = gradeFor(d);
    }
    this.log.push({ t: Math.round(n.t * 1000) / 1000, kind: n.kind, hand: n.hand, grade: g ?? 'verpasst', d: d < Infinity ? Math.round(d * 100) / 100 : null, at: Math.round(t * 1000) / 1000 });
    if (!g) {
      this.score.miss();
      this.slicer.error(pos, 24);
      if (settings.missMute) this.ev.muteNow();
      return;
    }
    this.score.touch(g);
    const c = n.kind === 'gold' ? GOLD_COLOR : n.kind === 'green' ? GREEN_COLOR : this.colors[n.hand];
    this.slicer.good(pos, new THREE.Color(GRADE_COLOR[g]).getHex());
    this.slicer.burst(pos, c, g === 'perfekt' ? 18 + Math.round(comboLevel(this.score.combo) * 30) : g === 'gut' ? 12 : 5);
    for (const h of this.handsFor(n)) if (s.best[h] < Infinity) this.ev.haptic(h, g === 'perfekt' ? 0.8 : 0.5, 45);
    this.ev.touch(g === 'perfekt' ? 1 : g === 'gut' ? 0.75 : 0.45, n.t);
  }
}
