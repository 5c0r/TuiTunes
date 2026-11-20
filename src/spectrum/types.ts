/**
 * Shared PCM capture contracts for the audio-reactive spectrum.
 *
 * A small fixed set of concrete adapters (pipewire, pulse, coreaudio) — not a
 * dynamically discovered provider framework. Adapters receive a validated
 * {@link CaptureTarget} (request identity, player process identity, audio
 * backend) and emit ordered {@link CaptureEvent}s for exactly one capture run.
 */

/** Typed, bounded failure reasons every capture adapter shares. */
export type SpectrumCaptureErrorCode =
  | 'tool-missing'
  | 'unsupported'
  | 'target-not-found'
  | 'target-ambiguous'
  | 'protocol'
  | 'process'
  | 'format'
  | 'attestation';

const MAX_DIAGNOSTIC_LENGTH = 240;

/** Collapse a raw diagnostic into a bounded, control-free one-line string. */
function stripControls(text: string): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const printable = code >= 0x20 && code !== 0x7f;
    if (printable) {
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      out += ch;
    } else {
      pendingSpace = true;
    }
  }
  return out;
}

export function sanitizeDiagnostic(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  const flat = stripControls(text).trim();
  const bounded = flat.length > MAX_DIAGNOSTIC_LENGTH ? `${flat.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : flat;
  return bounded.length > 0 ? bounded : 'unknown error';
}
/**
 * Typed capture failure with a sanitized, bounded message. An intentional
 * abort is never represented by this class.
 */
export class SpectrumCaptureError extends Error {
  readonly code: SpectrumCaptureErrorCode;

  constructor(code: SpectrumCaptureErrorCode, message: string) {
    super(`[${code}] ${sanitizeDiagnostic(message)}`);
    this.name = 'SpectrumCaptureError';
    this.code = code;
  }
}

export function isSpectrumCaptureError(value: unknown): value is SpectrumCaptureError {
  return value instanceof SpectrumCaptureError;
}

/** True when the error represents an intentional, signal-driven abort. */
export function isIntentionalAbort(value: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (value instanceof DOMException && value.name === 'AbortError') return true;
  if (value instanceof Error && value.name === 'AbortError') return true;
  return false;
}

/** PCM format every adapter must normalize to before publishing samples. */
export interface PcmFormat {
  /** Integer 8_000..192_000 Hz. */
  sampleRate: number;
  /** Integer 1..8. */
  channels: number;
  /** Interleaved complete frames after boundary decoding. */
  encoding: 'f32le';
}

export const MIN_SAMPLE_RATE = 8_000;
export const MAX_SAMPLE_RATE = 192_000;
export const MAX_CHANNELS = 8;
/** Fixed adapter-side capture rate; recorders are asked to resample to this. */
export const CAPTURE_SAMPLE_RATE = 48_000;

function isFiniteInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Strictly validate an untrusted PCM format (from a child process or parser). */
export function isValidPcmFormat(value: unknown): value is PcmFormat {
  if (value == null || typeof value !== 'object') return false;
  const format = value as Record<string, unknown>;
  return (
    isFiniteInteger(format.sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE) &&
    isFiniteInteger(format.channels, 1, MAX_CHANNELS) &&
    format.encoding === 'f32le'
  );
}

/** Audio backends with a concrete capture adapter. */
export type CaptureBackend = 'pipewire' | 'pulse' | 'coreaudio';

/** Exactly one capture intent: one playback request, one owned player process. */
export interface CaptureTarget {
  requestId: number;
  process: { pid: number; clientName: string };
  ao: CaptureBackend;
}

/** Strictly validate an untrusted capture target. */
export function isValidCaptureTarget(value: unknown): value is CaptureTarget {
  if (value == null || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  const process = target.process as Record<string, unknown> | null | undefined;
  return (
    isFiniteInteger(target.requestId, 0, Number.MAX_SAFE_INTEGER) &&
    target.ao !== null &&
    target.ao !== undefined &&
    ['pipewire', 'pulse', 'coreaudio'].includes(String(target.ao)) &&
    process != null &&
    typeof process === 'object' &&
    isFiniteInteger(process.pid, 1, Number.MAX_SAFE_INTEGER) &&
    typeof process.clientName === 'string' &&
    process.clientName.length > 0 &&
    process.clientName.length <= 128
  );
}

export type CaptureEvent =
  | { kind: 'reset' }
  | { kind: 'format'; format: PcmFormat }
  | { kind: 'pcm'; bytes: Uint8Array };

/**
 * One capture lifetime for one target. Settles only after every owned child
 * process and resource has drained; an intentional abort resolves normally.
 */
export interface SpectrumCapturePort {
  run(target: CaptureTarget, signal: AbortSignal, emit: (event: CaptureEvent) => void): Promise<void>;
}
