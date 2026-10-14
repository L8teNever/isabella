import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, generateOrbit, checkOrbit, handPath, DIFFICULTIES, ORBIT, ORBIT_DIFFICULTY } from '../dist/index.js';
import { synthSong } from './synth.mjs';

const songs = [128, 96, 174].map((bpm) => analyze(synthSong({ bpm, seconds: 90, seed: 3 })));

test('Orbit: deterministisch je Seed, anderer Seed = anderes Level', () => {
  const a = songs[0];
  for (const d of DIFFICULTIES) {
    const m1 = generateOrbit(a, d, 7), m2 = generateOrbit(a, d, 7), m3 = generateOrbit(a, d, 8);
    assert.deepEqual(m1, m2, `${d}: gleicher Seed`);
    assert.notDeepEqual(m1.notes, m3.notes, `${d}: anderer Seed`);
  }
});

test('Orbit: Dichte steigt mit der Schwierigkeit, keine Probleme', () => {
  for (const a of songs) {
    let prev = 0;
    for (const d of DIFFICULTIES) {
      const m = generateOrbit(a, d, 7);
      assert.ok(m.stats.notes > prev, `${a.bpm} ${d}: ${m.stats.notes} <= ${prev}`);
      prev = m.stats.notes;
      assert.deepEqual(m.stats.issues, {}, `${a.bpm} ${d}: ${JSON.stringify(m.stats.issues)}`);
      assert.equal(m.stats.playability, 100);
    }
  }
});

test('Orbit: keine Hand schneller als erlaubt, alles in der Flaeche', () => {
  for (const a of songs) for (const d of DIFFICULTIES) {
    const m = generateOrbit(a, d, 7), max = ORBIT_DIFFICULTY[d].maxHandSpeed;
    for (const hand of [0, 1]) {
      const p = handPath(m, hand);
      for (let i = 1; i < p.length; i++) {
        const dt = p[i].t - p[i - 1].t, dist = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
        if (dist < 0.02) continue;
        const lim = p[i].rail !== undefined && p[i].rail === p[i - 1].rail ? max * 1.2 : max;
        assert.ok(dt > 0 && dist / dt <= lim * 1.001 + 1e-9, `${a.bpm} ${d} Hand ${hand} bei ${p[i].t}: ${(dist / dt).toFixed(2)} m/s`);
      }
    }
    for (const n of m.notes) assert.ok(n.x >= ORBIT.minX && n.x <= ORBIT.maxX && n.y >= ORBIT.minY && n.y <= ORBIT.maxY);
  }
});

test('Orbit: Rails nur auf gehaltenen Klaengen, mit Start-Note, ohne Ueberlappung', () => {
  let total = 0;
  for (const a of songs) for (const d of DIFFICULTIES) {
    const m = generateOrbit(a, d, 7);
    m.rails.forEach((r, i) => {
      total++;
      const k0 = m.beats.findIndex((t) => t >= r.t0 - 1e-3), k1 = m.beats.findIndex((t) => t >= r.t1 - 1e-3);
      const s = a.sustain.slice(k0, k1);
      const mean = s.reduce((x, y) => x + y, 0) / s.length;
      assert.ok(mean >= ORBIT.railMeanSustain - 1e-9, `${d}: Rail ${i} auf sustain ${mean.toFixed(2)}`);
      assert.ok(m.notes.some((n) => n.rail === i && Math.abs(n.t - r.t0) < 1e-3), `${d}: Rail ${i} ohne Start-Note`);
      if (i) assert.ok(r.t0 >= m.rails[i - 1].t1, 'Rails ueberlappen');
    });
    const share = m.rails.reduce((x, r) => x + r.t1 - r.t0, 0) / a.duration;
    assert.ok(share <= ORBIT_DIFFICULTY[d].railShare + 1e-9, `${d}: Rail-Anteil ${share.toFixed(2)}`);
  }
  assert.ok(total > 0, 'keine einzige Rail erzeugt');
});

test('Orbit: Gold-Rails fuer beide Haende, waehrenddessen keine anderen Noten', () => {
  let gold = 0;
  for (const a of songs) for (const d of DIFFICULTIES) {
    const m = generateOrbit(a, d, 7);
    m.rails.forEach((r, i) => {
      if (r.kind !== 'gold') return;
      gold++;
      assert.notEqual(d, 'easy', 'Gold-Rail auf Leicht');
      const inside = m.notes.filter((n) => n.t > r.t0 + 0.05 && n.t < r.t1 - 0.05);
      assert.ok(inside.every((n) => n.rail === i && n.kind === 'gold'), `${d}: fremde Note auf Gold-Rail ${i}`);
    });
  }
  assert.ok(gold > 0, 'keine Gold-Rail erzeugt');
});

test('Orbit: ohne sustain (alte Analyse) keine Rails, aber spielbar', () => {
  const { sustain, pitch, ...old } = songs[0];
  const m = generateOrbit(old, 'hard', 7);
  assert.equal(m.rails.length, 0);
  assert.ok(m.notes.length > 50);
  assert.deepEqual(m.stats.issues, {});
});

test('Orbit-Validierung findet eingebaute Fehler', () => {
  const m = generateOrbit(songs[0], 'hard', 7);
  const clone = () => JSON.parse(JSON.stringify(m));
  // zu schnelle Hand
  const f1 = clone(); const n1 = f1.notes.find((n, i) => i > 5 && n.kind === 'normal' && n.rail === undefined);
  n1.x = n1.hand === 0 ? ORBIT.minX : ORBIT.maxX; n1.y = ORBIT.maxY;
  const prevSame = f1.notes.filter((n) => n.t < n1.t && n.hand === n1.hand && n.kind === 'normal').pop();
  if (prevSame) { prevSame.x = n1.hand === 0 ? 0 : 0; prevSame.y = ORBIT.minY; prevSame.t = n1.t - 0.05; }
  assert.ok(checkOrbit(f1).handSpeed > 0, 'handSpeed');
  // Note in einer Wand
  const f2 = clone(); const n2 = f2.notes[10];
  f2.obstacles.push({ b: n2.b, t: n2.t - 0.2, dur: 0.5, x: 0, w: 4, kind: 'full' });
  assert.ok(checkOrbit(f2).inWall > 0, 'inWall');
  // ueberkreuzte Haende
  const f3 = clone(); const L = f3.notes.find((n) => n.hand === 0 && n.kind === 'normal' && n.rail === undefined);
  const R = f3.notes.find((n) => n.hand === 1 && n.kind === 'normal' && n.rail === undefined && Math.abs(n.t - L.t) < 0.4 && n.t > L.t);
  if (R) { L.x = 0.5; R.x = -0.5; assert.ok(checkOrbit(f3).crossing > 0, 'crossing'); }
  // ausserhalb der Flaeche
  const f4 = clone(); f4.notes[3].y = 3; assert.ok(checkOrbit(f4).outOfArea > 0, 'outOfArea');
  // kurze Rail
  const f5 = clone(); if (f5.rails.length) { f5.rails[0].t1 = f5.rails[0].t0 + 0.1; assert.ok(checkOrbit(f5).railShort > 0, 'railShort'); }
});
