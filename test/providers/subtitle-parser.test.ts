import { describe, test, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseSrt, parseVtt } from '../../src/providers/subtitle-parser';

mkdirSync(join(homedir(), '.config', 'tuimusic'), { recursive: true });

describe('parseSrt', () => {
  test('parses basic SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,000
Second line`;
    const result = parseSrt(srt);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ time: 1, text: 'Hello world' });
    expect(result[1]).toEqual({ time: 5, text: 'Second line' });
  });

  test('strips HTML tags', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
<b>bold</b> and <i>italic</i>`;
    const result = parseSrt(srt);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('bold and italic');
  });

  test('joins multi-line text', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
First part
Second part`;
    const result = parseSrt(srt);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('First part Second part');
  });

  test('skips blocks with fewer than 3 lines', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000

2
00:00:05,000 --> 00:00:08,000
Valid line`;
    const result = parseSrt(srt);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Valid line');
  });

  test('returns empty for empty input', () => {
    expect(parseSrt('')).toEqual([]);
  });

  test('handles comma and dot in timestamp', () => {
    const srtComma = `1
00:00:02,500 --> 00:00:04,000
Comma`;
    const srtDot = `1
00:00:02.500 --> 00:00:04.000
Dot`;
    const resultComma = parseSrt(srtComma);
    const resultDot = parseSrt(srtDot);
    expect(resultComma).toHaveLength(1);
    expect(resultDot).toHaveLength(1);
    expect(resultComma[0].time).toBe(2.5);
    expect(resultDot[0].time).toBe(2.5);
  });

  test('calculates time correctly', () => {
    const srt = `1
01:02:03,456 --> 01:05:00,000
Timed text`;
    const result = parseSrt(srt);
    expect(result).toHaveLength(1);
    expect(result[0].time).toBe(3723.456);
  });
});

describe('parseVtt', () => {
  test('parses basic VTT', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
Second cue`;
    const result = parseVtt(vtt);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ time: 1, text: 'Hello world' });
    expect(result[1]).toEqual({ time: 5, text: 'Second cue' });
  });

  test('skips WEBVTT header', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Only cue`;
    const result = parseVtt(vtt);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Only cue');
  });

  test('skips Kind: and Language: blocks', () => {
    const vtt = `WEBVTT

Kind: captions

Language: en

00:00:01.000 --> 00:00:04.000
Actual content`;
    const result = parseVtt(vtt);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Actual content');
  });

  test('strips HTML tags', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<c>styled</c> and <v Speaker>voiced</v>`;
    const result = parseVtt(vtt);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('styled and voiced');
  });

  test('handles cues with index lines', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
First cue

2
00:00:05.000 --> 00:00:08.000
Second cue`;
    const result = parseVtt(vtt);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ time: 1, text: 'First cue' });
    expect(result[1]).toEqual({ time: 5, text: 'Second cue' });
  });

  test('returns empty for empty input', () => {
    expect(parseVtt('')).toEqual([]);
  });

  test('calculates time correctly', () => {
    const vtt = `WEBVTT

00:01:30.500 --> 00:02:00.000
Timed text`;
    const result = parseVtt(vtt);
    expect(result).toHaveLength(1);
    expect(result[0].time).toBe(90.5);
  });
});
