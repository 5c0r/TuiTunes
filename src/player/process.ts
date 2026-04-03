import { type Subprocess } from 'bun';
import { unlinkSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Logger } from '../utils/logger';

// Prefer XDG_RUNTIME_DIR (per-user tmpdir, no cleanup races),
// fall back to /tmp with a user-scoped name.
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
export const SOCKET_PATH = path.join(runtimeDir, 'tunefork-mpv.sock');

const MPV_ARGS = [
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
] as const;

let mpvProc: Subprocess | null = null;

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

  Logger.info(`mpv spawned with pid ${mpvProc.pid}`);

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
    if (mpvProc.exitCode === null) {
      mpvProc.kill();
      Logger.info('mpv process killed');
    }
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
    mpvProc = null;
  }
  return mpvProc;
}
