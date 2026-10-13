// Geraeusche, komplett erzeugt (keine Audio-Dateien): Kegel-Klacken, Rollen der Kugel, Jubel bei Strike.
let ctx = null, noise = null, roll = null;

export function initSound() {
  if (ctx) { ctx.resume?.(); return; }
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  const len = ctx.sampleRate;
  noise = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  // Rollgeraeusch: tiefes, gefiltertes Rauschen, Lautstaerke nach Tempo
  const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 180;
  const g = ctx.createGain(); g.gain.value = 0;
  src.connect(f).connect(g).connect(ctx.destination); src.start();
  roll = g;
}

// Aufprall: Holz-Klack (kurzer Ton + Rauschen), Lautstaerke nach Aufprall-Tempo
export function hit(speed, kind = 'pin') {
  if (!ctx || speed < 0.3) return;
  const t = ctx.currentTime, v = Math.min(1, speed / 6) * (kind === 'ball' ? 0.9 : 0.55);
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'triangle'; o.frequency.setValueAtTime(kind === 'ball' ? 420 : 900 + Math.random() * 500, t);
  o.frequency.exponentialRampToValueAtTime(200, t + 0.08);
  og.gain.setValueAtTime(v * 0.5, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.13);
  const n = ctx.createBufferSource(); n.buffer = noise;
  const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 2200; nf.Q.value = 0.8;
  const ng = ctx.createGain(); ng.gain.setValueAtTime(v * 0.6, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  n.connect(nf).connect(ng).connect(ctx.destination); n.start(t, Math.random() * 0.5, 0.1);
}

export function rolling(speed, onFloor) {
  if (!roll) return;
  const target = onFloor ? Math.min(0.35, speed * 0.06) : 0;
  roll.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
}

// kleine Melodie: Strike / Spare
export function cheer(strike) {
  if (!ctx) return;
  const notes = strike ? [523, 659, 784, 1047] : [523, 659, 784];
  notes.forEach((f, k) => {
    const t = ctx.currentTime + k * 0.11, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.4);
  });
}
