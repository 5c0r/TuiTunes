import { existsSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Subprocess } from 'bun';
import { isWSL } from '../utils/deps';
import { Logger } from '../utils/logger';

// Prefer XDG_RUNTIME_DIR (per-user tmpdir, no cleanup races),
// fall back to /tmp with a user-scoped name.
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
export const SOCKET_PATH = path.join(runtimeDir, 'tuimusic-mpv.sock');

const MPV_ARGS: readonly string[] = [
  '--idle',
  '--no-video',
  '--no-terminal',
  `--input-ipc-server=${SOCKET_PATH}`,
  '--volume=100',
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

let mpvProc: Subprocess | null = null;

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

/** Return a copy of all currently tracked PIDs (for debugging). */
export function getTrackedPids(): number[] {
  return [...spawnedPids];
}

// ---------------------------------------------------------------------------
// mpv process lifecycle
// ---------------------------------------------------------------------------

/**
 * Remove a stale socket file left from a previous crash.
 * Safe to call even if the file doesn't exist.
 */
function cleanStaleSocket(): void {
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // ENOENT is fine — no stale socket
  }
}

/**
 * Spawn an mpv process in idle mode with IPC enabled.
 * Returns only after the socket file appears on disk (mpv is ready).
 *
 * Throws if mpv fails to start within 5 seconds.
 */
export async function spawnMpv(): Promise<Subprocess> {
  if (mpvProc && mpvProc.exitCode === null) {
    Logger.warn('spawnMpv called while mpv is already running');
    return mpvProc;
  }

  cleanStaleSocket();

  mpvProc = Bun.spawn(['mpv', ...MPV_ARGS], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });

  const pid = mpvProc.pid;
  trackPid(pid);
  Logger.info(`mpv spawned with pid ${pid}`);

  // Poll for socket file creation — mpv needs a moment.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // Bun.file().exists() doesn't detect Unix sockets — use existsSync
    if (existsSync(SOCKET_PATH)) {
      Logger.info('mpv IPC socket ready');
      return mpvProc;
    }
    // Early exit if mpv already died
    if (mpvProc.exitCode !== null) {
      untrackPid(pid);
      throw new Error(`mpv exited with code ${mpvProc.exitCode} before creating socket`);
    }
    await Bun.sleep(50);
  }

  throw new Error('mpv did not create IPC socket within 5 seconds');
}

/**
 * Kill the running mpv process and clean up the socket.
 * Safe to call multiple times.
 */
export function killMpv(): void {
  if (mpvProc) {
    const pid = mpvProc.pid;
    if (mpvProc.exitCode === null) {
      mpvProc.kill();
      Logger.info(`mpv process killed (pid ${pid})`);
    }
    untrackPid(pid);
    mpvProc = null;
  }
  cleanStaleSocket();
}

/**
 * Return the current mpv subprocess, or null if not running.
 */
export function getMpvProcess(): Subprocess | null {
  if (mpvProc && mpvProc.exitCode !== null) {
    // Process died — clear the reference
    untrackPid(mpvProc.pid);
    mpvProc = null;
  }
  return mpvProc;
}
