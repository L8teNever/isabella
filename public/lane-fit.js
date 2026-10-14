// Bowlingbahn automatisch in den gescannten Raum legen:
// Boden-Umriss, Waende und Moebel (RoomScan) werden zu einem Raster (5 cm), daraus der freie Abstand
// zum naechsten Hindernis. Gesucht wird die laengste gerade, ausreichend breite Strecke.
// Ergebnis: Kandidaten { foul, dir, dist } – Foul-Linie (Mitte, auf dem Boden), Richtung zu den Kegeln,
// Abstand Foul-Linie -> Kopfkegel.
import * as THREE from 'three';

const CELL = 0.05;
const LANE_HW = 0.45;         // halbe Breite, die frei sein muss (Kegel-Dreieck ~0,92 m breit)
const STAND_HW = 0.3;         // Platz fuer den Spieler hinter der Foul-Linie
const BEHIND = 0.5;           // Anlauf hinter der Foul-Linie
const DECK = 0.79 + 0.35;     // Kegel-Dreieck + Rand dahinter
export const MAX_DIST = 18.29;
export const MIN_DIST = 1.2;

// Freiraum-Feld: at(x, z) = Abstand zum naechsten Hindernis in Metern (0 = belegt/ausserhalb)
export function clearanceField(scan) {
  const pts = [];
  if (scan.floorPoly) pts.push(...scan.floorPoly);
  for (const w of scan.walls) pts.push(...w);
  if (pts.length < 3) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  if (x1 - x0 > 40 || z1 - z0 > 40) return null;
  const nx = Math.ceil((x1 - x0) / CELL) + 1, nz = Math.ceil((z1 - z0) / CELL) + 1;
  const free = new Uint8Array(nx * nz);
  const boxes = scan.boxes.filter((b) => b.center.y - b.size.y / 2 < scan.floorY + 0.5).map((b) => {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    return { cx: b.center.x, cz: b.center.z, c, s, hx: b.size.x / 2 + 0.03, hz: b.size.z / 2 + 0.03 };
  });
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * CELL, z = z0 + j * CELL;
    if (scan.floorPoly && !scan.onFloor(x, z)) continue;
    let ok = true;
    for (const b of boxes) {
      const dx = x - b.cx, dz = z - b.cz;
      // Kiste ist um yaw (um +y) gedreht: in ihre Achsen zurueckdrehen
      const u = dx * b.c - dz * b.s, w = dx * b.s + dz * b.c;
      if (Math.abs(u) < b.hx && Math.abs(w) < b.hz) { ok = false; break; }
    }
    if (ok) for (const [[ax, az], [bx, bz]] of scan.walls) if (segDist(x, z, ax, az, bx, bz) < 0.06) { ok = false; break; }
    if (ok) free[j * nx + i] = 1;
  }
  const clear = distance(free, nx, nz);
  const at = (x, z) => {
    const i = Math.round((x - x0) / CELL), j = Math.round((z - z0) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= nz ? 0 : clear[j * nx + i];
  };
  return { at, x0, x1, z0, z1 };
}

export function findLanes(scan, viewer, fwd) {
  const f = clearanceField(scan); if (!f) return [];
  const { at, x0, x1, z0, z1 } = f;

  const cands = [];
  const step = 0.25;
  for (let z = z0 + step / 2; z < z1; z += step) for (let x = x0 + step / 2; x < x1; x += step) {
    if (at(x, z) < STAND_HW) continue;
    for (let a = 0; a < 72; a++) {
      const th = (a / 72) * Math.PI * 2, dx = Math.sin(th), dz = -Math.cos(th);
      // Laenge der freien Strecke ab hier
      let L = 0;
      while (L < BEHIND + MAX_DIST + DECK) {
        const need = L < BEHIND ? STAND_HW : LANE_HW;
        if (at(x + dx * L, z + dz * L) < need) break;
        L += CELL;
      }
      const dist = Math.min(MAX_DIST, L - BEHIND - DECK);
      if (dist < MIN_DIST) continue;
      const foul = new THREE.Vector3(x + dx * BEHIND, scan.floorY, z + dz * BEHIND);
      const away = Math.hypot(x - viewer.x, z - viewer.z);
      const turn = fwd ? 1 - (dx * fwd.x + dz * fwd.z) : 0;
      cands.push({ foul, dir: new THREE.Vector3(dx, 0, dz), dist, score: dist - 0.25 * away - 0.15 * turn });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  // verschiedene Vorschlaege (andere Richtung oder anderer Ort)
  const out = [];
  for (const c of cands) {
    if (out.some((o) => o.dir.dot(c.dir) > 0.87 && o.foul.distanceTo(c.foul) < 1.2)) continue;
    out.push(c); if (out.length >= 5) break;
  }
  return out;
}

function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)) : 0;
  return Math.hypot(px - ax - vx * t, pz - az - vz * t);
}

// Abstand jeder freien Zelle zur naechsten blockierten (in Metern, Chamfer 3-4)
function distance(free, nx, nz) {
  const INF = 1e9, d = new Float32Array(nx * nz);
  for (let k = 0; k < d.length; k++) d[k] = free[k] ? INF : 0;
  const a = 1, b = Math.SQRT2;
  const get = (i, j) => (i < 0 || j < 0 || i >= nx || j >= nz ? 0 : d[j * nx + i]);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; if (!d[k]) continue;
    d[k] = Math.min(d[k], get(i - 1, j) + a, get(i, j - 1) + a, get(i - 1, j - 1) + b, get(i + 1, j - 1) + b);
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i; if (!d[k]) continue;
    d[k] = Math.min(d[k], get(i + 1, j) + a, get(i, j + 1) + a, get(i + 1, j + 1) + b, get(i - 1, j + 1) + b);
  }
  for (let k = 0; k < d.length; k++) d[k] *= CELL;
  return d;
}
