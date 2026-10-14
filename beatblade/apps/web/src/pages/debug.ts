// Debug-Ansicht: Wellenform + Beats/Takte + Onsets je Band + Abschnitte + Energie + Noten als Zeitleiste.
// Abspielen mit Metronom-Klick (Web Audio, auf audioContext.currentTime geplant) und optionalem Noten-Klick.
import '../style.css';
import { BANDS, DIFFICULTIES, DIFFICULTY_LABEL, Cut, cutVector, type Beatmap, type Difficulty, type SongAnalysis, type Waveform, type Song } from '@beatblade/core';
import { api, BASE } from '../api';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const id = new URLSearchParams(location.search).get('song') ?? '';
const cv = $<HTMLCanvasElement>('tl'), ctx = cv.getContext('2d')!;
let song: Song, A: SongAnalysis | null = null, W: Waveform | null = null, M: Beatmap | null = null;
let view0 = 0;                 // linker Rand (s)
let span = 16;                 // sichtbare Sekunden
let ac: AudioContext | null = null, buf: AudioBuffer | null = null, src: AudioBufferSourceNode | null = null, startAt = 0, offset = 0, playing = false;
let scheduledUntil = 0;

const SEC_COLORS: Record<string, string> = { intro: '#3a3550', verse: '#24456b', buildup: '#6b5a24', drop: '#6b2440', breakdown: '#245e4c', outro: '#3a3550' };

async function boot() {
  if (!id) { $('title').textContent = 'Kein Song gewählt (…/debug.html?song=ID)'; return; }
  song = await api.song(id);
  $('title').textContent = `${song.title} – ${song.artist}`;
  $<HTMLAnchorElement>('playlink').href = `${BASE}/play.html?song=${id}`;
  const sel = $<HTMLSelectElement>('diff');
  sel.innerHTML = DIFFICULTIES.map((d) => `<option value="${d}" ${d === 'expert' ? 'selected' : ''}>${DIFFICULTY_LABEL[d]}</option>`).join('');
  $<HTMLInputElement>('seed').value = String(song.seed);
  [A, W] = await Promise.all([api.analysis(id).catch(() => null), api.waveform(id).catch(() => null)]);
  await loadMap();
  api.log(id).then((l) => { $('log').textContent = l.map((x) => `${new Date(x.at).toLocaleTimeString('de-DE')} ${x.msg}`).join('\n'); });
  resize(); draw();
}

async function loadMap() {
  M = await api.beatmap(id, $<HTMLSelectElement>('diff').value as Difficulty, +$<HTMLInputElement>('seed').value || 0).catch(() => null);
  const s = M?.stats;
  $('stats').innerHTML = !A ? '' : [
    ['BPM', `${A.bpm} (${Math.round(A.bpmConfidence * 100)} %)`], ['Takt', `${A.beatsPerBar}/4, ${A.bars.length} Takte`],
    ['Abschnitte', A.sections.length], ['Analyse', `${A.took} ms`],
    ...(s ? [['Noten', `${s.notes} (${s.nps}/s)`], ['Drop / Strophe', `${s.dropNps} / ${s.verseNps} /s`], ['Spitze (2 s)', `${s.peakNps}/s`],
      ['Bomben / Wände', `${s.bombs} / ${s.obstacles}`], ['Spielbarkeit', `${s.playability}/100`], ['Korrigiert', Object.entries(s.issues).map(([k, v]) => `${k} ${v}`).join(', ') || '–']] : []),
  ].map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
  draw();
}

function resize() { const r = cv.getBoundingClientRect(); cv.width = Math.round(r.width * devicePixelRatio); cv.height = Math.round(r.height * devicePixelRatio); }
addEventListener('resize', () => { resize(); draw(); });

// ---------- Zeichnen ----------
function draw() {
  const w = cv.width, h = cv.height, dpr = devicePixelRatio;
  ctx.clearRect(0, 0, w, h);
  if (!A) { ctx.fillStyle = '#888'; ctx.font = `${14 * dpr}px system-ui`; ctx.fillText('Noch keine Analyse vorhanden', 20, 40); return; }
  const x = (t: number) => ((t - view0) / span) * w;
  const rows = { sec: [0, 22], wave: [22, 120], energy: [120, 160], bands: [160, 280], notes: [290, 600], lights: [604, 640] };
  const Y = (r: number[]) => [r[0] * dpr * (h / dpr / 640), r[1] * dpr * (h / dpr / 640)];
  // Abschnitte
  const [s0, s1] = Y(rows.sec);
  for (const s of A.sections) {
    ctx.fillStyle = SEC_COLORS[s.type] ?? '#333'; ctx.fillRect(x(s.start), s0, x(s.end) - x(s.start), s1 - s0);
    ctx.fillStyle = '#fff'; ctx.font = `${11 * dpr}px system-ui`; ctx.fillText(`${s.type} g${s.group}${s.occurrence ? '′' : ''}`, x(s.start) + 4, s0 + 15 * dpr);
  }
  // Wellenform
  const [w0, w1] = Y(rows.wave), wm = (w0 + w1) / 2, wh = (w1 - w0) / 2;
  if (W) {
    ctx.fillStyle = '#5b4f86';
    const per = W.duration / W.count;
    for (let i = Math.max(0, Math.floor(view0 / per)); i < Math.min(W.count, Math.ceil((view0 + span) / per)); i++) {
      const mn = W.peaks[i * 2], mx = W.peaks[i * 2 + 1], xx = x(i * per);
      ctx.fillRect(xx, wm - mx * wh, Math.max(1, (w / span) * per), (mx - mn) * wh);
    }
  }
  // Beats und Takte
  for (let k = 0; k < A.beats.length; k++) {
    const t = A.beats[k]; if (t < view0 - 1 || t > view0 + span + 1) continue;
    const down = (k - A.downbeatOffset) % A.beatsPerBar === 0;
    ctx.fillStyle = down ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.16)';
    ctx.fillRect(x(t), w0, down ? 2 * dpr : 1 * dpr, h - w0);
  }
  // Energie
  const [e0, e1] = Y(rows.energy);
  ctx.strokeStyle = '#ffc547'; ctx.lineWidth = 1.5 * dpr; ctx.beginPath();
  A.energyCurve.forEach((v, i) => { const t = i * 0.1; if (t < view0 - 1 || t > view0 + span + 1) return; const yy = e1 - v * (e1 - e0); ctx.lineTo(x(t), yy); });
  ctx.stroke();
  // Onsets je Band
  const [b0, b1] = Y(rows.bands), bh = (b1 - b0) / 4;
  const bandCol = ['#ff7a59', '#ffc547', '#4be3a0', '#7ad7ff'];
  BANDS.forEach((b, i) => {
    ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(0, b0 + i * bh, w, bh - 2);
    ctx.fillStyle = bandCol[i];
    for (const o of A!.onsets[b]) { if (o.t < view0 || o.t > view0 + span) continue; const hh = (bh - 4) * o.s; ctx.fillRect(x(o.t) - dpr, b0 + i * bh + (bh - 2 - hh), 2 * dpr, hh); }
    ctx.fillStyle = '#aaa'; ctx.font = `${10 * dpr}px system-ui`; ctx.fillText(['Sub', 'Low-Mid', 'High-Mid', 'High'][i], 4, b0 + i * bh + 11 * dpr);
  });
  // Noten: 12 Zeilen (4 Spalten x 3 Reihen), Reihe oben = y2
  const [n0, n1] = Y(rows.notes), nh = (n1 - n0) / 12;
  for (let r = 0; r < 12; r++) { ctx.fillStyle = r % 3 === 2 ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.03)'; ctx.fillRect(0, n0 + r * nh, w, nh - 1); }
  const rowOf = (xx: number, yy: number) => xx * 3 + (2 - yy);
  if (M) {
    for (const o of M.obstacles) {
      if (o.t + o.dur < view0 || o.t > view0 + span) continue;
      ctx.fillStyle = o.kind === 'crouch' ? 'rgba(255,120,80,.35)' : 'rgba(255,200,80,.3)';
      const ys = o.kind === 'crouch' ? [0, 1, 2, 3].map((c) => rowOf(c, 2)) : Array.from({ length: o.w }, (_, i) => o.x + i).flatMap((c) => [rowOf(c, 2), rowOf(c, 1), rowOf(c, 0)]);
      for (const r of ys) ctx.fillRect(x(o.t), n0 + r * nh, x(o.t + o.dur) - x(o.t), nh - 1);
    }
    const sz = Math.min(nh - 2, 14 * dpr);
    for (const n of M.notes) {
      if (n.t < view0 - 0.2 || n.t > view0 + span) continue;
      const cx = x(n.t), cy = n0 + rowOf(n.x, n.y) * nh + nh / 2;
      ctx.fillStyle = n.c === 0 ? '#ff3d6e' : '#3db8ff'; ctx.fillRect(cx - sz / 2, cy - sz / 2, sz, sz);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * dpr; ctx.beginPath();
      if (n.d === Cut.Any) { ctx.arc(cx, cy, sz * 0.18, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
      else { const [vx, vy] = cutVector(n.d); ctx.moveTo(cx - vx * sz * 0.35, cy + vy * sz * 0.35); ctx.lineTo(cx + vx * sz * 0.35, cy - vy * sz * 0.35); ctx.stroke(); }
    }
    for (const b of M.bombs) { if (b.t < view0 || b.t > view0 + span) continue; ctx.fillStyle = '#888'; ctx.beginPath(); ctx.arc(x(b.t), n0 + rowOf(b.x, b.y) * nh + nh / 2, sz * 0.45, 0, Math.PI * 2); ctx.fill(); }
    // Lichtshow
    const [l0, l1] = Y(rows.lights);
    for (const l of M.lights) {
      if (l.t < view0 || l.t > view0 + span) continue;
      ctx.fillStyle = l.type === 'flash' ? `rgba(255,255,255,${l.v})` : l.type === 'burst' ? '#ff3d6e' : l.type === 'off' ? '#000' : l.type === 'color' ? '#b46bff' : `rgba(122,215,255,${l.v * 0.6})`;
      ctx.fillRect(x(l.t), l0, l.type === 'laser' ? 3 * dpr : 2 * dpr, l1 - l0);
    }
  }
  // Abspielkopf
  const now = currentTime();
  ctx.fillStyle = '#fff'; ctx.fillRect(x(now), 0, 2 * dpr, h);
  $('time').textContent = `${now.toFixed(2)} s`;
}

// ---------- Audio ----------
const currentTime = () => (playing && ac ? ac.currentTime - startAt : offset);

async function play() {
  if (playing) { offset = currentTime(); src?.stop(); playing = false; $('play').textContent = '▶ Abspielen'; return; }
  ac ??= new AudioContext();
  if (!buf) { $('play').textContent = 'Lade …'; buf = await ac.decodeAudioData(await (await fetch(api.audioUrl(id))).arrayBuffer()); }
  src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
  startAt = ac.currentTime + 0.1 - offset; src.start(ac.currentTime + 0.1, offset);
  playing = true; scheduledUntil = offset; $('play').textContent = '❚❚ Pause';
}

function click(at: number, freq: number, gain = 0.25) {
  const o = ac!.createOscillator(), g = ac!.createGain();
  o.frequency.value = freq; g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  o.connect(g).connect(ac!.destination); o.start(at); o.stop(at + 0.06);
}

function tick() {
  if (playing && ac && A) {
    const t = currentTime();
    // Klicks 200 ms im Voraus auf der Audio-Uhr planen
    const until = t + 0.2;
    if ($<HTMLInputElement>('click').checked) A.beats.forEach((b, k) => { if (b >= scheduledUntil && b < until) click(startAt + b, (k - A!.downbeatOffset) % A!.beatsPerBar === 0 ? 1600 : 1000); });
    if ($<HTMLInputElement>('nclick').checked && M) for (const n of M.notes) if (n.t >= scheduledUntil && n.t < until) click(startAt + n.t, n.c === 0 ? 700 : 900, 0.15);
    scheduledUntil = until;
    if (t > view0 + span * 0.85 || t < view0) view0 = Math.max(0, t - span * 0.15);
    if (buf && t > buf.duration) { playing = false; offset = 0; $('play').textContent = '▶ Abspielen'; }
  }
  draw();
  requestAnimationFrame(tick);
}

$('play').addEventListener('click', play);
$('load').addEventListener('click', loadMap);
$('diff').addEventListener('change', loadMap);
$('zoom').addEventListener('input', () => { span = +$<HTMLInputElement>('zoom').value; draw(); });
cv.addEventListener('click', (e) => {
  const r = cv.getBoundingClientRect(), t = view0 + ((e.clientX - r.left) / r.width) * span;
  const was = playing; if (playing) { src?.stop(); playing = false; }
  offset = Math.max(0, t); if (was) play(); else draw();
});
cv.addEventListener('wheel', (e) => { e.preventDefault(); view0 = Math.max(0, view0 + (e.deltaY + e.deltaX) / 400 * span * 0.25); if (!playing) offset = Math.max(offset, 0); draw(); }, { passive: false });

boot(); tick();
