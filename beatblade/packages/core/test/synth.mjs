// Synthetische Testsongs: Kick/Snare/Hi-Hat/Bass mit bekanntem Tempo, Taktart und Struktur.
export function synthSong({ bpm, seconds = 60, sr = 44100, meter = 4, swing = 0, seed = 1, structure = true }) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const n = Math.floor(seconds * sr), pcm = new Float32Array(n);
  const beat = 60 / bpm;
  const add = (t0, fn, dur) => { const a = Math.floor(t0 * sr), b = Math.min(n, a + Math.floor(dur * sr)); for (let i = Math.max(0, a); i < b; i++) pcm[i] += fn((i - a) / sr); };
  const kick = (t) => Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) * t) * Math.exp(-t * 8) * 0.9;
  const snare = (t) => ((rnd() * 2 - 1) * 0.5 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 18);
  const hat = (t) => (rnd() * 2 - 1) * 0.18 * Math.exp(-t * 60);
  const notes = [55, 55, 65.4, 73.4];
  const nb = Math.floor(seconds / beat);
  for (let k = 0; k < nb; k++) {
    const t = k * beat, pos = k % meter, bar = Math.floor(k / meter);
    // Struktur: 8 Takte leise (nur Hats+Bass), dann voll, dann Breakdown
    const phase = structure ? Math.floor(bar / 8) % 3 : 1;
    const full = phase !== 0;
    if (full && (meter === 4 ? pos === 0 || pos === 2 : pos === 0)) add(t, kick, 0.4);
    if (full && (meter === 4 ? pos === 1 || pos === 3 : pos === 1 || pos === 2)) add(t, snare, 0.25);
    add(t, hat, 0.08); add(t + beat / 2 + swing * beat / 6, hat, 0.06);
    if (phase === 1) { add(t + beat / 4, hat, 0.04); add(t + (3 * beat) / 4, hat, 0.04); }
    const f = notes[bar % 4];
    add(t, (u) => Math.sin(2 * Math.PI * f * u) * 0.25 * Math.exp(-u * 3), beat * 0.9);
  }
  let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(pcm[i]));
  for (let i = 0; i < n; i++) pcm[i] /= mx || 1;
  return pcm;
}
