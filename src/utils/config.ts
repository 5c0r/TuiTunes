import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TuiTunesConfig {
  volume: number;
  translationLanguage: string | null;
  translationProvider: 'lingva' | 'deepl' | 'mymemory';
  deeplApiKey: string | null;
  lingvaInstance: string | null;
  ascii: boolean;
  reducedMotion: boolean;
  spectrumEnabled: boolean;
}

export const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), '.config', 'tuimusic');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: TuiTunesConfig = {
  volume: 80,
  translationLanguage: null,
  translationProvider: 'lingva',
  deeplApiKey: null,
  lingvaInstance: null,
  ascii: false,
  reducedMotion: false,
  spectrumEnabled: false,
};

export function loadConfig(): TuiTunesConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG };
    const value = parsed as Record<string, unknown>;
    return {
      volume:
        typeof value.volume === 'number' && Number.isFinite(value.volume)
          ? Math.max(0, Math.min(150, value.volume))
          : DEFAULT_CONFIG.volume,
      translationLanguage:
        typeof value.translationLanguage === 'string' ? value.translationLanguage : null,
      translationProvider:
        value.translationProvider === 'deepl' || value.translationProvider === 'mymemory'
          ? value.translationProvider
          : 'lingva',
      deeplApiKey: typeof value.deeplApiKey === 'string' ? value.deeplApiKey : null,
      lingvaInstance: typeof value.lingvaInstance === 'string' ? value.lingvaInstance : null,
      ascii: typeof value.ascii === 'boolean' ? value.ascii : false,
      reducedMotion: typeof value.reducedMotion === 'boolean' ? value.reducedMotion : false,
      spectrumEnabled: typeof value.spectrumEnabled === 'boolean' ? value.spectrumEnabled : false,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: TuiTunesConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
