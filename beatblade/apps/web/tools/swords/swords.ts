// Prozedurale Schwert-Modelle fuer content/sabers/ (Frostklinge, Glutklinge).
// Wird von tools/swords/build.mjs im Browser gebaut und als .glb exportiert – nicht Teil des Spiels.
// Konvention (siehe sabervisuals.ts): Klinge zeigt nach -Z, Griffende bei z = +0.14, Spitze bei z = -1.06,
// Klinge beginnt bei z = -0.06 (1 m), Gesamtlaenge 1,2 m. Breite der Klinge entlang Y, Dicke entlang X.
// Materialnamen steuern das Leuchten im Spiel: glow (Handfarbe), glowcore (heller Kern), glowsoft (weiches Glühen).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type P = [number, number];   // (Laenge, Breite): Laenge = spaeteres z, Breite = y

export interface SwordSpec {
  /** Klingen-Umriss (obere Haelfte, von der Parierstange zur Spitze); wird an der Mittellinie gespiegelt */
  blade: P[];
  /** Dicke der Klinge (m) */
  thick: number;
  /** Breite des Leuchtrands (m) */
  rim: number;
  /** Leuchtstriche auf der Klinge: [z0, z1, y, Hoehe] */
  strokes: [number, number, number, number][];
  /** Parierstange: Umriss obere Haelfte (z, y), gespiegelt; Dicke */
  guard: P[]; guardThick: number;
  /** leuchtende Rauten/Details an der Parierstange: [z, y, Radius] */
  gems: [number, number, number][];
  /** Symbol nahe dem Heft (Linienzug-Rahmen + Raute) */
  emblem?: { z: number; w: number; h: number };
  /** Griff: Radius, Wicklungen, Knauf-Radius */
  gripR: number; wraps: number; pommelR: number;
  /** Farben der Grundmaterialien */
  steel: number; grip: number; metal: number;
  /** Staerke des weichen Gluehens (0..1) */
  softGlow: number;
}

/** obere Haelfte an der Mittellinie spiegeln; Punkte auf der Mittellinie (Spitze) nicht doppelt */
const mirror = (half: P[]): P[] => [...half, ...half.slice().reverse().filter(([, y]) => Math.abs(y) > 1e-9).map(([z, y]) => [z, -y] as P)];

/** Shape in (z, y) -> Geometrie: extrudiert entlang x (Dicke), danach Achsen auf (x = Dicke, y = Breite, z = Laenge) */
export function extrude(outline: P[], depth: number, holes: P[][] = [], bevel = 0): THREE.BufferGeometry {
  const s = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
  for (const h of holes) s.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(z, y))));
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2);          // (Form-x = Laenge) -> z, Extrusion -> x
  return g;
}

/** Umriss nach innen versetzen (einfach: Richtung Schwerpunkt der Mittellinie, je Punkt senkrecht zur Kante) */
export function inset(poly: P[], d: number): P[] {
  const n = poly.length, out: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
    const n1 = norm([b[1] - a[1], -(b[0] - a[0])]), n2 = norm([c[1] - b[1], -(c[0] - b[0])]);
    let m = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const cos = Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    m = [m[0] / cos, m[1] / cos];
    out.push([b[0] + m[0] * d, b[1] + m[1] * d]);
  }
  return out;
}
const norm = (v: P): P => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
/** Umlaufsinn: Innen-Normale zeigt nach innen, wenn der Umriss gegen den Uhrzeigersinn laeuft */
const area = (p: P[]) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
const ccw = (p: P[]) => (area(p) > 0 ? p : p.slice().reverse());

/** Leuchtrand: Ring zwischen Umriss und eingeruecktem Umriss */
export function rimGeo(outline: P[], width: number, depth: number): THREE.BufferGeometry {
  const o = ccw(outline), i = inset(o, -width);   // ccw: Normale (dy, -dx) zeigt nach aussen -> -width = nach innen
  return extrude(o, depth, [i.slice().reverse()]);
}

/** weiches Gluehen: Band um den Umriss, innen hell, aussen 0 (Vertex-Farben, additiv im Spiel) – ohne Textur */
export function softGlow(outline: P[], pad: number, strength: number): THREE.Mesh {
  const o = ccw(outline), out = inset(o, pad), n = o.length;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let i = 0; i < n; i++) {
    pos.push(0, o[i][1], o[i][0], 0, out[i][1], out[i][0]);
    col.push(1, 1, 1, 0, 0, 0);
    const a = i * 2, b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b + 1, a, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({ name: 'glowsoft', color: 0xffffff, vertexColors: true, transparent: true, opacity: strength, depthWrite: false, side: THREE.DoubleSide });
  return new THREE.Mesh(g, mat);
}

export function buildSword(spec: SwordSpec): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ name: 'steel', color: spec.steel, metalness: 0.55, roughness: 0.55 });
  const metal = new THREE.MeshStandardMaterial({ name: 'metal', color: spec.metal, metalness: 0.85, roughness: 0.28 });
  const grip = new THREE.MeshStandardMaterial({ name: 'grip', color: spec.grip, metalness: 0.2, roughness: 0.85 });
  const glow = new THREE.MeshBasicMaterial({ name: 'glow', color: 0xffffff });
  const core = new THREE.MeshBasicMaterial({ name: 'glowcore', color: 0xffffff });

  // Klinge: dunkler Stahl, Leuchtrand (aussen Farbe, innen heller Kern), Leuchtstriche
  const blade = mirror(spec.blade);
  g.add(new THREE.Mesh(extrude(blade, spec.thick, [], 0.0015), steel));
  g.add(new THREE.Mesh(rimGeo(blade, spec.rim, spec.thick + 0.004), glow));
  g.add(new THREE.Mesh(rimGeo(blade, spec.rim * 0.4, spec.thick + 0.005), core));
  const strokes = spec.strokes.map(([z0, z1, y, h]) => extrude([[z0, y - h / 2], [z1, y - h / 2], [z1, y + h / 2], [z0, y + h / 2]], spec.thick + 0.004));
  if (strokes.length) g.add(new THREE.Mesh(mergeGeometries(strokes), core));

  // Symbol nahe dem Heft: Rahmen + Raute
  if (spec.emblem) {
    const { z, w, h } = spec.emblem;
    const frame: P[] = [[z - w / 2, -h / 2], [z + w / 2, -h / 2], [z + w / 2, h / 2], [z - w / 2, h / 2]];
    const d = Math.min(w, h) * 0.32;
    const gem: P[] = [[z - d, 0], [z, -d], [z + d, 0], [z, d]];
    g.add(new THREE.Mesh(mergeGeometries([rimGeo(frame, 0.0022, spec.thick + 0.005), extrude(gem, spec.thick + 0.005)]), glow));
  }

  // Parierstange: Metallkoerper mit Leuchtrand, leuchtende Rauten
  const guard = mirror(spec.guard);
  g.add(new THREE.Mesh(extrude(guard, spec.guardThick, [], 0.002), metal));
  g.add(new THREE.Mesh(rimGeo(guard, spec.rim * 0.9, spec.guardThick + 0.004), glow));
  const gems = spec.gems.flatMap(([z, y, r]) => [y, ...(y ? [-y] : [])].map((yy) => extrude([[z - r, yy], [z, yy - r * 1.3], [z + r, yy], [z, yy + r * 1.3]], spec.guardThick + 0.008)));
  if (gems.length) g.add(new THREE.Mesh(mergeGeometries(gems), core));

  // Griff mit Wicklung und Knauf (Griff von z = -0.02 bis +0.115)
  const gz0 = -0.02, gz1 = 0.115, gl = gz1 - gz0;
  const gripGeo = new THREE.CylinderGeometry(spec.gripR, spec.gripR * 1.08, gl, 10); gripGeo.rotateX(Math.PI / 2); gripGeo.translate(0, 0, (gz0 + gz1) / 2);
  g.add(new THREE.Mesh(gripGeo, grip));
  const wraps: THREE.BufferGeometry[] = [];
  for (let i = 0; i < spec.wraps; i++) {
    const t = new THREE.TorusGeometry(spec.gripR * 1.05, spec.gripR * 0.22, 4, 12);
    t.rotateX(0.35); t.translate(0, 0, gz0 + ((i + 0.5) / spec.wraps) * gl);
    wraps.push(t);
  }
  g.add(new THREE.Mesh(mergeGeometries(wraps), new THREE.MeshStandardMaterial({ name: 'wrap', color: new THREE.Color(spec.grip).multiplyScalar(1.6), roughness: 0.9 })));
  const collar = new THREE.CylinderGeometry(spec.gripR * 1.35, spec.gripR * 1.35, 0.012, 10); collar.rotateX(Math.PI / 2); collar.translate(0, 0, gz0 - 0.004);
  const pommel = new THREE.OctahedronGeometry(spec.pommelR, 1); pommel.scale(1, 1, 1.4); pommel.translate(0, 0, 0.14 - spec.pommelR * 1.4);
  g.add(new THREE.Mesh(mergeGeometries([collar.toNonIndexed(), pommel]), metal));
  const pg = new THREE.OctahedronGeometry(spec.pommelR * 0.45, 0); pg.translate(0, 0, 0.14 - spec.pommelR * 1.4);
  pg.scale(1.6, 1, 1);
  g.add(new THREE.Mesh(pg, core));

  // weiches Gluehen um die Klinge
  g.add(softGlow(blade, 0.03, spec.softGlow));
  return mergeByMaterial(g);
}

/** Teile mit gleichem Material zu einem Mesh zusammenfassen: wenige Draw Calls im Headset */
export function mergeByMaterial(g: THREE.Group): THREE.Group {
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  g.updateMatrixWorld(true);
  g.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    let geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    if (geo.index) geo = geo.toNonIndexed();
    const keep = new Set(['position', 'normal', 'uv', 'color']);
    for (const k of Object.keys(geo.attributes)) if (!keep.has(k)) geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const mat = m.material as THREE.Material;
    (groups.get(mat) ?? groups.set(mat, []).get(mat)!).push(geo);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of groups) {
    // gemeinsame Attribute (uv fehlt manchen Teilen)
    const common = ['position', 'normal', 'uv', 'color'].filter((k) => geos.every((x) => x.attributes[k]));
    for (const x of geos) for (const k of Object.keys(x.attributes)) if (!common.includes(k)) x.deleteAttribute(k);
    const merged = mergeGeometries(geos);
    if (merged) out.add(new THREE.Mesh(merged, mat));
  }
  return out;
}

/** Frostklinge: schlank, gerade, Leuchtstriche, gezackte Schulter, kleine Parierstange mit Rauten */
export const FROST: SwordSpec = {
  blade: [
    [-0.06, 0.016], [-0.075, 0.026], [-0.085, 0.019], [-0.1, 0.028], [-0.112, 0.02], [-0.13, 0.024], [-0.16, 0.019],
    [-0.5, 0.0175], [-0.96, 0.0155], [-1.06, 0],
  ],
  thick: 0.006, rim: 0.0045,
  strokes: [[-0.2, -0.215, 0, 0.004], [-0.24, -0.4, 0, 0.0035], [-0.42, -0.44, 0, 0.004], [-0.13, -0.15, 0.006, 0.003], [-0.13, -0.15, -0.006, 0.003]],
  guard: [[-0.035, 0.012], [-0.04, 0.03], [-0.05, 0.046], [-0.058, 0.03], [-0.062, 0.012]],
  guardThick: 0.016,
  gems: [[-0.048, 0.05, 0.007], [-0.048, 0, 0.007]],
  gripR: 0.0135, wraps: 9, pommelR: 0.016,
  steel: 0x13262e, grip: 0x14191c, metal: 0x2b3a40,
  softGlow: 0.5,
};

/** Glutklinge: kraeftige Klinge, Symbol am Heft, grosse geschwungene Parierstange mit Zacken, Knauf */
export const GLUT: SwordSpec = {
  blade: [[-0.06, 0.022], [-0.1, 0.0235], [-0.55, 0.0215], [-0.97, 0.019], [-1.06, 0]],
  thick: 0.007, rim: 0.005,
  strokes: [],
  emblem: { z: -0.115, w: 0.05, h: 0.022 },
  // geschwungene Arme: ein langer Arm nach vorn oben, zwei kuerzere Zacken, kleiner Haken zum Griff hin
  guard: [
    [-0.02, 0.011], [-0.026, 0.024], [-0.014, 0.036], [-0.03, 0.042], [-0.042, 0.06], [-0.05, 0.078], [-0.07, 0.098],
    [-0.062, 0.074], [-0.058, 0.06], [-0.08, 0.066], [-0.068, 0.047], [-0.094, 0.04], [-0.072, 0.03], [-0.074, 0.011],
  ],
  guardThick: 0.02,
  gems: [[-0.046, 0, 0.011]],
  gripR: 0.015, wraps: 11, pommelR: 0.02,
  steel: 0x161013, grip: 0x121012, metal: 0x4a0d16,
  softGlow: 0.8,
};
