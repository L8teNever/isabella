// Pruefung eines Orbit-Levels: Handgeschwindigkeit, Ueberkreuzen, zu nahe Kugeln, Noten in Waenden,
// Bereich, Rails, lokale Dichte. Liefert Zaehler je Problem und eine Spielbarkeits-Note (0..100).
import type { OrbitMap, OrbitNote, OrbitRail, Obstacle } from '../../types.js';
import { ORBIT, ORBIT_DIFFICULTY } from './tuning.js';

/** ein Punkt, an dem eine Hand zu einer Zeit sein muss */
export interface HandPoint { t: number; x: number; y: number; note?: OrbitNote; rail?: number }

/** Wand-Bereich in Metern (x von..bis) */
export function wallSpan(o: Obstacle): [number, number] {
  return [ORBIT.wallX0 + o.x * ORBIT.wallCol, ORBIT.wallX0 + (o.x + o.w) * ORBIT.wallCol];
}

export function wallActive(o: Obstacle, t: number): boolean {
  return t >= o.t - 0.15 && t <= o.t + o.dur + 0.1;
}

/** Position auf einer Rail zur Zeit t (linear zwischen den Stuetzpunkten) */
export function railAt(r: OrbitRail, t: number): { x: number; y: number } {
  const p = r.points;
  if (t <= p[0].t) return { x: p[0].x, y: p[0].y };
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i].t) {
      const u = (t - p[i - 1].t) / Math.max(1e-6, p[i].t - p[i - 1].t);
      return { x: p[i - 1].x + u * (p[i].x - p[i - 1].x), y: p[i - 1].y + u * (p[i].y - p[i - 1].y) };
    }
  }
  return { x: p[p.length - 1].x, y: p[p.length - 1].y };
}

/** alle Punkte einer Hand in Zeitreihenfolge (Noten, Gold auf beiden Haenden, Rail-Stuetzpunkte) */
export function handPath(m: Pick<OrbitMap, 'notes' | 'rails'>, hand: 0 | 1): HandPoint[] {
  const pts: HandPoint[] = [];
  for (const n of m.notes) {
    if (n.kind === 'gold') pts.push({ t: n.t, x: n.x + (hand === 0 ? -1 : 1) * ORBIT.goldHandOffset, y: n.y, note: n });
    else if (n.hand === hand && n.rail === undefined) pts.push({ t: n.t, x: n.x, y: n.y, note: n });
  }
  m.rails.forEach((r, i) => { if (r.hand === hand) for (const p of r.points) pts.push({ t: p.t, x: p.x, y: p.y, rail: i }); });
  return pts.sort((a, b) => a.t - b.t || (a.rail !== undefined ? -1 : 1));
}

/** Noten, die eine Hand zu schnell erreichen muesste (jeweils die spaetere der beiden) */
export function speedViolations(m: Pick<OrbitMap, 'notes' | 'rails'>, maxSpeed: number): OrbitNote[] {
  const bad = new Set<OrbitNote>();
  for (const hand of [0, 1] as const) {
    const p = handPath(m, hand);
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      if (a.rail !== undefined && a.rail === b.rail) continue;          // Rail-Verlauf prueft railJump
      const d = Math.hypot(b.x - a.x, b.y - a.y), dt = b.t - a.t;
      if (d < 0.02) continue;
      if (dt < 1e-3 || d / dt > maxSpeed * 1.001) {
        const victim = b.note ?? a.note;
        if (victim) bad.add(victim);
      }
    }
  }
  return [...bad];
}

export function checkOrbit(m: OrbitMap): Record<string, number> {
  const D = ORBIT_DIFFICULTY[m.difficulty];
  const iss: Record<string, number> = {};
  const add = (k: string, n = 1) => { iss[k] = (iss[k] ?? 0) + n; };

  const fast = speedViolations(m, D.maxHandSpeed).length;
  if (fast) add('handSpeed', fast);

  const paths = [handPath(m, 0), handPath(m, 1)];
  const lastBefore = (p: HandPoint[], t: number) => { let r: HandPoint | undefined; for (const q of p) { if (q.t > t + 0.05) break; if (q.t >= t - 0.4) r = q; } return r; };
  for (const n of m.notes) {
    if (n.x < ORBIT.minX - 1e-6 || n.x > ORBIT.maxX + 1e-6 || n.y < ORBIT.minY - 1e-6 || n.y > ORBIT.maxY + 1e-6) add('outOfArea');
    if (n.kind !== 'gold') {
      const other = lastBefore(paths[1 - n.hand], n.t);
      if (other) {
        const lx = n.hand === 0 ? n.x : other.x, rx = n.hand === 0 ? other.x : n.x;
        if (lx > rx + 0.05) add('crossing');
      }
    }
    for (const o of m.obstacles) {
      if (!wallActive(o, n.t)) continue;
      if (o.kind === 'crouch') { if (n.y > ORBIT.crouchMaxY + 1e-6) add('inWall'); continue; }
      const [x0, x1] = wallSpan(o);
      const r = n.kind === 'gold' ? ORBIT.goldHandOffset : 0;
      if (n.x + r > x0 - ORBIT.wallMargin + 1e-6 && n.x - r < x1 + ORBIT.wallMargin - 1e-6) add('inWall');
    }
  }
  // gleichzeitige Kugeln verschiedener Haende zu nah beieinander
  const ns = [...m.notes].sort((a, b) => a.t - b.t);
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length && ns[j].t - ns[i].t < 0.06; j++) {
      const a = ns[i], b = ns[j];
      if (a.kind === 'gold' || b.kind === 'gold' || a.hand === b.hand) { add('stacked'); continue; }
      if (Math.hypot(a.x - b.x, a.y - b.y) < ORBIT.minSpread - 1e-6) add('spread');
    }
  }
  // Rails
  for (const r of m.rails) {
    if (r.t1 - r.t0 < 0.4 || r.points.length < 2) add('railShort');
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1], b = r.points[i];
      const dt = b.t - a.t;
      if (dt <= 0 || Math.hypot(b.x - a.x, b.y - a.y) / dt > D.maxHandSpeed * 1.2) { add('railJump'); break; }
    }
  }
  for (let i = 1; i < m.rails.length; i++) {
    const a = m.rails[i - 1], b = m.rails[i];
    if (b.t0 < a.t1) add('railOverlap');
  }
  // lokale Dichte (1-s-Fenster, gleichzeitige Noten zaehlen einmal)
  const u = [...new Set(ns.map((n) => Math.round(n.t * 50)))].sort((a, b) => a - b).map((x) => x / 50);
  let j = 0;
  for (let i = 0; i < u.length; i++) {
    while (u[i] - u[j] >= 1 - 1e-9) j++;
    if (i - j + 1 > Math.floor(D.maxLocalNps) + 1) add('density');
  }
  return iss;
}

/** Spielbarkeit 0..100 aus den Problem-Zaehlern */
export function orbitPlayability(iss: Record<string, number>): number {
  const W: Record<string, number> = { handSpeed: 8, crossing: 6, inWall: 15, spread: 4, stacked: 6, outOfArea: 5, railShort: 3, railJump: 4, railOverlap: 8, density: 2 };
  let p = 100;
  for (const [k, n] of Object.entries(iss)) p -= (W[k] ?? 3) * n;
  return Math.max(0, Math.round(p));
}
