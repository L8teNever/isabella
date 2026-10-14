// "Fake-Raytracing": weiches Leuchten ohne Nachbearbeitung (WebXR-tauglich, billig auf der Quest).
// Halo hinter jedem Block, Lichtfleck auf dem Boden unter Bloecken und Schwertern, Leucht-Huelle um die Klingen.
import * as THREE from 'three';

// ---------- Stellschrauben ----------
export const GLOW = {
  haloSize: 2.4,        // Halo hinter dem Block (x Blockgroesse)
  haloStrength: 0.8,    // Helligkeit des Halos
  shellScale: 1.14,     // Leucht-Rand um den Block
  shellStrength: 0.45,
  poolSize: 1.3,        // Lichtfleck auf dem Boden (m)
  poolStrength: 0.5,
  poolFadeHeight: 2.2,  // ab dieser Hoehe (m) kein Bodenlicht mehr
  saberHalo: 0.075,     // Radius der weichen Huelle um die Klinge (m)
  saberHaloStrength: 0.5,
  saberPoolSize: 1.6,
  saberPoolStrength: 0.7,
};

let tex: THREE.Texture | null = null;
/** weicher runder Verlauf (weiss -> transparent) */
export function glowTexture(): THREE.Texture {
  if (tex) return tex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!, gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** additives Material mit dem Verlauf */
export function glowMaterial(opacity = 1, color = 0xffffff): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
}
