/**
 * Shared PCM→band analyzer (feature 15).
 *
 * One implementation for every adapter: bounded latest-sample rings, a
 * preallocated Hann window and fft.js radix-4 real FFT, per-channel spectral
 * power averaged before banding so opposite-phase stereo does not cancel.
 * No auto/random/time-based heights — values are pure dBFS conversions of
 * measured spectra.
 */
import FFT from 'fft.js';
import {
  isValidPcmFormat,
  MAX_CHANNELS,
  SpectrumCaptureError,
  type PcmFormat,
} from './types';

/** fft.js 4.0.4 ships permissive `any` declarations; narrow them here only. */
interface RealFFT {
  realTransform(out: Float64Array, input: Float64Array): void;
}

export const DEFAULT_BAND_COUNT = 32;
export const DEFAULT_LOW_HZ = 50;
export const DEFAULT_HIGH_HZ = 10_000;
/** FFT size for a rate: ≥1024, ~12 analysis windows per second, power of two. */
export function fftSizeForSampleRate(sampleRate: number): number {
  let size = 1024;
  while (size < sampleRate / 12) size *= 2;
  return size;
}

export interface SpectrumAnalysis {
  readonly lowHz: number;
  readonly highHz: number;
  /** Normalized 0..1 band values; the array is reused between calls. */
  readonly values: Float64Array;
}

export interface SpectrumAnalyzerOptions {
  bandCount?: number;
  lowHz?: number;
  highHzCap?: number;
}

/**
 * Stateless DSP core over latest-sample rings. `analyze()` publishes only when
 * fresh PCM arrived since the previous call; all buffers are preallocated per
 * format so memory is bounded by the accepted format range.
 */
export class SpectrumAnalyzer {
  readonly bandCount: number;
  readonly lowHz: number;
  readonly highHzCap: number;

  private format: PcmFormat | null = null;
  private fft: RealFFT | null = null;
  private fftSize = 0;
  private windowSum = 0;
  private window = new Float64Array(0);
  private rings: Float32Array[] = [];
  private ringPos = 0;
  private work = new Float64Array(0);
  private spectrum = new Float64Array(0);
  private binPower = new Float64Array(0);
  private binAmplitude = new Float64Array(0);
  private bandEdges = new Float64Array(0);
  private values = new Float64Array(0);
  private carry = new Uint8Array(0);
  private carryLength = 0;
  private freshSamples = 0;
  private nonfinite = 0;

  constructor(options: SpectrumAnalyzerOptions = {}) {
    this.bandCount =
      typeof options.bandCount === 'number' && Number.isInteger(options.bandCount) && options.bandCount >= 8
        ? Math.min(options.bandCount, 128)
        : DEFAULT_BAND_COUNT;
    this.lowHz = typeof options.lowHz === 'number' && options.lowHz > 0 ? options.lowHz : DEFAULT_LOW_HZ;
    this.highHzCap =
      typeof options.highHzCap === 'number' && options.highHzCap > this.lowHz
        ? options.highHzCap
        : DEFAULT_HIGH_HZ;
    this.values = new Float64Array(this.bandCount);
    this.bandEdges = new Float64Array(this.bandCount + 1);
  }

  get pcmFormat(): PcmFormat | null {
    return this.format;
  }

  /** Number of samples replaced with zero because they were not finite. */
  get nonfiniteSamples(): number {
    return this.nonfinite;
  }

  /** Forget all PCM history (a capture reset); the negotiated format stays. */
  reset(): void {
    for (const ring of this.rings) ring.fill(0);
    this.ringPos = 0;
    this.carryLength = 0;
    this.freshSamples = 0;
    this.values.fill(0);
  }

  /**
   * Negotiate (or re-negotiate) the PCM format. Reallocates every buffer once;
   * a format change implies a reset of PCM history.
   */
  setFormat(format: PcmFormat): void {
    if (!isValidPcmFormat(format)) {
      throw new SpectrumCaptureError('format', `invalid PCM format ${JSON.stringify(format)}`);
    }
    if (
      this.format !== null &&
      this.format.sampleRate === format.sampleRate &&
      this.format.channels === format.channels
    ) {
      this.reset();
      return;
    }
    this.format = { ...format };
    this.fftSize = fftSizeForSampleRate(format.sampleRate);
    const n = this.fftSize;
    this.fft = new FFT(n) as unknown as RealFFT;
    this.window = new Float64Array(n);
    this.windowSum = 0;
    for (let i = 0; i < n; i++) {
      // Hann window: 0.5 * (1 - cos(2πi/(n-1)))
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      this.windowSum += this.window[i];
    }
    this.rings = [];
    for (let ch = 0; ch < format.channels && ch < MAX_CHANNELS; ch++) this.rings.push(new Float32Array(n));
    this.work = new Float64Array(n);
    this.spectrum = new Float64Array(2 * n);
    const half = Math.floor(n / 2);
    this.binPower = new Float64Array(half + 1);
    this.binAmplitude = new Float64Array(half + 1);
    this.carry = new Uint8Array(format.channels * 4);
    this.carryLength = 0;
    this.ringPos = 0;
    this.freshSamples = 0;
    this.nonfinite = 0;
    this.values.fill(0);
  }

  /**
   * Feed interleaved f32le PCM. Carries less than one interleaved frame across
   * chunk boundaries; rejects byte streams that cannot be split into samples.
   */
  pushPcm(bytes: Uint8Array): void {
    if (this.format === null) {
      throw new SpectrumCaptureError('format', 'PCM bytes arrived before a valid format');
    }
    const frame = this.format.channels * 4;
    const total = new Uint8Array(this.carryLength + bytes.length);
    total.set(this.carry.subarray(0, this.carryLength), 0);
    total.set(bytes, this.carryLength);
    const usable = total.length - (total.length % frame);
    const view = new DataView(total.buffer, total.byteOffset, usable);
    const n = this.rings[0].length;
    for (let offset = 0; offset + frame <= usable; offset += frame) {
      for (let ch = 0; ch < this.rings.length; ch++) {
        let sample = view.getFloat32(offset + ch * 4, true);
        if (!Number.isFinite(sample)) {
          this.nonfinite++;
          sample = 0;
        }
        this.rings[ch][this.ringPos] = sample;
      }
      this.ringPos = (this.ringPos + 1) % n;
      this.freshSamples++;
    }
    const remainder = total.length - usable;
    if (remainder > this.carry.length) {
      // Cannot happen: remainder < frame and carry has exactly one frame.
      throw new SpectrumCaptureError('format', 'PCM chunk remainder exceeds one interleaved frame');
    }
    this.carry.set(total.subarray(usable, total.length), 0);
    this.carryLength = remainder;
  }

  /**
   * Analyze the latest ring contents. Returns null when no fresh PCM arrived
   * since the previous call — stale data is never re-published.
   */
  analyze(): SpectrumAnalysis | null {
    const fft = this.fft;
    if (this.format === null || fft === null || this.freshSamples === 0) return null;
    this.freshSamples = 0;
    const n = this.fftSize;
    const half = Math.floor(n / 2);
    const { sampleRate } = this.format;
    this.binPower.fill(0);
    for (const ring of this.rings) {
      let mean = 0;
      for (let i = 0; i < n; i++) mean += ring[i];
      mean /= n;
      for (let i = 0; i < n; i++) {
        this.work[i] = (ring[(this.ringPos + i) % n] - mean) * this.window[i];
      }
      fft.realTransform(this.spectrum, this.work);
      for (let k = 0; k <= half; k++) {
        const re = this.spectrum[2 * k];
        const im = this.spectrum[2 * k + 1];
        this.binPower[k] += re * re + im * im;
      }
    }
    const channels = this.rings.length;
    for (let k = 0; k <= half; k++) {
      const averagePower = this.binPower[k] / channels;
      this.binAmplitude[k] = (2 * Math.sqrt(averagePower)) / this.windowSum;
    }
    const nyquist = sampleRate / 2;
    const highHz = Math.min(this.highHzCap, nyquist);
    for (let i = 0; i <= this.bandCount; i++) {
      this.bandEdges[i] =
        highHz > this.lowHz ? this.lowHz * (highHz / this.lowHz) ** (i / this.bandCount) : this.lowHz;
    }
    for (let band = 0; band < this.bandCount; band++) {
      const f0 = this.bandEdges[band];
      const f1 = this.bandEdges[band + 1];
      let kLow = Math.max(1, Math.ceil((f0 * n) / sampleRate));
      let kHigh = Math.min(half - 1, Math.floor((f1 * n) / sampleRate));
      if (kHigh < kLow) {
        // Narrow low band between two bin centers: use the geometric mean bin.
        kLow = Math.min(half - 1, Math.max(1, Math.round((Math.sqrt(f0 * f1) * n) / sampleRate)));
        kHigh = kLow;
      }
      let sumSquares = 0;
      let count = 0;
      for (let k = kLow; k <= kHigh; k++) {
        sumSquares += this.binAmplitude[k] * this.binAmplitude[k];
        count++;
      }
      const bandAmplitude = count > 0 ? Math.sqrt(sumSquares / count) : 0;
      const db = 20 * Math.log10(Math.max(bandAmplitude, 1e-12));
      this.values[band] = Math.max(0, Math.min(1, (db + 60) / 60));
    }
    return { lowHz: this.lowHz, highHz, values: this.values };
  }
}
