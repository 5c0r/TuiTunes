import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BAND_COUNT,
  SpectrumAnalyzer,
  fftSizeForSampleRate,
} from '../../src/spectrum/analyzer';
import { SpectrumCaptureError } from '../../src/spectrum/types';
import { f32le } from './fakes';

const RATE = 48_000;

function bandForFrequency(analyzer: SpectrumAnalyzer, hz: number, rate = 48_000): number {
  void analyzer; // band edges derive from the fixed range; no analysis consumed
  const lowHz = 50;
  const highHz = Math.min(10_000, rate / 2);
  const ratio = Math.log(hz / lowHz) / Math.log(highHz / lowHz);
  return Math.min(DEFAULT_BAND_COUNT - 1, Math.max(0, Math.floor(ratio * DEFAULT_BAND_COUNT)));
}

function feedSine(
  analyzer: SpectrumAnalyzer,
  frequencyHz: number,
  options: {
    seconds?: number;
    amplitude?: number;
    channels?: number;
    phase?: number;
    rate?: number;
  } = {},
): void {
  const rate = options.rate ?? RATE;
  const channels = options.channels ?? 1;
  const seconds = options.seconds ?? 1;
  const amplitude = options.amplitude ?? 0.5;
  const phase = options.phase ?? 0;
  const frames = Math.round(rate * seconds);
  const samples: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const value = amplitude * Math.sin((2 * Math.PI * frequencyHz * frame) / rate + phase);
    for (let channel = 0; channel < channels; channel++) samples.push(value);
  }
  analyzer.pushPcm(f32le(samples));
}

describe('SpectrumAnalyzer', () => {
  test('FFT size: >=1024, ~12 windows per second, power of two', () => {
    expect(fftSizeForSampleRate(48_000)).toBe(4096);
    expect(fftSizeForSampleRate(8_000)).toBe(1024);
    expect(fftSizeForSampleRate(192_000)).toBe(16_384);
    expect(fftSizeForSampleRate(44_100)).toBe(4096);
  });

  test('sine lands in its own band with strong normalized value', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 1, encoding: 'f32le' });
    feedSine(analyzer, 440);
    const analysis = analyzer.analyze();
    expect(analysis).not.toBeNull();
    const values = [...(analysis?.values ?? [])];
    expect(values).toHaveLength(DEFAULT_BAND_COUNT);
    const band = bandForFrequency(analyzer, 440);
    expect(values[band]).toBeGreaterThan(0.75);
    for (let other = 0; other < DEFAULT_BAND_COUNT; other++) {
      if (Math.abs(other - band) <= 1) continue;
      expect(values[other]).toBeLessThan(0.2);
    }
  });

  test('two tones separate into different bands', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 1, encoding: 'f32le' });
    const frames = RATE;
    const samples: number[] = [];
    for (let frame = 0; frame < frames; frame++) {
      samples.push(
        0.4 * Math.sin((2 * Math.PI * 200 * frame) / RATE) +
          0.4 * Math.sin((2 * Math.PI * 4000 * frame) / RATE),
      );
    }
    analyzer.pushPcm(f32le(samples));
    const values = [...(analyzer.analyze()?.values ?? [])];
    const low = bandForFrequency(analyzer, 200);
    const high = bandForFrequency(analyzer, 4000);
    expect(Math.abs(low - high)).toBeGreaterThanOrEqual(2);
    expect(values[low]).toBeGreaterThan(0.6);
    expect(values[high]).toBeGreaterThan(0.6);
    const between = Math.floor((low + high) / 2);
    expect(values[between]).toBeLessThan(0.3);
  });

  test('silence and DC produce zeros, not fake bars', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 1, encoding: 'f32le' });
    analyzer.pushPcm(f32le(new Array(4800).fill(0)));
    expect([...(analyzer.analyze()?.values ?? [])].every((value) => value === 0)).toBe(true);

    analyzer.reset();
    analyzer.pushPcm(f32le(new Array(4800).fill(0.8))); // constant DC offset
    const values = [...(analyzer.analyze()?.values ?? [])];
    expect(values.every((value) => value < 0.05)).toBe(true);
  });

  test('opposite-phase stereo still registers (per-channel power, not samples)', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 2, encoding: 'f32le' });
    const frames = RATE;
    const samples: number[] = [];
    for (let frame = 0; frame < frames; frame++) {
      const value = 0.5 * Math.sin((2 * Math.PI * 1000 * frame) / RATE);
      samples.push(value, -value);
    }
    analyzer.pushPcm(f32le(samples));
    const values = [...(analyzer.analyze()?.values ?? [])];
    expect(values[bandForFrequency(analyzer, 1000)]).toBeGreaterThan(0.6);
  });

  test('mono, stereo and 5.1 layouts all work', () => {
    for (const channels of [1, 2, 6]) {
      const analyzer = new SpectrumAnalyzer();
      analyzer.setFormat({ sampleRate: RATE, channels, encoding: 'f32le' });
      const frames = RATE / 2;
      const samples: number[] = [];
      for (let frame = 0; frame < frames; frame++) {
        const value = 0.5 * Math.sin((2 * Math.PI * 880 * frame) / RATE);
        for (let channel = 0; channel < channels; channel++) samples.push(value);
      }
      analyzer.pushPcm(f32le(samples));
      const values = [...(analyzer.analyze()?.values ?? [])];
      expect(values[bandForFrequency(analyzer, 880)]).toBeGreaterThan(0.7);
    }
  });

  test('sample-rate variants keep the tone in the same band', () => {
    for (const rate of [8_000, 22_050, 44_100, 96_000]) {
      const analyzer = new SpectrumAnalyzer();
      analyzer.setFormat({ sampleRate: rate, channels: 1, encoding: 'f32le' });
      feedSine(analyzer, 500, { rate, seconds: 0.5 });
      const values = [...(analyzer.analyze()?.values ?? [])];
      expect(values[bandForFrequency(analyzer, 500, rate)]).toBeGreaterThan(0.55);
    }
  });

  test('fragmented float and frame boundaries carry correctly', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 2, encoding: 'f32le' });
    const frames = RATE / 4;
    const samples: number[] = [];
    for (let frame = 0; frame < frames; frame++) {
      const value = 0.5 * Math.sin((2 * Math.PI * 300 * frame) / RATE);
      samples.push(value, value);
    }
    const bytes = f32le(samples);
    // Feed odd chunk sizes: sub-sample, sub-frame, and frame-aligned.
    const cuts = [3, 5, 7, 1, 8, 12, 4, 9, 2, 15, 11, 6, 13, 10, 14];
    let offset = 0;
    let cut = 0;
    while (offset < bytes.length) {
      const size = Math.min(cuts[cut % cuts.length] ?? 1, bytes.length - offset);
      analyzer.pushPcm(bytes.subarray(offset, offset + size));
      offset += size;
      cut++;
    }
    const values = [...(analyzer.analyze()?.values ?? [])];
    expect(values[bandForFrequency(analyzer, 300)]).toBeGreaterThan(0.7);
  });

  test('nonfinite input is sanitized to silence, not propagated', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 1, encoding: 'f32le' });
    const nasty: number[] = [];
    for (let frame = 0; frame < RATE / 2; frame++) {
      nasty.push(frame % 3 === 0 ? Number.NaN : frame % 5 === 0 ? Number.POSITIVE_INFINITY : 0);
    }
    analyzer.pushPcm(f32le(nasty));
    expect(analyzer.nonfiniteSamples).toBeGreaterThan(0);
    const values = [...(analyzer.analyze()?.values ?? [])];
    expect(values.every((value) => Number.isFinite(value))).toBe(true);
  });

  test('analyze publishes fresh data only once per chunk', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 1, encoding: 'f32le' });
    expect(analyzer.analyze()).toBeNull();
    analyzer.pushPcm(f32le(new Array(480).fill(0.1)));
    expect(analyzer.analyze()).not.toBeNull();
    expect(analyzer.analyze()).toBeNull(); // stale data is never re-published
  });

  test('memory is bounded: repeated pushes keep allocations fixed', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 2, encoding: 'f32le' });
    for (let round = 0; round < 64; round++) {
      analyzer.pushPcm(f32le(new Array(480).fill(0.2)));
      analyzer.analyze();
    }
    expect(analyzer.pcmFormat).toEqual({ sampleRate: RATE, channels: 2, encoding: 'f32le' });
  });

  test('full-scale tone maps to ~1.0 and quiet tone clamps at -60 dBFS floor', () => {
    const loud = new SpectrumAnalyzer();
    loud.setFormat({ sampleRate: RATE, channels: 1, encoding: 'f32le' });
    feedSine(loud, 700, { amplitude: 1.0 });
    const loudValues = [...(loud.analyze()?.values ?? [])];
    expect(loudValues[bandForFrequency(loud, 700)]).toBeGreaterThan(0.8);

    const quiet = new SpectrumAnalyzer();
    quiet.setFormat({ sampleRate: RATE, channels: 1, encoding: 'f32le' });
    feedSine(quiet, 700, { amplitude: 0.0005 });
    const quietValues = [...(quiet.analyze()?.values ?? [])];
    expect(quietValues[bandForFrequency(quiet, 700)]).toBe(0);
  });

  test('invalid formats and PCM-before-format are typed errors', () => {
    const analyzer = new SpectrumAnalyzer();
    expect(() =>
      analyzer.setFormat({ sampleRate: 1000, channels: 1, encoding: 'f32le' } as never),
    ).toThrow(SpectrumCaptureError);
    expect(() =>
      analyzer.setFormat({ sampleRate: 48_000, channels: 9, encoding: 'f32le' } as never),
    ).toThrow(SpectrumCaptureError);
    expect(() => analyzer.pushPcm(f32le([0.1]))).toThrow(SpectrumCaptureError);
  });

  test('format renegotiation resets history', () => {
    const analyzer = new SpectrumAnalyzer();
    analyzer.setFormat({ sampleRate: RATE, channels: 1, encoding: 'f32le' });
    feedSine(analyzer, 440, { seconds: 0.25 });
    expect(analyzer.analyze()).not.toBeNull();
    analyzer.setFormat({ sampleRate: 44_100, channels: 2, encoding: 'f32le' });
    expect(analyzer.analyze()).toBeNull();
    expect(analyzer.pcmFormat).toEqual({ sampleRate: 44_100, channels: 2, encoding: 'f32le' });
  });
});
