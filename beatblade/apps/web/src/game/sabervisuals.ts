// Aussehen der Schwerter (getrennt von der Treffer-Logik in sabers.ts – die Treffer-Zone bleibt immer gleich).
// Eingebaute Stile: Lichtschwert (bisher), Katana, Neon-Stab. Oder eigenes .glb-Modell aus content/sabers/<name>/.
// Konvention: Griff am Ursprung, Klinge zeigt nach -Z, beginnt bei z = -0.06.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLOW } from './glow';

export interface SaberVisual {
  group: THREE.Group;
  /** weiche Leucht-Huelle (an/aus mit Einstellung "Leuchten") */
  halo: THREE.Mesh;
  tint(c: number): void;
  boost(level: number): void;
}

const BLADE_START = 0.06;

function haloMesh(len: number, radius: number, strength: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len + 0.06, 16, 1, true),
    new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, strength: { value: strength } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 color; uniform float strength; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(abs(dot(vN, vV)), 2.5); gl_FragColor = vec4(color, f * strength); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
  m.rotation.x = Math.PI / 2; m.position.z = -len / 2 - BLADE_START;
  return m;
}
const additive = (color: number, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
const along = (m: THREE.Mesh, len: number) => { m.rotation.x = Math.PI / 2; m.position.z = -len / 2 - BLADE_START; return m; };

/** gemeinsame Teile: Leucht-Huelle + Farb-/Boost-Logik */
function finish(group: THREE.Group, halo: THREE.Mesh, glows: THREE.MeshBasicMaterial[], baseOpacity: number[], haloStrength: number, scaleGlow: THREE.Object3D[]): SaberVisual {
  group.add(halo);
  return {
    group, halo,
    tint(c) { for (const m of glows) m.color.setHex(c); (halo.material as THREE.ShaderMaterial).uniforms.color.value.setHex(c); },
    boost(level) {
      glows.forEach((m, i) => { m.opacity = Math.min(1, baseOpacity[i] + 0.4 * level); });
      for (const o of scaleGlow) o.scale.set(1 + level * 1.2, 1, 1 + level * 1.2);
      (halo.material as THREE.ShaderMaterial).uniforms.strength.value = haloStrength * (1 + level * 0.8);
    },
  };
}

export function buildSaberVisual(style: string, len: number, color: number): SaberVisual {
  const group = new THREE.Group();
  if (style === 'katana') {
    // umwickelter Griff, runde Tsuba, schmale Stahlklinge mit leuchtender Schneide
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.26, 10), new THREE.MeshStandardMaterial({ color: 0x1b1a22, roughness: 0.8 }));
    grip.rotation.x = Math.PI / 2; grip.position.z = 0.08;
    const tsuba = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 24), new THREE.MeshStandardMaterial({ color: 0x6b5a3a, metalness: 0.8, roughness: 0.35 }));
    tsuba.rotation.x = Math.PI / 2; tsuba.position.z = -0.05;
    const bladeGeo = new THREE.BoxGeometry(0.01, len, 0.036);
    // zur Spitze hin schmaler
    const p = bladeGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) { const t = (p.getY(i) + len / 2) / len; p.setZ(i, p.getZ(i) * (1 - 0.55 * t)); }
    bladeGeo.computeVertexNormals();
    const blade = along(new THREE.Mesh(bladeGeo, new THREE.MeshStandardMaterial({ color: 0xe8edf3, metalness: 0.6, roughness: 0.22, emissive: 0x4a5260 })), len);
    const edgeMat = additive(color, 1);
    const edge = along(new THREE.Mesh(new THREE.BoxGeometry(0.014, len, 0.012), edgeMat), len);
    (edge.geometry as THREE.BoxGeometry).translate(0, 0, 0.02);   // Schneide an der Unterkante der Klinge
    group.add(grip, tsuba, blade, edge);
    return finish(group, haloMesh(len, GLOW.saberHalo * 0.8, GLOW.saberHaloStrength * 0.9, color), [edgeMat], [1], GLOW.saberHaloStrength * 0.9, []);
  }
  if (style === 'neon-stab') {
    // dicker Leuchtstab mit Ringen
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.18, 12), new THREE.MeshStandardMaterial({ color: 0x2a2836, metalness: 0.5, roughness: 0.4 }));
    grip.rotation.x = Math.PI / 2; grip.position.z = 0.04;
    const core = along(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, len, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })), len);
    const glowMat = additive(color, 0.6);
    const glow = along(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, len, 16, 1, true), glowMat), len);
    const ringMat = additive(color, 0.9);
    group.add(grip, core, glow);
    for (let i = 1; i <= 5; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 6, 20), ringMat);
      r.position.z = -BLADE_START - (len * i) / 6; group.add(r);
    }
    return finish(group, haloMesh(len, GLOW.saberHalo * 1.3, GLOW.saberHaloStrength * 1.2, color), [glowMat, ringMat], [0.6, 0.9], GLOW.saberHaloStrength * 1.2, [glow]);
  }
  // Lichtschwert (bisher)
  const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.2, 12), new THREE.MeshStandardMaterial({ color: 0x22202c, metalness: 0.6, roughness: 0.35 }));
  hilt.rotation.x = Math.PI / 2; hilt.position.z = 0.04;
  const blade = along(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.012, len, 10), new THREE.MeshBasicMaterial({ color: 0xffffff })), len);
  const glowMat = additive(color, 0.55);
  const glow = along(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, len, 12, 1, true), glowMat), len);
  group.add(hilt, blade, glow);
  return finish(group, haloMesh(len, GLOW.saberHalo, GLOW.saberHaloStrength, color), [glowMat], [0.55], GLOW.saberHaloStrength, [glow]);
}

const gltfCache = new Map<string, Promise<GLTF>>();

/**
 * eigenes Modell (.glb): laengste Achse wird zur Klinge (-Z), Laenge = Klinge + Griff; Leuchten kommt dazu.
 * Materialnamen im Modell steuern das Leuchten (alles andere bleibt, wie modelliert):
 *  - "glow…"     Leuchtrand/Muster: in der Schwertfarbe (Handfarbe), voll hell
 *  - "glowcore…" heller Kern des Leuchtrands: Schwertfarbe stark aufgehellt
 *  - "glowsoft…" weiches Glühen (Fläche mit Verlaufs-Textur): additiv, wird mit der Combo staerker
 * Ohne solche Materialien bekommt die Klinge wie bisher einen Leuchtzylinder.
 */
export async function saberFromModel(url: string, len: number, color: number): Promise<SaberVisual | null> {
  try {
    let p = gltfCache.get(url);
    if (!p) { p = new GLTFLoader().loadAsync(url); gltfCache.set(url, p); p.catch(() => gltfCache.delete(url)); }   // Fehlschlag nicht merken
    const model = (await p).scene.clone(true);
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    // laengste Achse auf -Z drehen
    if (size.y >= size.x && size.y >= size.z) model.rotation.x = -Math.PI / 2;
    else if (size.x >= size.z) model.rotation.y = Math.PI / 2;
    const wrap = new THREE.Group(); wrap.add(model);
    const b2 = new THREE.Box3().setFromObject(wrap), s2 = b2.getSize(new THREE.Vector3());
    const k = (len + 0.2) / Math.max(s2.z, 1e-6);
    wrap.scale.setScalar(k);
    const b3 = new THREE.Box3().setFromObject(wrap);
    wrap.position.z -= b3.max.z - 0.14;   // Griffende knapp hinter der Hand
    const group = new THREE.Group(); group.add(wrap);
    // Leucht-Materialien nach Namen ersetzen
    const glows: THREE.MeshBasicMaterial[] = [], cores: THREE.MeshBasicMaterial[] = [], softs: THREE.MeshBasicMaterial[] = [], softBase: number[] = [];
    model.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      const src = m.material as THREE.Material & { map?: THREE.Texture | null; opacity: number };
      const name = (src.name || '').toLowerCase();
      if (name.startsWith('glowsoft')) {
        const op = src.opacity < 1 ? src.opacity : 0.55;
        const g = additive(color, op); g.map = src.map ?? null; g.side = THREE.DoubleSide;
        g.vertexColors = !!m.geometry.attributes.color;   // Verlauf innen hell -> aussen 0
        m.material = g; m.renderOrder = 2; softs.push(g); softBase.push(op);
      } else if (name.startsWith('glowcore')) {
        const g = new THREE.MeshBasicMaterial({ color: coreColor(color) }); m.material = g; cores.push(g);
      } else if (name.startsWith('glow')) {
        const g = new THREE.MeshBasicMaterial({ color }); m.material = g; glows.push(g);
      }
    });
    if (!glows.length && !cores.length && !softs.length) {
      const glowMat = additive(color, 0.35);
      const glow = along(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 12, 1, true), glowMat), len);
      group.add(glow);
      return finish(group, haloMesh(len, GLOW.saberHalo, GLOW.saberHaloStrength, color), [glowMat], [0.35], GLOW.saberHaloStrength, [glow]);
    }
    // eigener Leuchtrand: Leucht-Huelle schmal und dezent, sonst ueberstrahlt sie die dunkle Klinge
    const hs = GLOW.saberHaloStrength * 0.2;
    // Huelle kuerzer als die Klinge (beginnt am Heft, endet vor der Spitze), damit sie nicht ueber die Spitze ragt
    const halo = haloMesh(len - 0.14, GLOW.saberHalo * 0.6, hs, color); halo.position.z += 0.05;
    const v = finish(group, halo, softs, softBase, hs, []);
    return {
      ...v,
      tint(c) { v.tint(c); for (const g of glows) g.color.setHex(c); for (const g of cores) g.color.setHex(coreColor(c)); },
    };
  } catch (e) {
    console.warn('Schwert-Modell konnte nicht geladen werden', url, e);
    return null;
  }
}

/** heller Kern eines Leuchtrands: Farbe stark zu Weiss gemischt */
function coreColor(c: number): number { return new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.72).getHex(); }
