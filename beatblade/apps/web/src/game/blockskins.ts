// Block-Skins: Form + Material der Bloecke. Eingebaute Stile (prozedural) oder eigenes .glb-Modell
// aus content/blocks/<name>/. Die Farbe kommt immer pro Block (InstancedMesh-Farbe), daher weisses Grundmaterial.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NOTE_SIZE } from './layout';

export interface BlockSkin { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }

/** Wuerfel mit abgerundeten Kanten (r = Rundung, segs = Unterteilung) */
export function roundedBox(size: number, r: number, segs = 4): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size, size, size, segs, segs, segs);
  const pos = g.attributes.position as THREE.BufferAttribute, h = size / 2 - r, v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    c.set(Math.max(-h, Math.min(h, v.x)), Math.max(-h, Math.min(h, v.y)), Math.max(-h, Math.min(h, v.z)));
    const d = v.clone().sub(c); if (d.lengthSq() > 0) d.setLength(r);
    pos.setXYZ(i, c.x + d.x, c.y + d.y, c.z + d.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Pixel-Raster (Retro): helle Flaeche mit dunklen Rasterlinien und Rand */
function pixelTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#b8b8b8';
  for (let i = 0; i <= 64; i += 8) { g.fillRect(i - 1, 0, 2, 64); g.fillRect(0, i - 1, 64, 2); }
  g.fillStyle = '#6a6a6a'; g.fillRect(0, 0, 64, 4); g.fillRect(0, 60, 64, 4); g.fillRect(0, 0, 4, 64); g.fillRect(60, 0, 4, 64);
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** eingebaute Stile – 'neon-cube' ist der bisherige Block */
export function builtinBlock(style: string): BlockSkin {
  switch (style) {
    case 'crystal':
      // stark abgeschraegte, facettierte Form, glaenzend und leicht durchscheinend
      return {
        geo: roundedBox(NOTE_SIZE, 0.11, 2),
        mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0.25, emissive: 0x222222, flatShading: true, transparent: true, opacity: 0.88 }),
      };
    case 'retro-pixel':
      return {
        geo: new THREE.BoxGeometry(NOTE_SIZE, NOTE_SIZE, NOTE_SIZE),
        mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, emissive: 0x181818, flatShading: true, map: pixelTexture() }),
      };
    default:
      return {
        geo: roundedBox(NOTE_SIZE, 0.06),
        mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.15, emissive: 0x111111 }),
      };
  }
}

/** eigenes Modell (.glb): erste Geometrie, zentriert und auf Blockgroesse skaliert; Vorderseite = +Z */
export async function blockFromModel(url: string): Promise<BlockSkin | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    let mesh: THREE.Mesh | null = null;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => { if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh; });
    if (!mesh) return null;
    const m = mesh as THREE.Mesh;
    const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    geo.computeBoundingBox();
    const box = geo.boundingBox!, size = new THREE.Vector3(), center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);
    geo.scale(NOTE_SIZE / Math.max(size.x, size.y, size.z, 1e-6), NOTE_SIZE / Math.max(size.x, size.y, size.z, 1e-6), NOTE_SIZE / Math.max(size.x, size.y, size.z, 1e-6));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    return { geo, mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.2, emissive: 0x111111 }) };
  } catch (e) {
    console.warn('Block-Modell konnte nicht geladen werden', url, e);
    return null;
  }
}
