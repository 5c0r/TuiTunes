import { describe, expect, test } from 'bun:test';
import { COMMANDS, type CommandId, filterCommands, KEY_BINDINGS } from '../src/commands';

const VALID_CATEGORIES = ['playback', 'navigation', 'queue', 'view', 'app'] as const;

const WIRED_COMMAND_IDS: readonly CommandId[] = [
  'load-more',
  'favorite',
  'queue-add',
  'queue-remove',
  'podcast-search',
];

describe('COMMANDS', () => {
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

  test('registry entries carry their literal ids', () => {
    const ids = new Set<string>(COMMANDS.map((c) => c.id));
    for (const id of WIRED_COMMAND_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test('help bindings exist and describe navigation without command ids', () => {
    expect(KEY_BINDINGS.length).toBeGreaterThan(0);
    for (const binding of KEY_BINDINGS) {
      expect(binding.keys.length).toBeGreaterThan(0);
      expect(binding.label.length).toBeGreaterThan(0);
    }
  });
});

describe('filterCommands', () => {
  test('empty query returns all', () => {
    expect(filterCommands('')).toEqual(COMMANDS);
  });

  test('matches category', () => {
    const results = filterCommands('playback');
    const playbackCmds = COMMANDS.filter((cmd) => cmd.category === 'playback');
    // Every playback command should appear (category is in the haystack)
    for (const cmd of playbackCmds) {
      expect(results.map((r) => r.id)).toContain(cmd.id);
    }
  });

  test('single term matches name', () => {
    const results = filterCommands('mute');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((cmd) => cmd.name.toLowerCase().includes('mute'))).toBe(true);
  });

  test('single term matches description', () => {
    const results = filterCommands('distraction');
    expect(results.map((cmd) => cmd.id)).toContain('layout-focus');
  });

  test('matches category', () => {
    const results = filterCommands('playback');
    expect(results.map((cmd) => cmd.id)).toContain('mute');
    expect(results.map((cmd) => cmd.id)).toContain('queue-add');
  });

  test('multi-term AND logic', () => {
    const results = filterCommands('toggle mute');
    expect(results.map((cmd) => cmd.id)).toContain('mute');
  });

  test('case insensitive', () => {
    expect(filterCommands('MUTE')).toEqual(filterCommands('mute'));
  });

  test('no match returns empty', () => {
    expect(filterCommands('xyznonexistent')).toEqual([]);
  });

  test('partial match', () => {
    const results = filterCommands('tran');
    expect(results.map((cmd) => cmd.id)).toContain('toggle-translation');
  });

  test('multi-term narrows results', () => {
    const broad = filterCommands('layout');
    const narrow = filterCommands('layout wide');
    expect(narrow.length).toBeLessThan(broad.length);
    expect(narrow.map((cmd) => cmd.id)).toEqual(['layout-wide']);
  });
});
