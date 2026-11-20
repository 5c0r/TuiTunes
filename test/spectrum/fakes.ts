/**
 * Deterministic in-memory fakes for spectrum capture tests. Children are
 * scripted through real ReadableStreams so the adapters exercise their exact
 * stream parsing, and spawn records argv verbatim (never a shell).
 */
import type { CaptureChild, CaptureEnv, CaptureSpawnFn } from '../../src/spectrum/capture';
import type { CaptureEvent, CaptureTarget, SpectrumCapturePort } from '../../src/spectrum/types';

export class FakeChild implements CaptureChild {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly exited: Promise<number | null>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kills: ('SIGTERM' | 'SIGKILL')[] = [];
  private readonly exitResolvers = Promise.withResolvers<number | null>();
  private stdoutControl!: ReadableStreamDefaultController<Uint8Array>;
  private stderrControl!: ReadableStreamDefaultController<Uint8Array>;

  constructor(argv: readonly string[], pid: number) {
    this.argv = [...argv];
    this.pid = pid;
    this.exited = this.exitResolvers.promise;
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stdoutControl = controller;
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stderrControl = controller;
      },
    });
  }

  private closed = false;

  pushStdout(bytes: Uint8Array | string): void {
    if (this.closed) return;
    this.stdoutControl.enqueue(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  }

  pushStderr(bytes: Uint8Array | string): void {
    if (this.closed) return;
    this.stderrControl.enqueue(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  }

  exit(code: number | null): void {
    if (this.closed) {
      this.exitResolvers.resolve(code);
      return;
    }
    this.closed = true;
    this.stdoutControl.close();
    this.stderrControl.close();
    this.exitResolvers.resolve(code);
  }

  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.kills.push(signal);
    if (this.kills.length === 1) this.exit(128 + (signal === 'SIGKILL' ? 9 : 15));
    // A second kill arrives only if the child ignored SIGTERM.
  }
}

export class FakeSpawn {
  readonly children: FakeChild[] = [];
  /** Optional per-command script hook, invoked synchronously on spawn. */
  onSpawn: ((child: FakeChild) => void) | null = null;
  /** Binary names that behave as missing (spawn throws). */
  missing = new Set<string>();

  readonly spawn: CaptureSpawnFn = (argv) => {
    const binary = argv[0] ?? '';
    if (this.missing.has(binary)) {
      throw new Error(`spawn ${binary} ENOENT`);
    }
    const child = new FakeChild(argv, 10_000 + this.children.length);
    this.children.push(child);
    this.onSpawn?.(child);
    return child;
  };

  byBinary(binary: string): FakeChild[] {
    return this.children.filter((child) => child.argv[0] === binary);
  }

  lastOf(binary: string): FakeChild {
    const found = this.byBinary(binary);
    if (found.length === 0) throw new Error(`no child spawned for ${binary}`);
    return found[found.length - 1] as FakeChild;
  }
}

export function fakeEnv(
  spawn: FakeSpawn,
  options: { startupTimeoutMs?: number; platform?: NodeJS.Platform } = {},
): CaptureEnv {
  return {
    spawn: spawn.spawn,
    now: () => Date.now(),
    platform: options.platform,
    startupTimeoutMs: options.startupTimeoutMs,
  };
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function f32le(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    view.setFloat32(index * 4, sample, true);
  });
  return bytes;
}

export function sineBytes(
  sampleRate: number,
  channels: number,
  frequencyHz: number,
  seconds: number,
  amplitude = 0.5,
  phase = 0,
): Uint8Array {
  const frames = Math.round(sampleRate * seconds);
  const samples: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const value = amplitude * Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate + phase);
    for (let channel = 0; channel < channels; channel++) samples.push(value);
  }
  return f32le(samples);
}

export function targetFixture(overrides: Partial<CaptureTarget> = {}): CaptureTarget {
  return {
    requestId: 7,
    process: { pid: 4242, clientName: 'TuiTunes-test-client' },
    ao: 'pipewire',
    ...overrides,
  };
}

export interface ScriptedRun {
  target: CaptureTarget;
  signal: AbortSignal;
  emit: (event: CaptureEvent) => void;
}

/** Capture port fake: records runs and lets tests emit events into them. */
export class ScriptedPort implements SpectrumCapturePort {
  readonly runs: ScriptedRun[] = [];

  async run(
    target: CaptureTarget,
    signal: AbortSignal,
    emit: (event: CaptureEvent) => void,
  ): Promise<void> {
    this.runs.push({ target, signal, emit });
    if (signal.aborted) return;
    const done = Promise.withResolvers<void>();
    signal.addEventListener('abort', () => done.resolve(), { once: true });
    await done.promise;
  }

  emit(index: number, event: CaptureEvent): void {
    const run = this.runs[index];
    if (run === undefined) throw new Error(`no scripted run ${index}`);
    run.emit(event);
  }
}
