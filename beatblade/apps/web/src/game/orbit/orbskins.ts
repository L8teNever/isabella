// Orbit-Optiken: Handkugeln (content/orbs/) und Notenkugeln mit Rail-Aussehen (content/orbnotes/).
// Eingebaute Stile werden prozedural gebaut; die Farbe kommt pro Note (InstancedMesh-Farbe) bzw. pro Hand.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glowMaterial } from '../glow';
import { pumpkinTexture } from '../blockskins';

/** Radius der Notenkugel (m) und der Handkugel */
export const NOTE_R = 0.1;
export const HAND_R = 0.065;

export interface RailLook {
  /** Dicke der Roehre (m) */
  width: number;
  /** Deckkraft (0..1) */
  opacity: number;
  /** additiv leuchtend statt deckend */
  glow: boolean;
}
export const DEFAULT_RAIL: RailLook = { width: 0.022, opacity: 0.75, glow: false };

export interface OrbNoteSkin { geo: THREE.BufferGeometry; mat: THREE.Material; rail: RailLook }

/** Rail-Aussehen aus info.json (railWidth, railOpacity, railGlow) */
export function railLook(data: Record<string, unknown> | undefined): RailLook {
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  return {
    width: num(data?.railWidth, 0.008, 0.06, DEFAULT_RAIL.width),
    opacity: num(data?.railOpacity, 0.2, 1, DEFAULT_RAIL.opacity),
    glow: typeof data?.railGlow === 'boolean' ? data.railGlow : DEFAULT_RAIL.glow,
  };
}

/** Notenkugel: eingebaute Stile */
export function builtinOrbNote(style: string, rail: RailLook = DEFAULT_RAIL): OrbNoteSkin {
  switch (style) {
    case 'crystal':
      return { rail, geo: new THREE.IcosahedronGeometry(NOTE_R * 1.08, 0),
        mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0.3, emissive: 0x262626, flatShading: true, transparent: true, opacity: 0.88 }) };
    case 'ring': {
      // Donut, der zum Spieler zeigt – die Hand "faedelt" durch
      const g = new THREE.TorusGeometry(NOTE_R * 0.78, NOTE_R * 0.3, 14, 36);
      return { rail, geo: g, mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.4, emissive: 0x2a2a2a }) };
    }
    case 'pumpkin': {
      const body = new THREE.SphereGeometry(NOTE_R, 32, 18);
      const p = body.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const k = 1 + 0.08 * Math.cos(Math.atan2(v.z, v.x) * 10);
        p.setXYZ(i, v.x * k, v.y * 0.86, v.z * k);
      }
      body.computeVertexNormals();
      const stem = new THREE.CylinderGeometry(0.012, 0.018, 0.045, 8); stem.translate(0, NOTE_R * 0.86 + 0.018, 0);
      return { rail, geo: mergeGeometries([body, stem], false) ?? body,
        mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x2a1a0a, map: pumpkinTexture() }) };
    }
    case 'ornament': {
      // Christbaumkugel: glaenzende Kugel mit Kappe und Aufhaenger
      const ball = new THREE.SphereGeometry(NOTE_R, 28, 18);
      const cap = new THREE.CylinderGeometry(0.02, 0.024, 0.022, 12); cap.translate(0, NOTE_R + 0.006, 0);
      const loop = new THREE.TorusGeometry(0.012, 0.0035, 6, 14); loop.translate(0, NOTE_R + 0.028, 0);
      const geo = mergeGeometries([ball.toNonIndexed(), cap.toNonIndexed(), loop.toNonIndexed()], false) ?? ball;
      return { rail, geo, mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.12, metalness: 0.75, emissive: 0x303030 }) };
    }
    default:
      return { rail, geo: new THREE.IcosahedronGeometry(NOTE_R, 3),
        mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1, emissive: 0x3a3a3a, transparent: true, opacity: 0.95 }) };
  }
}

/** Handkugel: Gruppe mit Kern und Leuchten; tint/boost wie bei den Schwertern */
export interface HandOrbVisual { group: THREE.Group; halo: THREE.Mesh; tint(c: number): void; boost(level: number): void; update(dt: number): void }

export function buildHandOrb(style: string, color: number): HandOrbVisual {
  const group = new THREE.Group();
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial(0.7, color));
  halo.scale.setScalar(HAND_R * 6); halo.renderOrder = 2;
  group.add(halo);
  const tinted: (THREE.MeshBasicMaterial | THREE.MeshStandardMaterial)[] = [halo.material as THREE.MeshBasicMaterial];
  let spin: THREE.Object3D | null = null;
  if (style === 'ring') {
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(HAND_R * 0.55, 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const ringMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.5 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(HAND_R * 1.05, HAND_R * 0.18, 10, 32), ringMat);
    const ring2 = ring.clone(); ring2.rotation.y = Math.PI / 2;
    const r = new THREE.Group(); r.add(ring, ring2); spin = r;
    group.add(core, r); tinted.push(ringMat);
  } else if (style === 'crystal') {
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.05, metalness: 0.3, flatShading: true, transparent: true, opacity: 0.9 });
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(HAND_R * 1.25, 0), mat);
    m.scale.y = 1.35; spin = m;
    group.add(m); tinted.push(mat);
  } else {
    const mat = new THREE.MeshBasicMaterial({ color });
    group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(HAND_R, 2), mat)); tinted.push(mat);
  }
  let lvl = 0;
  return {
    group, halo,
    tint(c) { for (const m of tinted) { m.color.setHex(c); if ('emissive' in m) m.emissive.setHex(c); } },
    boost(l) { lvl = l; group.scale.setScalar(1 + l * 0.25); (halo.material as THREE.MeshBasicMaterial).opacity = 0.7 + l * 0.3; },
    update(dt) { if (spin) { spin.rotation.y += dt * (1.2 + lvl * 3); spin.rotation.x += dt * 0.5; } },
  };
}

const gltfCache = new Map<string, Promise<GLTF>>();
/** Handkugel aus eigenem Modell (.glb): zentriert, auf Kugelgroesse skaliert, in Handfarbe getoent. Treffer-Zone bleibt gleich. */
export async function handOrbFromModel(url: string, color: number): Promise<HandOrbVisual | null> {
  try {
    let p = gltfCache.get(url);
    if (!p) { p = new GLTFLoader().loadAsync(url); gltfCache.set(url, p); }
    const model = (await p).scene.clone(true);
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const wrap = new THREE.Group(); wrap.add(model);
    model.position.sub(center);
    wrap.scale.setScalar((HAND_R * 2.2) / Math.max(size.x, size.y, size.z, 1e-6));
    const group = new THREE.Group(); group.add(wrap);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial(0.7, color));
    halo.scale.setScalar(HAND_R * 6); halo.renderOrder = 2; group.add(halo);
    const mats: THREE.MeshStandardMaterial[] = [];
    model.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      if (!m.geometry.attributes.normal) { m.geometry = m.geometry.clone(); m.geometry.computeVertexNormals(); }
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, roughness: 0.35, metalness: 0.3, map: (m.material as THREE.MeshStandardMaterial).map ?? null });
      m.material = mat; mats.push(mat);
    });
    let lvl = 0;
    return {
      group, halo,
      tint(c) { (halo.material as THREE.MeshBasicMaterial).color.setHex(c); for (const m of mats) { m.color.setHex(c); m.emissive.setHex(c); } },
      boost(l) { lvl = l; group.scale.setScalar(1 + l * 0.25); (halo.material as THREE.MeshBasicMaterial).opacity = 0.7 + l * 0.3; },
      update(dt) { wrap.rotation.y += dt * (0.8 + lvl * 2); },
    };
  } catch (e) {
    console.warn('Handkugel-Modell konnte nicht geladen werden', url, e);
    return null;
  }
}
