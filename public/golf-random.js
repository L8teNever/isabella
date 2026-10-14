// Zufallsbahnen fuer Minigolf: mehrere Loecher, die in den freien Raum passen (Moebel/Waende werden umgangen).
// Jedes Loch ist gerade oder ein Knick (Dogleg) und bekommt ein Thema: Banden, Sprungschanze, Slalom,
// Drehkreuz, Tunnel, Huegel, Looping mit Boost, Sand- und Wasserhindernisse.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// field.at(x, z) -> freier Abstand in m; ohne Raum-Scan: Quadrat um den Spieler
export function virtualField(center, size = 6) {
  const h = size / 2;
  return { at: (x, z) => Math.max(0, Math.min(h - Math.abs(x - center.x), h - Math.abs(z - center.z))),
    x0: center.x - h, x1: center.x + h, z0: center.z - h, z1: center.z + h };
}

// Pfad aus Punkten (xz) mit Hilfsfunktionen
function makePath(pts) {
  const seg = []; let L = 0;
  for (let i = 1; i < pts.length; i++) { const l = pts[i].distanceTo(pts[i - 1]); seg.push(l); L += l; }
  const at = (t) => {
    let d = t * L;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i] || i === seg.length - 1) {
        const a = pts[i], b = pts[i + 1], u = Math.min(1, d / seg[i]);
        return { p: a.clone().lerp(b, u), dir: b.clone().sub(a).normalize(), i };
      }
      d -= seg[i];
    }
  };
  return { pts, L, at, seg };
}

export function generateCourse(course, field, { viewer, fwd, floorY, holes = 3 }) {
  const placed = [];                 // Punkte bereits gebauter Loecher (Abstand halten)
  for (const it of course.items) placed.push(it.obj.position.clone().setY(0));
  const ok = (p, need) => field.at(p.x, p.z) >= need && placed.every((q) => q.distanceTo(p) > 0.55);
  const made = [];
  for (let h = 0; h < holes; h++) {
    let path = null;
    for (let tries = 0; tries < 400 && !path; tries++) {
      // erster Start nahe beim Spieler, sonst irgendwo frei
      let tee;
      if (h === 0 && tries < 150) tee = viewer.clone().addScaledVector(fwd, rnd(0.4, 1)).add(new THREE.Vector3(rnd(-0.5, 0.5), 0, rnd(-0.5, 0.5)));
      else tee = new THREE.Vector3(rnd(field.x0, field.x1), 0, rnd(field.z0, field.z1));
      tee.y = 0;
      if (!ok(tee, 0.35)) continue;
      const a0 = h === 0 && tries < 150 ? Math.atan2(fwd.x, fwd.z) + rnd(-0.6, 0.6) : rnd(0, Math.PI * 2);
      const d0 = new THREE.Vector3(Math.sin(a0), 0, Math.cos(a0));
      const pts = [tee];
      if (Math.random() < 0.45) {        // Knick
        const l1 = rnd(1.1, 2), l2 = rnd(0.9, 1.8), turn = (Math.random() < 0.5 ? -1 : 1) * rnd(0.7, 1.4);
        const c = tee.clone().addScaledVector(d0, l1);
        pts.push(c, c.clone().addScaledVector(d0.clone().applyAxisAngle(UP, turn), l2));
      } else pts.push(tee.clone().addScaledVector(d0, rnd(1.8, 3.6)));
      const P = makePath(pts);
      let good = true;
      for (let d = 0; d <= P.L && good; d += 0.05) good = ok(P.at(d / P.L).p, 0.3);
      if (good) path = P;
    }
    if (!path) break;
    for (let d = 0; d <= path.L; d += 0.1) placed.push(path.at(d / path.L).p);
    made.push(buildHole(course, path, field, floorY));
  }
  return made.length;
}

function buildHole(course, path, field, floorY) {
  const n = course.nextHoleNumber('tee');
  const Y = (p) => p.clone().setY(floorY);
  const yawOf = (d) => Math.atan2(d.x, d.z);
  const first = path.at(0), last = path.at(1);
  course.add('tee', Y(path.pts[0]), yawOf(first.dir), n);
  course.add('cup', Y(path.pts.at(-1)), yawOf(last.dir), n);
  const add = (type, t, side = 0, opts = {}, yawAdd = 0) => {
    const { p, dir } = path.at(t);
    const s = new THREE.Vector3(-dir.z, 0, dir.x);
    const q = p.clone().addScaledVector(s, side);
    if (field.at(q.x, q.z) < 0.12) return null;
    return course.add(type, Y(q), yawOf(dir) + yawAdd, undefined, opts);
  };
  // Banden entlang gerader Stuecke (sieht aus wie eine echte Minigolfbahn)
  const rails = Math.random() < 0.6;
  if (rails) {
    let d0 = 0;
    path.seg.forEach((l, i) => {
      const a = path.pts[i], b = path.pts[i + 1], dir = b.clone().sub(a).normalize(), s = new THREE.Vector3(-dir.z, 0, dir.x);
      const from = i === 0 ? 0.25 : 0.2, to = l - (i === path.seg.length - 1 ? 0.35 : 0.2);
      for (let u = from; u + 0.2 < to; u += 0.55) {
        const len = Math.min(0.5, to - u), mid = a.clone().addScaledVector(dir, u + len / 2);
        for (const e of [-1, 1]) {
          const q = mid.clone().addScaledVector(s, e * 0.27);
          if (field.at(q.x, q.z) > 0.06) course.add('wall', Y(q), yawOf(dir) + Math.PI / 2, undefined, { s: [len / 0.5, 1, 1] });
        }
      }
      d0 += l;
    });
  }
  // Knick: schraege Bande aussen in der Ecke zum Anspielen
  if (path.pts.length === 3) {
    const a = path.pts[0], c = path.pts[1], b = path.pts[2];
    const out = c.clone().sub(a).normalize().add(c.clone().sub(b).normalize()).normalize();
    const q = c.clone().addScaledVector(out, 0.3);
    if (field.at(q.x, q.z) > 0.08) course.add('wall', Y(q), Math.atan2(out.x, out.z) + Math.PI / 2, undefined, { s: [1.3, 1.2, 1] });
  }
  // Thema
  const themes = ['jump', 'slalom', 'spinner', 'tunnel', 'hill', 'loop', 'bunker', 'water', 'mix'];
  const theme = pick(themes), t = rnd(0.35, 0.55);
  if (theme === 'jump') { add('ramp', t); add('sand', Math.min(0.85, t + 0.2), 0, { s: [0.9, 1, 1.1] }); }
  else if (theme === 'slalom') { add('bumper', t - 0.12, 0.11); add('bumper', t, -0.11); add('bumper', t + 0.12, 0.11); }
  else if (theme === 'spinner') { add('spinner', t, 0, { s: [1.1, 1, 1] }); }
  else if (theme === 'tunnel') { add('tunnel', t); add('bumper', Math.min(0.85, t + 0.22), 0.12); }
  else if (theme === 'hill') { add('hill', t, 0, { s: [1.2, 1, 1] }); add('bumper', Math.min(0.85, t + 0.2), -0.12); }
  else if (theme === 'loop') { add('boost', t - 0.12); add('loop', t + 0.05); }
  else if (theme === 'bunker') { add('sand', 0.8, 0.18); add('sand', t, -0.15, { s: [0.8, 1, 1.4] }); }
  else if (theme === 'water') { add('water', t, rails ? 0.55 : 0.4, { s: [1, 1, 1.3] }); add('ramp', t - 0.1); }
  else { add('boost', 0.2); add('hill', t); add('spinner', Math.min(0.85, t + 0.22)); }
  return n;
}
