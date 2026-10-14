// Spielablauf: Noten/Bomben/Waende nach Songzeit bewegen, Treffer (Swept-Collision) erkennen,
// Richtung pruefen, schneiden, Punkte/Energie fuehren, Fehlschlaege und Wand-Kollision werten.
import * as THREE from 'three';
import { Cut, cutVector, type Beatmap, type Note, type Bomb, type Obstacle } from '@beatblade/core';
import { HIT_Z, laneX, rowY, COLORS, lookahead, NOTE_SIZE } from './layout';
import { NoteView } from './notes';
import { Slicer, ERROR_COLOR } from './slicer';
import { Saber, FollowThrough } from './sabers';
import { ScoreKeeper } from './score';
import { comboLevel } from './combo';
import { settings } from '../settings';

interface NoteState { n: Note; done: boolean; muted?: boolean; }
interface BombState { b: Bomb; done: boolean; }

export interface GameEvents {
  haptic(hand: 0 | 1, intensity: number, ms: number): void;
  slice(intensity: number): void;
  finished(): void;
  /** Planungs-Vorlauf der Audio-Ausgabe (s) – so frueh muss ein Aussetzer feststehen */
  audioLead(): number;
  /** Musik an Songzeit t aussetzen / Aussetzer zuruecknehmen */
  muteAt(t: number): void;
  unmute(): void;
}

const HIT_R = 0.4;            // Treffer-Radius um die Notenmitte (grosszuegig, wie in Rhythmus-Spielen ueblich)
const BOMB_R = 0.2;
const MIN_SPEED = 0.7;        // m/s Spitzengeschwindigkeit fuer einen gueltigen Schnitt
const ANGLE_TOL = 70;         // Grad
const MUTE_DECIDE = 0.03;     // Verfehlt = stumm: so viel (s) vor dem Planungs-Zeitpunkt wird entschieden
const MUTE_SPAN = 0.16;       // Noten innerhalb dieses Abstands teilen sich einen Aussetzer

/** Modifikatoren und Linkshaender-Spiegelung anwenden */
export function prepareMap(bm: Beatmap): Beatmap {
  const m: Beatmap = JSON.parse(JSON.stringify(bm));
  if (settings.noWalls) m.obstacles = [];
  if (settings.noBombs) m.bombs = [];
  if (settings.fastNotes) m.njs *= 1.25;
  if (settings.leftHanded) {
    const mirror: Partial<Record<Cut, Cut>> = { [Cut.Left]: Cut.Right, [Cut.Right]: Cut.Left, [Cut.UpLeft]: Cut.UpRight, [Cut.UpRight]: Cut.UpLeft, [Cut.DownLeft]: Cut.DownRight, [Cut.DownRight]: Cut.DownLeft };
    for (const n of m.notes) { n.x = 3 - n.x; n.c = (1 - n.c) as 0 | 1; n.d = mirror[n.d] ?? n.d; }
    for (const b of m.bombs) b.x = 3 - b.x;
    for (const o of m.obstacles) o.x = 4 - o.x - o.w;
  }
  return m;
}

export class Game {
  notes: NoteState[] = []; bombs: BombState[] = []; walls: Obstacle[] = [];
  map: Beatmap | null = null;
  score = new ScoreKeeper();
  private look = 1.2; private speed = 16;
  private follows: FollowThrough[] = [];
  private i0 = 0; private b0 = 0;
  inWall = false;
  private wallFx = 0;
  /** Protokoll aller Schnitte (zur Fehlersuche an den Server) */
  cutLog: Record<string, unknown>[] = [];
  ended = false;
  lastT = 0;
  colors: [number, number] = [COLORS.left, COLORS.right];

  constructor(public root: THREE.Object3D, public view: NoteView, public slicer: Slicer, public sabers: [Saber, Saber], public ev: GameEvents) {}

  start(bm: Beatmap) {
    this.map = bm;
    this.notes = bm.notes.slice().sort((a, b) => a.t - b.t).map((n) => ({ n, done: false }));
    this.bombs = bm.bombs.slice().sort((a, b) => a.t - b.t).map((b) => ({ b, done: false }));
    this.walls = bm.obstacles.slice();
    this.score = new ScoreKeeper();
    this.score.total = this.notes.length;
    this.speed = bm.njs;
    this.look = lookahead(bm.njs, bm.bpm, bm.offset);
    this.follows = []; this.cutLog = []; this.i0 = 0; this.b0 = 0; this.ended = false; this.inWall = false;
    this.colors = settings.leftHanded ? [COLORS.right, COLORS.left] : [COLORS.left, COLORS.right];
    this.sabers[0].setColor(this.colors[0]); this.sabers[1].setColor(this.colors[1]);
    this.slicer.clear();
  }

  /** z-Position fuer ein Objekt mit Zeit tt bei Songzeit t */
  private z(tt: number, t: number) { return HIT_Z - (tt - t) * this.speed; }

  /** Ende der Musik/Noten */
  get endTime(): number {
    const lastNote = this.notes.length ? this.notes[this.notes.length - 1].n.t : 0;
    const lastWall = this.walls.reduce((m, o) => Math.max(m, o.t + o.dur), 0);
    return Math.max(lastNote, lastWall) + 1.5;
  }

  update(t: number, dt: number, head: THREE.Vector3, paused: boolean) {
    const v = this.view; v.begin();
    // ---------- Noten zeichnen + Fehlschlaege ----------
    while (this.i0 < this.notes.length && this.notes[this.i0].done) this.i0++;
    for (let i = this.i0; i < this.notes.length; i++) {
      const s = this.notes[i], n = s.n;
      const dtn = n.t - t;
      if (dtn > this.look) break;
      if (s.done) continue;
      const z = this.z(n.t, t);
      if (!paused && z > HIT_Z + 0.65) { s.done = true; this.score.miss(); this.slicer.error(new THREE.Vector3(laneX(n.x), rowY(n.y), HIT_Z - 0.6), 30); continue; }   // vorbeigeflogen
      // Verfehlt = stumm: noch nicht getroffen, kurz bevor die Musik diese Stelle spielt -> Aussetzer einplanen
      if (!paused && settings.missMute && !s.muted && dtn <= this.ev.audioLead() + MUTE_DECIDE) { s.muted = true; this.ev.muteAt(n.t); }
      // Einflug: aus dem Boden hochspringen und aufdrehen (erste 40 % der Vorlaufzeit)
      const p = Math.min(1, Math.max(0, 1 - dtn / this.look) / 0.4), e = 1 - (1 - p) ** 3;
      const y = rowY(n.y) * e + (1 - e) * 0.1;
      v.addNote(laneX(n.x), y, z, this.colors[n.c], n.d, 0.6 + 0.4 * e, (1 - e) * Math.PI);
    }
    while (this.b0 < this.bombs.length && this.bombs[this.b0].done) this.b0++;
    for (let i = this.b0; i < this.bombs.length; i++) {
      const s = this.bombs[i], b = s.b, dtn = b.t - t;
      if (dtn > this.look) break; if (s.done) continue;
      const z = this.z(b.t, t);
      if (z > HIT_Z + 1) { s.done = true; continue; }
      v.addBomb(laneX(b.x), rowY(b.y), z, t * 2 + i);
    }
    // ---------- Waende ----------
    this.inWall = false;
    for (const o of this.walls) {
      if (o.t - t > this.look + 0.5 || o.t + o.dur - t < -1.5) continue;
      const zf = Math.min(this.z(o.t, t), 3), zb = this.z(o.t + o.dur, t);
      if (zb > 3) continue;
      v.addWall(o.x, o.w, zf, zb, o.kind === 'crouch', rowY(0));
      // Kopf in der Wand?
      const x0 = laneX(o.x) - 0.275, x1 = laneX(o.x + o.w - 1) + 0.275;
      const yMin = o.kind === 'crouch' ? rowY(0) + 0.75 : -1;
      // 8 cm Toleranz: nur wer wirklich mit dem Kopf in der Wand steht, verliert Energie
      const m = 0.08;
      if (head.x > x0 + m && head.x < x1 - m && head.y > yMin + m && head.z < zf && head.z > zb) this.inWall = true;
    }
    v.end();
    if (paused) return;
    if (this.inWall) {
      this.score.wall(dt);
      // rote Funken vor dem Gesicht, solange man in der Wand steht
      this.wallFx -= dt;
      if (this.wallFx <= 0) { this.wallFx = 0.12; this.slicer.burst(new THREE.Vector3(head.x, head.y, head.z - 0.35), ERROR_COLOR, 14); }
    }

    // ---------- Treffer ----------
    for (const saber of this.sabers) if (saber.active) this.collide(saber, t);
    const now = performance.now() / 1000;
    for (const f of this.follows) f.update(now);
    this.follows = this.follows.filter((f) => !f.done);
    this.lastT = t;
    if (!this.ended && t > this.endTime) { this.ended = true; this.ev.finished(); }
  }

  /** Swept-Collision: Klinge zwischen letztem und aktuellem Bild abtasten (schnelle Schlaege rutschen nicht durch) */
  private collide(sb: Saber, t: number) {
    const steps = 6, along = 10;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = i / steps;
      const h = sb.prevHilt.clone().lerp(sb.hilt, a), tp = sb.prevTip.clone().lerp(sb.tip, a);
      for (let j = 2; j <= along; j++) pts.push(h.clone().lerp(tp, j / along));
    }
    // Noten in Reichweite
    for (let i = this.i0; i < this.notes.length; i++) {
      const s = this.notes[i]; const n = s.n;
      if (n.t - t > 0.6) break;
      if (s.done) continue;
      const c = new THREE.Vector3(laneX(n.x), rowY(n.y), this.z(n.t, t));
      if (c.z < HIT_Z - 1.4) continue;
      let best = Infinity;
      for (const p of pts) { const d = p.distanceToSquared(c); if (d < best) best = d; }
      if (best > HIT_R * HIT_R) continue;
      this.resolveCut(s, sb, c, Math.sqrt(best), t);
    }
    for (let i = this.b0; i < this.bombs.length; i++) {
      const s = this.bombs[i]; if (s.b.t - t > 0.6) break; if (s.done) continue;
      const c = new THREE.Vector3(laneX(s.b.x), rowY(s.b.y), this.z(s.b.t, t));
      if (pts.some((p) => p.distanceToSquared(c) < BOMB_R * BOMB_R)) {
        s.done = true; this.score.bomb();
        this.slicer.burst(c, 0x666677, 30); this.slicer.error(c, 40);
        this.ev.haptic(sb.hand, 1, 160);
      }
    }
  }

  private resolveCut(s: NoteState, sb: Saber, c: THREE.Vector3, dist: number, t: number) {
    const n = s.n;
    const vel = sb.tipVelocity();
    const v2 = new THREE.Vector2(vel.x, vel.y);
    const speed = v2.length();
    // Richtung pruefen (Pfeil-Vektor in der Spielfeld-Ebene)
    let okDir = true;
    // Pfeile 'egal': Richtung wird nicht geprueft, jeder saubere Schnitt (Farbe + Mindesttempo) zaehlt
    if (n.d !== Cut.Any && settings.arrows === 'pflicht') {
      const [ax, ay] = cutVector(n.d);
      const ang = speed > 0.01 ? (Math.acos(Math.max(-1, Math.min(1, (v2.x * ax + v2.y * ay) / speed))) * 180) / Math.PI : 180;
      okDir = ang <= ANGLE_TOL;
    }
    const okColor = sb.hand === n.c;
    this.cutLog.push({ t: Math.round(t * 1000) / 1000, hand: sb.hand, c: n.c, d: n.d, vx: Math.round(v2.x * 100) / 100, vy: Math.round(v2.y * 100) / 100, okDir, okColor, dist: Math.round(dist * 100) / 100 });
    if (speed < MIN_SPEED && okColor) return;          // zu langsam: kein Schnitt (Note fliegt weiter)
    s.done = true;
    const normal = new THREE.Vector3().crossVectors(sb.dir, vel.clone().normalize()).normalize();
    if (normal.lengthSq() < 0.5) normal.set(1, 0, 0);
    this.slicer.cut(c, n.d, this.colors[n.c], normal, new THREE.Vector3(0, 0, this.speed), okColor && okDir ? 16 + Math.round(comboLevel(this.score.combo) * 50) : 6);
    if (!okColor || !okDir) {
      this.score.miss(true, okColor ? 'dir' : 'color');
      this.slicer.error(c, 36);
      this.ev.haptic(sb.hand, 0.3, 40);
      if (settings.missMute && !s.muted) { s.muted = true; this.ev.muteAt(n.t); }
      return;
    }
    // doch noch getroffen: geplanten Aussetzer zuruecknehmen (ausser eine Nachbarnote bleibt verfehlt)
    if (s.muted) {
      s.muted = false;
      if (!this.notes.some((o) => o.muted && Math.abs(o.n.t - n.t) < MUTE_SPAN)) this.ev.unmute();
    }
    this.slicer.good(c, this.colors[n.c]);
    const mult = this.score.hit();
    const pre = Math.min(70, (sb.preSwingAngle() / 100) * 70);
    const acc = 15 * (1 - Math.min(1, dist / (NOTE_SIZE * 0.75)));
    this.ev.haptic(sb.hand, 0.7, 50);
    this.ev.slice(1);
    this.follows.push(new FollowThrough(sb, performance.now() / 1000, (post) => { this.score.finalize(pre, (post / 60) * 30, acc, mult); }));
  }
}
