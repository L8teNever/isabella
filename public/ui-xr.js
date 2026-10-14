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

// Uhr-Menue am linken Handgelenk.
// Oeffnen: Handruecken links zu dir drehen und kurz draufschauen (wie auf eine Uhr) –
// oder am Controller X/Y (bzw. A/B) druecken. Danach bleibt das Menue ruhig im Raum stehen
// (es wackelt nicht mit der Hand mit), bis du etwas drueckst, wegschaust oder es nach 12 s
// von selbst zugeht. Erneutes Oeffnen erst, wenn die Hand einmal weggedreht war.
const V = () => new THREE.Vector3();
export class WristMenu {
  constructor(scene, width = 0.24) {
    this.panel = new Panel(width); scene.add(this.panel);
    this.visible = false; this.items = []; this.enabled = true;
    this.gaze = 0; this.armed = true; this.away = 0; this.idle = 0; this.btn = new Map();
  }
  setItems(items) { this.items = items; if (this.visible) this.panel.show({ buttons: items, cols: 2 }); }
  close() { this.panel.hide(); this.visible = false; this.armed = false; this.gaze = 0; }

  open(at, head) {
    if (!this.items.length) return;
    this.panel.show({ buttons: this.items, cols: 2 });
    const p = at.clone();
    // nicht zu nah am Gesicht, sonst kann man es kaum antippen
    const toP = p.clone().sub(head); const d = toP.length();
    if (d < 0.38) p.copy(head).addScaledVector(toP.normalize(), 0.38);
    this.panel.position.copy(p);
    this.panel.lookAt(head);
    this.visible = true; this.away = 0; this.idle = 0;
  }

  // inputs: Liste mit { hand, grip, mode, source }; cam: XR-Kamera; Rueckgabe: offen?
  update(inputs, head, dt, cam) {
    if (!this.enabled) { if (this.visible) this.close(); this.armed = true; return false; }
    // Controller: X/Y bzw. A/B schaltet um (Flanke)
    for (const inp of inputs) {
      const gp = inp.mode && !inp.source?.hand && inp.source?.gamepad; if (!gp) continue;
      const down = !!(gp.buttons[4]?.pressed || gp.buttons[5]?.pressed), was = this.btn.get(inp) || false;
      this.btn.set(inp, down);
      if (down && !was) {
        if (this.visible) this.close();
        else {
          const o = (inp.grip.visible ? inp.grip : inp.ray).getWorldPosition(V());
          this.open(o.add(V().set(0, 0.12, 0)).lerp(head, 0.25), head);
        }
        return this.visible;
      }
    }
    // Hand: Handruecken zum Gesicht, Hand im Blickfeld, kurz halten
    const L = inputs.find((i) => i.mode && i.source?.hand && i.source.handedness === 'left');
    const w = L?.hand.joints?.wrist;
    let looking = false, wp = null;
    if (w?.visible) {
      wp = w.getWorldPosition(V());
      const back = V().set(0, 1, 0).applyQuaternion(w.getWorldQuaternion(new THREE.Quaternion()));
      const toHead = head.clone().sub(wp); const d = toHead.length(); toHead.normalize();
      const fwd = cam ? V().set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())) : toHead.clone().negate();
      looking = back.dot(toHead) > 0.5 && d < 0.75 && fwd.dot(toHead.clone().negate()) > 0.75;
    }
    if (!looking) { this.gaze = 0; if (!this.visible) this.armed = true; }
    if (!this.visible) {
      if (looking && this.armed) { this.gaze += dt; if (this.gaze > 0.3) this.open(wp.addScaledVector(V().set(0, 1, 0), 0.1), head); }
      return false;
    }
    // offen: zugehen, wenn man lange wegschaut, sich weit entfernt oder nichts drueckt
    const toPanel = this.panel.position.clone().sub(head); const dist = toPanel.length(); toPanel.normalize();
    const fwd = cam ? V().set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())) : toPanel;
    this.away = fwd.dot(toPanel) < 0.5 ? this.away + dt : 0;
    this.idle += dt;
    if (this.away > 1 || dist > 1.3 || this.idle > 12) this.close();
    if (this.panel.hover >= 0) this.idle = 0;
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
