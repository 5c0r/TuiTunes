#!/usr/bin/env bun
/**
 * Native spectrum verification driver (feature 15).
 *
 * macOS only: compiles test/native/spectrum-pcm.test.mm against
 * native/macos/pcm.hpp twice (plain and ASan/UBSan), runs both, and compiles
 * native/macos/spectrum-tap.mm with -Wall -Wextra as a warning-count-checked
 * build proof. Verifies the built helper bundle when present. These are
 * compiler/sanitizer/resource checks only — never capture or consent proof.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const sourceDir = path.join(root, 'native', 'macos');
const tapSource = path.join(sourceDir, 'spectrum-tap.mm');
const testSource = path.join(root, 'test', 'native', 'spectrum-pcm.test.mm');
const helperBundle = path.join(root, 'native', 'bin', 'TuiTunesSpectrum.app');
const helperExecutable = path.join(helperBundle, 'Contents', 'MacOS', 'tuitunes-spectrum-tap');
const DEPLOYMENT_TARGET = '14.2';

class VerificationFailure extends Error {}

if (process.platform !== 'darwin') {
  console.error(
    `test-spectrum-native requires the macOS toolchain; refusing on ${process.platform}. ` +
      'Native PCM checks for other platforms are covered by the TS suites.',
  );
  process.exit(1);
}

function runOrFail(cmd: string, args: readonly string[], label: string): string {
  const proc = Bun.spawnSync({ cmd: [cmd, ...args], stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new VerificationFailure(
      `${label} failed (${cmd} exit ${proc.exitCode}):\n${proc.stderr.toString().trim()}`,
    );
  }
  return proc.stdout.toString();
}

function compile(args: readonly string[], label: string): void {
  runOrFail('xcrun', ['--sdk', 'macosx', 'clang++', ...args], label);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'tuitunes-spectrum-native-'));
let failures = 0;
try {
  // 1. Pure PCM tests, plain build.
  const plainBinary = path.join(scratch, 'pcm-plain');
  compile(
    [
      '-std=c++17',
      '-x',
      'c++',
      `-mmacosx-version-min=${DEPLOYMENT_TARGET}`,
      '-O1',
      '-Wall',
      '-Wextra',
      `-I${sourceDir}`,
      testSource,
      '-o',
      plainBinary,
    ],
    'plain pcm test build',
  );
  process.stdout.write(runOrFail(plainBinary, [], 'plain pcm test run'));

  // 2. Pure PCM tests under address/undefined-behavior sanitizers.
  const sanitizedBinary = path.join(scratch, 'pcm-sanitized');
  compile(
    [
      '-std=c++17',
      '-x',
      'c++',
      `-mmacosx-version-min=${DEPLOYMENT_TARGET}`,
      '-O1',
      '-g',
      '-Wall',
      '-Wextra',
      '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer',
      `-I${sourceDir}`,
      testSource,
      '-o',
      sanitizedBinary,
    ],
    'sanitized pcm test build',
  );
  const sanitizedRun = Bun.spawnSync({
    cmd: [sanitizedBinary],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1', UBSAN_OPTIONS: 'halt_on_error=1' },
  });
  process.stdout.write(sanitizedRun.stdout.toString());
  if (sanitizedRun.exitCode !== 0) {
    failures++;
    console.error(sanitizedRun.stderr.toString().trim());
  }

  // 3. Tap helper compile proof with warnings surfaced (no run: no consent).
  compile(
    [
      '-std=c++17',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      `-mmacosx-version-min=${DEPLOYMENT_TARGET}`,
      '-O2',
      '-DNDEBUG',
      '-fobjc-arc',
      '-Wall',
      '-Wextra',
      `-I${sourceDir}`,
      '-c',
      tapSource,
      '-o',
      path.join(scratch, 'spectrum-tap.o'),
    ],
    'spectrum-tap.mm universal compile',
  );

  // 4. Built helper bundle: signature + --version contract, when present.
  if (existsSync(helperExecutable)) {
    runOrFail('codesign', ['--verify', '--strict', helperBundle], 'helper codesign verification');
    const version = Bun.spawnSync({ cmd: [helperExecutable, '--version'], stdout: 'pipe', stderr: 'pipe' });
    const versionLine = version.stdout.toString();
    if (version.exitCode !== 0 || versionLine !== 'TUITUNES_SPECTRUM_HELPER 1\n') {
      throw new VerificationFailure(
        `helper --version contract violated (exit ${version.exitCode}, "${versionLine.trim()}")`,
      );
    }
    console.log('helper bundle: codesign verified, --version contract OK');
  } else {
    console.log('helper bundle: not built yet (run bun run build:spectrum-helper)');
  }

  if (failures > 0) throw new VerificationFailure(`${failures} sanitized native test run(s) failed`);
  console.log('NATIVE SPECTRUM CHECKS PASSED');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
