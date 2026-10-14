// SQLite (better-sqlite3): Songs, Jobs, Highscores. Synchron und schnell; schwere Arbeit laeuft in Workern.
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import type { Difficulty, Highscore, Song, SongStatus } from '@beatblade/core';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'beatblade.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  bpm REAL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  bundled INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  has_cover INTEGER NOT NULL DEFAULT 0,
  difficulties TEXT NOT NULL DEFAULT '[]',
  seed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL DEFAULT '',
  ext TEXT NOT NULL DEFAULT 'mp3',
  license TEXT,
  source TEXT,
  analysis_version INTEGER NOT NULL DEFAULT 0,
  mapping_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_song ON logs(song_id);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  difficulty TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  rank TEXT NOT NULL,
  max_combo INTEGER NOT NULL,
  misses INTEGER NOT NULL,
  modifiers TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_song ON scores(song_id, difficulty, score DESC);
`);

type Row = Record<string, unknown>;

export function rowToSong(r: Row): Song {
  return {
    id: r.id as string, title: r.title as string, artist: r.artist as string, album: r.album as string,
    duration: r.duration as number, bpm: (r.bpm as number) ?? null, status: r.status as SongStatus, progress: r.progress as number,
    error: (r.error as string) ?? null, bundled: !!r.bundled, hidden: !!r.hidden, hasCover: !!r.has_cover,
    difficulties: JSON.parse((r.difficulties as string) || '[]'), seed: r.seed as number,
    createdAt: r.created_at as number, updatedAt: r.updated_at as number, hash: r.hash as string, fileName: r.file_name as string,
    license: (r.license as string) ?? null, source: (r.source as string) ?? null,
  };
}

export const q = {
  song: db.prepare('SELECT * FROM songs WHERE id = ?'),
  songByHash: db.prepare('SELECT * FROM songs WHERE hash = ?'),
  songs: db.prepare('SELECT * FROM songs ORDER BY created_at DESC'),
  insertSong: db.prepare(`INSERT INTO songs (id, title, artist, album, duration, status, bundled, has_cover, created_at, updated_at, hash, file_name, ext, license, source)
    VALUES (@id, @title, @artist, @album, @duration, 'queued', @bundled, @has_cover, @now, @now, @hash, @file_name, @ext, @license, @source)`),
  deleteSong: db.prepare('DELETE FROM songs WHERE id = ?'),
  insertJob: db.prepare(`INSERT INTO jobs (song_id, type, status, created_at) VALUES (?, ?, 'queued', ?)`),
  nextJob: db.prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`),
  openJobFor: db.prepare(`SELECT * FROM jobs WHERE song_id = ? AND status IN ('queued','running') LIMIT 1`),
  log: db.prepare('INSERT INTO logs (song_id, at, level, msg) VALUES (?, ?, ?, ?)'),
  logs: db.prepare('SELECT at, level, msg FROM logs WHERE song_id = ? ORDER BY id DESC LIMIT 300'),
  scores: db.prepare('SELECT * FROM scores WHERE song_id = ? AND difficulty = ? ORDER BY score DESC, created_at ASC LIMIT ?'),
  insertScore: db.prepare(`INSERT INTO scores (song_id, difficulty, name, score, accuracy, rank, max_combo, misses, modifiers, created_at)
    VALUES (@songId, @difficulty, @name, @score, @accuracy, @rank, @maxCombo, @misses, @modifiers, @createdAt)`),
};

/** Teil-Update eines Songs (nur erlaubte Spalten) */
const COLS = new Set(['title', 'artist', 'album', 'duration', 'bpm', 'status', 'progress', 'error', 'hidden', 'has_cover', 'difficulties', 'seed', 'analysis_version', 'mapping_version']);
export function updateSong(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields).filter((k) => COLS.has(k));
  if (!keys.length) return;
  const sql = `UPDATE songs SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`;
  db.prepare(sql).run({ ...fields, updated_at: Date.now(), id });
}

export function getSong(id: string): Song | null {
  const r = q.song.get(id) as Row | undefined;
  return r ? rowToSong(r) : null;
}

export function songRow(id: string): Row | undefined { return q.song.get(id) as Row | undefined; }

export function logSong(id: string, msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  q.log.run(id, Date.now(), level, msg);
}

export function topScores(songId: string, difficulty: Difficulty, limit = 10): Highscore[] {
  return (q.scores.all(songId, difficulty, limit) as Row[]).map((r) => ({
    songId: r.song_id as string, difficulty: r.difficulty as Difficulty, name: r.name as string, score: r.score as number,
    accuracy: r.accuracy as number, rank: r.rank as string, maxCombo: r.max_combo as number, misses: r.misses as number,
    modifiers: r.modifiers as string, createdAt: r.created_at as number,
  }));
}
