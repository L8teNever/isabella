// Worker-Thread: Analyse und Level-Generierung laufen hier, damit der Webserver nie blockiert.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { analyze, waveform, generate, DIFFICULTIES, type SongAnalysis, type Difficulty } from '@beatblade/core';

export type WorkerTask =
  | { task: 'full'; id: string; dir: string; seed: number; pcm: Float32Array; sr: number }
  | { task: 'map'; id: string; dir: string; seed: number; difficulties?: Difficulty[] };

export type WorkerMsg =
  | { type: 'progress'; stage: 'analyzing' | 'mapping'; p: number }
  | { type: 'log'; msg: string; level?: 'info' | 'warn' }
  | { type: 'done'; bpm: number; duration: number; difficulties: Difficulty[] }
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
      post({ type: 'done', bpm: a.bpm, duration: a.duration, difficulties: diffs });
    } else {
      const a = JSON.parse(fs.readFileSync(path.join(t.dir, 'analysis.json'), 'utf8')) as SongAnalysis;
      const list = t.difficulties ?? DIFFICULTIES;
      if (!t.difficulties) fs.rmSync(path.join(t.dir, 'beatmaps'), { recursive: true, force: true });
      const diffs = mapAll(a, t.dir, t.seed, list);
      post({ type: 'done', bpm: a.bpm, duration: a.duration, difficulties: t.difficulties ? diffs : diffs });
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message || String(e) });
  }
});
