// Raum-Anker (WebXR anchors): haelt Bahnen an derselben Stelle im echten Raum –
// auch wenn die Brille abgesetzt und wieder aufgesetzt wird (Tracking-Ursprung springt)
// und beim naechsten Start (persistenter Anker, Quest).
import * as THREE from 'three';

export class RoomAnchor {
  constructor(key) {
    this.key = key; this.anchor = null; this.M = new THREE.Matrix4(); this.ok = false;
    this.state = null; this.restored = false; this.t0 = 0;
  }

  begin(session) { this.session = session; this.anchor = null; this.ok = false; this.restored = false; this.state = 'start'; this.t0 = performance.now(); }
  end() { this.anchor = null; this.ok = false; this.state = null; }

  async _init(frame, ref) {
    let id = null;
    try { id = localStorage.getItem(this.key); } catch {}
    try { if (id && this.session.restorePersistentAnchor) { this.anchor = await this.session.restorePersistentAnchor(id); this.restored = !!this.anchor; } } catch { this.anchor = null; }
    if (!this.anchor && frame.createAnchor) {
      try {
        this.anchor = await frame.createAnchor(new XRRigidTransform(), ref);
        const h = await this.anchor.requestPersistentHandle?.();
        if (h) try { localStorage.setItem(this.key, h); } catch {}
      } catch { this.anchor = null; }
    }
  }

  // pro Bild; Rueckgabe: { ready, delta } – delta (Matrix4) wenn der Anker sich in Weltkoordinaten verschoben hat
  update(frame, ref) {
    if (this.state === 'start' && frame) { this.state = 'busy'; this._init(frame, ref).finally(() => { this.state = 'wait'; }); }
    let delta = null;
    if (this.anchor && frame) {
      const pose = frame.getPose(this.anchor.anchorSpace, ref);
      if (pose) {
        const M = new THREE.Matrix4().fromArray(pose.transform.matrix);
        if (this.ok) {
          const d = new THREE.Matrix4().multiplyMatrices(M, this.M.clone().invert());
          const p = new THREE.Vector3(), q = new THREE.Quaternion(); d.decompose(p, q, new THREE.Vector3());
          if (p.length() > 0.01 || 2 * Math.acos(Math.min(1, Math.abs(q.w))) > 0.01) delta = d;
        }
        if (!this.ok || delta) this.M.copy(M);
        this.ok = true;
      }
    }
    const ready = this.state === 'wait' && (this.ok || performance.now() - this.t0 > 2500);
    if (ready) this.state = 'done';
    return { ready, delta };
  }

  // Weltpunkt <-> Anker-Koordinaten (ohne Anker: unveraendert)
  toLocal(v) { return this.ok ? v.clone().applyMatrix4(this.M.clone().invert()) : v.clone(); }
  toWorld(v) { return this.ok ? v.clone().applyMatrix4(this.M) : v.clone(); }
  dirToLocal(d) { return this.ok ? d.clone().transformDirection(this.M.clone().invert()) : d.clone(); }
  dirToWorld(d) { return this.ok ? d.clone().transformDirection(this.M) : d.clone(); }
}

// Drehung um die Hochachse aus einer Delta-Matrix
export function deltaYaw(d) {
  const x = new THREE.Vector3(0, 0, 1).transformDirection(d);
  return Math.atan2(x.x, x.z);
}
