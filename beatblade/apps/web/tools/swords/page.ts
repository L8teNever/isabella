// Bau-Seite (Browser): Schwerter bauen, als .glb exportieren und Vorschaubilder rendern (mit Bloom wie in der Vorlage).
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildSword, FROST, GLUT } from './swords';
import { saberFromModel } from '../../src/game/sabervisuals';

const SWORDS = { frostklinge: { spec: FROST, color: 0x3fc8ff }, glutklinge: { spec: GLUT, color: 0xff2a3a } };

async function exportGlb(g: THREE.Object3D): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(g, { binary: true })) as ArrayBuffer;
}
const b64 = (buf: ArrayBuffer) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

/** Szene wie in der Vorlage: dunkles Petrol, Schwerter waagerecht (Spitze links) */
function stage(w: number, h: number) {
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setSize(w, h); r.setPixelRatio(1); r.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(r.domElement);
  const scene = new THREE.Scene();
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(128, 120, 10, 128, 128, 220); gr.addColorStop(0, '#174a5c'); gr.addColorStop(1, '#06161e');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const bg = new THREE.CanvasTexture(c); bg.colorSpace = THREE.SRGBColorSpace; scene.background = bg;
  scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x203040, 1.4));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(-2, 2, 1); scene.add(dl);
  const cam = new THREE.PerspectiveCamera(26, w / h, 0.05, 20);
  const comp = new EffectComposer(r);
  comp.addPass(new RenderPass(scene, cam));
  if (!dbg.has('nobloom')) comp.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.7, 0.45, 0.82));
  comp.addPass(new OutputPass());
  return { r, scene, cam, comp };
}

/** Schwert so drehen, dass es waagerecht liegt: Spitze links, flache Seite zur Kamera */
function place(o: THREE.Object3D, y: number) {
  const holder = new THREE.Group(); holder.add(o);
  o.rotation.y = Math.PI / 2;            // -Z (Spitze) -> -X (links)
  holder.rotation.x = 0.12; holder.position.y = y;
  return holder;
}

const dbg = new URLSearchParams(location.search);
async function visual(id: keyof typeof SWORDS, url: string) {
  const v = await saberFromModel(url, 1.0, SWORDS[id].color);
  if (!v) throw new Error('Modell laedt nicht: ' + id);
  v.tint(SWORDS[id].color); v.boost(0.25);
  if (dbg.has('nohalo')) v.halo.visible = false;
  if (dbg.has('nosoft')) v.group.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m && m.blending === THREE.AdditiveBlending) o.visible = false; });
  return v.group;
}

(window as unknown as { build: () => Promise<unknown> }).build = async () => {
  const out: Record<string, unknown> = {};
  const urls: Record<string, string> = {};
  const stats: Record<string, unknown> = {};
  for (const id of Object.keys(SWORDS) as (keyof typeof SWORDS)[]) {
    const g = buildSword(SWORDS[id].spec);
    let tris = 0, meshes = 0;
    g.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; meshes++; const gg = m.geometry; tris += (gg.index ? gg.index.count : gg.attributes.position.count) / 3; });
    const buf = await exportGlb(g);
    out[id] = b64(buf);
    urls[id] = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
    stats[id] = { tris: Math.round(tris), meshes, kb: Math.round(buf.byteLength / 1024) };
  }
  // Vorschau je Schwert (256 x 256)
  const shots: Record<string, string> = {};
  for (const id of Object.keys(SWORDS) as (keyof typeof SWORDS)[]) {
    const s = stage(256, 256);
    s.scene.add(place(await visual(id, urls[id]), 0));
    s.cam.position.set(-0.46, 0.05, 3.15); s.cam.lookAt(-0.46, 0, 0);
    s.comp.render();
    shots[id] = s.r.domElement.toDataURL('image/jpeg', 0.9);
    s.r.dispose(); s.r.domElement.remove();
  }
  // Vergleich wie die Vorlage: beide uebereinander
  const big = dbg.has('big'), s = stage(big ? 1400 : 489, big ? 1400 : 489);
  s.scene.add(place(await visual('frostklinge', urls.frostklinge), 0.2), place(await visual('glutklinge', urls.glutklinge), -0.28));
  if (dbg.has('zoom')) { s.cam.position.set(0.0, -0.04, 1.0); s.cam.lookAt(0.0, -0.04, 0); }
  else { s.cam.position.set(-0.46, -0.04, 3.05); s.cam.lookAt(-0.46, -0.04, 0); }
  s.comp.render();
  shots.vergleich = s.r.domElement.toDataURL('image/png');
  return { glb: out, shots, stats };
};
(window as unknown as { ready: boolean }).ready = true;
