import { mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface TuneForkConfig {
  defaultProvider: string;
  volume: number;
  localMusicDirs: string[];
  theme: 'dark';
  poToken: string | null;
  visitorData: string | null;
}

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'tunefork');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: TuneForkConfig = {
  defaultProvider: 'youtube',
  volume: 80,
  localMusicDirs: [path.join(os.homedir(), 'Music')],
  theme: 'dark',
  poToken: null,
  visitorData: null,
};

export function loadConfig(): TuneForkConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TuneForkConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: TuneForkConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
