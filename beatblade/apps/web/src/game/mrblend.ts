// Mixed Reality: leuchtende (additive) Effekte duerfen das Kamerabild nicht abdunkeln.
// Bei Passthrough wird das Bild mit dem Alpha-Kanal ueber die Kamera gelegt; normale additive Mischung
// schreibt auch Alpha – dunkle oder ausgeblendete Funken erscheinen dann als schwarze Flecken.
// Hier wird nur die Farbe addiert, Alpha bleibt unveraendert.
import * as THREE from 'three';

export function mrSafeBlending(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (mat.blending !== THREE.AdditiveBlending || mat.userData.mrSafe) continue;
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.SrcAlphaFactor; mat.blendDst = THREE.OneFactor;
      mat.blendSrcAlpha = THREE.ZeroFactor; mat.blendDstAlpha = THREE.OneFactor;
      mat.userData.mrSafe = true; mat.needsUpdate = true;
    }
  });
}
