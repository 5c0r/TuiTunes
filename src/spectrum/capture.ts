/**
 * Common capture ownership for the spectrum adapters (feature 15).
 *
 * Every recorder, watcher and helper belongs to one capture run. This module
 * owns child startup/drain/reap, the capture-process exit safety net, and the
 * platform dispatch to the concrete adapters; backend files own only their
 * discovery/link/protocol behavior. The PID registry is deliberately separate
 * from the mpv-only registry in player/process.ts.
 */
import { Logger } from '../utils/logger';
import { runCoreAudioCapture, MACOS_CAPTURE_STARTUP_MS } from './coreaudio';
import { pipeWireToolsAvailable, runPipeWireCapture } from './pipewire';
import { nativePulseAvailable, runPulseCapture } from './pulse';
import {
  SpectrumCaptureError,
  isValidCaptureTarget,
  type CaptureEvent,
  type CaptureTarget,
  type SpectrumCapturePort,
} from './types';

/** A spawned capture child process, shell-free (argv is passed verbatim). */
export interface CaptureChild {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly exited: Promise<number | null>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export interface CaptureSpawnOptions {
  /** Merged over the parent environment (undefined removes a key). */
  env?: Record<string, string | undefined>;
}

export type CaptureSpawnFn = (argv: readonly string[], options?: CaptureSpawnOptions) => CaptureChild;

/** Boundary seam: real process spawning in production, fakes in tests. */
export interface CaptureEnv {
  spawn: CaptureSpawnFn;
  now(): number;
  platform?: NodeJS.Platform;
  /** Override the per-backend startup budget (tests/integration). */
  startupTimeoutMs?: number;
}

export const DEFAULT_CAPTURE_STARTUP_MS = 5_000;
export const KILL_GRACE_MS = 500;
/** Hard ceiling for a single child to die after SIGKILL before giving up. */
const REAP_CEILING_MS = 3_000;
/** Bounded wall time for short-lived probe tools. */
const PROBE_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Capture process registry — separate from the mpv-only registry
// ---------------------------------------------------------------------------

const capturePids = new Set<number>();
const activeRunAborts = new Set<() => void>();

/**
 * Exit safety net for spectrum capture children: abort every active run, then
 * SIGKILL every tracked child. Synchronous-safe for a process 'exit' handler.
 */
export function killAllSpectrumCaptures(): void {
  if (activeRunAborts.size > 0) {
    for (const abort of activeRunAborts) {
      try {
        abort();
      } catch {
        // Teardown must never throw from an exit handler.
      }
    }
    activeRunAborts.clear();
  }
  if (capturePids.size === 0) return;
  for (const pid of capturePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead.
    }
  }
  capturePids.clear();
}

/** Currently tracked capture child PIDs (debugging/tests). */
export function getSpectrumCapturePids(): number[] {
  return [...capturePids];
}

function mergeEnv(overrides: Record<string, string | undefined> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

const realSpawn: CaptureSpawnFn = (argv, options) => {
  try {
    const proc = Bun.spawn({
      cmd: [...argv],
      env: mergeEnv(options?.env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const child: CaptureChild = {
      pid: proc.pid,
      argv: [...argv],
      exited: proc.exited,
      stdout: proc.stdout as ReadableStream<Uint8Array> | null,
      stderr: proc.stderr as ReadableStream<Uint8Array> | null,
      kill(signal) {
        try {
          proc.kill(signal ?? 'SIGTERM');
        } catch {
          // Already dead.
        }
      },
    };
    capturePids.add(child.pid);
    void child.exited.finally(() => capturePids.delete(child.pid));
    return child;
  } catch (error) {
    throw new SpectrumCaptureError('tool-missing', `failed to start ${argv[0]}: ${error}`);
  }
};

export const realCaptureEnv: CaptureEnv = { spawn: realSpawn, now: () => Date.now() };

// ---------------------------------------------------------------------------
// Stream helpers — bounded, always draining so pipes can never fill
// ---------------------------------------------------------------------------

/** Forward raw stdout chunks to a sink; resolves when the stream ends. */
export function pumpBytes(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  if (!stream) return Promise.resolve();
  return (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) onChunk(value);
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

/** Read a whole stream as text, bounded; used only for short tool probes. */
export async function readAllText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = 64 * 1024,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;
  await pumpBytes(stream, (chunk) => {
    if (overflowed) return;
    if (total + chunk.byteLength > maxBytes) {
      overflowed = true;
      return;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  });
  return new TextDecoder().decode(concatBytes(chunks));
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Incremental line reader with a bounded per-line cap. */
export function readLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
  maxLineBytes = 4096,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  return pumpBytes(stream, (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > maxLineBytes * 4) {
      throw new SpectrumCaptureError('protocol', 'unterminated diagnostic line exceeds bound');
    }
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf('\n');
    }
  }).finally(() => {
    decoder.decode();
    if (buffer.length > 0) onLine(buffer);
  });
}

// ---------------------------------------------------------------------------
// Child teardown — TERM, bounded grace, KILL, reap
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Stop one child: SIGTERM, 500ms grace, SIGKILL, then await exit (bounded). */
export async function stopChild(child: CaptureChild): Promise<void> {
  let settled = false;
  const exited = child.exited.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  if (!settled) child.kill('SIGTERM');
  const grace = sleep(KILL_GRACE_MS).then(() => {
    if (!settled) child.kill('SIGKILL');
  });
  await Promise.race([exited, grace]);
  if (!settled) {
    await Promise.race([exited, sleep(REAP_CEILING_MS)]);
  }
}

/** Wait for a child to exit on its own within a deadline (no signal sent). */
export async function waitExit(
  child: CaptureChild,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  const exited = child.exited.then((code) => ({ code, timedOut: false }));
  const timer = sleep(Math.max(0, timeoutMs)).then(() => ({ code: null as number | null, timedOut: true }));
  return Promise.race([exited, timer]);
}

/**
 * Run a short-lived probe child to completion. Kill-first on timeout or
 * abort — a hung child's never-ending pipes can never delay the kill — and
 * only then drain what was captured. Never used for recorders/watchers.
 */
export async function runTool(
  env: CaptureEnv,
  argv: readonly string[],
  options?: CaptureSpawnOptions & { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const child = env.spawn(argv, options);
  const stdout = readAllText(child.stdout).catch(() => '');
  const stderr = readAllText(child.stderr).catch(() => '');
  const result = await waitExit(child, timeoutMs);
  if (result.timedOut || options?.signal?.aborted) {
    await stopChild(child); // kill first, which also closes the pipes…
    await Promise.allSettled([stdout, stderr]); // …then drain the ended readers
    throw new SpectrumCaptureError('process', `${argv[0]} did not exit within ${timeoutMs}ms`);
  }
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  return { code: result.code, stdout: stdoutText, stderr: stderrText };
}

// ---------------------------------------------------------------------------
// Per-run context handed to backend implementations
// ---------------------------------------------------------------------------

export interface CaptureRunContext {
  readonly target: CaptureTarget;
  readonly signal: AbortSignal;
  readonly env: CaptureEnv;
  readonly startupMs: number;
  now(): number;
  emit(event: CaptureEvent): void;
  /** Spawn a child owned by this run; reaped at run teardown. */
  spawn(argv: readonly string[], options?: CaptureSpawnOptions): CaptureChild;
  /** Stop every child spawned through this context (TERM→KILL→reap). */
  stopOwned(): Promise<void>;
  /** Children still alive (exited ones are dropped from ownership). */
  outstandingChildren(): number;
  throwIfAborted(): void;
}

/**
 * Wrap one backend capture run: validate the target, own all children, turn
 * intentional aborts into normal completion, and drain everything before the
 * returned promise settles.
 */
export async function runCaptureBackend(
  backend: string,
  target: CaptureTarget,
  signal: AbortSignal,
  emit: (event: CaptureEvent) => void,
  env: CaptureEnv,
  body: (ctx: CaptureRunContext) => Promise<void>,
  startupMs = env.startupTimeoutMs ?? DEFAULT_CAPTURE_STARTUP_MS,
): Promise<void> {
  if (!isValidCaptureTarget(target)) {
    throw new SpectrumCaptureError('unsupported', `invalid ${backend} capture target`);
  }
  const owned: CaptureChild[] = [];
  let teardown: Promise<void> = Promise.resolve();
  let stopping = false;

  const stopOwned = async (): Promise<void> => {
    if (owned.length === 0) return;
    const children = owned.splice(0, owned.length);
    await Promise.all(children.map((child) => stopChild(child)));
  };
  const onAbort = () => {
    if (stopping) return;
    stopping = true;
    for (const child of owned) child.kill('SIGTERM');
  };
  const abortRun = () => onAbort();
  signal.addEventListener('abort', onAbort, { once: true });
  activeRunAborts.add(abortRun);
  const ctx: CaptureRunContext = {
    target,
    signal,
    env,
    startupMs,
    now: () => env.now(),
    emit,
    spawn(argv, options) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      let child: CaptureChild;
      try {
        child = env.spawn(argv, options);
      } catch (error) {
        if (error instanceof SpectrumCaptureError) throw error;
        throw new SpectrumCaptureError('tool-missing', `failed to start ${argv[0]}: ${error}`);
      }
      owned.push(child);
      void child.exited.finally(() => {
        const index = owned.indexOf(child);
        if (index >= 0) owned.splice(index, 1);
      });
      return child;
    },
    stopOwned() {
      stopping = true;
      teardown = stopOwned();
      return teardown;
    },
    outstandingChildren() {
      return owned.length;
    },
    throwIfAborted() {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    },
  };

  try {
    await body(ctx);
  } catch (error) {
    if (signal.aborted) return; // intentional abort is not an error
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    activeRunAborts.delete(abortRun);
    onAbort();
    await Promise.all([teardown, stopOwned()]);
  }
  if (signal.aborted) return;
  Logger.debug(`spectrum/${backend}: capture run ended without abort`);
  throw new SpectrumCaptureError('process', `${backend} capture ended unexpectedly`);
}

// ---------------------------------------------------------------------------
// Port factory + platform dispatch
// ---------------------------------------------------------------------------

/**
 * Platform/stack dispatch. On Linux the player's ACTUAL audio backend decides
 * the route first: ao=pulse probes the Pulse server implementation (native
 * PulseAudio → direct monitor; PipeWire-Pulse → the graph adapter, which then
 * requires PipeWire tools), ao=pipewire always uses the graph route. Tool
 * presence alone never picks a route, and no route ever falls back to a
 * microphone, default sink, or guessed process.
 */
export async function dispatchSpectrumCapture(
  env: CaptureEnv,
  target: CaptureTarget,
  signal: AbortSignal,
  emit: (event: CaptureEvent) => void,
): Promise<void> {
  const platform = env.platform ?? process.platform;
  if (platform === 'darwin') {
    if (target.ao !== 'coreaudio') {
      throw new SpectrumCaptureError(
        'unsupported',
        `CoreAudio capture requires the coreaudio audio backend, not ${target.ao}`,
      );
    }
    return runCoreAudioCapture(target, signal, emit, env);
  }
  if (platform === 'linux') {
    if (target.ao === 'pulse') {
      const pulse = await nativePulseAvailable(env, { signal });
      if (pulse.available) {
        return runPulseCapture(target, signal, emit, env);
      }
      if (pulse.pipeWirePulse) {
        const pipeWire = await pipeWireToolsAvailable(env, { signal });
        if (pipeWire.available) {
          return runPipeWireCapture(target, signal, emit, env);
        }
        throw new SpectrumCaptureError(
          'tool-missing',
          `PipeWire-Pulse server detected but PipeWire tools are unavailable: ${pipeWire.reason}`,
        );
      }
      throw new SpectrumCaptureError('tool-missing', `no supported PulseAudio capture route: ${pulse.reason}`);
    }
    const pipeWire = await pipeWireToolsAvailable(env, { signal });
    if (pipeWire.available) {
      return runPipeWireCapture(target, signal, emit, env);
    }
    throw new SpectrumCaptureError(
      'tool-missing',
      `PipeWire tools unavailable for ao=${target.ao}: ${pipeWire.reason}`,
    );
  }
  throw new SpectrumCaptureError('unsupported', `spectrum capture is not implemented on ${platform}`);
}

/** Create the real spectrum capture port (production spawn environment). */
export function createSpectrumCapturePort(): SpectrumCapturePort {
  return {
    run(target, signal, emit) {
      return dispatchSpectrumCapture(realCaptureEnv, target, signal, emit);
    },
  };
}

export { MACOS_CAPTURE_STARTUP_MS };
