// Persistente Job-Queue (SQLite) + Worker-Pool.
// Jobs ueberleben Neustarts: laufende Jobs werden beim Start wieder in die Warteschlange gestellt.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { config } from './config.js';
import { db, q, getSong, songRow, updateSong, logSong } from './db.js';
import { songChanged } from './events.js';
import { audioPath, songDir } from './files.js';
import { decode } from './media.js';
import { ANALYSIS_VERSION, MAPPING_VERSION, ORBIT_MAPPING_VERSION, type Difficulty, type GameModeId, type JobType } from '@beatblade/core';
import type { WorkerMsg, WorkerTask } from './worker.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

class Pool {
  private idle: Worker[] = [];
  private all: Worker[] = [];
  private waiting: ((w: Worker) => void)[] = [];
  constructor(private size: number) {}
  private spawn(): Worker {
    const w = new Worker(WORKER_URL);
    w.on('error', (e) => console.error('Worker-Fehler', e));
    w.on('exit', () => { this.all = this.all.filter((x) => x !== w); this.idle = this.idle.filter((x) => x !== w); });
    this.all.push(w); return w;
  }
  async acquire(): Promise<Worker> {
    const w = this.idle.pop();
    if (w) return w;
    if (this.all.length < this.size) return this.spawn();
    return new Promise((res) => this.waiting.push(res));
  }
  release(w: Worker): void {
    w.removeAllListeners('message');
    const next = this.waiting.shift();
    if (next) next(w); else this.idle.push(w);
  }
  /** Aufgabe ausfuehren, Nachrichten weiterreichen */
  async run(task: WorkerTask, onMsg: (m: WorkerMsg) => void, transfer: ArrayBuffer[] = []): Promise<WorkerMsg & { type: 'done' }> {
    const w = await this.acquire();
    try {
      return await new Promise((resolve, reject) => {
        const onExit = (code: number) => reject(new Error(`Worker beendet (${code}) – evtl. zu wenig Speicher`));
        w.once('exit', onExit);
        w.on('message', (m: WorkerMsg) => {
          if (m.type === 'done') { w.off('exit', onExit); resolve(m); }
          else if (m.type === 'error') { w.off('exit', onExit); reject(new Error(m.message)); }
          else onMsg(m);
        });
        w.postMessage(task, transfer);
      });
    } finally {
      if (this.all.includes(w)) this.release(w);
    }
  }
}

export const pool = new Pool(config.concurrency);
let running = 0;

export function enqueue(songId: string, type: JobType): void {
  const open = q.openJobFor.get(songId) as { type: string; status: string } | undefined;
  // laufender/wartender Komplett-Job deckt alles ab
  if (open && (open.type === 'full' || open.type === type) && open.status === 'queued') return;
  q.insertJob.run(songId, type, Date.now());
  updateSong(songId, { status: 'queued', progress: 0, error: null });
  songChanged(getSong(songId));
  pump();
}

function pump(): void {
  while (running < config.concurrency) {
    const job = q.nextJob.get() as { id: number; song_id: string; type: JobType } | undefined;
    if (!job) return;
    db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?`).run(Date.now(), job.id);
    running++;
    runJob(job).finally(() => { running--; pump(); });
  }
}

async function runJob(job: { id: number; song_id: string; type: JobType }): Promise<void> {
  const id = job.song_id;
  const row = songRow(id);
  if (!row) { db.prepare(`UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?`).run(Date.now(), job.id); return; }
  // Orbit-Nachruesten laeuft still im Hintergrund: der Song bleibt fuer Schnitt spielbar
  const quiet = job.type === 'orbit';
  const set = (status: string, progress: number) => { if (quiet) return; updateSong(id, { status, progress }); songChanged(getSong(id)); };
  let lastP = -1;
  const onMsg = (m: WorkerMsg) => {
    if (m.type === 'progress') { if (Math.abs(m.p - lastP) >= 0.03 || m.p === 1) { lastP = m.p; set(m.stage, m.p); } }
    else if (m.type === 'log') logSong(id, m.msg, m.level ?? 'info');
  };
  const t0 = Date.now();
  try {
    const seed = row.seed as number;
    let result;
    if (job.type === 'full') {
      set('decoding', 0);
      logSong(id, `Dekodieren (${row.ext})`);
      const pcm = await decode(audioPath(id, row.ext as string), row.duration as number, (p) => { if (p - lastP > 0.05) { lastP = p; set('decoding', p); } });
      lastP = -1;
      logSong(id, `Dekodiert: ${(pcm.length / 44100).toFixed(1)} s Audio in ${Date.now() - t0} ms`);
      set('analyzing', 0);
      result = await pool.run({ task: 'full', id, dir: songDir(id), seed, pcm, sr: 44100 }, onMsg, [pcm.buffer as ArrayBuffer]);
      updateSong(id, { analysis_version: ANALYSIS_VERSION });
    } else {
      set('mapping', 0);
      // 'map' erzeugt beide Modi neu, 'orbit' nur die Orbit-Levels (Schnitt bleibt unberuehrt)
      result = await pool.run({ task: 'map', id, dir: songDir(id), seed, mode: job.type === 'orbit' ? 'orbit' : undefined }, onMsg);
    }
    const upd: Record<string, unknown> = quiet ? {} : { status: 'ready', progress: 1, error: null, bpm: result.bpm, duration: result.duration };
    if (result.difficulties) { upd.difficulties = JSON.stringify(result.difficulties); upd.mapping_version = MAPPING_VERSION; }
    if (result.orbitDifficulties) { upd.orbit_difficulties = JSON.stringify(result.orbitDifficulties); upd.orbit_version = ORBIT_MAPPING_VERSION; }
    updateSong(id, upd);
    logSong(id, `Fertig in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    db.prepare(`UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?`).run(Date.now(), job.id);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    logSong(id, quiet ? `Orbit: ${msg}` : msg, 'error');
    if (!quiet) updateSong(id, { status: 'error', error: msg, progress: 0 });
    db.prepare(`UPDATE jobs SET status = 'error', error = ?, finished_at = ? WHERE id = ?`).run(msg, Date.now(), job.id);
  }
  songChanged(getSong(id));
}

/** einzelne Schwierigkeit/Seed bei Bedarf erzeugen (z. B. GET beatmap mit neuem Seed) */
export async function mapOnDemand(id: string, d: Difficulty, seed: number, mode: GameModeId = 'schnitt'): Promise<void> {
  await pool.run({ task: 'map', id, dir: songDir(id), seed, difficulties: [d], mode }, () => {});
}

/** Beim Start: unterbrochene Jobs fortsetzen, veraltete Analysen/Levels neu erzeugen */
export function resumeAndUpgrade(): void {
  db.prepare(`UPDATE jobs SET status = 'queued' WHERE status = 'running'`).run();
  // Songs, die mitten in der Verarbeitung standen und keinen Job mehr haben
  for (const r of db.prepare(`SELECT id FROM songs WHERE status IN ('queued','decoding','analyzing','mapping') AND id NOT IN (SELECT song_id FROM jobs WHERE status = 'queued')`).all() as { id: string }[]) {
    q.insertJob.run(r.id, 'full', Date.now());
  }
  for (const r of db.prepare(`SELECT id, analysis_version, mapping_version, orbit_version FROM songs WHERE status IN ('ready','outdated')`).all() as { id: string; analysis_version: number; mapping_version: number; orbit_version: number }[]) {
    if (r.analysis_version < ANALYSIS_VERSION) { updateSong(r.id, { status: 'outdated' }); logSong(r.id, `Analyse veraltet (v${r.analysis_version} -> v${ANALYSIS_VERSION}), wird neu erstellt`); q.insertJob.run(r.id, 'full', Date.now()); }
    else if (r.mapping_version < MAPPING_VERSION) { updateSong(r.id, { status: 'outdated' }); logSong(r.id, `Levels veraltet (v${r.mapping_version} -> v${MAPPING_VERSION}), werden neu erzeugt`); q.insertJob.run(r.id, 'map', Date.now()); }
    else if (r.orbit_version < ORBIT_MAPPING_VERSION) { logSong(r.id, `Orbit-Levels ${r.orbit_version ? `veraltet (v${r.orbit_version} -> v${ORBIT_MAPPING_VERSION})` : 'fehlen'}, werden erzeugt`); q.insertJob.run(r.id, 'orbit', Date.now()); }
  }
  pump();
}

export const cpuCount = os.cpus().length;
