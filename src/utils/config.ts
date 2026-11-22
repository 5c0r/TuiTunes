import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type IconStyle = 'unicode' | 'nerd-font';

/** External translation backends; 'none' keeps translation native-only. */
export type TranslationProviderId = 'none' | 'libretranslate' | 'lingva' | 'mymemory' | 'deepl';

export interface TuiTunesConfig {
  volume: number;
  translationLanguage: string | null;
  translationProvider: TranslationProviderId;
  /** Explicit source language code; null lets each provider detect/auto. */
  translationSourceLanguage: string | null;
  /** Self-hosted LibreTranslate base URL; required by the libretranslate provider. */
  libreTranslateEndpoint: string | null;
  deeplApiKey: string | null;
  lingvaInstance: string | null;
  ascii: boolean;
  /** Icon glyph set used while `ascii` is off; saved while suppressed. */
  iconStyle: IconStyle;
  reducedMotion: boolean;
  spectrumEnabled: boolean;
  lyricFollowMode: LyricFollowMode;
}

export type LyricFollowMode = 'keep-visible' | 'upper-third';

export const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), '.config', 'tuimusic');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: TuiTunesConfig = {
  volume: 80,
  translationLanguage: null,
  translationProvider: 'none',
  translationSourceLanguage: null,
  libreTranslateEndpoint: null,
  deeplApiKey: null,
  lingvaInstance: null,
  ascii: false,
  iconStyle: 'nerd-font',
  reducedMotion: false,
  spectrumEnabled: false,
  lyricFollowMode: 'keep-visible',
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
      translationProvider: readTranslationProvider(
        value.translationProvider,
        typeof value.lingvaInstance === 'string' ? value.lingvaInstance : null,
      ),
      translationSourceLanguage:
        typeof value.translationSourceLanguage === 'string' &&
        value.translationSourceLanguage.trim().length > 0
          ? value.translationSourceLanguage
          : null,
      libreTranslateEndpoint:
        typeof value.libreTranslateEndpoint === 'string' &&
        value.libreTranslateEndpoint.trim().length > 0
          ? value.libreTranslateEndpoint
          : null,
      deeplApiKey: typeof value.deeplApiKey === 'string' ? value.deeplApiKey : null,
      lingvaInstance: typeof value.lingvaInstance === 'string' ? value.lingvaInstance : null,
      ascii: typeof value.ascii === 'boolean' ? value.ascii : false,
      // Missing or invalid values (including pre-icon-style configs) fall
      // back to Nerd Font; only an explicit 'unicode' opt-in is preserved.
      iconStyle: value.iconStyle === 'unicode' ? 'unicode' : 'nerd-font',
      reducedMotion: typeof value.reducedMotion === 'boolean' ? value.reducedMotion : false,
      spectrumEnabled: typeof value.spectrumEnabled === 'boolean' ? value.spectrumEnabled : false,
      lyricFollowMode: value.lyricFollowMode === 'upper-third' ? 'upper-third' : 'keep-visible',
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Read the translation provider from persisted JSON. Lingva stays
 * configured only with a genuinely custom instance: the legacy default
 * provider value survives when a non-stock instance URL was explicitly
 * configured, while the stock public instance (compared after
 * normalization, including trailing-slash variants) resolves to 'none'
 * like every other unsupported value.
 */
function readTranslationProvider(
  raw: unknown,
  lingvaInstance: string | null,
): TranslationProviderId {
  if (raw === 'libretranslate' || raw === 'mymemory' || raw === 'deepl') return raw;
  if (raw === 'lingva' && lingvaInstance) {
    const normalized = lingvaInstance.trim().replace(/\/+$/, '');
    if (normalized.length > 0 && normalized !== 'https://lingva.ml') return 'lingva';
  }
  return 'none';
}

export function saveConfig(config: TuiTunesConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
