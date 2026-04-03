import { describe, test, expect } from 'bun:test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

mkdirSync(join(homedir(), '.config', 'tuimusic'), { recursive: true });

import { COMMANDS, filterCommands } from '../src/commands';
import type { Command } from '../src/commands';

const VALID_CATEGORIES = ['playback', 'navigation', 'queue', 'view', 'app'] as const;

describe('COMMANDS', () => {
  test('has expected length', () => {
    expect(COMMANDS.length).toBe(37);
  });

  test('all have required fields', () => {
    for (const cmd of COMMANDS) {
      expect(typeof cmd.id).toBe('string');
      expect(cmd.id.length).toBeGreaterThan(0);
      expect(typeof cmd.name).toBe('string');
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(typeof cmd.description).toBe('string');
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(typeof cmd.category).toBe('string');
    }
  });

  test('categories are valid', () => {
    for (const cmd of COMMANDS) {
      expect(VALID_CATEGORIES).toContain(cmd.category);
    }
  });

  test('ids are unique', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('filterCommands', () => {
  test('empty query returns all', () => {
    expect(filterCommands('')).toEqual(COMMANDS);
  });

  test('whitespace-only returns all', () => {
    expect(filterCommands('   ')).toEqual(COMMANDS);
    expect(filterCommands('\t')).toEqual(COMMANDS);
  });

  test('single term matches name', () => {
    const results = filterCommands('volume');
    const ids = results.map((c) => c.id);
    expect(ids).toContain('volume-up');
    expect(ids).toContain('volume-down');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test('single term matches description', () => {
    const results = filterCommands('mute');
    const ids = results.map((c) => c.id);
    expect(ids).toContain('mute');
  });

  test('matches category', () => {
    const results = filterCommands('playback');
    const playbackCmds = COMMANDS.filter((c) => c.category === 'playback');
    // Every playback command should appear (category is in the haystack)
    for (const cmd of playbackCmds) {
      expect(results.map((r) => r.id)).toContain(cmd.id);
    }
  });

  test('multi-term AND logic', () => {
    const results = filterCommands('play pause');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('play-pause');
  });

  test('case insensitive', () => {
    const lower = filterCommands('volume');
    const upper = filterCommands('VOLUME');
    const mixed = filterCommands('VoLuMe');
    expect(upper).toEqual(lower);
    expect(mixed).toEqual(lower);
  });

  test('no match returns empty', () => {
    expect(filterCommands('xyznonexistent')).toEqual([]);
  });

  test('partial match', () => {
    const results = filterCommands('vol');
    const ids = results.map((c) => c.id);
    expect(ids).toContain('volume-up');
    expect(ids).toContain('volume-down');
  });

  test('multi-term narrows results', () => {
    const broad = filterCommands('speed');
    const narrow = filterCommands('speed normal');
    expect(broad.length).toBeGreaterThan(narrow.length);
    expect(narrow.length).toBe(1);
    expect(narrow[0].id).toBe('speed-reset');
  });
});
