import { existsSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Subprocess } from 'bun';
import { isWSL } from '../utils/deps';
import { Logger } from '../utils/logger';
import type { PlayerProcessIdentity } from './types';

/** Handle for a spawned (or reused) mpv process. */
export type MpvProcessHandle = PlayerProcessIdentity;

// Prefer XDG_RUNTIME_DIR (per-user tmpdir, no cleanup races),
// fall back to /tmp with a user-scoped name.
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();

/**
 * Options for spawning mpv. `binary`/`extraArgs` exist as an internal
 * fixture seam for tests, not as a public CLI surface.
 */
export interface MpvSpawnOptions {
  /** mpv binary to launch. Defaults to "mpv" resolved from PATH. */
  binary?: string;
  /** Extra arguments appended after the standard idle/IPC arguments. */
  extraArgs?: readonly string[];
  /** Aborts startup; a child that already spawned is killed, reaped, and its socket removed. */
  signal?: AbortSignal;
}

const STARTUP_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 500;

let mpvProc: Subprocess | null = null;
let mpvHandle: MpvProcessHandle | null = null;
let socketCounter = 0;

/** Build the standard idle-mode IPC argument list for a specific spawn. */
function mpvArgs(socketPath: string, clientName: string): string[] {
  return [
    '--idle',
    '--no-video',
    '--no-terminal',
    `--input-ipc-server=${socketPath}`,
    '--volume=100',
    // Unique per actual spawn: lets external tooling attribute exactly this
    // player's audio output. Does not select an output device.
    `--audio-client-name=${clientName}`,
    // Audio-only optimizations (~20% less memory)
    '--audio-display=no',
    '--vo=null',
    '--ytdl-format=bestaudio',
    '--demuxer-max-bytes=512KiB',
    '--demuxer-max-back-bytes=128KiB',
    '--cache-secs=10',
    // WSL2: force PulseAudio output (WSLg provides PulseAudio server)
    ...(isWSL() ? ['--ao=pulse'] : []),
  ];
}

// ---------------------------------------------------------------------------
// Process registry — tracks all spawned PIDs so nothing survives on exit.
// ---------------------------------------------------------------------------

/** Set of PIDs for every mpv process we have spawned. */
const spawnedPids = new Set<number>();

/** Register a PID in the registry. */
function trackPid(pid: number): void {
  spawnedPids.add(pid);
  Logger.debug(`Process registry: tracking pid ${pid} (total: ${spawnedPids.size})`);
}

/** Remove a PID from the registry (after confirmed dead). */
function untrackPid(pid: number): void {
  spawnedPids.delete(pid);
  Logger.debug(`Process registry: untracked pid ${pid} (total: ${spawnedPids.size})`);
}

/**
 * Kill ALL tracked processes. Called on exit as a safety net.
 * This is synchronous-safe for the process 'exit' handler.
 */
export function killAllTracked(): void {
  if (spawnedPids.size === 0) return;
  Logger.info(
    `Process registry: killing all ${spawnedPids.size} tracked process(es): [${[...spawnedPids].join(', ')}]`,
  );
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL'); // Use SIGKILL in exit handler — no time for SIGTERM grace
    } catch {
      // Already dead
    }
  }
  spawnedPids.clear();
}

/** Return a copy of all currently tracked PIDs (for debugging/tests). */
export function getTrackedPids(): number[] {
  return [...spawnedPids];
}

// ---------------------------------------------------------------------------
// mpv process lifecycle
// ---------------------------------------------------------------------------

/**
 * Remove a socket file left from a previous run or crash.
 * Safe to call even if the file doesn't exist.
 */
function cleanStaleSocket(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // ENOENT is fine — no stale socket
  }
}

/**
 * Wait for the subprocess to exit; escalate to SIGKILL after a bounded
 * grace period so a hung child can never stall shutdown.
 */
async function reapWithKill(proc: Subprocess): Promise<void> {
  const killTimer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already dead
    }
  }, KILL_GRACE_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(killTimer);
  }
}

/**
 * Spawn an mpv process in idle mode with IPC enabled.
 * Resolves with the process handle (socket path, pid, unique audio client
 * name) once the socket appears on disk (mpv is ready). An already-running
 * process is reused with its existing handle and name.
 *
 * On startup timeout, caller abort, or early child exit, the owned child is
 * terminated, reaped, and its socket removed before rejecting.
 */
export async function spawnMpv(options: MpvSpawnOptions = {}): Promise<MpvProcessHandle> {
  if (mpvProc && mpvProc.exitCode === null && mpvHandle) {
    Logger.warn('spawnMpv called while mpv is already running');
    return mpvHandle;
  }
  if (mpvProc) {
    // Previous process died on its own — stop tracking it before respawning.
    untrackPid(mpvProc.pid);
  }

  // Unique per process and spawn: pid avoids cross-process collisions, the
  // counter avoids respawn races (a crashed mpv may leave its socket behind).
  const socketPath = path.join(runtimeDir, `tuimusic-mpv-${process.pid}-${++socketCounter}.sock`);
  // Fresh identity per actual spawn: audio-graph attribution must never
  // confuse two lifetimes of the player, even if the OS reuses a PID.
  const clientName = `TuiTunes-${crypto.randomUUID()}`;
  const handle: MpvProcessHandle = { socketPath, pid: -1, clientName };
  const binary = options.binary ?? 'mpv';
  const args = [...mpvArgs(socketPath, clientName), ...(options.extraArgs ?? [])];
  cleanStaleSocket(socketPath);

  const proc = Bun.spawn([binary, ...args], {
    // Bun's implicit environment is the launch snapshot; pass the live
    // environment so mpv and capture see the same configured audio server.
    env: process.env,
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  handle.pid = proc.pid;
  mpvProc = proc;
  mpvHandle = handle;
  trackPid(proc.pid);
  // Observing `exited` is what makes Bun reap the child; without it,
  // exitCode stays null after a crash and a respawn would reuse the dead
  // socket. Untrack natural exits promptly and remove this child's socket
  // (a SIGKILLed mpv cannot clean up after itself) for the same reason.
  const cleanupExitedProc = (): void => {
    untrackPid(proc.pid);
    if (mpvProc === proc) {
      mpvProc = null;
      mpvHandle = null;
    }
    cleanStaleSocket(socketPath);
  };
  void proc.exited.then(cleanupExitedProc, cleanupExitedProc);
  Logger.info(`mpv spawned with pid ${proc.pid} (audio client ${clientName})`);

  const startup = new AbortController();
  const timer = setTimeout(() => startup.abort(), STARTUP_TIMEOUT_MS);
  const onCallerAbort = (): void => startup.abort();
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    while (true) {
      if (existsSync(socketPath)) {
        Logger.info('mpv IPC socket ready');
        return handle;
      }
      if (proc.exitCode !== null) {
        throw new Error(`mpv exited with code ${proc.exitCode} before creating socket`);
      }
      if (startup.signal.aborted) {
        throw new Error(
          options.signal?.aborted
            ? 'mpv startup aborted'
            : `mpv did not create IPC socket within ${STARTUP_TIMEOUT_MS / 1000}s`,
        );
      }
      await Bun.sleep(50);
    }
  } catch (err) {
    // Terminate + reap the child we own and remove its socket.
    await killMpv();
    throw err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Kill the running mpv process and clean up the socket.
 * Terminates, allows a 500 ms grace period, SIGKILLs if still alive,
 * awaits exit, then untracks the PID and unlinks the socket.
 * Safe to call multiple times.
 */
export async function killMpv(): Promise<void> {
  const proc = mpvProc;
  const socketPath = mpvHandle?.socketPath ?? null;
  mpvProc = null;
  mpvHandle = null;

  if (!proc) {
    if (socketPath) cleanStaleSocket(socketPath);
    return;
  }

  if (proc.exitCode === null) {
    try {
      proc.kill(); // SIGTERM
      Logger.info(`mpv process terminated (pid ${proc.pid})`);
    } catch {
      // Already dead
    }
    await reapWithKill(proc);
  }
  untrackPid(proc.pid);
  if (socketPath) cleanStaleSocket(socketPath);
}
