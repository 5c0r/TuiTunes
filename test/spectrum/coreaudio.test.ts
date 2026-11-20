import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MACOS_CAPTURE_STARTUP_MS,
  parseHelperHeader,
  resolveHelperExecutable,
  runCoreAudioCapture,
} from '../../src/spectrum/coreaudio';
import type { SpectrumCaptureError, CaptureEvent, CaptureTarget } from '../../src/spectrum/types';
import { FakeSpawn, f32le, targetFixture, textToBytes } from './fakes';

const EXECUTABLE = 'tuitunes-spectrum-tap';
const APP = 'TuiTunesSpectrum.app';

// Fixtures live exclusively under throwaway tmpdir sandboxes: the repo's own
// native/bin/TuiTunesSpectrum.app — a developer's real built and signed
// helper on macOS — is never created, overwritten, or deleted by this suite.
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'tunefork-coreaudio-'));
const sentinelRoot = mkdtempSync(path.join(os.tmpdir(), 'tunefork-coreaudio-sentinel-'));

const stagedApp = path.join(sandbox, 'native', 'bin', APP);
const stagedExecutable = path.join(stagedApp, 'Contents', 'MacOS', EXECUTABLE);

// A real-looking helper bundle OUTSIDE the staging sandbox: present and
// executable, but never offered as a candidate, so it must remain untouched.
const sentinelApp = path.join(sentinelRoot, APP);
const sentinelExecutable = path.join(sentinelApp, 'Contents', 'MacOS', EXECUTABLE);
const SENTINEL_PAYLOAD = '#!/bin/sh\n# genuine built helper - never touch\nexit 0\n';

function writeBundleExecutable(appDir: string, payload: string): string {
  const executable = path.join(appDir, 'Contents', 'MacOS', EXECUTABLE);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, payload);
  chmodSync(executable, 0o755);
  return executable;
}

function stageFakeHelper(): void {
  writeBundleExecutable(stagedApp, '#!/bin/sh\nexit 0\n');
}

writeBundleExecutable(sentinelApp, SENTINEL_PAYLOAD);

afterAll(() => {
  // Clean only the test-created scratch roots — never the repo tree.
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(sentinelRoot, { recursive: true, force: true });
});

// The adapter advances via real sleep()/Date.now() polling and surfaces
// progress only through the captured emit array, so awaiting the condition
// (never a fixed delay) is the closest thing to a deterministic signal.
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached within deadline');
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

function target(): CaptureTarget {
  return targetFixture({ ao: 'coreaudio' });
}

/** Every capture run pins the helper explicitly: staged path, or null. */
function captureEnv(
  spawn: FakeSpawn['spawn'],
  helperExecutable: string | null,
  startupTimeoutMs: number,
) {
  return { spawn, now: () => Date.now(), startupTimeoutMs, helperExecutable };
}

describe('parseHelperHeader', () => {
  test('accepts the exact ordered protocol and validates ranges', () => {
    expect(parseHelperHeader('TUITUNES_PCM 1 48000 2 F32LE')).toEqual({
      sampleRate: 48_000,
      channels: 2,
    });
    expect(parseHelperHeader('TUITUNES_PCM 2 48000 2 F32LE')).toBeNull(); // wrong version
    expect(parseHelperHeader('TUITUNES_PCM 1 4000 2 F32LE')).toBeNull(); // rate too low
    expect(parseHelperHeader('TUITUNES_PCM 1 48000 9 F32LE')).toBeNull(); // channels too many
    expect(parseHelperHeader('TUITUNES_PCM 1 48000 2 S16LE')).toBeNull(); // wrong encoding
    expect(parseHelperHeader('garbage')).toBeNull();
  });
});

describe('resolveHelperExecutable', () => {
  test('finds the executable inside an explicit candidate app bundle', () => {
    stageFakeHelper();
    expect(resolveHelperExecutable([stagedApp])).toBe(stagedExecutable);
  });

  test('scans candidates in order and takes the first executable', () => {
    stageFakeHelper();
    const alternateApp = path.join(sandbox, 'alternate', APP);
    const alternateExecutable = writeBundleExecutable(alternateApp, '#!/bin/sh\nexit 0\n');
    expect(resolveHelperExecutable([stagedApp, alternateApp])).toBe(stagedExecutable);
    expect(resolveHelperExecutable([path.join(sandbox, 'nowhere'), alternateApp])).toBe(
      alternateExecutable,
    );
  });

  test('missing helper resolves to null (never PATH lookup)', () => {
    // The sentinel is a valid executable bundle elsewhere; only the given
    // candidate dirs are consulted, so it can never leak in.
    expect(resolveHelperExecutable([path.join(sandbox, 'nowhere')])).toBeNull();
  });
});

describe('runCoreAudioCapture', () => {
  test('missing helper is a typed tool-missing failure', async () => {
    const events: CaptureEvent[] = [];
    const controller = new AbortController();
    const failure = await runCoreAudioCapture(
      target(),
      controller.signal,
      (event) => events.push(event),
      captureEnv(new FakeSpawn().spawn, null, 200),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('tool-missing');
    expect(events).toEqual([]);
  });

  test('version probe gates the protocol before any tap starts', async () => {
    stageFakeHelper();
    const spawn = new FakeSpawn();
    spawn.onSpawn = (child) => {
      if (child.argv[1] === '--version') {
        child.pushStdout('SOME_OTHER_TOOL 9\n');
        child.exit(0);
      }
    };
    const events: CaptureEvent[] = [];
    const controller = new AbortController();
    const failure = await runCoreAudioCapture(
      target(),
      controller.signal,
      (event) => events.push(event),
      captureEnv(spawn.spawn, stagedExecutable, 300),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('protocol');
    expect(spawn.children).toHaveLength(1); // only the --version probe ran
  });

  test('ordered header then PCM forwarding, restart handshake, abort drain', async () => {
    stageFakeHelper();
    const spawn = new FakeSpawn();
    spawn.onSpawn = (child) => {
      if (child.argv[1] === '--version') {
        child.pushStdout('TUITUNES_SPECTRUM_HELPER 1\n');
        child.exit(0);
        return;
      }
      // Tap helper: exact executable launched with pid and client name only.
      child.pushStdout('TUITUNES_PCM 1 48000 2 F32LE\n');
      child.pushStdout(textToBytes('pcm-frame'));
    };
    const events: CaptureEvent[] = [];
    const controller = new AbortController();
    const run = runCoreAudioCapture(target(), controller.signal, (event) => events.push(event), {
      spawn: spawn.spawn,
      now: () => Date.now(),
      startupTimeoutMs: 1_000,
      helperExecutable: stagedExecutable,
    });
    await until(() => events.some((event) => event.kind === 'format'));
    const helper = spawn.byBinary(stagedExecutable).find((child) => child.argv[1] !== '--version');
    expect(helper?.argv).toEqual([stagedExecutable, '4242', 'TuiTunes-test-client']);
    await until(() => events.some((event) => event.kind === 'pcm'));

    // Format change: helper exits cleanly with a restart marker; the parent
    // relaunches and re-handshakes rather than reusing the old stride.
    helper?.pushStderr('TUITUNES_RESTART format-change\n');
    helper?.exit(0);
    await until(() => events.filter((event) => event.kind === 'reset').length === 1);
    await until(() => spawn.byBinary(stagedExecutable).length === 3); // probe + 2 taps
    await until(() => events.filter((event) => event.kind === 'format').length === 2);

    controller.abort();
    await expect(run).resolves.toBeUndefined();
  }, 10_000);

  test('fatal helper diagnostics surface as process errors', async () => {
    stageFakeHelper();
    const spawn = new FakeSpawn();
    spawn.onSpawn = (child) => {
      if (child.argv[1] === '--version') {
        child.pushStdout('TUITUNES_SPECTRUM_HELPER 1\n');
        child.exit(0);
        return;
      }
      child.pushStderr('TUITUNES_ERROR AudioHardwareCreateProcessTap failed (OSStatus -609)\n');
      child.exit(4);
    };
    const events: CaptureEvent[] = [];
    const controller = new AbortController();
    const failure = await runCoreAudioCapture(
      target(),
      controller.signal,
      (event) => events.push(event),
      captureEnv(spawn.spawn, stagedExecutable, 500),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('process');
    expect((failure as SpectrumCaptureError).message).toContain('OSStatus -609');
  });

  test('startup budget honors the 120s macOS consent default', () => {
    expect(MACOS_CAPTURE_STARTUP_MS).toBe(120_000);
  });
});

test('non-UTF8 PCM in the header chunk is forwarded byte-exact', async () => {
  stageFakeHelper();
  const spawn = new FakeSpawn();
  const pcm = f32le([0.5, -0.9, Number.NaN, 123.5, -0.0001]);
  spawn.onSpawn = (child) => {
    if (child.argv[1] === '--version') {
      child.pushStdout('TUITUNES_SPECTRUM_HELPER 1\n');
      child.exit(0);
      return;
    }
    const header = new TextEncoder().encode('TUITUNES_PCM 1 48000 2 F32LE\n');
    const joined = new Uint8Array(header.length + pcm.length);
    joined.set(header, 0);
    joined.set(pcm, header.length);
    child.pushStdout(joined);
  };
  const events: CaptureEvent[] = [];
  const controller = new AbortController();
  const run = runCoreAudioCapture(target(), controller.signal, (event) => events.push(event), {
    spawn: spawn.spawn,
    now: () => Date.now(),
    startupTimeoutMs: 1_000,
    helperExecutable: stagedExecutable,
  });
  await until(() => events.some((event) => event.kind === 'pcm'));
  controller.abort();
  await run.then(
    () => undefined,
    () => undefined,
  );
  const forwarded = events.find((event) => event.kind === 'pcm');
  expect(forwarded).toEqual({ kind: 'pcm', bytes: pcm }); // byte-exact suffix
}, 10_000);

test('a real-looking app outside the sandbox is never touched', async () => {
  const before = statSync(sentinelExecutable);
  stageFakeHelper();
  const spawn = new FakeSpawn();
  spawn.onSpawn = (child) => {
    if (child.argv[1] === '--version') {
      child.pushStdout('TUITUNES_SPECTRUM_HELPER 1\n');
      child.exit(0);
      return;
    }
    child.pushStdout('TUITUNES_PCM 1 48000 2 F32LE\n');
  };
  const events: CaptureEvent[] = [];
  const controller = new AbortController();
  const run = runCoreAudioCapture(target(), controller.signal, (event) => events.push(event), {
    spawn: spawn.spawn,
    now: () => Date.now(),
    startupTimeoutMs: 1_000,
    helperExecutable: stagedExecutable,
  });
  await until(() => events.some((event) => event.kind === 'format'));
  controller.abort();
  await run.then(
    () => undefined,
    () => undefined,
  );

  // The whole run stayed inside the sandbox: only the staged executable was
  // ever resolved or spawned, and the sentinel bundle elsewhere is untouched
  // — same mode, same mtime, byte-identical payload.
  expect(spawn.children.every((child) => child.argv[0] === stagedExecutable)).toBe(true);
  expect(resolveHelperExecutable([stagedApp])).not.toBe(sentinelExecutable);
  expect(existsSync(sentinelExecutable)).toBe(true);
  const after = statSync(sentinelExecutable);
  expect(after.mode).toBe(before.mode);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(readFileSync(sentinelExecutable, 'utf8')).toBe(SENTINEL_PAYLOAD);
}, 10_000);

test('the native helper protocol is stereo-only', () => {
  expect(parseHelperHeader('TUITUNES_PCM 1 48000 1 F32LE')).toBeNull();
  expect(parseHelperHeader('TUITUNES_PCM 1 48000 6 F32LE')).toBeNull();
});
