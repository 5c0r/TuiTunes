/**
 * Spectrum session owner (feature 15).
 *
 * Subscribes to config, committed playback target, player state, audio
 * backend and player process identity; starts exactly one capture generation
 * per eligible audio signature. Position updates never respawn recorders,
 * stale generations are ignored, PCM stalls become `unavailable`, and no
 * failure ever touches player controls, errors or the queue.
 */
import type { Store } from 'jotai/vanilla/store';
import type { PlayerProcessIdentity } from '../player/types';
import { configAtom } from '../store/config';
import {
  playerAudioBackendAtom,
  playerPlaybackAtom,
  playerProcessIdentityAtom,
  playerStateAtom,
} from '../store/player';
import {
  SPECTRUM_BAND_COUNT,
  spectrumFrameAtom,
  spectrumStatusAtom,
  type SpectrumStatus,
  type SpectrumUnavailableReason,
} from '../store/spectrum';
import { SpectrumAnalyzer } from '../spectrum/analyzer';
import {
  isSpectrumCaptureError,
  sanitizeDiagnostic,
  type CaptureBackend,
  type CaptureEvent,
  type SpectrumCapturePort,
} from '../spectrum/types';
import { Logger } from '../utils/logger';

/** Fixed analysis/publish cadence — never above 20 Hz. */
export const SPECTRUM_ANALYZE_INTERVAL_MS = 50;
/** PCM quiet period while playback claims to be active before giving up. */
const PCM_STALL_MS = 1_000;

export type SpectrumClockHandle = NodeJS.Timeout;

/** Interval scheduling seam; production uses one 50 ms interval. */
export interface SpectrumClock {
  now(): number;
  setInterval(handler: () => void, intervalMs: number): SpectrumClockHandle;
  clearInterval(handle: SpectrumClockHandle): void;
}

const defaultSpectrumClock: SpectrumClock = {
  now: () => Date.now(),
  setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

export interface SpectrumSessionOptions {
  /** Injected capture port; the real adapter in production, fakes in tests. */
  capture: SpectrumCapturePort;
  clock?: SpectrumClock;
}

export interface SpectrumSession {
  dispose(): Promise<void>;
}

interface CaptureSignature {
  key: string;
  requestId: number;
  backend: CaptureBackend;
  pid: number;
  clientName: string;
}

interface ActiveRun {
  generation: number;
  controller: AbortController;
  analyzer: SpectrumAnalyzer;
  signature: CaptureSignature;
  finished: Promise<void>;
  lastPcmAt: number;
  hadPcm: boolean;
  hadFrame: boolean;
}

function signatureOf(
  requestId: number,
  backend: CaptureBackend,
  identity: PlayerProcessIdentity,
): CaptureSignature {
  return {
    key: `${requestId}:${backend}:${identity.pid}:${identity.clientName}`,
    requestId,
    backend,
    pid: identity.pid,
    clientName: identity.clientName,
  };
}

function describeFailure(error: unknown): { reason: SpectrumUnavailableReason; message: string } {
  if (isSpectrumCaptureError(error)) {
    return {
      reason: error.code === 'unsupported' ? 'unsupported-backend' : error.code,
      message: error.message,
    };
  }
  return { reason: 'internal', message: sanitizeDiagnostic(error) };
}

/** Own the spectrum capture lifecycle for one jotai store. */
export function createSpectrumSession(
  store: Store,
  options: SpectrumSessionOptions,
): SpectrumSession {
  const clock = options.clock ?? defaultSpectrumClock;
  const port = options.capture;
  let disposed = false;
  let generation = 0;
  let run: ActiveRun | null = null;
  let failedSignature: string | null = null;
  let draining: Promise<void> | null = null;
  let intervalHandle: SpectrumClockHandle | null = null;
  let disposal: Promise<void> | null = null;

  function stopRun(): void {
    if (intervalHandle !== null) {
      clock.clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (!disposed) store.set(spectrumFrameAtom, null);
    const active = run;
    run = null;
    if (active === null) return;
    const finished = active.finished.catch(() => undefined);
    draining = finished;
    void finished.then(() => {
      if (draining !== finished) return;
      draining = null;
      evaluate(); // only the latest still-eligible target may start after teardown
    });
    active.controller.abort();
  }

  function setStatus(status: SpectrumStatus): void {
    if (!disposed) store.set(spectrumStatusAtom, status);
  }

  function fail(active: ActiveRun, reason: SpectrumUnavailableReason, message: string): void {
    if (disposed || run !== active) return;
    failedSignature = active.signature.key;
    stopRun();
    if (!disposed) store.set(spectrumFrameAtom, null);
    setStatus({ kind: 'unavailable', reason, message });
    Logger.warn(`spectrum: capture unavailable (${reason}): ${message}`);
  }

  function applyEvent(active: ActiveRun, event: CaptureEvent): void {
    if (event.kind === 'reset') {
      active.analyzer.reset();
      active.hadPcm = false;
      active.hadFrame = false;
      active.lastPcmAt = clock.now();
      store.set(spectrumFrameAtom, null);
      setStatus({ kind: 'starting' });
      return;
    }
    if (event.kind === 'format') {
      try {
        active.analyzer.setFormat(event.format);
      } catch (error) {
        fail(active, 'format', sanitizeDiagnostic(error));
      }
      return;
    }
    active.lastPcmAt = clock.now();
    active.hadPcm = true;
    try {
      active.analyzer.pushPcm(event.bytes);
    } catch (error) {
      fail(active, 'format', sanitizeDiagnostic(error));
    }
  }

  function startRun(signature: CaptureSignature): void {
    const myGeneration = ++generation;
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    const active: ActiveRun = {
      generation: myGeneration,
      controller,
      analyzer: new SpectrumAnalyzer({ bandCount: SPECTRUM_BAND_COUNT }),
      signature,
      finished: completion.promise,
      lastPcmAt: clock.now(),
      hadPcm: false,
      hadFrame: false,
    };
    run = active;
    store.set(spectrumFrameAtom, null);
    setStatus({ kind: 'starting' });
    intervalHandle = clock.setInterval(tick, SPECTRUM_ANALYZE_INTERVAL_MS);
    const emit = (event: CaptureEvent): void => {
      if (disposed || run !== active) return; // late events from stale generations
      applyEvent(active, event);
    };
    const target = {
      requestId: signature.requestId,
      process: { pid: signature.pid, clientName: signature.clientName },
      ao: signature.backend,
    };
    const finished = completion.promise;
    try {
      void port.run(target, controller.signal, emit).then(completion.resolve, completion.reject);
    } catch (error) {
      completion.reject(error);
    }
    void finished.then(
      () => {
        if (!disposed && run === active && !controller.signal.aborted) {
          fail(active, 'capture-ended', 'capture ended while still eligible');
        }
      },
      (error) => {
        if (disposed || run !== active || controller.signal.aborted) return;
        const described = describeFailure(error);
        fail(active, described.reason, described.message);
      },
    );
  }

  function evaluate(): void {
    if (disposed) return;
    const config = store.get(configAtom);
    const playback = store.get(playerPlaybackAtom);
    const state = store.get(playerStateAtom);
    const backend = store.get(playerAudioBackendAtom);
    const identity = store.get(playerProcessIdentityAtom);

    if (!config.spectrumEnabled) {
      stopRun();
      failedSignature = null;
      setStatus({ kind: 'off' });
      return;
    }
    if (config.reducedMotion) {
      stopRun();
      failedSignature = null;
      setStatus({ kind: 'suppressed', reason: 'reduced-motion' });
      return;
    }
    if (playback === null || state !== 'playing') {
      stopRun();
      failedSignature = null; // eligibility break: a later transition may retry
      setStatus({ kind: 'suppressed', reason: 'not-playing' });
      return;
    }
    if (backend === null || backend === 'unsupported') {
      stopRun();
      setStatus({
        kind: 'unavailable',
        reason: 'unsupported-backend',
        message: `audio backend ${backend ?? 'not yet reported'} cannot be captured`,
      });
      return;
    }
    if (
      identity === null ||
      !Number.isInteger(identity.pid) ||
      typeof identity.clientName !== 'string' ||
      identity.clientName.length === 0
    ) {
      stopRun();
      setStatus({
        kind: 'unavailable',
        reason: 'missing-process-identity',
        message: 'player process identity has not been published',
      });
      return;
    }
    const signature = signatureOf(playback.requestId, backend, identity);
    if (run !== null) {
      if (run.signature.key === signature.key) return; // same audio: never respawn
      stopRun(); // source switch or process recovery: fresh generation
    }
    if (failedSignature === signature.key) return; // retry needs a new transition
    if (draining !== null) {
      setStatus({ kind: 'starting' });
      return;
    }
    startRun(signature);
  }

  function tick(): void {
    if (disposed || run === null) return;
    const active = run;
    try {
      const analysis = active.analyzer.analyze();
      if (analysis !== null) {
        if (!active.hadFrame) {
          active.hadFrame = true;
          setStatus({ kind: 'active' });
        }
        store.set(spectrumFrameAtom, {
          requestId: active.signature.requestId,
          lowHz: analysis.lowHz,
          highHz: analysis.highHz,
          values: Array.from(analysis.values),
        });
      }
    } catch (error) {
      fail(active, 'internal', sanitizeDiagnostic(error));
      return;
    }
    if (run === active && active.hadPcm && clock.now() - active.lastPcmAt > PCM_STALL_MS) {
      fail(
        active,
        'pcm-stalled',
        `no PCM for over ${PCM_STALL_MS}ms while playback is active; capture stopped`,
      );
    }
  }

  const unsubscribers = [
    store.sub(configAtom, evaluate),
    store.sub(playerPlaybackAtom, evaluate),
    store.sub(playerStateAtom, evaluate),
    store.sub(playerAudioBackendAtom, evaluate),
    store.sub(playerProcessIdentityAtom, evaluate),
  ];
  evaluate();

  return {
    dispose(): Promise<void> {
      if (disposal !== null) return disposal;
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      stopRun();
      disposal = (async () => {
        await draining;
        store.set(spectrumStatusAtom, { kind: 'off' });
        store.set(spectrumFrameAtom, null);
      })();
      return disposal;
    },
  };
}
