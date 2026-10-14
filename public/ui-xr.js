// Bedienung in der Brille ohne feste Leiste:
// - Panel: schwebende Tafel mit Titel, Text und Knoepfen (Schritt-fuer-Schritt-Einrichtung)
// - WristMenu: Uhr-Menue am linken Handgelenk/Controller, erscheint nur beim Draufschauen
// Bedienen per Strahl (Controller, Pinch) oder Antippen mit dem Zeigefinger.
import * as THREE from 'three';

const W = 768;

export class Panel extends THREE.Mesh {
  // width in Metern
  constructor(width = 0.5) {
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    super(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
    this.canvas = canvas; this.tex = tex; this.widthM = width; this.renderOrder = 30;
    this.buttons = []; this.hover = -1; this.visible = false;
  }

  // spec: { title, text, buttons: [{ id, label, on?, small? }], cols? }
  show(spec) {
    this.spec = spec; this.visible = true; this.hover = -1; this.draw(); return this;
  }
  hide() { this.visible = false; this.spec = null; }

  draw() {
    const s = this.spec; if (!s) return;
    const cols = s.cols || 1, pad = 28, bh = 92, gap = 14;
    const c = this.canvas.getContext('2d');
    c.font = '500 30px system-ui, sans-serif';
    const lines = s.text ? wrap(c, s.text, W - 2 * pad) : [];
    // Layout: normale Knoepfe in Spalten, Hauptknopf (main) ueber die ganze Breite
    const slots = []; let col = 0, row = 0;
    for (const b of s.buttons) {
      const wide = b.main && cols > 1;
      if (wide && col) { row++; col = 0; }
      slots.push({ row, col, span: wide ? cols : 1 });
      col += wide ? cols : 1; if (col >= cols) { col = 0; row++; }
    }
    const rows = slots.length ? (col ? row + 1 : row) : 0;
    const H = pad + (s.title ? 60 : 0) + lines.length * 40 + (lines.length ? 16 : 0) + rows * (bh + gap) + pad - gap;
    if (this.canvas.height !== H) {
      this.canvas.height = H; this.tex.dispose(); this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
      this.material.map = this.tex; this.material.needsUpdate = true;
      this.geometry.dispose(); this.geometry = new THREE.PlaneGeometry(this.widthM, this.widthM * H / W);
    }
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(22,16,32,0.92)'; rr(c, 0, 0, W, H, 34); c.fill();
    c.strokeStyle = 'rgba(255,122,182,0.6)'; c.lineWidth = 3; rr(c, 2, 2, W - 4, H - 4, 32); c.stroke();
    let y = pad;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    if (s.title) { c.fillStyle = '#ffb3d1'; c.font = '800 44px system-ui, sans-serif'; c.fillText(s.title, W / 2, y + 26, W - 2 * pad); y += 60; }
    c.fillStyle = '#fbe9f2'; c.font = '500 30px system-ui, sans-serif';
    for (const l of lines) { c.fillText(l, W / 2, y + 18); y += 40; }
    if (lines.length) y += 16;
    const bw = (W - 2 * pad - (cols - 1) * gap) / cols;
    this.buttons = s.buttons.map((b, k) => {
      const sl = slots[k], w = bw * sl.span + gap * (sl.span - 1);
      const x = pad + sl.col * (bw + gap), by = y + sl.row * (bh + gap);
      const hot = k === this.hover, on = b.on;
      c.fillStyle = hot ? '#ff7ab6' : on ? 'rgba(255,122,182,0.35)' : b.main ? 'rgba(138,60,255,0.85)' : 'rgba(255,255,255,0.1)';
      rr(c, x, by, w, bh, 24); c.fill();
      c.fillStyle = hot ? '#2a0f1f' : '#fff'; c.font = `${b.main ? 800 : 650} ${b.small ? 26 : 32}px system-ui, sans-serif`;
      c.fillText(b.label, x + w / 2, by + bh / 2, w - 16);
      return { id: b.id, u0: x / W, u1: (x + w) / W, v0: 1 - (by + bh) / H, v1: 1 - by / H };
    });
    this.tex.needsUpdate = true;
  }

  _at(uv) { return this.buttons.findIndex((b) => uv.x >= b.u0 && uv.x <= b.u1 && uv.y >= b.v0 && uv.y <= b.v1); }

  // Strahl -> Knopf-Index
  pick(raycaster) {
    if (!this.visible) return -1;
    const h = raycaster.intersectObject(this, false)[0];
    return h ? this._at(h.uv) : -1;
  }

  // Fingerspitze nah an der Tafel -> Knopf-Index
  poke(p) {
    if (!this.visible) return -1;
    const l = this.worldToLocal(p.clone());
    const w = this.geometry.parameters.width, h = this.geometry.parameters.height;
    if (Math.abs(l.z) > 0.02 || Math.abs(l.x) > w / 2 || Math.abs(l.y) > h / 2) return -1;
    return this._at({ x: l.x / w + 0.5, y: l.y / h + 0.5 });
  }

  setHover(i) { if (i !== this.hover) { this.hover = i; this.draw(); } }
  idAt(i) { return this.buttons[i]?.id ?? null; }

  // vor den Spieler stellen (Blickrichtung, leicht unter Augenhoehe); follow: nur nachziehen, wenn weit weggedreht
  place(cam, dist = 0.75, follow = false) {
    const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld)); dir.y = 0;
    if (dir.lengthSq() < 1e-4) return; dir.normalize();
    const want = pos.clone().addScaledVector(dir, dist); want.y = pos.y - 0.12;
    if (follow) {
      const cur = this.position.clone().sub(pos).setY(0).normalize();
      if (cur.angleTo(dir) < 0.75 && Math.abs(this.position.y - want.y) < 0.4 && this.position.distanceTo(pos) < 1.5) return;
    }
    this.position.copy(want); this.lookAt(pos.x, want.y, pos.z);
  }
}

// Uhr-Menue: haengt am linken Handgelenk (Hand-Tracking) bzw. am linken Controller.
// Sichtbar, wenn man auf das Handgelenk schaut: Handruecken zeigt zum Kopf und die Hand ist nah vor dem Gesicht.
export class WristMenu {
  constructor(scene, width = 0.16) {
    this.panel = new Panel(width); scene.add(this.panel);
    this.visible = false; this.items = []; this.enabled = true; this.lost = 0;
  }
  setItems(items) { this.items = items; if (this.visible) this.panel.show({ buttons: items, cols: 2 }); }

  // inputs: Liste mit { hand, grip, mode, source }; head: Kopfposition
  update(inputs, head, dt) {
    const L = inputs.find((i) => i.mode && (i.source?.handedness === 'left')) || null;
    let show = false, pos = null, q = null;
    if (L && this.enabled && this.items.length) {
      const j = L.hand.joints;
      if (j?.wrist?.visible) {
        const w = j.wrist, wp = w.getWorldPosition(new THREE.Vector3()), wq = w.getWorldQuaternion(new THREE.Quaternion());
        const back = new THREE.Vector3(0, 1, 0).applyQuaternion(wq);           // Handruecken
        const toHead = head.clone().sub(wp); const d = toHead.length(); toHead.normalize();
        show = Math.abs(back.dot(toHead)) > 0.6 && d < 0.7;
        pos = wp.addScaledVector(toHead, 0.05).addScaledVector(new THREE.Vector3(0, 1, 0), 0.06);
      } else if (L.mode === 'tracked-pointer' && L.grip.visible) {
        const gp = L.grip.getWorldPosition(new THREE.Vector3()), gq = L.grip.getWorldQuaternion(new THREE.Quaternion());
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(gq), toHead = head.clone().sub(gp); const d = toHead.length(); toHead.normalize();
        show = up.dot(toHead) > 0.45 && d < 0.75;
        pos = gp.addScaledVector(up, 0.09).addScaledVector(toHead, 0.03);
      }
    }
    // kurzes Wackeln nicht sofort zuklappen
    if (show) this.lost = 0; else this.lost += dt;
    const vis = show || (this.visible && this.lost < 0.35 && pos);
    if (vis && !this.visible) this.panel.show({ buttons: this.items, cols: 2 });
    if (!vis && this.visible) this.panel.hide();
    this.visible = !!vis;
    if (this.visible && pos) { this.panel.position.lerp(pos, this.panel.userData.init ? 0.5 : 1); this.panel.userData.init = true; this.panel.lookAt(head); }
    if (!this.visible) this.panel.userData.init = false;
    this.left = L;
    return this.visible;
  }
}

function wrap(c, text, max) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(' ')) {
      const t = line ? line + ' ' + w : w;
      if (c.measureText(t).width > max && line) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}
function rr(c, x, y, w, h, r) { c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); }

// Eingaben auf Panels verarbeiten: Strahl/Pinch (pending select) und Antippen (Fingerspitze).
// Gibt den gedrueckten Knopf zurueck { panel, id } oder null.
export function pokeAll(panels, inputs, state) {
  for (const inp of inputs) {
    if (!inp.mode) continue;
    const tip = inp.hand?.joints?.['index-finger-tip'];
    if (!tip?.visible) { inp.pokeLock = null; continue; }
    const p = tip.getWorldPosition(new THREE.Vector3());
    let hit = null;
    for (const pn of panels) { const i = pn.poke(p); if (i >= 0) { hit = { panel: pn, id: pn.idAt(i), i }; break; } }
    if (hit && inp.pokeLock !== hit.id) { inp.pokeLock = hit.id; state.lastPoke = performance.now(); return hit; }
    if (!hit) inp.pokeLock = null;
  }
  return null;
}
