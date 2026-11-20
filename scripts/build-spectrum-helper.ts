#!/usr/bin/env bun
/**
 * Build the universal TuiTunesSpectrum.app helper bundle (feature 15).
 *
 * macOS only: compiles native/macos/spectrum-tap.mm for arm64 and x86_64 with
 * xcrun/clang++, merges them with lipo, assembles
 * native/bin/TuiTunesSpectrum.app (executable name tuitunes-spectrum-tap,
 * Info.plist with the audio-capture usage string), ad-hoc codesigns, and
 * verifies the signature and architectures. No downloads, no postinstall
 * compilation, no Developer-ID assumptions. Linux development never runs it.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const BUNDLE_ID = 'io.github.5c0r.tuitunes.spectrum';
const EXECUTABLE_NAME = 'tuitunes-spectrum-tap';
const APP_NAME = 'TuiTunesSpectrum.app';
const DEPLOYMENT_TARGET = '14.2';

const root = path.resolve(import.meta.dir, '..');
const sourceDir = path.join(root, 'native', 'macos');
const sourceFile = path.join(sourceDir, 'spectrum-tap.mm');
const outApp = path.join(root, 'native', 'bin', APP_NAME);

class BuildFailure extends Error {}

function run(cmd: string, args: readonly string[], label: string): string {
  const proc = Bun.spawnSync({ cmd: [cmd, ...args], stdout: 'pipe', stderr: 'pipe' });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) {
    throw new BuildFailure(`${label} failed (${cmd} exit ${proc.exitCode}):\n${stderr.trim()}`);
  }
  return `${stdout}${stderr}`;
}

function usage(): never {
  console.error('usage: bun scripts/build-spectrum-helper.ts [--debug] [--archs arm64,x86_64]');
  process.exit(64);
}

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const archIndex = args.indexOf('--archs');
const archs = archIndex >= 0 ? (args[archIndex + 1] ?? '').split(',').filter(Boolean) : ['arm64', 'x86_64'];
const knownFlags: Record<string, true> = { '--debug': true, '--archs': true };
for (let i = 0; i < args.length; i++) {
  if (!knownFlags[args[i]] && i !== archIndex + 1) usage();
}
if (archs.length === 0) usage();
if (process.platform !== 'darwin') {
  console.error(
    `build-spectrum-helper requires the macOS toolchain (xcrun/clang++/lipo/codesign); refusing on ${process.platform}. ` +
      'Linux development and CI never need the helper.',
  );
  process.exit(1);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'tuitunes-spectrum-build-'));
try {
  const slices: string[] = [];
  for (const arch of archs) {
    const slice = path.join(scratch, `spectrum-tap-${arch}`);
    const flags = [
      '-std=c++17',
      '-arch',
      arch,
      `-mmacosx-version-min=${DEPLOYMENT_TARGET}`,
      ...(debug ? ['-O0', '-g'] : ['-O2', '-DNDEBUG']),
      '-fobjc-arc',
      '-Wall',
      '-Wextra',
      `-I${sourceDir}`,
      sourceFile,
      '-framework',
      'CoreAudio',
      '-framework',
      'CoreFoundation',
      '-framework',
      'Foundation',
      '-o',
      slice,
    ];
    run('xcrun', ['--sdk', 'macosx', 'clang++', ...flags], `building spectrum-tap.mm for ${arch}`);
    slices.push(slice);
  }

  const universal = path.join(scratch, EXECUTABLE_NAME);
  if (slices.length === 1) {
    copyFileSync(slices[0], universal);
  } else {
    run('lipo', ['-create', ...slices, '-output', universal], 'lipo universal merge');
  }

  const stagedApp = path.join(scratch, APP_NAME);
  const contents = path.join(stagedApp, 'Contents');
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  copyFileSync(universal, path.join(contents, 'MacOS', EXECUTABLE_NAME));
  chmodSync(path.join(contents, 'MacOS', EXECUTABLE_NAME), 0o755);
  copyFileSync(path.join(sourceDir, 'Info.plist'), path.join(contents, 'Info.plist'));
  await Bun.write(path.join(contents, 'PkgInfo'), 'APPL????');

  // Ad-hoc signature: verifiable integrity for development/OSS artifacts; this
  // is explicitly NOT a Developer-ID/notarization claim, and nothing here
  // touches Gatekeeper or the user's TCC database.
  run('codesign', ['--sign', '-', '--force', '--timestamp=none', stagedApp], 'ad-hoc codesign');
  run('codesign', ['--verify', '--strict', '--verbose=2', stagedApp], 'codesign verification');
  const info = run('lipo', ['-info', path.join(contents, 'MacOS', EXECUTABLE_NAME)], 'lipo -info').trim();
  const plist = run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(contents, 'Info.plist')], 'bundle id check').trim();
  if (plist !== BUNDLE_ID) {
    throw new BuildFailure(`unexpected bundle identifier ${plist}`);
  }
  const usageKey = run(
    'plutil',
    ['-extract', 'NSAudioCaptureUsageDescription', 'raw', path.join(contents, 'Info.plist')],
    'usage description check',
  ).trim();
  if (usageKey.length === 0) {
    throw new BuildFailure('Info.plist lacks NSAudioCaptureUsageDescription');
  }

  rmSync(outApp, { recursive: true, force: true });
  mkdirSync(path.dirname(outApp), { recursive: true });
  Bun.spawnSync({ cmd: ['cp', '-R', stagedApp, outApp] });
  chmodSync(path.join(outApp, 'Contents', 'MacOS', EXECUTABLE_NAME), 0o755);

  const executablePath = path.join(outApp, 'Contents', 'MacOS', EXECUTABLE_NAME);
  const bytes = statSync(executablePath).size;
  const executable = new Uint8Array(await Bun.file(executablePath).arrayBuffer());
  const sha256 = createHash('sha256').update(executable).digest('hex');
  console.log(`built ${outApp}`);
  console.log(`  executable: Contents/MacOS/${EXECUTABLE_NAME} (${bytes} bytes)`);
  console.log(`  archs: ${info}`);
  console.log(`  sha256: ${sha256}`);
  console.log('  signature: ad-hoc (verified); NOT Developer-ID notarized');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
