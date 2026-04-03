import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  CONFIG_DIR,
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  type TuiTunesConfig,
} from '../../src/utils/config';

// Ensure logger dir exists (other modules imported transitively may need it)
mkdirSync(join(homedir(), '.config', 'tuimusic'), { recursive: true });

describe('config', () => {
  // Back up any existing config so tests don't destroy user state.
  let backup: string | null = null;

  beforeEach(() => {
    try {
      backup = readFileSync(CONFIG_PATH, 'utf-8');
    } catch {
      backup = null;
    }
  });

  afterEach(() => {
    try {
      if (backup !== null) {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, backup, 'utf-8');
      } else {
        // Remove config file tests may have created
        if (existsSync(CONFIG_PATH)) {
          unlinkSync(CONFIG_PATH);
        }
      }
    } catch {
      // best-effort restore
    }
  });

  // ── Shape / constant tests ──────────────────────────────────────

  test('DEFAULT_CONFIG has correct shape and values', () => {
    expect(DEFAULT_CONFIG.defaultProvider).toBe('youtube');
    expect(DEFAULT_CONFIG.volume).toBe(80);
    expect(Array.isArray(DEFAULT_CONFIG.localMusicDirs)).toBe(true);
    expect(DEFAULT_CONFIG.localMusicDirs.length).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.theme).toBe('dark');
    expect(DEFAULT_CONFIG.poToken).toBeNull();
    expect(DEFAULT_CONFIG.visitorData).toBeNull();
  });

  test('CONFIG_DIR contains tuimusic', () => {
    expect(typeof CONFIG_DIR).toBe('string');
    expect(CONFIG_DIR).toContain('tuimusic');
    expect(CONFIG_DIR).toContain('.config');
  });

  test('CONFIG_PATH ends with config.json', () => {
    expect(typeof CONFIG_PATH).toBe('string');
    expect(CONFIG_PATH.endsWith('config.json')).toBe(true);
    expect(CONFIG_PATH).toContain('tuimusic');
  });

  // ── loadConfig ──────────────────────────────────────────────────

  test('loadConfig returns object with all default keys', () => {
    const config = loadConfig();
    const defaultKeys = Object.keys(DEFAULT_CONFIG);
    for (const key of defaultKeys) {
      expect(config).toHaveProperty(key);
    }
  });

  test('loadConfig returns defaults when config file is missing', () => {
    // Remove existing config so the catch branch fires
    try { unlinkSync(CONFIG_PATH); } catch { /* may not exist */ }

    const config = loadConfig();
    expect(config.defaultProvider).toBe(DEFAULT_CONFIG.defaultProvider);
    expect(config.volume).toBe(DEFAULT_CONFIG.volume);
    expect(config.theme).toBe(DEFAULT_CONFIG.theme);
    expect(config.poToken).toBe(DEFAULT_CONFIG.poToken);
    expect(config.visitorData).toBe(DEFAULT_CONFIG.visitorData);
    expect(config.localMusicDirs).toEqual(DEFAULT_CONFIG.localMusicDirs);
  });

  test('loadConfig returns defaults when config file is invalid JSON', () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, '%%%not json%%%', 'utf-8');

    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  // ── saveConfig ──────────────────────────────────────────────────

  test('saveConfig writes config file that is valid JSON', () => {
    saveConfig(DEFAULT_CONFIG);
    expect(existsSync(CONFIG_PATH)).toBe(true);

    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.defaultProvider).toBe('youtube');
  });

  // ── Round-trip ──────────────────────────────────────────────────

  test('saveConfig + loadConfig round-trip preserves custom values', () => {
    const custom: TuiTunesConfig = {
      defaultProvider: 'spotify',
      volume: 42,
      localMusicDirs: ['/tmp/music', '/opt/tunes'],
      theme: 'dark',
      poToken: 'tok_abc',
      visitorData: 'vis_xyz',
    };

    saveConfig(custom);
    const loaded = loadConfig();

    expect(loaded.defaultProvider).toBe('spotify');
    expect(loaded.volume).toBe(42);
    expect(loaded.localMusicDirs).toEqual(['/tmp/music', '/opt/tunes']);
    expect(loaded.theme).toBe('dark');
    expect(loaded.poToken).toBe('tok_abc');
    expect(loaded.visitorData).toBe('vis_xyz');
  });

  test('loadConfig merges partial config with defaults', () => {
    // Write a partial config — only volume overridden
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ volume: 33 }), 'utf-8');

    const config = loadConfig();
    // Overridden field
    expect(config.volume).toBe(33);
    // Defaults filled in
    expect(config.defaultProvider).toBe('youtube');
    expect(config.theme).toBe('dark');
    expect(config.poToken).toBeNull();
    expect(config.visitorData).toBeNull();
    expect(config.localMusicDirs).toEqual(DEFAULT_CONFIG.localMusicDirs);
  });
});
