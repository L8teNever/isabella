// Block-Skins: Form + Material der Bloecke. Eingebaute Stile (prozedural) oder eigenes .glb-Modell
// aus content/blocks/<name>/. Die Farbe kommt immer pro Block (InstancedMesh-Farbe), daher weisses Grundmaterial.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

/** Kuerbis-Textur: dunkle Rippen, hell leuchtende geschnitzte Augen ueber dem Pfeil (Mund) */
function pumpkinTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8c8c8c'; g.fillRect(0, 0, 256, 128);
  // Rippen
  g.strokeStyle = '#5a5a5a'; g.lineWidth = 3;
  for (let i = 0; i < 10; i++) { const x = (i / 10) * 256 + 12; g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x - 6, 40, x - 6, 88, x, 128); g.stroke(); }
  // Vorderseite liegt bei u = 0.25 (x = 64): zwei dreieckige Augen, hell = leuchtet in der Kuerbisfarbe
  g.fillStyle = '#ffffff';
  const eye = (cx: number) => { g.beginPath(); g.moveTo(cx - 11, 54); g.lineTo(cx + 11, 54); g.lineTo(cx, 36); g.closePath(); g.fill(); };
  eye(52); eye(76);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Geschenk-Textur: Grundfarbe + helles Band; Vorderseite bekommt ein bandfreies Stueck (Pfeil gut lesbar) */
function giftTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffffff'; g.fillRect(52, 0, 24, 128); g.fillRect(0, 52, 128, 24);
  g.fillStyle = '#e0e0e0'; g.fillRect(56, 0, 4, 128); g.fillRect(0, 56, 128, 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
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
    case 'pumpkin': {
      // geriffelter, leicht flacher Kuerbis mit Stiel; der Pfeil vorne ist der geschnitzte Mund
      const r = NOTE_SIZE / 2;
      const body = new THREE.SphereGeometry(r, 40, 20);
      const p = body.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const phi = Math.atan2(v.z, v.x), k = 1 + 0.07 * Math.cos(phi * 10);
        p.setXYZ(i, v.x * k, v.y * 0.86, v.z * k);
      }
      body.computeVertexNormals();
      const stem = new THREE.CylinderGeometry(0.018, 0.028, 0.08, 8); stem.translate(0, r * 0.86 + 0.03, 0);
      const geo = mergeGeometries([body, stem], false) ?? body;
      return { geo, mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0, emissive: 0x2a1a0a, map: pumpkinTexture() }) };
    }
    case 'gift': {
      // Geschenk mit Band rundherum und Schleife oben; Vorderseite ohne Band, damit der Pfeil lesbar bleibt
      const box = new THREE.BoxGeometry(NOTE_SIZE * 0.96, NOTE_SIZE * 0.96, NOTE_SIZE * 0.96);
      const uv = box.attributes.uv as THREE.BufferAttribute;
      for (let i = 16; i < 20; i++) uv.setXY(i, 0.05 + (uv.getX(i) * 0.25), 0.05 + (uv.getY(i) * 0.25));   // Flaeche +Z
      const bow1 = new THREE.TorusGeometry(0.045, 0.012, 6, 16); bow1.rotateY(Math.PI / 2); bow1.rotateZ(0.6); bow1.translate(-0.04, NOTE_SIZE * 0.48 + 0.03, 0);
      const bow2 = new THREE.TorusGeometry(0.045, 0.012, 6, 16); bow2.rotateY(Math.PI / 2); bow2.rotateZ(-0.6); bow2.translate(0.04, NOTE_SIZE * 0.48 + 0.03, 0);
      // Schleife: UV auf das helle Band legen
      for (const b of [bow1, bow2]) { const u = b.attributes.uv as THREE.BufferAttribute; for (let i = 0; i < u.count; i++) u.setXY(i, 0.5, 0.5); }
      const geo = mergeGeometries([box.toNonIndexed(), bow1.toNonIndexed(), bow2.toNonIndexed()], false) ?? box;
      return { geo, mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.1, emissive: 0x151515, map: giftTexture() }) };
    }
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
