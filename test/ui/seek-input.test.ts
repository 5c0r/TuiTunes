import { describe, test, expect } from 'bun:test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

mkdirSync(join(homedir(), '.config', 'tuimusic'), { recursive: true });

import { parseTimeInput } from '../../src/ui/SeekInput';

describe('parseTimeInput', () => {
  test('returns null for empty string', () => {
    expect(parseTimeInput('')).toBeNull();
  });

  test('returns null for whitespace', () => {
    expect(parseTimeInput('   ')).toBeNull();
  });

  test('parses integer seconds', () => {
    expect(parseTimeInput('90')).toBe(90);
  });

  test('parses float seconds', () => {
    expect(parseTimeInput('150.5')).toBe(150.5);
  });

  test('parses m:ss', () => {
    expect(parseTimeInput('1:30')).toBe(90);
  });

  test('parses h:mm:ss', () => {
    expect(parseTimeInput('1:05:30')).toBe(3930);
  });

  test('returns null for invalid format', () => {
    expect(parseTimeInput('abc')).toBeNull();
  });

  test('returns null for too many colons', () => {
    expect(parseTimeInput('1:2:3:4')).toBeNull();
  });

  test('returns null for letters in colon format', () => {
    expect(parseTimeInput('a:b')).toBeNull();
  });

  test('handles leading/trailing whitespace', () => {
    expect(parseTimeInput('  90  ')).toBe(90);
  });

  test('parses zero', () => {
    expect(parseTimeInput('0')).toBe(0);
  });

  test('parses 0:00', () => {
    expect(parseTimeInput('0:00')).toBe(0);
  });
});
