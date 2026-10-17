import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, generate, generateDuet, countProblems, splitSlots, pickTiming, schnittTiming, Rng, DIFFICULTIES, DUET_DENSITY, DUET_MIN_SHARE, DUET_MAX_SHARE } from '../dist/index.js';
import { synthSong } from './synth.mjs';

const songs = [128, 96, 174].map((bpm) => analyze(synthSong({ bpm, seconds: 90, seed: 3 })));
const k = (t) => Math.round(Math.round(t * 1e4) / 10);
const times = (m) => new Set(m.notes.map((n) => k(n.t)));
const chosenOf = (a, d, seed) => pickTiming(a, schnittTiming(d, DUET_DENSITY), new Rng(`${seed}:${d}:duet`)).chosen;

test('Duett: deterministisch je Seed, anderer Seed = anderes Ergebnis', () => {
  const a = songs[0];
  for (const d of DIFFICULTIES) {
    const m1 = generateDuet(a, d, 7), m2 = generateDuet(a, d, 7), m3 = generateDuet(a, d, 8);
    assert.deepEqual(m1, m2, `${d}: gleicher Seed`);
    assert.notDeepEqual([m1.parts[0].notes, m1.parts[1].notes], [m3.parts[0].notes, m3.parts[1].notes], `${d}: anderer Seed`);
  }
});

test('Duett: beide Stimmen zusammen = alle Slots, kein Zeitpunkt doppelt (ausser Unisono)', () => {
  for (const a of songs) for (const d of DIFFICULTIES) {
    const m = generateDuet(a, d, 7), t0 = times(m.parts[0]), t1 = times(m.parts[1]);
    const uni = new Set(m.unison.map(k));
    assert.deepEqual([...new Set([...t0, ...t1])].sort((x, y) => x - y), m.slots.map(k), `${a.bpm} ${d}: Vereinigung`);
    for (const t of t0) if (t1.has(t)) assert.ok(uni.has(t), `${a.bpm} ${d}: ${t / 1000}s in beiden Stimmen`);
    // gespielt wird nur, was die Zeitauswahl gewaehlt hat – und fast alles davon
    const chosen = new Set(chosenOf(a, d, 7).map((s) => k(s.t)));
    for (const t of m.slots) assert.ok(chosen.has(k(t)), `${a.bpm} ${d}: ${t}s nicht gewaehlt`);
    assert.ok(m.slots.length >= chosen.size * 0.95, `${a.bpm} ${d}: nur ${m.slots.length}/${chosen.size} Slots gespielt`);
  }
});

test('Duett: Ausgleich je Abschnitt innerhalb der Grenzen', () => {
  for (const a of songs) for (const d of DIFFICULTIES) {
    const split = splitSlots(chosenOf(a, d, 7));
    const per = new Map();
    for (const v of [0, 1]) for (const s of split.parts[v]) {
      if (s.drop) continue;
      const key = s.sec?.startBar ?? -1, c = per.get(key) ?? [0, 0]; c[v]++; per.set(key, c);
    }
    for (const [sec, [n0, n1]] of per) {
      if (n0 + n1 < 10) continue;
      const share = n0 / (n0 + n1);
      assert.ok(share >= DUET_MIN_SHARE - 0.05 && share <= DUET_MAX_SHARE + 0.05, `${a.bpm} ${d} Abschnitt ${sec}: Stimme 1 hat ${(share * 100).toFixed(0)} %`);
    }
  }
});

test('Duett: jede Stimme spielbar, Dichte steigt mit der Schwierigkeit', () => {
  for (const a of songs) {
    const prev = [0, 0];
    for (const d of DIFFICULTIES) {
      const m = generateDuet(a, d, 7);
      m.parts.forEach((p, v) => {
        // Spielbarkeit wie bei den Solo-Tests: keine Parity-Fehler, keine Ueberkreuzungen
        const pr = countProblems(p);
        assert.equal(pr.parity, 0, `${a.bpm} ${d} Stimme ${v + 1}: Parity-Fehler`);
        assert.equal(pr.crossover, 0, `${a.bpm} ${d} Stimme ${v + 1}: Ueberkreuzungen`);
        assert.ok(p.stats.playability >= 95, `${a.bpm} ${d} Stimme ${v + 1}: Spielbarkeit ${p.stats.playability} (${JSON.stringify(p.stats.issues)})`);
        assert.ok(p.notes.length > prev[v], `${a.bpm} ${d} Stimme ${v + 1}: ${p.notes.length} <= ${prev[v]}`);
        prev[v] = p.notes.length;
        assert.ok(p.notes.some((n) => n.c === 0) && p.notes.some((n) => n.c === 1), 'beide Haende');
      });
      assert.deepEqual(m.parts[0].obstacles, m.parts[1].obstacles, 'gleiche Waende');
      assert.deepEqual(m.parts[0].lights, m.parts[1].lights, 'gleiche Lichtshow');
    }
  }
});

test('Duett: Solo-Level bleibt unberuehrt', () => {
  const a = songs[0];
  const before = JSON.stringify(generate(a, 'hard', 7));
  generateDuet(a, 'hard', 7);
  assert.equal(JSON.stringify(generate(a, 'hard', 7)), before);
});

// kuenstliche Slots: 8 Takte, je 4 Schlaege
const fakeSlots = (fn) => {
  const sec = { startBar: 0, endBar: 8, type: 'drop', group: 0, occurrence: 0 };
  const out = [];
  for (let bar = 0; bar < 8; bar++) for (let q = 0; q < 4; q++) {
    const b = bar * 4 + q;
    out.push({ b, t: b * 0.5, g: b * 24, sal: 0.5 + (q === 0 ? 0.3 : 0), kick: 0, snare: 0, hat: 0, mel: 0, bar, inBar: q, sec, ...fn(bar, q) });
  }
  return out;
};

test('Duett: Drop-Einsatz spielen beide (Unisono), sonst jeder Slot genau einmal', () => {
  const slots = fakeSlots((bar, q) => ({ kick: q % 2 ? 0 : 0.9, hat: q % 2 ? 0.9 : 0, drop: bar === 2 && q === 0 }));
  const sp = splitSlots(slots);
  assert.equal(sp.unison.length, 1);
  assert.ok(sp.parts[0].includes(sp.unison[0]) && sp.parts[1].includes(sp.unison[0]));
  const n = sp.parts[0].length + sp.parts[1].length - sp.unison.length;
  assert.equal(n, slots.length, 'jeder Slot genau einmal');
  // Kick-Schlaege -> Stimme 1, Hi-Hats -> Stimme 2
  assert.ok(sp.parts[0].filter((s) => !s.drop).every((s) => s.kick > 0), 'Stimme 1 = Rhythmus');
  assert.ok(sp.parts[1].filter((s) => !s.drop).every((s) => s.hat > 0), 'Stimme 2 = Melodie/Glanz');
});

test('Duett: nur eine Klangart -> Frage-Antwort je Phrase, ausgeglichen', () => {
  const sp = splitSlots(fakeSlots(() => ({ kick: 0.9 })));
  const share = sp.parts[0].length / (sp.parts[0].length + sp.parts[1].length);
  assert.ok(share >= DUET_MIN_SHARE && share <= DUET_MAX_SHARE, `Anteil ${share}`);
  // innerhalb einer 2-Takt-Phrase bleibt es bei einer Stimme
  for (const v of [0, 1]) {
    const phrases = new Set(sp.parts[v].map((s) => Math.floor(s.bar / 2)));
    for (const p of phrases) assert.ok(!sp.parts[1 - v].some((s) => Math.floor(s.bar / 2) === p), `Phrase ${p} geteilt`);
  }
});

// ---------- Orbit-Duett ----------
import { generateOrbitDuet, generateOrbit, checkOrbit } from '../dist/index.js';

test('Orbit-Duett: deterministisch, Stimmen getrennt, jede Rail genau einer Stimme', () => {
  for (const a of songs) for (const d of DIFFICULTIES) {
    const m1 = generateOrbitDuet(a, d, 7), m2 = generateOrbitDuet(a, d, 7);
    assert.deepEqual(m1, m2, `${a.bpm} ${d}: gleicher Seed`);
    const own = (p) => new Set(p.notes.filter((n) => n.rail === undefined).map((n) => k(n.t)));
    const t0 = own(m1.parts[0]), t1 = own(m1.parts[1]), uni = new Set(m1.unison.map(k));
    for (const t of t0) if (t1.has(t)) assert.ok(uni.has(t), `${a.bpm} ${d}: ${t / 1000}s in beiden Stimmen`);
    const r0 = m1.parts[0].rails.map((r) => r.t0), r1 = m1.parts[1].rails.map((r) => r.t0);
    for (const t of r0) assert.ok(!r1.includes(t), `${a.bpm} ${d}: Rail ${t}s in beiden Stimmen`);
    m1.parts.forEach((p, v) => {
      assert.deepEqual(checkOrbit(p), {}, `${a.bpm} ${d} Stimme ${v + 1}: ${JSON.stringify(checkOrbit(p))}`);
      assert.equal(p.stats.playability, 100);
    });
  }
  const a = songs[0];
  assert.notDeepEqual(generateOrbitDuet(a, 'hard', 7).parts[0].notes, generateOrbitDuet(a, 'hard', 8).parts[0].notes, 'anderer Seed');
});

test('Orbit-Duett: Dichte jeder Stimme steigt mit der Schwierigkeit', () => {
  for (const a of songs) {
    // zusammen streng steigend; je Stimme hoechstens leichte Schwankung (Rails wechseln die Stimme)
    let prevSum = 0; const prev = [0, 0], first = [];
    for (const d of DIFFICULTIES) {
      const m = generateOrbitDuet(a, d, 7), sum = m.parts[0].notes.length + m.parts[1].notes.length;
      assert.ok(sum > prevSum, `${a.bpm} ${d}: zusammen ${sum} <= ${prevSum}`); prevSum = sum;
      m.parts.forEach((p, v) => {
        assert.ok(p.notes.length >= prev[v] * 0.92, `${a.bpm} ${d} Stimme ${v + 1}: ${p.notes.length} < ${prev[v]}`);
        prev[v] = p.notes.length; first[v] ??= p.notes.length;
      });
    }
    for (const v of [0, 1]) assert.ok(prev[v] > first[v] * 2, `${a.bpm} Stimme ${v + 1}: Expert+ kaum dichter als Easy`);
  }
});
