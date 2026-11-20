/**
 * Spectrum presentation state (feature 15). Status and band frames are stored
 * separately so 20 Hz band updates rerender only the Spectrum child, never
 * the whole App/metadata tree.
 */
import { atom } from 'jotai';

/** Number of logarithmic bands in one published frame. */
export const SPECTRUM_BAND_COUNT = 32;

/** Why no capture is running or starting. */
export type SpectrumUnavailableReason =
  | 'disabled'
  | 'unsupported-backend'
  | 'missing-process-identity'
  | 'tool-missing'
  | 'target-not-found'
  | 'target-ambiguous'
  | 'protocol'
  | 'process'
  | 'format'
  | 'attestation'
  | 'pcm-stalled'
  | 'capture-ended'
  | 'internal';

export type SpectrumStatus =
  | { kind: 'off' }
  | { kind: 'suppressed'; reason: 'reduced-motion' | 'not-playing' }
  | { kind: 'starting' }
  | { kind: 'active' }
  | { kind: 'unavailable'; reason: SpectrumUnavailableReason; message: string };

/** One analyzed frame: 32 normalized finite band values plus its range. */
export interface SpectrumFrame {
  requestId: number;
  lowHz: number;
  highHz: number;
  values: readonly number[];
}

export const spectrumStatusAtom = atom<SpectrumStatus>({ kind: 'off' });
export const spectrumFrameAtom = atom<SpectrumFrame | null>(null);
