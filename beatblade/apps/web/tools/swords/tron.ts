// Tron-Schwerter (Gitterklinge, Neonsaebel): schwarz-matte, kantige Formen mit Leuchtraendern, Leuchtschlitzen,
// Aussparungen und Leuchtbloecken. Gleiche Konvention wie swords.ts: Klinge nach -Z, Griffende bei z = +0.14,
// Form-Koordinaten (z = Laenge, y = Breite/oben), Dicke entlang X. Materialnamen: glow / glowcore / glowsoft.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { extrude, inset, rimGeo, softGlow, mergeByMaterial, type P } from './swords';

const dark = () => new THREE.MeshStandardMaterial({ name: 'dark', color: 0x0b0d10, metalness: 0.2, roughness: 0.85 });
const darker = () => new THREE.MeshStandardMaterial({ name: 'grip', color: 0x07080a, metalness: 0.1, roughness: 0.95 });
const glowMat = () => new THREE.MeshBasicMaterial({ name: 'glow', color: 0xffffff });
const coreMat = () => new THREE.MeshBasicMaterial({ name: 'glowcore', color: 0xffffff });

const rect = (z0: number, z1: number, y0: number, y1: number): P[] => [[z0, y0], [z1, y0], [z1, y1], [z0, y1]];
const circle = (z: number, y: number, r: number, n = 16): P[] => Array.from({ length: n }, (_, i) => [z + Math.cos((i / n) * Math.PI * 2) * r, y + Math.sin((i / n) * Math.PI * 2) * r] as P);
/** schraeger Streifen (Parallelogramm) */
const slant = (z: number, y0: number, y1: number, w: number, lean: number): P[] => [[z, y0], [z + w, y0], [z + w + lean, y1], [z + lean, y1]];

/** Teile sammeln, am Ende je Material zusammenfassen */
class Parts {
  g = new THREE.Group();
  private mats = { dark: dark(), grip: darker(), glow: glowMat(), core: coreMat() };
  add(geo: THREE.BufferGeometry, m: keyof Parts['mats']) { this.g.add(new THREE.Mesh(geo, this.mats[m])); }
  build(soft?: { outline: P[]; pad: number; strength: number }) {
    if (soft) this.g.add(softGlow(soft.outline, soft.pad, soft.strength));
    return mergeByMaterial(this.g);
  }
}

/** Gitterklinge (blau): kurz und wuchtig, kantige Klinge mit Haken an der Spitze, Leuchtschlitze, eckige Parierstange mit Zaehnen,
 *  dicker Griff mit schraegen Leuchtstreifen, grosser kantiger Knauf mit Leuchtblock. Spitze bei z = -0.91 (0,85 m Klinge). */
export function buildGitter(): THREE.Group {
  const p = new Parts();
  const T = 0.012;   // Klingendicke
  const blade: P[] = [
    [-0.05, -0.03], [-0.84, -0.03], [-0.905, 0.012], [-0.91, 0.03], [-0.895, 0.03], [-0.888, 0.02], [-0.876, 0.042],
    [-0.62, 0.042], [-0.59, 0.034], [-0.05, 0.034],
  ];
  // zwei laengliche Fenster als Aussparung (durchsichtig), Leuchtschlitze eingelassen
  const win1 = rect(-0.17, -0.42, 0.006, 0.018), win2 = rect(-0.47, -0.74, 0.006, 0.018);
  p.add(extrude(blade, T, [win1, win2], 0.001), 'dark');
  p.add(rimGeo(blade, 0.006, T + 0.004), 'glow');
  p.add(rimGeo(inset(blade, -0.012), 0.002, T + 0.004), 'core');       // innere Leiterbahn
  for (const w of [win1, win2]) p.add(rimGeo(inset(w, 0.003), 0.003, T + 0.004), 'glow');
  // Leiterbahn-Stummel unten (wie Platinen-Linien)
  const stubs: P[][] = [];
  for (let i = 0; i < 4; i++) { const z = -0.2 - i * 0.12; stubs.push(rect(z, z - 0.004, -0.019, -0.008), rect(z, z - 0.06, -0.012, -0.0095)); }
  p.add(mergeGeometries(stubs.map((s) => extrude(s, T + 0.004))), 'core');
  // eckige Parierstange (Sechseck) mit Leuchtkanten und Zaehnen darunter
  const guard: P[] = [[-0.015, -0.045], [-0.075, -0.045], [-0.095, 0.0], [-0.075, 0.062], [-0.015, 0.062], [0.0, 0.01]];
  p.add(extrude(guard, 0.034, [], 0.002), 'dark');
  p.add(rimGeo(guard, 0.004, 0.038), 'glow');
  p.add(rimGeo(inset(guard, -0.012), 0.0025, 0.038), 'core');
  const teeth: P[][] = Array.from({ length: 6 }, (_, i) => rect(-0.02 - i * 0.012, -0.028 - i * 0.012, -0.058, -0.047));
  p.add(mergeGeometries(teeth.map((t) => extrude(t, 0.026))), 'glow');
  // dicker, kantiger Griff mit schraegen Leuchtstreifen
  const grip = rect(-0.005, 0.098, -0.022, 0.026);
  p.add(extrude(grip, 0.034, [], 0.002), 'grip');
  const stripes: P[][] = Array.from({ length: 4 }, (_, i) => slant(0.008 + i * 0.022, -0.016, 0.02, 0.006, 0.01));
  p.add(mergeGeometries(stripes.map((s) => extrude(s, 0.037))), 'glow');
  // C-foermiger Griffbuegel wie in der Vorlage: oberer Ruecken-Steg bis zum Knauf, unterer gebogener Buegel mit Leuchtblock
  const spine: P[] = [[-0.01, 0.04], [0.1, 0.044], [0.13, 0.064], [0.112, 0.07], [0.09, 0.056], [-0.01, 0.054]];
  p.add(extrude(spine, 0.022, [], 0.0015), 'dark');
  p.add(extrude(rect(0.0, 0.085, 0.046, 0.0495), 0.025), 'core');
  const bow: P[] = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10, z = -0.03 + t * 0.15, y = -0.05 - Math.sin(t * Math.PI) * 0.018; bow.push([z, y]); }
  for (let i = 10; i >= 0; i--) { const t = i / 10, z = -0.03 + t * 0.15, y = -0.064 - Math.sin(t * Math.PI) * 0.018; bow.push([z, y]); }
  p.add(extrude(bow, 0.02, [], 0.0015), 'dark');
  const blk: P[] = [];
  for (let i = 0; i <= 6; i++) { const t = 0.35 + (i / 6) * 0.4, z = -0.03 + t * 0.15; blk.push([z, -0.0515 - Math.sin(t * Math.PI) * 0.018]); }
  for (let i = 6; i >= 0; i--) { const t = 0.35 + (i / 6) * 0.4, z = -0.03 + t * 0.15; blk.push([z, -0.0625 - Math.sin(t * Math.PI) * 0.018]); }
  p.add(extrude(blk, 0.024), 'glow');
  // grosser kantiger Knauf mit Leuchtblock
  const pommel: P[] = [[0.098, -0.032], [0.128, -0.04], [0.14, -0.02], [0.14, 0.04], [0.118, 0.05], [0.098, 0.034]];
  p.add(extrude(pommel, 0.04, [], 0.002), 'dark');
  p.add(extrude(rect(0.106, 0.132, -0.022, 0.03), 0.044), 'glow');
  p.add(rimGeo(pommel, 0.003, 0.043), 'glow');
  return p.build({ outline: blade, pad: 0.026, strength: 0.55 });
}

/** Neonsaebel (rot): lang und schmal, zur Spitze nach oben gebogen, Leuchtrand, zwei Leuchtschlitze, zwei runde Loecher,
 *  kleine Parierstange, gewickelter Griff, schlichter Knauf, starkes Gluehen. Spitze bei z = -1.21 (1,15 m Klinge). */
export function buildSaebel(): THREE.Group {
  const p = new Parts();
  const T = 0.008, L = 1.15, z0 = -0.06;
  // Mittellinie: zur Spitze hin nach oben gebogen (Saebel)
  const bend = (u: number) => 0.034 * u * u * u;
  const top: P[] = [], bot: P[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const u = i / N, z = z0 - u * L, c = bend(u);
    const w = 0.019 * (1 - 0.25 * u);
    if (i < N) { top.push([z, c + w]); bot.push([z, c - w]); }
  }
  const tipZ = z0 - L, tipY = bend(1) + 0.012;
  const blade: P[] = [...bot, [tipZ + 0.06, bend(0.95) - 0.01], [tipZ, tipY], ...top.reverse()];
  // zwei runde Loecher nahe dem Heft
  const holes = [circle(-0.16, bend(0.09), 0.0065), circle(-0.2, bend(0.12), 0.0065)];
  p.add(extrude(blade, T, holes, 0.0008), 'dark');
  p.add(rimGeo(blade, 0.0065, T + 0.004), 'glow');
  p.add(rimGeo(blade, 0.002, T + 0.005), 'core');
  for (const h of holes) p.add(rimGeo(inset(h, 0.003), 0.003, T + 0.004), 'glow');
  // zwei laengliche Leuchtschlitze entlang der Kruemmung
  const slot = (u0: number, u1: number, dy: number, h: number): P[] => {
    const pts: P[] = [], back: P[] = [];
    for (let i = 0; i <= 8; i++) { const u = u0 + ((u1 - u0) * i) / 8, z = z0 - u * L, c = bend(u) + dy; pts.push([z, c - h / 2]); back.push([z, c + h / 2]); }
    return [...pts, ...back.reverse()];
  };
  p.add(mergeGeometries([extrude(slot(0.22, 0.55, 0.004, 0.005), T + 0.004), extrude(slot(0.6, 0.86, 0.004, 0.005), T + 0.004)]), 'glow');
  // kleine Parierstange
  const guard = rect(-0.03, -0.062, -0.034, 0.036);
  p.add(extrude(guard, 0.026, [], 0.0015), 'dark');
  p.add(rimGeo(guard, 0.0035, 0.03), 'glow');
  // gewickelter Griff, schlichter Knauf
  const gz0 = -0.03, gz1 = 0.118, gl = gz1 - gz0, r = 0.0145;
  const grip = new THREE.CylinderGeometry(r, r * 1.05, gl, 10); grip.rotateX(Math.PI / 2); grip.translate(0, 0, (gz0 + gz1) / 2);
  p.add(grip, 'grip');
  const wraps = Array.from({ length: 12 }, (_, i) => { const t = new THREE.TorusGeometry(r * 1.06, r * 0.2, 4, 12); t.rotateX(0.4); t.translate(0, 0, gz0 + ((i + 0.5) / 12) * gl); return t; });
  p.add(mergeGeometries(wraps), 'dark');
  const pommel = new THREE.CylinderGeometry(r * 1.4, r * 1.1, 0.022, 8); pommel.rotateX(Math.PI / 2); pommel.translate(0, 0, 0.129);
  p.add(pommel, 'dark');
  const pring = new THREE.TorusGeometry(r * 1.42, 0.0022, 4, 16); pring.translate(0, 0, 0.122);
  p.add(pring, 'glow');
  return p.build({ outline: blade, pad: 0.034, strength: 0.85 });
}
