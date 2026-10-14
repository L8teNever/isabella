// 3D-Menue-Tafeln: per Canvas gezeichnet, per Laserpointer (Controller/Hand-Pinch) bedient.
import * as THREE from 'three';

export type Item =
  | { type: 'button'; id: string; label: string; sub?: string; img?: CanvasImageSource | null; on?: boolean; disabled?: boolean; main?: boolean; span?: number; h?: number; color?: string }
  | { type: 'text'; text: string; size?: number; color?: string; align?: CanvasTextAlign; span?: number }
  | { type: 'image'; img: CanvasImageSource; h: number; span?: number }
  | { type: 'progress'; value: number; label?: string; span?: number }
  | { type: 'gap'; h?: number };

export interface Spec { title?: string; subtitle?: string; items: Item[]; cols?: number }

const W = 1024, PAD = 34, GAP = 14;

export class Panel extends THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  canvas = document.createElement('canvas');
  tex: THREE.CanvasTexture;
  spec: Spec | null = null;
  hover: string | null = null;
  rects: { id: string; x: number; y: number; w: number; h: number; disabled?: boolean }[] = [];
  widthM: number;

  constructor(widthM = 1.2) {
    const c = document.createElement('canvas'); c.width = W; c.height = 256;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    super(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.canvas = c; this.tex = tex; this.widthM = widthM; this.renderOrder = 20; this.visible = false;
  }

  show(spec: Spec): this { this.spec = spec; this.visible = true; this.draw(); return this; }
  hide(): void { this.visible = false; this.spec = null; this.hover = null; }
  refresh(): void { if (this.spec) this.draw(); }

  private layout(c: CanvasRenderingContext2D, s: Spec) {
    const cols = s.cols ?? 1, cw = (W - 2 * PAD - (cols - 1) * GAP) / cols;
    let y = PAD;
    if (s.title) y += 64;
    if (s.subtitle) y += 40;
    const out: { it: Item; x: number; y: number; w: number; h: number }[] = [];
    let col = 0, rowH = 0;
    const newRow = () => { if (col > 0) { y += rowH + GAP; col = 0; rowH = 0; } };
    for (const it of s.items) {
      if (it.type === 'gap') { newRow(); y += it.h ?? 12; continue; }
      const span = Math.min(cols, it.type === 'text' || it.type === 'progress' || it.type === 'image' ? (it.span ?? cols) : (it.span ?? (it.main ? cols : 1)));
      if (col + span > cols) newRow();
      let h = 0;
      if (it.type === 'button') h = it.h ?? (it.img || it.sub ? 104 : 86);
      else if (it.type === 'text') {
        c.font = `500 ${it.size ?? 30}px system-ui, sans-serif`;
        h = wrap(c, it.text, cw * span + GAP * (span - 1)).length * ((it.size ?? 30) * 1.3);
      } else if (it.type === 'image') h = it.h;
      else if (it.type === 'progress') h = 40;
      out.push({ it, x: PAD + col * (cw + GAP), y, w: cw * span + GAP * (span - 1), h });
      rowH = Math.max(rowH, h); col += span;
      if (col >= cols) { y += rowH + GAP; col = 0; rowH = 0; }
    }
    if (col > 0) y += rowH + GAP;
    return { out, H: Math.max(140, y - GAP + PAD) };
  }

  draw(): void {
    const s = this.spec; if (!s) return;
    const c = this.canvas.getContext('2d')!;
    const { out, H } = this.layout(c, s);
    if (this.canvas.height !== H) {
      this.canvas.height = H; this.tex.dispose();
      this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 4;
      this.material.map = this.tex; this.material.needsUpdate = true;
      this.geometry.dispose(); this.geometry = new THREE.PlaneGeometry(this.widthM, (this.widthM * H) / W);
    }
    c.clearRect(0, 0, W, H);
    const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, 'rgba(24,18,40,0.94)'); g.addColorStop(1, 'rgba(10,20,34,0.94)');
    c.fillStyle = g; rr(c, 0, 0, W, H, 36); c.fill();
    c.strokeStyle = 'rgba(180,107,255,0.55)'; c.lineWidth = 3; rr(c, 2, 2, W - 4, H - 4, 34); c.stroke();
    let y = PAD;
    c.textBaseline = 'middle';
    if (s.title) { c.fillStyle = '#fff'; c.font = '800 48px system-ui, sans-serif'; c.textAlign = 'left'; c.fillText(s.title, PAD, y + 28, W - 2 * PAD); y += 64; }
    if (s.subtitle) { c.fillStyle = '#b8b0d6'; c.font = '500 28px system-ui, sans-serif'; c.textAlign = 'left'; c.fillText(s.subtitle, PAD, y + 16, W - 2 * PAD); }
    this.rects = [];
    for (const { it, x, y: yy, w, h } of out) {
      if (it.type === 'button') {
        const hot = this.hover === it.id && !it.disabled;
        c.fillStyle = hot ? '#ff3d6e' : it.on ? 'rgba(61,184,255,0.35)' : it.main ? 'rgba(180,107,255,0.75)' : 'rgba(255,255,255,0.08)';
        if (it.color && !hot) c.fillStyle = it.color;
        rr(c, x, yy, w, h, 20); c.fill();
        if (it.disabled) { c.fillStyle = 'rgba(0,0,0,0.45)'; rr(c, x, yy, w, h, 20); c.fill(); }
        let tx = x + 22;
        if (it.img) { try { c.save(); rr(c, x + 10, yy + 10, h - 20, h - 20, 12); c.clip(); c.drawImage(it.img, x + 10, yy + 10, h - 20, h - 20); c.restore(); } catch { /* Bild noch nicht geladen */ } tx = x + h + 6; }
        c.textAlign = it.img || it.sub ? 'left' : 'center';
        const lx = it.img || it.sub ? tx : x + w / 2;
        // verfuegbare Breite: zentriert die ganze Knopfbreite, sonst ab Textanfang
        const maxW = it.img || it.sub ? w - (lx - x) - 16 : w - 24;
        // Schrift verkleinern statt stauchen (bis 20 px)
        let fs = it.sub ? 32 : 34;
        c.fillStyle = '#fff'; c.font = `${it.main ? 800 : 650} ${fs}px system-ui, sans-serif`;
        while (fs > 20 && c.measureText(it.label).width > maxW) { fs -= 2; c.font = `${it.main ? 800 : 650} ${fs}px system-ui, sans-serif`; }
        c.fillText(it.label, lx, yy + (it.sub ? h * 0.36 : h / 2), maxW);
        if (it.sub) { c.fillStyle = hot ? '#ffe' : '#b8b0d6'; c.font = '500 25px system-ui, sans-serif'; c.fillText(it.sub, lx, yy + h * 0.7, w - (lx - x) - 16); }
        this.rects.push({ id: it.id, x, y: yy, w, h, disabled: it.disabled });
      } else if (it.type === 'text') {
        const size = it.size ?? 30;
        c.fillStyle = it.color ?? '#e8e2ff'; c.font = `500 ${size}px system-ui, sans-serif`; c.textAlign = it.align ?? 'left';
        const lines = wrap(c, it.text, w);
        lines.forEach((l, i) => c.fillText(l, it.align === 'center' ? x + w / 2 : x, yy + size * 0.65 + i * size * 1.3, w));
      } else if (it.type === 'image') {
        const iw = (it.img as HTMLCanvasElement).width || h, ih = (it.img as HTMLCanvasElement).height || h;
        const sc = Math.min(w / iw, h / ih); c.drawImage(it.img, x + (w - iw * sc) / 2, yy, iw * sc, ih * sc);
      } else if (it.type === 'progress') {
        c.fillStyle = 'rgba(255,255,255,0.1)'; rr(c, x, yy + 10, w, 20, 10); c.fill();
        const gg = c.createLinearGradient(x, 0, x + w, 0); gg.addColorStop(0, '#ff3d6e'); gg.addColorStop(1, '#3db8ff');
        c.fillStyle = gg; rr(c, x, yy + 10, Math.max(20, w * Math.min(1, it.value)), 20, 10); c.fill();
        if (it.label) { c.fillStyle = '#fff'; c.font = '600 22px system-ui'; c.textAlign = 'center'; c.fillText(it.label, x + w / 2, yy + 20); }
      }
    }
    this.tex.needsUpdate = true;
  }

  /** Button-ID unter dem Strahl */
  pick(ray: THREE.Raycaster): string | null {
    if (!this.visible) return null;
    const h = ray.intersectObject(this, false)[0];
    if (!h?.uv) return null;
    const px = h.uv.x * W, py = (1 - h.uv.y) * this.canvas.height;
    const r = this.rects.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    return r && !r.disabled ? r.id : null;
  }
  hits(ray: THREE.Raycaster): number | null { if (!this.visible) return null; return ray.intersectObject(this, false)[0]?.distance ?? null; }
  setHover(id: string | null): void { if (id !== this.hover) { this.hover = id; this.draw(); } }
}

export function wrap(c: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(' ')) { const t = line ? `${line} ${w}` : w; if (c.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; }
    out.push(line);
  }
  return out;
}
export function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
}
