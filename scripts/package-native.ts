#!/usr/bin/env bun
/**
 * Native release packaging for the macOS spectrum helper and standalone builds.
 *
 * Subcommands:
 *   helper   Stage `native/bin/TuiTunesSpectrum.app` (as produced by
 *            `bun run build:spectrum-helper`) into a tar artifact that
 *            preserves executable modes and any ad-hoc signature, for npm
 *            staging and for the release workflow.
 *   archive  Stage `dist/tuimusic` and `TuiTunesSpectrum.app` adjacent in a
 *            fresh `tui-tunes-darwin-<arch>.tar.gz` for direct download.
 *
 * Both subcommands write into `--out` (default `<repo>/artifacts`):
 * the tar archive, a `*.sha256` sidecar compatible with `sha256sum -c`, and a
 * JSON manifest recording the source commit SHA plus archive/helper digests.
 *
 * Staging happens in a fresh `os.tmpdir()` directory, never inside the
 * checkout. All paths resolve from the script location (repository root),
 * never from the process working directory, and no lookup goes through PATH.
 * Packaging performs no audio capture, no consent flow, and never executes
 * the helper.
 */
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const HELPER_APP_DIR = 'TuiTunesSpectrum.app';
export const HELPER_APP_RELATIVE_PATH = 'native/bin/TuiTunesSpectrum.app';
export const HELPER_EXECUTABLE_RELATIVE_PATH = 'Contents/MacOS/tuitunes-spectrum-tap';
export const HELPER_INFO_PLIST_RELATIVE_PATH = 'Contents/Info.plist';
export const HELPER_SIGNATURE_RELATIVE_PATH = 'Contents/_CodeSignature/CodeResources';
export const HELPER_BUNDLE_ID = 'io.github.5c0r.tuitunes.spectrum';
export const HELPER_USAGE_DESCRIPTION_KEY = 'NSAudioCaptureUsageDescription';
export const PLAYER_BINARY_NAME = 'tuimusic';
export const HELPER_ARCHIVE_NAME = 'tuitunes-spectrum-helper.tar.gz';
export const DARWIN_ARCHES = ['arm64', 'x64'] as const;
export type DarwinArch = (typeof DARWIN_ARCHES)[number];

export class PackagingError extends Error {}

/** Shared descriptor recorded in every manifest and compared at release time. */
export interface HelperDescriptor {
  appPath: string;
  bundleId: string;
  executableRelativePath: string;
  executableSha256: string;
  bundleDigest: string;
  signaturePresent: boolean;
}

export interface NativeArchiveManifest {
  schema: 1;
  kind: 'archive' | 'helper';
  arch: DarwinArch | null;
  sourceSha: string;
  createdAt: string;
  archive: { name: string; sha256: string };
  player: { name: string; sha256: string } | null;
  helper: HelperDescriptor;
}

export interface ArchiveOptions {
  arch: DarwinArch;
  binaryPath: string;
  helperPath: string;
  outDir: string;
  sourceSha: string;
  createdAt?: string;
}

export interface HelperOptions {
  helperPath: string;
  outDir: string;
  sourceSha: string;
  createdAt?: string;
}

export interface HelperBundleInfo {
  appPath: string;
  bundleId: string;
  executablePath: string;
  signaturePresent: boolean;
}

/**
 * Resolve the repository root from an explicit starting directory so behavior
 * never depends on the process working directory. `from` must be (or be
 * inside) the checkout that contains `package.json` and this script.
 */
export function resolveRepoRoot(from: string): string {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'scripts', 'package-native.ts'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new PackagingError(
        `no repository root found above ${resolve(from)} (expected package.json + scripts/package-native.ts)`,
      );
    }
    current = parent;
  }
}

function isExecutableFile(path: string): boolean {
  if (!statSync(path).isFile()) return false;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return false;
  }
  return true;
}

/** A compiled player binary must exist and keep its executable mode. */
export function validatePlayerBinary(binaryPath: string): void {
  if (!existsSync(binaryPath)) {
    throw new PackagingError(`player binary not found: ${binaryPath} (run "bun run build" first)`);
  }
  if (!isExecutableFile(binaryPath)) {
    throw new PackagingError(`player binary is not an executable file: ${binaryPath}`);
  }
}

/**
 * Validate the helper .app bundle: executable present with its mode, purpose
 * string and bundle ID in Info.plist. Signature presence is recorded, not
 * required: development artifacts are ad-hoc signed, never claimed as
 * Developer-ID trusted.
 */
export function inspectHelperBundle(appPath: string): HelperBundleInfo {
  if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
    throw new PackagingError(
      `helper app bundle not found: ${appPath} (run "bun run build:spectrum-helper" first)`,
    );
  }
  const executablePath = join(appPath, HELPER_EXECUTABLE_RELATIVE_PATH);
  if (!existsSync(executablePath)) {
    throw new PackagingError(`helper executable missing: ${executablePath}`);
  }
  if (!isExecutableFile(executablePath)) {
    throw new PackagingError(`helper executable is not an executable file: ${executablePath}`);
  }
  const infoPlistPath = join(appPath, HELPER_INFO_PLIST_RELATIVE_PATH);
  if (!existsSync(infoPlistPath) || !statSync(infoPlistPath).isFile()) {
    throw new PackagingError(`helper Info.plist missing: ${infoPlistPath}`);
  }
  const plist = readFileSync(infoPlistPath, 'utf8');
  if (!plist.includes(`<string>${HELPER_BUNDLE_ID}</string>`)) {
    throw new PackagingError(`helper Info.plist does not declare bundle id ${HELPER_BUNDLE_ID}: ${infoPlistPath}`);
  }
  if (!plist.includes(HELPER_USAGE_DESCRIPTION_KEY)) {
    throw new PackagingError(
      `helper Info.plist is missing the ${HELPER_USAGE_DESCRIPTION_KEY} purpose string: ${infoPlistPath}`,
    );
  }
  return {
    appPath,
    bundleId: HELPER_BUNDLE_ID,
    executablePath,
    signaturePresent: existsSync(join(appPath, HELPER_SIGNATURE_RELATIVE_PATH)),
  };
}

/** SHA-256 of a file, streamed so large archives stay memory-bounded. */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest('hex');
}

type BundleEntry =
  | { rel: string; kind: 'file'; mode: number }
  | { rel: string; kind: 'dir' }
  | { rel: string; kind: 'link'; target: string };

function collectBundleEntries(appPath: string, prefix = ''): BundleEntry[] {
  const entries: BundleEntry[] = [];
  for (const dirent of readdirSync(join(appPath, prefix), { withFileTypes: true }).sort(byName)) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isSymbolicLink()) {
      entries.push({ rel, kind: 'link', target: readlinkSync(join(appPath, rel)) });
    } else if (dirent.isDirectory()) {
      entries.push({ rel, kind: 'dir' });
      entries.push(...collectBundleEntries(appPath, rel));
    } else if (dirent.isFile()) {
      entries.push({ rel, kind: 'file', mode: statSync(join(appPath, rel)).mode & 0o777 });
    } else {
      throw new PackagingError(`unsupported helper bundle entry type: ${rel}`);
    }
  }
  return entries;
}

/** Locale-free name ordering so digests are stable across machines. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Deterministic digest over the whole bundle (sorted paths, modes, contents) so
 * release verification can compare the universal helper across artifacts even
 * after tar metadata differences.
 */
export async function bundleDigest(appPath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const entry of collectBundleEntries(appPath)) {
    if (entry.kind === 'file') {
      hasher.update(`${entry.rel}\0${entry.mode.toString(8)}\0${await sha256File(join(appPath, entry.rel))}\n`);
    } else if (entry.kind === 'dir') {
      hasher.update(`${entry.rel}\0dir\n`);
    } else {
      hasher.update(`${entry.rel}\0link\0${entry.target}\n`);
    }
  }
  return hasher.digest('hex');
}

/** Recursively copy a file/tree preserving modes and symlinks. */
function copyTreePreservingMode(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  if (stat.isFile()) {
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode & 0o777);
    return;
  }
  if (!stat.isDirectory()) {
    throw new PackagingError(`cannot stage non-regular entry: ${source}`);
  }
  mkdirSync(destination);
  chmodSync(destination, stat.mode & 0o777);
  for (const dirent of readdirSync(source, { withFileTypes: true }).sort(byName)) {
    copyTreePreservingMode(join(source, dirent.name), join(destination, dirent.name));
  }
}

/** Create a gzip tar from `cwd`; AppleDouble metadata stays out on macOS. */
function runTar(cwd: string, archivePath: string, entries: string[]): void {
  const result = Bun.spawnSync(['tar', '-czf', archivePath, ...entries], {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new PackagingError(`tar failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
}

/** `sha256sum -c`-compatible sidecar: `<digest>  <name>`. */
function writeChecksumSidecar(archivePath: string, name: string, sha256: string): void {
  writeFileSync(`${archivePath}.sha256`, `${sha256}  ${name}\n`);
}

function writeManifest(outDir: string, fileName: string, manifest: NativeArchiveManifest): void {
  writeFileSync(join(outDir, fileName), `${JSON.stringify(sortKeys(manifest), null, 2)}\n`);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

async function helperDescriptor(appPath: string): Promise<HelperDescriptor> {
  const info = inspectHelperBundle(appPath);
  return {
    appPath: HELPER_APP_DIR,
    bundleId: info.bundleId,
    executableRelativePath: HELPER_EXECUTABLE_RELATIVE_PATH,
    executableSha256: await sha256File(info.executablePath),
    bundleDigest: await bundleDigest(appPath),
    signaturePresent: info.signaturePresent,
  };
}

/**
 * Stage `dist/tuimusic` and the helper .app adjacent in a fresh archive named
 * `tui-tunes-darwin-<arch>.tar.gz`; both sit at the archive root so the
 * runtime resolves the bundle beside the standalone executable.
 */
export async function createDarwinArchive(options: ArchiveOptions): Promise<NativeArchiveManifest> {
  if (!DARWIN_ARCHES.includes(options.arch)) {
    throw new PackagingError(`unsupported darwin arch: ${options.arch} (expected ${DARWIN_ARCHES.join(' or ')})`);
  }
  validatePlayerBinary(options.binaryPath);
  const descriptor = await helperDescriptor(options.helperPath);

  const staging = mkdtempSync(join(tmpdir(), 'tui-tunes-archive-'));
  try {
    copyTreePreservingMode(resolve(options.binaryPath), join(staging, PLAYER_BINARY_NAME));
    copyTreePreservingMode(resolve(options.helperPath), join(staging, HELPER_APP_DIR));
    mkdirSync(options.outDir, { recursive: true });
    const archiveName = `tui-tunes-darwin-${options.arch}.tar.gz`;
    const archivePath = join(options.outDir, archiveName);
    runTar(staging, archivePath, [PLAYER_BINARY_NAME, HELPER_APP_DIR]);
    const manifest: NativeArchiveManifest = {
      schema: 1,
      kind: 'archive',
      arch: options.arch,
      sourceSha: options.sourceSha,
      createdAt: options.createdAt ?? new Date().toISOString(),
      archive: { name: archiveName, sha256: await sha256File(archivePath) },
      player: { name: PLAYER_BINARY_NAME, sha256: await sha256File(join(staging, PLAYER_BINARY_NAME)) },
      helper: descriptor,
    };
    writeChecksumSidecar(archivePath, archiveName, manifest.archive.sha256);
    writeManifest(options.outDir, `native-release-${options.arch}.json`, manifest);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Stage the helper .app under its npm-staging path `native/bin/...`. */
export async function createHelperArtifact(options: HelperOptions): Promise<NativeArchiveManifest> {
  const descriptor = await helperDescriptor(options.helperPath);
  const staging = mkdtempSync(join(tmpdir(), 'tui-tunes-helper-'));
  try {
    copyTreePreservingMode(resolve(options.helperPath), join(staging, HELPER_APP_RELATIVE_PATH));
    mkdirSync(options.outDir, { recursive: true });
    const archivePath = join(options.outDir, HELPER_ARCHIVE_NAME);
    runTar(staging, archivePath, ['native']);
    const manifest: NativeArchiveManifest = {
      schema: 1,
      kind: 'helper',
      arch: null,
      sourceSha: options.sourceSha,
      createdAt: options.createdAt ?? new Date().toISOString(),
      archive: { name: HELPER_ARCHIVE_NAME, sha256: await sha256File(archivePath) },
      player: null,
      helper: descriptor,
    };
    writeChecksumSidecar(archivePath, HELPER_ARCHIVE_NAME, manifest.archive.sha256);
    writeManifest(options.outDir, 'native-release-helper.json', manifest);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Candidate source commit: explicit flag, then the CI-provided SHA, then the
 * local checkout. Git runs with the resolved repository root as cwd, never the
 * caller's working directory.
 */
export function determineSourceSha(repoRoot: string, override?: string): string {
  if (override !== undefined) {
    if (!SHA_PATTERN.test(override)) {
      throw new PackagingError(`--source-sha must be a 40-hex commit sha (got "${override}")`);
    }
    return override;
  }
  const envSha = process.env.GITHUB_SHA;
  if (envSha !== undefined && SHA_PATTERN.test(envSha)) return envSha;
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sha = git.exitCode === 0 ? git.stdout.toString().trim() : '';
  if (SHA_PATTERN.test(sha)) return sha;
  throw new PackagingError('cannot determine source commit SHA; pass --source-sha <40-hex-sha>');
}

function usage(): string {
  return [
    'usage:',
    '  bun scripts/package-native.ts helper [--helper <path>] [--out <dir>] [--source-sha <sha>]',
    '  bun scripts/package-native.ts archive --arch arm64|x64 [--binary <path>] [--helper <path>] [--out <dir>] [--source-sha <sha>]',
    '',
    'defaults (resolved from the repository root, never the working directory):',
    `  --helper  ${HELPER_APP_RELATIVE_PATH}`,
    `  --binary  dist/${PLAYER_BINARY_NAME}`,
    '  --out     artifacts',
    '',
    'outputs: <archive>.tar.gz, <archive>.tar.gz.sha256, native-release-{arm64,x64,helper}.json',
  ].join('\n');
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new PackagingError(`unexpected argument: ${arg}\n\n${usage()}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new PackagingError(`missing value for --${arg.slice(2)}\n\n${usage()}`);
    }
    flags.set(arg.slice(2), value);
    index++;
  }
  return flags;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'helper' && command !== 'archive') {
    process.stderr.write(usage());
    return 2;
  }
  const repoRoot = resolveRepoRoot(import.meta.dir);
  const flags = parseFlags(rest);
  const outDir = resolve(repoRoot, flags.get('out') ?? 'artifacts');
  const helperPath = resolve(repoRoot, flags.get('helper') ?? HELPER_APP_RELATIVE_PATH);
  const sourceSha = determineSourceSha(repoRoot, flags.get('source-sha'));

  if (command === 'helper') {
    const manifest = await createHelperArtifact({ helperPath, outDir, sourceSha });
    process.stdout.write(
      `helper artifact: ${join(outDir, manifest.archive.name)} (sha256 ${manifest.archive.sha256})\n` +
        `manifest: ${join(outDir, 'native-release-helper.json')} (source ${sourceSha.slice(0, 12)})\n`,
    );
    return 0;
  }

  const arch = flags.get('arch');
  if (arch !== 'arm64' && arch !== 'x64') {
    process.stderr.write(`--arch must be arm64 or x64 (got ${arch ?? 'nothing'})\n\n${usage()}`);
    return 2;
  }
  const binaryPath = resolve(repoRoot, flags.get('binary') ?? `dist/${PLAYER_BINARY_NAME}`);
  const manifest = await createDarwinArchive({ arch, binaryPath, helperPath, outDir, sourceSha });
  process.stdout.write(
    `darwin ${arch} archive: ${join(outDir, manifest.archive.name)} (sha256 ${manifest.archive.sha256})\n` +
      `manifest: ${join(outDir, `native-release-${arch}.json`)} (source ${sourceSha.slice(0, 12)})\n`,
  );
  return 0;
}

if (import.meta.main) {
  // exitCode (not process.exit) so stdout/stderr writes flush before exit.
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`packaging failed: ${error instanceof PackagingError ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
