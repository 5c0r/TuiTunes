import { describe, expect, test } from 'bun:test';
import { searchTranscript } from '../../src/utils/transcript-search';
import type { LyricLine } from '../../src/providers/lyrics';

const SAMPLE_LINES: LyricLine[] = [
  { time: 0, text: 'Welcome to our podcast about machine learning.' },
  { time: 5.2, text: 'Today we will discuss neural networks.' },
  { time: 12.8, text: 'Machine learning has grown rapidly in recent years.' },
  { time: 20.1, text: 'Deep learning is a subset of machine learning.' },
  { time: 30.5, text: 'Let us start with the basics of programming.' },
  { time: 45.0, text: '' },
  { time: 50.3, text: 'Python is a popular language for ML tasks.' },
];

describe('searchTranscript', () => {
  test('finds matching lines (case insensitive)', () => {
    const matches = searchTranscript(SAMPLE_LINES, 'machine learning');
    expect(matches).toHaveLength(3);
    expect(matches[0].idx).toBe(0);
    expect(matches[0].time).toBe(0);
    expect(matches[1].idx).toBe(2);
    expect(matches[1].time).toBe(12.8);
    expect(matches[2].idx).toBe(3);
    expect(matches[2].time).toBe(20.1);
  });

  test('case insensitive matching', () => {
    const matches = searchTranscript(SAMPLE_LINES, 'NEURAL');
    expect(matches).toHaveLength(1);
    expect(matches[0].idx).toBe(1);
    expect(matches[0].text).toBe('Today we will discuss neural networks.');
  });

  test('partial word matching', () => {
    const matches = searchTranscript(SAMPLE_LINES, 'learn');
    expect(matches).toHaveLength(3); // machine learning x3
    expect(matches.map((m) => m.idx)).toEqual([0, 2, 3]);
  });

  test('returns empty array for empty query', () => {
    expect(searchTranscript(SAMPLE_LINES, '')).toEqual([]);
    expect(searchTranscript(SAMPLE_LINES, '   ')).toEqual([]);
  });

  test('returns empty array for no matches', () => {
    const matches = searchTranscript(SAMPLE_LINES, 'quantum computing');
    expect(matches).toEqual([]);
  });

  test('returns empty array for empty lines', () => {
    expect(searchTranscript([], 'test')).toEqual([]);
  });

  test('preserves original line index', () => {
    const matches = searchTranscript(SAMPLE_LINES, 'Python');
    expect(matches).toHaveLength(1);
    expect(matches[0].idx).toBe(6);
    expect(matches[0].time).toBe(50.3);
  });

  test('skips empty text lines', () => {
    const matches = searchTranscript(SAMPLE_LINES, '');
    expect(matches).toEqual([]);
  });

  test('matches preserve time for seeking', () => {
    const matches = searchTranscript(SAMPLE_LINES, 'basics');
    expect(matches).toHaveLength(1);
    expect(matches[0].time).toBe(30.5);
    expect(matches[0].text).toContain('basics');
  });

  test('single character query works', () => {
    // Should match lines containing 'a'
    const matches = searchTranscript(SAMPLE_LINES, 'a');
    expect(matches.length).toBeGreaterThan(0);
  });
});
