import { mkdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TuiTunesConfig {
  defaultProvider: string;
  volume: number;
  localMusicDirs: string[];
  theme: 'dark';
  poToken: string | null;
  visitorData: string | null;
  translationLanguage: string | null;
  translationProvider: string;
  deeplApiKey: string | null;
  lingvaInstance: string | null;
}

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'tuimusic');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: TuiTunesConfig = {
  defaultProvider: 'youtube',
  volume: 80,
  localMusicDirs: [path.join(os.homedir(), 'Music')],
  theme: 'dark',
  poToken: null,
  visitorData: null,
  translationLanguage: null,
  translationProvider: 'lingva',
  deeplApiKey: null,
  lingvaInstance: null,
};

export function loadConfig(): TuiTunesConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TuiTunesConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: TuiTunesConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
