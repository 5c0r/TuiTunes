import { beforeEach, describe, expect, test } from 'bun:test';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import type { PlayerProcessIdentity } from '../../src/player/types';
import {
  SPECTRUM_ANALYZE_INTERVAL_MS,
  createSpectrumSession,
  type SpectrumClock,
  type SpectrumClockHandle,
} from '../../src/application/spectrum';
import { DEFAULT_CONFIG } from '../../src/utils/config';
import { configAtom } from '../../src/store/config';
import {
  playerAudioBackendAtom,
  playerErrorAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerProcessIdentityAtom,
  playerStateAtom,
} from '../../src/store/player';
import {
  spectrumFrameAtom,
  spectrumStatusAtom,
  type SpectrumStatus,
} from '../../src/store/spectrum';
import {
  SpectrumCaptureError,
  type CaptureEvent,
  type CaptureTarget,
  type SpectrumCapturePort,
} from '../../src/spectrum/types';
import { f32le } from '../spectrum/fakes';

type Outcome = 'hang' | 'reject' | 'resolve';

interface FakeRun {
  target: CaptureTarget;
  signal: AbortSignal;
  emit: (event: CaptureEvent) => void;
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const done = Promise.withResolvers<void>();
  signal.addEventListener('abort', () => done.resolve(), { once: true });
  return done.promise;
}

function untilStatus(store: Store, kind: SpectrumStatus['kind']): Promise<SpectrumStatus> {
  const current = store.get(spectrumStatusAtom);
  if (current.kind === kind) return Promise.resolve(current);
  const done = Promise.withResolvers<SpectrumStatus>();
  const unsubscribe = store.sub(spectrumStatusAtom, () => {
    const status = store.get(spectrumStatusAtom);
    if (status.kind !== kind) return;
    unsubscribe();
    done.resolve(status);
  });
  return done.promise;
}

function microtaskCheckpoint(): Promise<void> {
  const done = Promise.withResolvers<void>();
  queueMicrotask(done.resolve);
  return done.promise;
}

class FakePort implements SpectrumCapturePort {
  readonly runs: FakeRun[] = [];
  outcomes: Outcome[] = [];
  private readonly started = new Map<number, Array<(run: FakeRun) => void>>();

  untilRun(index: number): Promise<FakeRun> {
    const existing = this.runs[index];
    if (existing) return Promise.resolve(existing);
    const done = Promise.withResolvers<FakeRun>();
    this.started.set(index, [...(this.started.get(index) ?? []), done.resolve]);
    return done.promise;
  }

  async run(
    target: CaptureTarget,
    signal: AbortSignal,
    emit: (event: CaptureEvent) => void,
  ): Promise<void> {
    const index = this.runs.length;
    this.runs.push({ target, signal, emit });
    for (const notify of this.started.get(index) ?? []) notify(this.runs[index]!);
    this.started.delete(index);
    if (this.outcomes[index] === 'reject') {
      throw new SpectrumCaptureError('tool-missing', 'pw-dump not installed');
    }
    if (this.outcomes[index] === 'resolve') {
      return; // unexpected clean exit while eligible
    }
    await untilAborted(signal);
  }
}

class ManualClock implements SpectrumClock {
  time = 1_000;
  private readonly handlers = new Set<() => void>();

  now(): number {
    return this.time;
  }

  setInterval(handler: () => void, _intervalMs: number): SpectrumClockHandle {
    void _intervalMs;
    this.handlers.add(handler);
    return this.handlers as unknown as SpectrumClockHandle;
  }

  clearInterval(handle: SpectrumClockHandle): void {
    (handle as unknown as Set<() => void>).clear?.();
    this.handlers.clear();
  }

  tick(): void {
    this.time += SPECTRUM_ANALYZE_INTERVAL_MS;
    for (const handler of [...this.handlers]) handler();
  }
}

function playbackTarget(requestId: number) {
  return {
    track: {
      id: 'a',
      provider: 'youtube' as const,
      source: { kind: 'youtube' as const, videoId: 'a' },
      title: 'T',
      artist: 'A',
      duration: 60,
    },
    source: {
      kind: 'youtube' as const,
      videoId: 'a',
      url: 'https://music.youtube.com/watch?v=a',
      selection: 'auto' as const,
    },
    requestId,
    origin: { kind: 'direct' as const },
  };
}

const IDENTITY: PlayerProcessIdentity = {
  socketPath: '/sock',
  pid: 4242,
  clientName: 'TuiTunes-x',
};

function eligibleStore(requestId = 7): Store {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, spectrumEnabled: true });
  store.set(playerPlaybackAtom, playbackTarget(requestId));
  store.set(playerStateAtom, 'playing');
  store.set(playerAudioBackendAtom, 'pipewire');
  store.set(playerProcessIdentityAtom, IDENTITY);
  return store;
}

function startSine(port: FakePort, runIndex = 0): void {
  const run = port.runs[runIndex];
  if (run === undefined) throw new Error('no run started');
  run.emit({ kind: 'format', format: { sampleRate: 48_000, channels: 2, encoding: 'f32le' } });
  const frames: number[] = [];
  for (let i = 0; i < 2 * 48_000; i++) {
    const v = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000);
    frames.push(v, v);
  }
  run.emit({ kind: 'pcm', bytes: f32le(frames) });
}

describe('createSpectrumSession', () => {
  let port: FakePort;
  let clock: ManualClock;
  let store: Store;

  beforeEach(() => {
    port = new FakePort();
    clock = new ManualClock();
    store = eligibleStore();
  });

  test('disabled by default: off, no capture, no interval work', () => {
    const disabled = createStore();
    disabled.set(configAtom, { ...DEFAULT_CONFIG });
    const session = createSpectrumSession(disabled, { capture: port, clock });
    expect(disabled.get(spectrumStatusAtom)).toEqual({ kind: 'off' });
    expect(port.runs).toHaveLength(0);
    clock.tick();
    expect(disabled.get(spectrumFrameAtom)).toBeNull();
    void session.dispose();
  });

  test('eligible playback starts one capture with the exact target', () => {
    createSpectrumSession(store, { capture: port, clock });
    expect(port.runs).toHaveLength(1);
    expect(port.runs[0]?.target).toEqual({
      requestId: 7,
      process: { pid: 4242, clientName: 'TuiTunes-x' },
      ao: 'pipewire',
    });
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'starting' });
  });

  test('fresh PCM publishes 32 finite bands and flips status active at <=20 Hz', () => {
    createSpectrumSession(store, { capture: port, clock });
    startSine(port);
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'starting' });
    clock.tick();
    const status = store.get(spectrumStatusAtom);
    const frame = store.get(spectrumFrameAtom);
    expect(status).toEqual({ kind: 'active' });
    expect(frame).not.toBeNull();
    expect(frame?.values).toHaveLength(32);
    expect(frame?.requestId).toBe(7);
    expect(frame?.lowHz).toBe(50);
    expect(frame?.highHz).toBe(10_000);
    expect(frame?.values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(
      true,
    );
    // Without fresh PCM the next tick must not republish.
    const first = store.get(spectrumFrameAtom);
    clock.tick();
    expect(store.get(spectrumFrameAtom)).toBe(first);
    expect(SPECTRUM_ANALYZE_INTERVAL_MS).toBeLessThanOrEqual(50);
  });

  test('pause/buffering/stop suppress; resume retries after the transition', async () => {
    createSpectrumSession(store, { capture: port, clock });
    startSine(port);
    for (const state of ['paused', 'buffering', 'stopped'] as const) {
      store.set(playerStateAtom, state);
      expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'suppressed', reason: 'not-playing' });
      expect(store.get(spectrumFrameAtom)).toBeNull();
      expect(port.runs[0]?.signal.aborted).toBe(true);
    }
    store.set(playerStateAtom, 'playing');
    await port.untilRun(1);
    expect(port.runs).toHaveLength(2); // retry on the new eligibility transition
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'starting' });
  });

  test('position updates never respawn the recorder', () => {
    createSpectrumSession(store, { capture: port, clock });
    startSine(port);
    for (const position of [1, 2.5, 3, 4.75, 5]) {
      store.set(playerPositionAtom, position);
      clock.tick();
    }
    expect(port.runs).toHaveLength(1);
  });

  test('source switch and process recovery start fresh generations', async () => {
    createSpectrumSession(store, { capture: port, clock });
    startSine(port);
    store.set(playerPlaybackAtom, playbackTarget(8));
    await port.untilRun(1);
    expect(port.runs).toHaveLength(2);
    expect(port.runs[0]?.signal.aborted).toBe(true);
    // Same requestId but a recovered process (new pid/name) is also new audio.
    store.set(playerProcessIdentityAtom, { ...IDENTITY, pid: 9999, clientName: 'TuiTunes-y' });
    await port.untilRun(2);
    expect(port.runs).toHaveLength(3);
    expect(port.runs[1]?.signal.aborted).toBe(true);
  });

  test('late events and errors from an older generation are ignored', () => {
    createSpectrumSession(store, { capture: port, clock });
    const first = port.runs[0] as FakeRun;
    store.set(playerPlaybackAtom, playbackTarget(8));
    const before = store.get(spectrumStatusAtom);
    first.emit({ kind: 'format', format: { sampleRate: 48_000, channels: 2, encoding: 'f32le' } });
    first.emit({ kind: 'pcm', bytes: f32le([0.5, 0.5]) });
    clock.tick();
    expect(store.get(spectrumStatusAtom)).toEqual(before);
    expect(store.get(spectrumFrameAtom)).toBeNull();
  });

  test('capture failure becomes unavailable and never touches the player', async () => {
    port.outcomes = ['reject'];
    createSpectrumSession(store, { capture: port, clock });
    await untilStatus(store, 'unavailable');
    const status = store.get(spectrumStatusAtom);
    expect(status.kind).toBe('unavailable');
    if (status.kind === 'unavailable') {
      expect(status.reason).toBe('tool-missing');
      expect(status.message).toContain('pw-dump');
    }
    expect(store.get(playerStateAtom)).toBe('playing');
    expect(store.get(playerErrorAtom)).toBeNull();
    // No retry loop: still playing, still one failed run.
    clock.tick();
    clock.tick();
    expect(port.runs).toHaveLength(1);
    // Pause→play re-arms the retry.
    store.set(playerStateAtom, 'paused');
    store.set(playerStateAtom, 'playing');
    await port.untilRun(1);
    expect(port.runs).toHaveLength(2);
  });

  test('PCM stall while playing clears bands and reports unavailable', () => {
    createSpectrumSession(store, { capture: port, clock });
    startSine(port);
    clock.tick();
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'active' });
    for (let i = 0; i < 25; i++) clock.tick(); // >1s of silence
    const status = store.get(spectrumStatusAtom);
    expect(status.kind).toBe('unavailable');
    if (status.kind === 'unavailable') expect(status.reason).toBe('pcm-stalled');
    expect(store.get(spectrumFrameAtom)).toBeNull();
    expect(port.runs[0]?.signal.aborted).toBe(true);
  });

  test('unexpected clean capture exit is capture-ended; fragmented frames still analyze', async () => {
    port.outcomes = ['resolve'];
    createSpectrumSession(store, { capture: port, clock });
    await untilStatus(store, 'unavailable');
    const ended = store.get(spectrumStatusAtom);
    expect(ended.kind).toBe('unavailable');
    if (ended.kind === 'unavailable') expect(ended.reason).toBe('capture-ended');

    const fresh = eligibleStore();
    const carryPort = new FakePort();
    const session = createSpectrumSession(fresh, { capture: carryPort, clock });
    carryPort.runs[0]?.emit({
      kind: 'format',
      format: { sampleRate: 48_000, channels: 2, encoding: 'f32le' },
    });
    // Odd-sized chunks crossing frame boundaries are carried, not errors.
    carryPort.runs[0]?.emit({ kind: 'pcm', bytes: f32le([0.1, 0.2, 0.3]) });
    carryPort.runs[0]?.emit({ kind: 'pcm', bytes: f32le([0.4, 0.1]) });
    clock.tick();
    expect(fresh.get(spectrumStatusAtom)).toEqual({ kind: 'active' });
    void session;
  });

  test('reduced motion suppresses without a row and without capture', () => {
    createSpectrumSession(store, { capture: port, clock });
    startSine(port);
    store.set(configAtom, { ...DEFAULT_CONFIG, spectrumEnabled: true, reducedMotion: true });
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'suppressed', reason: 'reduced-motion' });
    expect(port.runs[0]?.signal.aborted).toBe(true);
    expect(store.get(spectrumFrameAtom)).toBeNull();
  });

  test('unsupported backend and missing identity are explicit unavailable states', () => {
    store.set(playerAudioBackendAtom, 'unsupported');
    createSpectrumSession(store, { capture: port, clock });
    expect(store.get(spectrumStatusAtom).kind).toBe('unavailable');

    const noIdentity = eligibleStore();
    noIdentity.set(playerProcessIdentityAtom, null);
    createSpectrumSession(noIdentity, { capture: port, clock });
    const status = noIdentity.get(spectrumStatusAtom);
    expect(status.kind).toBe('unavailable');
    if (status.kind === 'unavailable') expect(status.reason).toBe('missing-process-identity');
    expect(port.runs).toHaveLength(0);
  });

  test('off/on toggles clear state and allow a fresh start', async () => {
    const session = createSpectrumSession(store, { capture: port, clock });
    startSine(port);
    clock.tick();
    store.set(configAtom, { ...DEFAULT_CONFIG, spectrumEnabled: false });
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'off' });
    store.set(configAtom, { ...DEFAULT_CONFIG, spectrumEnabled: true });
    await port.untilRun(1);
    expect(port.runs).toHaveLength(2);
    await session.dispose();
  });

  test('replacement waits for teardown and starts only the latest eligible target', async () => {
    const retired = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const runs: FakeRun[] = [];
    const capture: SpectrumCapturePort = {
      run(target, signal, emit) {
        runs.push({ target, signal, emit });
        if (runs.length === 1) return retired.promise;
        started.resolve();
        return untilAborted(signal);
      },
    };
    const session = createSpectrumSession(store, { capture, clock });
    try {
      store.set(playerPlaybackAtom, playbackTarget(8));
      store.set(playerPlaybackAtom, playbackTarget(9));
      store.set(playerProcessIdentityAtom, {
        ...IDENTITY,
        pid: 9999,
        clientName: 'TuiTunes-latest',
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.signal.aborted).toBe(true);
      runs[0]?.emit({ kind: 'pcm', bytes: f32le([0.5, 0.5]) });
      expect(store.get(spectrumFrameAtom)).toBeNull();
      retired.resolve();
      await started.promise;
      expect(runs).toHaveLength(2);
      expect(runs[1]?.target).toMatchObject({
        requestId: 9,
        process: { pid: 9999, clientName: 'TuiTunes-latest' },
      });
    } finally {
      retired.resolve();
      await session.dispose();
    }
  });

  test('dispose shares its drain promise and cancels a pending replacement', async () => {
    const retired = Promise.withResolvers<void>();
    const runs: FakeRun[] = [];
    const capture: SpectrumCapturePort = {
      run(target, signal, emit) {
        runs.push({ target, signal, emit });
        return retired.promise;
      },
    };
    const session = createSpectrumSession(store, { capture, clock });
    store.set(playerPlaybackAtom, playbackTarget(8));
    const disposal = session.dispose();
    expect(session.dispose()).toBe(disposal);
    retired.resolve();
    await disposal;
    expect(runs).toHaveLength(1);
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'off' });
  });

  test('a synchronous capture callback failure still drains before replacement', async () => {
    const retired = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const runs: FakeRun[] = [];
    const capture: SpectrumCapturePort = {
      run(target, signal, emit) {
        runs.push({ target, signal, emit });
        if (runs.length === 1) {
          emit({ kind: 'format', format: { sampleRate: 1, channels: 2, encoding: 'f32le' } });
          return retired.promise;
        }
        started.resolve();
        return untilAborted(signal);
      },
    };
    const session = createSpectrumSession(store, { capture, clock });
    try {
      expect(store.get(spectrumStatusAtom).kind).toBe('unavailable');
      store.set(playerPlaybackAtom, playbackTarget(8));
      await microtaskCheckpoint();
      expect(runs).toHaveLength(1);
      retired.resolve();
      await started.promise;
      expect(runs).toHaveLength(2);
    } finally {
      retired.resolve();
      await session.dispose();
    }
  });

  test('synchronous capture throws become unavailable without escaping the owner', async () => {
    const capture: SpectrumCapturePort = {
      run() {
        throw new Error('synchronous boundary failure');
      },
    };
    const session = createSpectrumSession(store, { capture, clock });
    await untilStatus(store, 'unavailable');
    expect(store.get(spectrumStatusAtom)).toMatchObject({
      kind: 'unavailable',
      reason: 'internal',
    });
    expect(store.get(playerStateAtom)).toBe('playing');
    await session.dispose();
  });

  test('dispose aborts, drains, and blocks late writes', async () => {
    const session = createSpectrumSession(store, { capture: port, clock });
    startSine(port);
    clock.tick();
    await session.dispose();
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'off' });
    expect(store.get(spectrumFrameAtom)).toBeNull();
    expect(port.runs[0]?.signal.aborted).toBe(true);
    port.runs[0]?.emit({ kind: 'pcm', bytes: f32le([0.5, 0.5]) });
    clock.tick();
    expect(store.get(spectrumFrameAtom)).toBeNull(); // no late writes after disposal
    store.set(playerStateAtom, 'paused');
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'off' });
  });
});
