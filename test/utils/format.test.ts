import { describe, test, expect } from 'bun:test';
import { formatTime, truncateText, padRight } from '../../src/utils/format';

describe('formatTime', () => {
  test.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [90, '1:30'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3661, '1:01:01'],
  ])('formatTime(%d) → %s', (input, expected) => {
    expect(formatTime(input)).toBe(expected);
  });

  test('NaN → 0:00', () => {
    expect(formatTime(NaN)).toBe('0:00');
  });

  test('Infinity → 0:00', () => {
    expect(formatTime(Infinity)).toBe('0:00');
  });

  test('negative → 0:00', () => {
    expect(formatTime(-5)).toBe('0:00');
  });

  test('fractional seconds are floored', () => {
    expect(formatTime(1.7)).toBe('0:01');
  });
});

describe('truncateText', () => {
  test('short text unchanged', () => {
    expect(truncateText('hello', 10)).toBe('hello');
  });

  test('long text truncated with ellipsis', () => {
    expect(truncateText('hello world', 5)).toBe('hell…');
  });

  test('empty string unchanged', () => {
    expect(truncateText('', 5)).toBe('');
  });

  test('maxLen 1 returns ellipsis only', () => {
    expect(truncateText('ab', 1)).toBe('…');
  });

  test('exact length unchanged', () => {
    expect(truncateText('abc', 3)).toBe('abc');
  });
});

describe('padRight', () => {
  test('pads short text', () => {
    expect(padRight('hi', 5)).toBe('hi   ');
  });

  test('exact width unchanged', () => {
    expect(padRight('hello', 5)).toBe('hello');
  });

  test('longer text unchanged', () => {
    expect(padRight('toolong', 3)).toBe('toolong');
  });
});
