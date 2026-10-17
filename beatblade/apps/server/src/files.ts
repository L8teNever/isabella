// Dateiablage pro Song: <DATA_DIR>/songs/<id>/{audio.<ext>, cover.<jpg|png>, analysis.json, waveform.json, beatmaps/<diff>-<seed>.json, beatmaps/orbit-<diff>-<seed>.json, beatmaps/duet/<mode>-<diff>-<seed>.json}
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { Difficulty, GameModeId } from '@beatblade/core';

export const songDir = (id: string) => path.join(config.dataDir, 'songs', id);
export const audioPath = (id: string, ext: string) => path.join(songDir(id), `audio.${ext}`);
export const analysisPath = (id: string) => path.join(songDir(id), 'analysis.json');
export const waveformPath = (id: string) => path.join(songDir(id), 'waveform.json');
export const beatmapDir = (id: string) => path.join(songDir(id), 'beatmaps');
export const beatmapPath = (id: string, d: Difficulty, seed: number, mode: GameModeId = 'schnitt') =>
  path.join(beatmapDir(id), `${mode === 'orbit' ? 'orbit-' : ''}${d}-${seed}.json`);
/** Duett-Levels liegen getrennt: beatmaps/duet/<mode>-<d>-<seed>.json (eigenes Aufraeumen) */
export const duetDir = (id: string) => path.join(beatmapDir(id), 'duet');
export const duetPath = (id: string, d: Difficulty, seed: number, mode: GameModeId) => path.join(duetDir(id), `${mode}-${d}-${seed}.json`);
export const tmpDir = () => { const p = path.join(config.dataDir, 'tmp'); fs.mkdirSync(p, { recursive: true }); return p; };

export function coverPath(id: string): string | null {
  for (const e of ['jpg', 'png', 'webp']) { const p = path.join(songDir(id), `cover.${e}`); if (fs.existsSync(p)) return p; }
  return null;
}

export function removeCovers(id: string): void {
  for (const e of ['jpg', 'png', 'webp']) fs.rmSync(path.join(songDir(id), `cover.${e}`), { force: true });
}
