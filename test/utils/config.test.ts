import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type TuiTunesConfig,
} from '../../src/utils/config';

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

  test('the translation provider defaults to none and legacy Lingva survives only with a custom instance', () => {
    expect(DEFAULT_CONFIG.translationProvider).toBe('none');

    // The legacy default value without a custom instance resolves to none.
    for (const instance of [undefined, null, '', 'https://lingva.ml', 'https://lingva.ml/']) {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          translationProvider: 'lingva',
          ...(instance === undefined ? {} : { lingvaInstance: instance }),
        }),
      );
      expect(loadConfig().translationProvider).toBe('none');
    }

    // A genuinely custom instance keeps the legacy provider selection.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        translationProvider: 'lingva',
        lingvaInstance: 'https://lingva.example.com/',
      }),
    );
    const kept = loadConfig();
    expect(kept.translationProvider).toBe('lingva');
    expect(kept.lingvaInstance).toBe('https://lingva.example.com/');

    // Other stored provider values pass through; unsupported values fall back.
    writeFileSync(CONFIG_PATH, JSON.stringify({ translationProvider: 'libretranslate' }));
    expect(loadConfig().translationProvider).toBe('libretranslate');
    writeFileSync(CONFIG_PATH, JSON.stringify({ translationProvider: 'unknown' }));
    expect(loadConfig().translationProvider).toBe('none');
  });

  test('translation source language and LibreTranslate endpoint persist as optional strings', () => {
  const config: TuiTunesConfig = {
      ...DEFAULT_CONFIG,
      translationProvider: 'libretranslate',
      translationSourceLanguage: 'ja',
      libreTranslateEndpoint: 'http://127.0.0.1:15097',
    };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);

    // Missing, empty, or whitespace values read back as null (unset).
    for (const raw of [undefined, '', '   ']) {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify(
          raw === undefined ? {} : { translationSourceLanguage: raw, libreTranslateEndpoint: raw },
        ),
      );
      const loaded = loadConfig();
      expect(loaded.translationSourceLanguage).toBeNull();
      expect(loaded.libreTranslateEndpoint).toBeNull();
    }
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

  test('icon style persists with Nerd Font default and Unicode opt-in', () => {
    expect(DEFAULT_CONFIG.iconStyle).toBe('nerd-font');

    saveConfig({ ...DEFAULT_CONFIG, iconStyle: 'nerd-font' });
    expect(loadConfig().iconStyle).toBe('nerd-font');
    saveConfig({ ...DEFAULT_CONFIG, iconStyle: 'unicode' });
    expect(loadConfig().iconStyle).toBe('unicode');

    // Missing (legacy), invalid, or non-string values fall back to Nerd Font.
    writeFileSync(CONFIG_PATH, JSON.stringify({ volume: 20 }));
    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG, volume: 20 });
    writeFileSync(CONFIG_PATH, JSON.stringify({ iconStyle: 'emoji' }));
    expect(loadConfig().iconStyle).toBe('nerd-font');
    writeFileSync(CONFIG_PATH, JSON.stringify({ iconStyle: 3 }));
    expect(loadConfig().iconStyle).toBe('nerd-font');

    // A saved style survives alongside ASCII mode; ASCII only suppresses it.
    saveConfig({ ...DEFAULT_CONFIG, ascii: true, iconStyle: 'unicode' });
    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG, ascii: true, iconStyle: 'unicode' });
  });
});
