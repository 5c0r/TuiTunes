import { describe, test, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

mkdirSync(join(homedir(), '.config', 'tuimusic'), { recursive: true });

import {
  LAYOUT_ORDER,
  nextLayout,
  LAYOUT_LABELS,
  LAYOUT_DESCRIPTIONS,
  type LayoutPreset,
} from '../../src/ui/layouts';

import {
  THEME_ORDER,
  THEMES,
  nextTheme,
  getTheme,
  type ThemeName,
  type Theme,
} from '../../src/ui/themes';

describe('layouts', () => {
  test('LAYOUT_ORDER has 6 entries', () => {
    expect(LAYOUT_ORDER).toHaveLength(6);
  });

  test('LAYOUT_ORDER starts with default', () => {
    expect(LAYOUT_ORDER[0]).toBe('default');
  });

  test('nextLayout cycles through all layouts', () => {
    let current: LayoutPreset = 'default';
    for (let i = 0; i < 6; i++) {
      current = nextLayout(current);
    }
    expect(current).toBe('default');
  });

  test('nextLayout wraps from focus to default', () => {
    expect(nextLayout('focus')).toBe('default');
  });

  test('LAYOUT_LABELS has entry for every layout', () => {
    for (const layout of LAYOUT_ORDER) {
      expect(LAYOUT_LABELS[layout]).toBeDefined();
      expect(typeof LAYOUT_LABELS[layout]).toBe('string');
    }
  });

  test('LAYOUT_DESCRIPTIONS has entry for every layout', () => {
    for (const layout of LAYOUT_ORDER) {
      expect(LAYOUT_DESCRIPTIONS[layout]).toBeDefined();
      expect(typeof LAYOUT_DESCRIPTIONS[layout]).toBe('string');
    }
  });
});

describe('themes', () => {
  test('THEME_ORDER has 8 entries', () => {
    expect(THEME_ORDER).toHaveLength(8);
  });

  test('THEMES has entry for every theme in THEME_ORDER', () => {
    for (const name of THEME_ORDER) {
      expect(THEMES[name]).toBeDefined();
    }
  });

  test('every theme has all required properties', () => {
    const requiredKeys: (keyof Theme)[] = [
      'name', 'accent', 'bg', 'fg', 'dim', 'green', 'red', 'yellow',
      'selection', 'border', 'borderActive', 'playing', 'playingFg',
    ];
    for (const themeName of THEME_ORDER) {
      const theme = THEMES[themeName];
      for (const key of requiredKeys) {
        expect(theme[key]).toBeDefined();
      }
    }
  });

  test('nextTheme cycles through all themes', () => {
    let current: ThemeName = 'tokyo-night';
    for (let i = 0; i < 8; i++) {
      current = nextTheme(current);
    }
    expect(current).toBe('tokyo-night');
  });

  test('nextTheme wraps from kanagawa to tokyo-night', () => {
    expect(nextTheme('kanagawa')).toBe('tokyo-night');
  });

  test('getTheme returns correct theme', () => {
    expect(getTheme('dracula').name).toBe('Dracula');
  });

  test('getTheme returns same object as THEMES', () => {
    expect(getTheme('nord')).toBe(THEMES.nord);
  });

  test('all theme colors are hex strings', () => {
    const colorKeys: (keyof Theme)[] = [
      'accent', 'bg', 'fg', 'dim', 'green', 'red', 'yellow',
      'selection', 'border', 'borderActive', 'playing', 'playingFg',
    ];
    const hexPattern = /^#[0-9a-f]{6}$/i;
    for (const themeName of THEME_ORDER) {
      const theme = THEMES[themeName];
      for (const key of colorKeys) {
        expect(theme[key]).toMatch(hexPattern);
      }
    }
  });
});
