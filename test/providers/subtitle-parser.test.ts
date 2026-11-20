import { describe, expect, test } from 'bun:test';
import { parseSrt, parseVtt } from '../../src/providers/subtitle-parser';

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
  test('parses cues separated by CRLF', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\n\r\n2\r\n00:00:05,000 --> 00:00:08,000\r\nWorld';
    const result = parseSrt(srt);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ time: 5, text: 'World' });
  });

  test('parses cues separated by bare CR', () => {
    const srt = '1\r00:00:01,000 --> 00:00:04,000\rHello\r\r2\r00:00:05,000 --> 00:00:08,000\rWorld';
    const result = parseSrt(srt);
    expect(result).toHaveLength(2);
    expect(result.map((line) => line.text)).toEqual(['Hello', 'World']);
  });

  test('accepts whitespace-only separator lines', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nHello\n \t\n2\n00:00:05,000 --> 00:00:08,000\nWorld';
    const result = parseSrt(srt);
    expect(result).toHaveLength(2);
    expect(result.map((line) => line.text)).toEqual(['Hello', 'World']);
  });

  test('parses a cue without a sequence identifier', () => {
    const srt = '00:00:01,000 --> 00:00:04,000\nNo identifier';
    const result = parseSrt(srt);
    expect(result).toEqual([{ time: 1, text: 'No identifier' }]);
  });

  test('skips invalid minute/second fields without absorbing later cues', () => {
    const srt = [
      '1',
      '00:75:00,000 --> 00:75:10,000',
      'Invalid minutes',
      '',
      '2',
      '00:00:99,000 --> 00:00:99,500',
      'Invalid seconds',
      '',
      '3',
      '00:00:05,000 --> 00:00:08,000',
      'Valid',
    ].join('\n');
    const result = parseSrt(srt);
    expect(result).toEqual([{ time: 5, text: 'Valid' }]);
  });

  test('keeps a cue starting at zero', () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nStart\n\n2\n00:00:05,000 --> 00:00:08,000\nLater';
    const result = parseSrt(srt);
    expect(result[0]).toEqual({ time: 0, text: 'Start' });
    expect(result).toHaveLength(2);
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
  test('parses minute-only timestamps', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:04.000\nMinute only';
    const result = parseVtt(vtt);
    expect(result).toEqual([{ time: 1, text: 'Minute only' }]);
  });

  test('strips a leading BOM before parsing', () => {
    const vtt = String.fromCharCode(0xfeff) + 'WEBVTT\n\n00:01.000 --> 00:04.000\nBOM cue';
    const result = parseVtt(vtt);
    expect(result).toEqual([{ time: 1, text: 'BOM cue' }]);
  });

  test('ignores cue settings after the end timestamp', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000 align:start position:0%\nSettings cue';
    const result = parseVtt(vtt);
    expect(result).toEqual([{ time: 1, text: 'Settings cue' }]);
  });

  test('skips NOTE, STYLE, and REGION metadata blocks', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE this is a comment',
      '',
      'STYLE',
      'cue { color: red }',
      '',
      'REGION',
      'id=fred width=40%',
      '',
      '00:00:01.000 --> 00:00:04.000',
      'Real cue',
    ].join('\n');
    const result = parseVtt(vtt);
    expect(result).toEqual([{ time: 1, text: 'Real cue' }]);
  });

  test('skips invalid minute/second fields without absorbing later cues', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:99:00.000 --> 00:99:05.000',
      'Invalid minutes',
      '',
      '00:00:60.000 --> 00:00:65.000',
      'Invalid seconds',
      '',
      '00:00:05.000 --> 00:00:08.000',
      'Valid cue',
    ].join('\n');
    const result = parseVtt(vtt);
    expect(result).toEqual([{ time: 5, text: 'Valid cue' }]);
  });

  test('keeps a cue starting at zero', () => {
    const vtt = 'WEBVTT\n\n00:00.000 --> 00:00:02.000\nStart\n\n00:00:05.000 --> 00:00:08.000\nLater';
    const result = parseVtt(vtt);
    expect(result[0]).toEqual({ time: 0, text: 'Start' });
    expect(result).toHaveLength(2);
  });
});
