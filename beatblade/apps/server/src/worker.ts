// Worker-Thread: Analyse und Level-Generierung laufen hier, damit der Webserver nie blockiert.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { analyze, waveform, generate, generateOrbit, generateDuet, generateOrbitDuet, DIFFICULTIES, type SongAnalysis, type Difficulty, type GameModeId } from '@beatblade/core';

export type WorkerTask =
  | { task: 'full'; id: string; dir: string; seed: number; pcm: Float32Array; sr: number }
  /** mode fehlt = beide Modi */
  | { task: 'map'; id: string; dir: string; seed: number; difficulties?: Difficulty[]; mode?: GameModeId }
  /** Duett-Level (Stimme 1 + 2) fuer eine Schwierigkeit, nur bei Bedarf */
  | { task: 'duet'; id: string; dir: string; seed: number; difficulty: Difficulty; mode: GameModeId };

export type WorkerMsg =
  | { type: 'progress'; stage: 'analyzing' | 'mapping'; p: number }
  | { type: 'log'; msg: string; level?: 'info' | 'warn' }
  | { type: 'done'; bpm: number; duration: number; difficulties?: Difficulty[]; orbitDifficulties?: Difficulty[] }
  | { type: 'error'; message: string };

const post = (m: WorkerMsg) => parentPort!.postMessage(m);
const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
};

function mapAll(a: SongAnalysis, dir: string, seed: number, list: readonly Difficulty[]): Difficulty[] {
  const done: Difficulty[] = [];
  list.forEach((d, i) => {
    const t0 = Date.now();
    const bm = generate(a, d, seed);
    write(path.join(dir, 'beatmaps', `${d}-${seed}.json`), bm);
    const s = bm.stats;
    post({ type: 'log', msg: `${d}: ${s.notes} Noten, ${s.nps}/s (Drop ${s.dropNps}/s, Strophe ${s.verseNps}/s, Spitze ${s.peakNps}/s), ${s.bombs} Bomben, ${s.obstacles} Wände, Spielbarkeit ${s.playability}/100${Object.keys(s.issues).length ? ', korrigiert: ' + JSON.stringify(s.issues) : ''} (${Date.now() - t0} ms)` });
    if (s.notes > 0) done.push(d);
    post({ type: 'progress', stage: 'mapping', p: (i + 1) / list.length });
  });
  return done;
}

function mapOrbit(a: SongAnalysis, dir: string, seed: number, list: readonly Difficulty[]): Difficulty[] {
  const done: Difficulty[] = [];
  list.forEach((d, i) => {
    const t0 = Date.now();
    const om = generateOrbit(a, d, seed);
    write(path.join(dir, 'beatmaps', `orbit-${d}-${seed}.json`), om);
    const s = om.stats;
    post({ type: 'log', msg: `Orbit ${d}: ${s.notes} Kugeln, ${s.nps}/s (Spitze ${s.peakNps}/s), ${s.rails} Rails (${s.railSeconds} s), ${s.gold} Gold, ${s.green} Grün, ${s.obstacles} Wände, Hand max ${s.maxHandSpeed} m/s, Spielbarkeit ${s.playability}/100${Object.keys(s.issues).length ? ', Probleme: ' + JSON.stringify(s.issues) : ''} (${Date.now() - t0} ms)` });
    if (s.notes > 0) done.push(d);
    post({ type: 'progress', stage: 'mapping', p: (i + 1) / list.length });
  });
  return done;
}

/** alte Levels eines Modus entfernen (Schnitt: <d>-<seed>.json, Orbit: orbit-<d>-<seed>.json); Duett-Ordner bleibt */
function clearMaps(dir: string, mode: GameModeId): void {
  const bd = path.join(dir, 'beatmaps');
  if (!fs.existsSync(bd)) return;
  for (const f of fs.readdirSync(bd)) {
    if (!f.endsWith('.json')) continue;
    if (f.startsWith('orbit-') === (mode === 'orbit')) fs.rmSync(path.join(bd, f), { force: true });
  }
}

parentPort!.on('message', (t: WorkerTask) => {
  try {
    if (t.task === 'full') {
      let last = 0;
      const a = analyze(t.pcm, t.sr, (stage, p) => {
        // Merkmals-Extraktion ist der groesste Teil (~80 %)
        const total = stage === 'features' ? p * 0.8 : stage === 'onsets' ? 0.82 : stage === 'tempo' ? 0.86 : stage === 'meter' ? 0.92 : 0.96;
        if (total - last > 0.02) { last = total; post({ type: 'progress', stage: 'analyzing', p: total }); }
      });
      write(path.join(t.dir, 'analysis.json'), a);
      write(path.join(t.dir, 'waveform.json'), waveform(t.pcm, t.sr));
      post({ type: 'log', msg: `Analyse fertig in ${a.took} ms: ${a.bpm} BPM (Sicherheit ${Math.round(a.bpmConfidence * 100)} %), ${a.beatsPerBar}/4, ${a.beats.length} Beats, Abschnitte: ${a.sections.map((s) => `${s.type}(${s.endBar - s.startBar})`).join(' ')}` });
      post({ type: 'progress', stage: 'mapping', p: 0 });
      // alte Levels entfernen (neue Analyse)
      fs.rmSync(path.join(t.dir, 'beatmaps'), { recursive: true, force: true });
      const diffs = mapAll(a, t.dir, t.seed, DIFFICULTIES);
      const orbit = mapOrbit(a, t.dir, t.seed, DIFFICULTIES);
      post({ type: 'done', bpm: a.bpm, duration: a.duration, difficulties: diffs, orbitDifficulties: orbit });
    } else if (t.task === 'duet') {
      const a = JSON.parse(fs.readFileSync(path.join(t.dir, 'analysis.json'), 'utf8')) as SongAnalysis;
      const t0 = Date.now();
      const dm = t.mode === 'orbit' ? generateOrbitDuet(a, t.difficulty, t.seed) : generateDuet(a, t.difficulty, t.seed);
      write(path.join(t.dir, 'beatmaps', 'duet', `${t.mode}-${t.difficulty}-${t.seed}.json`), dm);
      post({ type: 'log', msg: `Duett ${t.mode} ${t.difficulty}: Stimme 1 ${dm.parts[0].notes.length}, Stimme 2 ${dm.parts[1].notes.length} Noten, Anteil ${dm.stats.share.map((x) => Math.round(x * 100)).join('/')} %, ${dm.stats.unison} gemeinsam (${Date.now() - t0} ms)` });
      post({ type: 'done', bpm: a.bpm, duration: a.duration });
    } else {
      const a = JSON.parse(fs.readFileSync(path.join(t.dir, 'analysis.json'), 'utf8')) as SongAnalysis;
      const list = t.difficulties ?? DIFFICULTIES;
      const out: WorkerMsg & { type: 'done' } = { type: 'done', bpm: a.bpm, duration: a.duration };
      if (t.mode !== 'orbit') {
        if (!t.difficulties) clearMaps(t.dir, 'schnitt');
        out.difficulties = mapAll(a, t.dir, t.seed, list);
      }
      if (t.mode !== 'schnitt') {
        if (!t.difficulties) clearMaps(t.dir, 'orbit');
        out.orbitDifficulties = mapOrbit(a, t.dir, t.seed, list);
      }
      post(out);
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message || String(e) });
  }
});
