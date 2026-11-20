#!/usr/bin/env bun
/**
 * Compiled-artifact smoke test.
 *
 * Launches the real dist/tuimusic binary under a PTY via util-linux
 * `script`, with a scratch HOME/XDG_RUNTIME_DIR so no real user state is
 * touched. Waits for the rendered "TuiTunes" header, sends Ctrl+C, waits
 * for the "Quit TuiTunes?" confirmation, answers "y", and requires:
 * exit code 0 and removal of every scratch mpv IPC socket.
 *
 * All waits are event-driven with bounded deadlines (never fixed sleeps).
 * On failure the owned process group is terminated and reaped before the
 * captured output is reported.
 */
import { accessSync, existsSync, mkdirSync, mkdtempSync, readdirSync, constants, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';

const READINESS_MARKER = 'TuiTunes';
const QUIT_MARKER = 'Quit TuiTunes?';
const DEADLINE_MS = 15_000;
const TERMINATE_GRACE_MS = 2_000;
const SOCKET_UNLINK_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 25;
const MAX_CAPTURED_OUTPUT = 2 * 1024 * 1024;
const REPORT_TAIL_BYTES = 16 * 1024;
const MPV_SOCKET_GLOB = /^tuimusic-mpv-.*\.sock$/;

class SmokeFailure extends Error {}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Consume a pipe continuously so it can never fill and block the child. */
function pump(stream: ReadableStream<Uint8Array>, monitor: OutputMonitor): void {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        monitor.append(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Stream torn down during shutdown; drained enough.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
      monitor.close();
    }
  })();
}

/** Accumulates PTY output and resolves waiters as soon as their marker appears. */
class OutputMonitor {
  #text = '';
  #waiters = new Set<{ marker: string; resolve: (found: boolean) => void }>();
  #closed = false;

  append(chunk: string): void {
    if (this.#text.length < MAX_CAPTURED_OUTPUT) this.#text += chunk;
    for (const waiter of [...this.#waiters]) {
      if (this.#text.includes(waiter.marker)) {
        this.#waiters.delete(waiter);
        waiter.resolve(true);
      }
    }
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters) {
      this.#waiters.delete(waiter);
      waiter.resolve(false);
    }
  }

  get text(): string {
    return this.#text;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Resolves true once the marker is seen; false on close (EOF) or deadline. */
  waitFor(marker: string, timeoutMs: number): Promise<boolean> {
    if (this.#text.includes(marker)) return Promise.resolve(true);
    if (this.#closed) return Promise.resolve(false);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const waiter = {
      marker,
      resolve: (found: boolean) => {
        clearTimeout(timer);
        resolve(found);
      },
    };
    const timer = setTimeout(() => {
      this.#waiters.delete(waiter);
      waiter.resolve(false);
    }, timeoutMs);
    this.#waiters.add(waiter);
    return promise;
  }
}

function listSockets(runtimeDir: string): string[] {
  try {
    return readdirSync(runtimeDir).filter(name => MPV_SOCKET_GLOB.test(name));
  } catch {
    return [];
  }
}

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

/** Terminate and reap the owned process group (child is its setsid leader). */
async function killOwnedTree(child: Subprocess): Promise<void> {
  const pgid = child.pid;
  if (pgid !== null && pgid > 0) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // group already gone
      }
      if (await pollUntil(() => child.exitCode !== null || child.signalCode !== null, TERMINATE_GRACE_MS)) {
        try {
          await child.exited;
        } catch {
          // ignore
        }
        return;
      }
    }
  }
  child.kill();
  try {
    await child.exited;
  } catch {
    // ignore
  }
}

function tail(text: string, bytes: number): string {
  if (text.length <= bytes) return text;
  return `…[${text.length - bytes} earlier bytes omitted]…\n${text.slice(-bytes)}`;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length !== 1) {
    process.stderr.write('usage: bun scripts/smoke-compiled.ts <path-to-compiled-binary>\n');
    return 2;
  }
  const binary = resolve(argv[0]);
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    process.stderr.write(`compiled binary not found: ${binary} (run "bun run build" first)\n`);
    return 2;
  }
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    process.stderr.write(`compiled binary is not executable: ${binary}\n`);
    return 2;
  }
  if (!Bun.which('script') || !Bun.which('setsid')) {
    process.stderr.write('util-linux "script" and "setsid" are required for the compiled smoke test\n');
    return 2;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'tuimusic-smoke-'));
  const home = join(scratch, 'home');
  const runtimeDir = join(scratch, 'runtime');
  for (const dir of [home, join(home, '.config'), join(home, '.local', 'state'), join(home, 'tmp'), runtimeDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const configDir = join(home, '.config', 'tuimusic');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    ascii: true,
    reducedMotion: true,
    spectrumEnabled: false,
  }));

  // setsid makes the child a session/group leader so failure cleanup can kill
  // the whole owned tree (script -> sh -> tuimusic -> mpv) by group id.
  const child = Bun.spawn(['setsid', 'script', '-qefc', shellQuote(binary), '/dev/null'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: home,
      TERM: 'xterm-256color',
      TMPDIR: join(home, 'tmp'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_RUNTIME_DIR: runtimeDir,
    },
  });

  const monitor = new OutputMonitor();
  pump(child.stdout, monitor);
  pump(child.stderr, monitor);

  const stdinWrite = (data: string): void => {
    try {
      child.stdin?.write(data);
    } catch {
      // child closed its input while we were sending; surfaced by the exit check
    }
  };

  let failure: string | null = null;
  let readySockets = false;
  try {
    try {
      if (!(await monitor.waitFor(READINESS_MARKER, DEADLINE_MS))) {
        throw new SmokeFailure(
          `binary did not render "${READINESS_MARKER}" within ${DEADLINE_MS / 1000}s${monitor.closed ? ' (output stream closed early)' : ''}`,
        );
      }
      // mpv is spawned during startup, before the renderer; its socket must exist now.
      readySockets = listSockets(runtimeDir).length > 0;
      if (!readySockets) {
        throw new SmokeFailure(`no mpv IPC socket (${MPV_SOCKET_GLOB.source}) appeared under the scratch XDG_RUNTIME_DIR`);
      }
      stdinWrite('\x03'); // Ctrl+C -> quit confirmation
      if (!(await monitor.waitFor(QUIT_MARKER, DEADLINE_MS))) {
        throw new SmokeFailure(`Ctrl+C did not show "${QUIT_MARKER}" within ${DEADLINE_MS / 1000}s`);
      }
      stdinWrite('y');
      if (!(await pollUntil(() => child.exitCode !== null || child.signalCode !== null, DEADLINE_MS))) {
        throw new SmokeFailure(`binary did not exit within ${DEADLINE_MS / 1000}s after confirming quit`);
      }
      await child.exited;
      if (child.exitCode !== 0) {
        throw new SmokeFailure(`expected exit code 0, got ${child.exitCode ?? `signal ${child.signalCode}`}`);
      }
      if (/[^\p{ASCII}]/u.test(monitor.text)) {
        throw new SmokeFailure('ASCII-mode compiled TUI emitted non-ASCII chrome');
      }
      if (!(await pollUntil(() => listSockets(runtimeDir).length === 0, SOCKET_UNLINK_GRACE_MS))) {
        throw new SmokeFailure(
          `scratch mpv socket(s) not removed after quit: ${listSockets(runtimeDir).join(', ')}`,
        );
      }
    } catch (error) {
      failure = error instanceof SmokeFailure ? error.message : String(error);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await killOwnedTree(child);
    }
  }

  rmSync(scratch, { recursive: true, force: true });

  if (failure !== null) {
    process.stderr.write(`compiled smoke test FAILED: ${failure}\n--- captured output (tail) ---\n`);
    process.stderr.write(`${tail(monitor.text, REPORT_TAIL_BYTES)}\n`);
    return 1;
  }
  process.stdout.write(`compiled smoke test passed: ASCII/reduced-motion render, quit via Ctrl+C+y, exited 0, scratch sockets removed\n`);
  return 0;
}

if (import.meta.main) {
  // exitCode (not process.exit) so stdout/stderr writes flush before exit.
  process.exitCode = await main(process.argv.slice(2));
}
