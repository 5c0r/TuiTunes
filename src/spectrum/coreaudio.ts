/**
 * macOS CoreAudio capture adapter (feature 15).
 *
 * Launches the bundled TuiTunesSpectrum.app helper's exact executable (never
 * a PATH-discovered binary or shell command). The helper taps only this mpv
 * child's process object and streams `TUITUNES_PCM 1 <rate> 2 F32LE` + PCM on
 * stdout with bounded diagnostics on stderr. Capture/consent startup gets a
 * 120s budget, cancellable immediately; silence is never interpreted as
 * permission denial, and OSStatus failures are reported generically.
 */
import { accessSync, constants } from 'node:fs';
import * as path from 'node:path';
import {
  concatBytes,
  pumpBytes,
  readLines,
  runCaptureBackend,
  runTool,
  sleep,
  stopChild,
  type CaptureChild,
  type CaptureRunContext,
} from './capture';
import { SpectrumCaptureError, type CaptureEvent, type CaptureTarget } from './types';

export const MACOS_CAPTURE_STARTUP_MS = 120_000;
const HELPER_EXECUTABLE = 'tuitunes-spectrum-tap';
const HELPER_APP = 'TuiTunesSpectrum.app';
const HELPER_PROTOCOL_VERSION = 1;
const HELPER_VERSION_LINE = 'TUITUNES_SPECTRUM_HELPER 1';
const HELPER_MAX_RESTARTS = 3;
const POLL_INTERVAL_MS = 50;
const HEADER_BOUND = 128;

/** Pure parse of one ordered stdout header line. */
export function parseHelperHeader(line: string): { sampleRate: number; channels: number } | null {
  const match = /^TUITUNES_PCM (\d+) (\d+) (\d+) (F32LE)$/.exec(line.trim());
  if (match === null) return null;
  const version = Number(match[1]);
  const sampleRate = Number(match[2]);
  const channels = Number(match[3]);
  if (version !== HELPER_PROTOCOL_VERSION) return null;
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) return null;
  if (channels !== 2) return null;
  return { sampleRate, channels };
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the helper executable from candidate app bundle directories.
 * Defaults are exactly the two production locations: the source/npm resource
 * at native/bin/TuiTunesSpectrum.app, then the bundle beside a standalone
 * executable. Never depends on cwd, PATH, or a compiler on the user's Mac;
 * explicit candidates let tests resolve against throwaway scratch bundles.
 */
export function resolveHelperExecutable(candidates?: readonly string[]): string | null {
  const apps = candidates ?? [
    path.resolve(import.meta.dir, '../../native/bin', HELPER_APP),
    path.join(path.dirname(process.execPath), HELPER_APP),
  ];
  for (const app of apps) {
    const executable = path.join(app, 'Contents', 'MacOS', HELPER_EXECUTABLE);
    if (isExecutable(executable)) return executable;
  }
  return null;
}

interface HelperRun {
  readonly child: CaptureChild;
  lastStatus: string;
  fatal: SpectrumCaptureError | null;
  restart: boolean;
  header: { sampleRate: number; channels: number } | null;
  exited: boolean;
  exitCode: number | null;
  /** Publish gate: closed before teardown so late bytes are never forwarded. */
  live: boolean;
  stdoutReader: Promise<void> | null;
}

/** Spawn the helper and wire its single stdout reader: header, then PCM. */
function startHelper(
  spawn: (argv: readonly string[]) => CaptureChild,
  target: CaptureTarget,
  emit: (event: CaptureEvent) => void,
  executable: string | null,
): HelperRun {
  if (executable === null) {
    throw new SpectrumCaptureError(
      'tool-missing',
      `TuiTunesSpectrum.app helper not found (looked for ${HELPER_APP} in native/bin and beside the executable)`,
    );
  }
  // Exact bundle executable, argv only — no shell, no PATH lookup.
  const child = spawn([executable, String(target.process.pid), target.process.clientName]);
  const run: HelperRun = {
    child,
    lastStatus: '',
    fatal: null,
    restart: false,
    header: null,
    exited: false,
    exitCode: 0,
    live: false,
    stdoutReader: null,
  };
  void child.exited.then(
    (code) => {
      run.exited = true;
      run.exitCode = code ?? 0;
    },
    () => {
      run.exited = true;
      run.exitCode = 0;
    },
  );

  const headerDecoder = new TextDecoder();
  let handshaking = true;
  let pendingHeader: Uint8Array = new Uint8Array(0);
  run.live = true;
  run.stdoutReader = pumpBytes(child.stdout, (chunk) => {
    if (!run.live) return; // gated off before teardown: never forward late bytes
    if (!handshaking) {
      emit({ kind: 'pcm', bytes: chunk });
      return;
    }
    // Find the newline in RAW bytes; decode only the header line so the
    // binary PCM suffix is forwarded untouched (no UTF-8 round trip).
    const buffered =
      pendingHeader.length === 0 ? chunk : concatBytes([pendingHeader, chunk]);
    pendingHeader = new Uint8Array(0);
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) {
      if (buffered.length > HEADER_BOUND) {
        run.fatal = new SpectrumCaptureError('protocol', 'helper header line exceeds 256 bytes');
        handshaking = false;
        return;
      }
      pendingHeader = buffered;
      return;
    }
    const headerLine = headerDecoder.decode(buffered.subarray(0, newline));
    headerDecoder.decode(); // reset streaming state
    const carry = buffered.subarray(newline + 1);
    handshaking = false;
    const header = parseHelperHeader(headerLine);
    if (header === null) {
      run.fatal = new SpectrumCaptureError('protocol', 'helper header line is malformed');
      return;
    }
    run.header = header;
    emit({ kind: 'format', format: { sampleRate: header.sampleRate, channels: header.channels, encoding: 'f32le' } });
    if (carry.length > 0) emit({ kind: 'pcm', bytes: carry });
  }).catch((error) => {
    if (run.fatal === null) {
      run.fatal = new SpectrumCaptureError('protocol', `helper stdout failed: ${error}`);
    }
  });
  void readLines(child.stderr, (line) => {
    if (line.startsWith('TUITUNES_ERROR ')) {
      if (run.fatal === null) {
        run.fatal = new SpectrumCaptureError('process', `helper: ${line.slice('TUITUNES_ERROR '.length)}`);
      }
      return;
    }
    if (line.startsWith('TUITUNES_RESTART')) {
      run.restart = true;
      return;
    }
    if (line.startsWith('TUITUNES_STATUS ')) {
      run.lastStatus = line.slice('TUITUNES_STATUS '.length).slice(0, 200);
    }
  }).catch(() => undefined);
  return run;
}

/**
 * Run environment for the CoreAudio adapter. `helperExecutable` is an
 * internal test seam — never wired from user config, environment variables,
 * or the CLI: undefined keeps the normal secure bundle lookup, null pins a
 * missing helper, and a string pins an explicit trusted path. Production
 * callers pass the shared capture env, which leaves it undefined.
 */
interface CoreAudioCaptureEnv {
  spawn: (argv: readonly string[]) => CaptureChild;
  now(): number;
  startupTimeoutMs?: number;
  helperExecutable?: string | null;
}

/** CoreAudio helper capture run with bounded format-change restarts. */
export async function runCoreAudioCapture(
  target: CaptureTarget,
  signal: AbortSignal,
  emit: (event: CaptureEvent) => void,
  env: CoreAudioCaptureEnv,
): Promise<void> {
  if (target.ao !== 'coreaudio') {
    throw new SpectrumCaptureError('unsupported', `CoreAudio capture requires ao=coreaudio, not ${target.ao}`);
  }
  await runCaptureBackend(
    'coreaudio',
    target,
    signal,
    emit,
    { spawn: env.spawn, now: env.now },
    async (ctx) => {
      // Resolve once per run — production defaults, or the pinned seam — and
      // reuse the same trusted path for the probe and every restart.
      const executable =
        env.helperExecutable === undefined ? resolveHelperExecutable() : env.helperExecutable;
      await probeHelperVersion(ctx, executable);
      let restarts = 0;
      for (;;) {
        ctx.throwIfAborted();
        const run = startHelper(ctx.spawn, ctx.target, ctx.emit, executable);
        // Handshake budget: capture/consent startup may take up to 120s.
        const deadline = ctx.now() + ctx.startupMs;
        while (run.header === null && run.fatal === null && !run.exited) {
          ctx.throwIfAborted();
          if (ctx.now() >= deadline) {
            await stopChild(run.child);
            throw new SpectrumCaptureError(
              'process',
              `helper did not deliver a PCM header within ${ctx.startupMs}ms${
                run.lastStatus !== '' ? ` (last status: ${run.lastStatus})` : ''
              }`,
            );
          }
          await sleep(POLL_INTERVAL_MS);
        }
        if (run.fatal !== null) throw run.fatal;
        if (run.exited) {
          if (run.restart && restarts < HELPER_MAX_RESTARTS) {
            restarts++;
            run.live = false;
            await Promise.allSettled([run.stdoutReader ?? Promise.resolve()]);
            emit({ kind: 'reset' });
            continue; // fresh helper/handshake with the renegotiated format
          }
          throw new SpectrumCaptureError('process', `helper exited during startup with code ${run.exitCode}`);
        }

        // Steady state: PCM forwards from the single stdout reader until the
        // helper reports a format restart, an error, or exits.
        while (!run.exited && run.fatal === null && !run.restart) {
          ctx.throwIfAborted();
          await sleep(POLL_INTERVAL_MS);
        }
        ctx.throwIfAborted();
        if (run.fatal !== null) throw run.fatal;
        if (run.restart && restarts < HELPER_MAX_RESTARTS) {
          restarts++;
          run.live = false; // gate off first: no late PCM after teardown
          await stopChild(run.child);
          await Promise.allSettled([run.stdoutReader ?? Promise.resolve()]);
          emit({ kind: 'reset' });
          continue;
        }
        throw new SpectrumCaptureError(
          'process',
          run.restart
            ? `helper restart loop exceeded ${HELPER_MAX_RESTARTS} attempts`
            : `helper exited with code ${run.exitCode}`,
        );
      }
    },
    env.startupTimeoutMs ?? MACOS_CAPTURE_STARTUP_MS,
  );
}

/**
 * Pre-flight the helper protocol without opening a tap or triggering the
 * permission prompt: `--version` must print exactly the marker and exit 0.
 */
async function probeHelperVersion(ctx: CaptureRunContext, executable: string | null): Promise<void> {
  if (executable === null) {
    throw new SpectrumCaptureError(
      'tool-missing',
      `TuiTunesSpectrum.app helper not found (looked for ${HELPER_APP} in native/bin and beside the executable)`,
    );
  }
  const { code, stdout } = await runTool(ctx.env, [executable, '--version']);
  if (code !== 0 || stdout.trim() !== HELPER_VERSION_LINE) {
    throw new SpectrumCaptureError(
      'protocol',
      `helper protocol mismatch: --version exited ${code} with "${stdout.trim().slice(0, 60)}"`,
    );
  }
}
