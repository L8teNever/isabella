// Anzeige waehrend des Spiels: Combo/Multiplikator links, Score/Genauigkeit rechts, Energieleiste unten,
// FPS (abschaltbar), Countdown, Wand-Vignette.
import * as THREE from 'three';
import { rr } from './panel';
import { starString, type ScoreKeeper } from '../game/score';

class Label extends THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D;
  constructor(w: number, h: number, px = 512) {
    const c = document.createElement('canvas'); c.width = px; c.height = Math.round((px * h) / w);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    super(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
    this.canvas = c; this.tex = t; this.ctx = c.getContext('2d')!; this.renderOrder = 15;
  }
}

export class Hud {
  group = new THREE.Group();
  private left = new Label(0.7, 0.45);
  private right = new Label(0.7, 0.45);
  private bar = new Label(1.6, 0.08, 800);
  private center = new Label(1.0, 0.5);
  fps = new Label(0.24, 0.08, 256);
  vignette: THREE.Mesh;
  private last = '';
  private t = 0;

  constructor(scene: THREE.Object3D, camera: THREE.Camera) {
    this.left.position.set(-1.75, 1.2, -3.2); this.left.rotation.y = 0.35;
    this.right.position.set(1.75, 1.2, -3.2); this.right.rotation.y = -0.35;
    this.bar.position.set(0, 0.12, -2.4); this.bar.rotation.x = -0.9;
    this.center.position.set(0, 1.5, -3);
    this.group.add(this.left, this.right, this.bar, this.center);
    this.group.visible = false; scene.add(this.group);
    this.fps.position.set(-0.22, -0.16, -0.6); this.fps.visible = false; camera.add(this.fps);
    // Vignette: Kugel um den Kopf, rot, nur sichtbar in Waenden
    this.vignette = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff2040, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false }));
    this.vignette.renderOrder = 99; camera.add(this.vignette);
  }

  show(on: boolean) { this.group.visible = on; if (!on) { this.vignette.visible = false; this.message(''); } }

  update(s: ScoreKeeper, dt: number, inWall: boolean) {
    this.t += dt;
    const key = `${s.score}|${s.combo}|${s.mult}|${Math.round(s.rating * 10)}|${s.hits}|${s.misses + s.badCuts}`;
    const v = this.vignette.material as THREE.MeshBasicMaterial;
    v.opacity += ((inWall ? 0.45 : 0) - v.opacity) * Math.min(1, dt * 10); this.vignette.visible = v.opacity > 0.01;
    if (key === this.last || this.t < 0.08) return;
    this.t = 0; this.last = key;
    let c = this.left.ctx, W = this.left.canvas.width, H = this.left.canvas.height;
    c.clearRect(0, 0, W, H); c.textAlign = 'center'; c.fillStyle = '#fff';
    c.font = '900 120px system-ui'; c.fillText(String(s.combo), W / 2, H * 0.48);
    c.font = '600 34px system-ui'; c.fillStyle = '#b8b0d6'; c.fillText('COMBO', W / 2, H * 0.64);
    c.font = '900 64px system-ui'; c.fillStyle = s.mult >= 8 ? '#ffd23c' : '#3db8ff'; c.fillText(`×${s.mult}`, W / 2, H * 0.92);
    this.left.tex.needsUpdate = true;
    c = this.right.ctx; W = this.right.canvas.width; H = this.right.canvas.height;
    c.clearRect(0, 0, W, H); c.textAlign = 'center';
    c.fillStyle = '#fff'; c.font = '900 110px system-ui'; c.fillText(`${s.rating.toFixed(1)} %`, W / 2, H * 0.42);
    c.fillStyle = '#ffd23c'; c.font = '700 54px system-ui'; c.fillText(starString(s.stars), W / 2, H * 0.68);
    c.font = '600 36px system-ui'; c.fillStyle = '#9fe8c4'; c.fillText(`✓ ${s.hits}`, W * 0.3, H * 0.93);
    c.fillStyle = '#ff9db0'; c.fillText(`✗ ${s.misses + s.badCuts}`, W * 0.7, H * 0.93);
    this.right.tex.needsUpdate = true;
    c = this.bar.ctx; W = this.bar.canvas.width; H = this.bar.canvas.height;
    c.clearRect(0, 0, W, H); c.fillStyle = 'rgba(255,255,255,0.15)'; rr(c, 0, 0, W, H, H / 2); c.fill();
    // Balken = aktuelle Wertung in Prozent
    c.fillStyle = s.rating >= 90 ? '#4be3a0' : s.rating >= 50 ? '#ffffff' : '#ff4d4d';
    rr(c, 2, 2, Math.max(H, ((W - 4) * s.rating) / 100), H - 4, (H - 4) / 2); c.fill();
    this.bar.tex.needsUpdate = true;
  }

  /** grosse Mitteilung (Countdown, "Fail"), leer = ausblenden */
  message(text: string, sub = '') {
    this.center.visible = !!text;
    if (!text) return;
    const c = this.center.ctx, W = this.center.canvas.width, H = this.center.canvas.height;
    c.clearRect(0, 0, W, H); c.textAlign = 'center'; c.fillStyle = '#fff';
    c.font = '900 150px system-ui'; c.fillText(text, W / 2, H * 0.55);
    if (sub) { c.font = '600 40px system-ui'; c.fillStyle = '#b8b0d6'; c.fillText(sub, W / 2, H * 0.85); }
    this.center.tex.needsUpdate = true;
  }

  setFps(v: number) {
    const c = this.fps.ctx; c.clearRect(0, 0, 256, 85); c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(0, 0, 256, 85);
    c.fillStyle = v >= 70 ? '#4be3a0' : v >= 60 ? '#ffc547' : '#ff5d5d'; c.font = '700 54px monospace'; c.textAlign = 'center'; c.fillText(`${Math.round(v)} fps`, 128, 62);
    this.fps.tex.needsUpdate = true;
  }
}
