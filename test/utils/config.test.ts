import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/utils/config';

afterEach(() => rmSync(CONFIG_PATH, { force: true }));

describe('config persistence', () => {
  test('missing and invalid JSON use defaults', () => {
    rmSync(CONFIG_PATH, { force: true });
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    writeFileSync(CONFIG_PATH, '%invalid%');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  test('saving completes before an immediate reload', () => {
    const config = {
      ...DEFAULT_CONFIG,
      volume: 42,
      translationLanguage: 'de',
      deeplApiKey: 'secret',
    };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))).toEqual(config);
  });

  test('legacy and unknown fields are discarded without losing supported settings', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        defaultProvider: 'local',
        localMusicDirs: ['/music'],
        theme: 'dark',
        poToken: 'old',
        visitorData: 'old',
        unknown: true,
        volume: 33,
        translationLanguage: 'fr',
        translationProvider: 'deepl',
      }),
    );
    const config = loadConfig();
    expect(config).toEqual({
      ...DEFAULT_CONFIG,
      volume: 33,
      translationLanguage: 'fr',
      translationProvider: 'deepl',
    });
    saveConfig(config);
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))).toEqual(config);
  });

  test('invalid fields fall back and finite volume is clamped', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ volume: 999, translationProvider: 'unknown', translationLanguage: 5 }),
    );
    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG, volume: 150 });
    writeFileSync(CONFIG_PATH, '{"volume":1e999}');
    expect(loadConfig().volume).toBe(80);
    writeFileSync(CONFIG_PATH, '{"volume":-10}');
    expect(loadConfig().volume).toBe(0);
  });

  test('presentation booleans persist independently and reject truthy non-booleans', () => {
    const config = { ...DEFAULT_CONFIG, ascii: true, reducedMotion: true, spectrumEnabled: true };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ascii: 'true', reducedMotion: 1, spectrumEnabled: {} }),
    );
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    writeFileSync(CONFIG_PATH, JSON.stringify({ ascii: true, spectrumEnabled: false }));
    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG, ascii: true });
  });
});
