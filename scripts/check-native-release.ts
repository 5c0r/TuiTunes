#!/usr/bin/env bun
/**
 * Fail-closed prepublish verification for the native-audio release.
 *
 * Read-only checks performed before semantic-release may publish:
 *   1. The GitHub environment (default `native-audio-release`) really has a
 *      required-reviewer protection rule with at least one reviewer. This
 *      script never creates environments, protection rules or secrets; missing
 *      or unverifiable protection is a failure, not a warning.
 *   2. The CI workflow run that produced the candidate artifacts completed
 *      successfully, was triggered by a push (not a PR), ran in this same
 *      repository (not a fork), and its head SHA equals the candidate SHA.
 *   3. The checked-out HEAD equals the candidate SHA.
 *   4. Every required artifact is present; archive/helper digests match both
 *      the `*.sha256` sidecars and the packaging manifests; all manifests
 *      record the same source SHA; the universal helper identity is identical
 *      across every manifest.
 *   5. Archive tar structure keeps `tuimusic` and the helper .app adjacent
 *      with executable modes intact and no AppleDouble pollution.
 *
 * Exit code is 0 only when every check passes. Any HTTP error, missing file,
 * or malformed record fails the run. This is not audio proof: macOS/WSLg
 * acceptance is a human record the required reviewer checks before approving
 * the environment.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DARWIN_ARCHES,
  HELPER_APP_DIR,
  HELPER_APP_RELATIVE_PATH,
  PackagingError,
  PLAYER_BINARY_NAME,
  bundleDigest,
  inspectHelperBundle,
  type NativeArchiveManifest,
  resolveRepoRoot,
  sha256File,
} from './package-native';

export const REQUIRED_ENVIRONMENT = 'native-audio-release';
export const CI_WORKFLOW_NAME = 'CI';
export const HELPER_ARCHIVE_NAME = 'tuitunes-spectrum-helper.tar.gz';
export const HELPER_EXECUTABLE_ARCHIVE_PATH = `${HELPER_APP_DIR}/Contents/MacOS/tuitunes-spectrum-tap`;
export const HELPER_INFO_PLIST_ARCHIVE_PATH = `${HELPER_APP_DIR}/Contents/Info.plist`;
export const HELPER_NPM_EXECUTABLE_ARCHIVE_PATH = `native/bin/${HELPER_EXECUTABLE_ARCHIVE_PATH}`;
export const HELPER_NPM_INFO_PLIST_ARCHIVE_PATH = `native/bin/${HELPER_INFO_PLIST_ARCHIVE_PATH}`;
export const MANIFEST_FILE_NAMES = {
  helper: 'native-release-helper.json',
  arm64: 'native-release-arm64.json',
  x64: 'native-release-x64.json',
} as const;

/** Every file the release consumes; absence of any one fails verification. */
export function requiredArtifactNames(): string[] {
  return [
    HELPER_ARCHIVE_NAME,
    `${HELPER_ARCHIVE_NAME}.sha256`,
    MANIFEST_FILE_NAMES.helper,
    ...DARWIN_ARCHES.flatMap((arch) => [
      `tui-tunes-darwin-${arch}.tar.gz`,
      `tui-tunes-darwin-${arch}.tar.gz.sha256`,
      MANIFEST_FILE_NAMES[arch],
    ]),
  ];
}

export interface TarEntry {
  name: string;
  mode: string;
}

/**
 * Parse `tar -tvzf` output. Tolerates GNU tar (`-rwxr-xr-x owner/group size
 * date time name`) and bsdtar (`-rwxr-xr-x 0 owner group size date time
 * name`) listings; the mode is the first token and the entry name is the last.
 */
export function parseTarListing(output: string): TarEntry[] {
  const entries: TarEntry[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const tokens = trimmed.split(/\s+/);
    const mode = tokens[0];
    if (!/^[ld-][rwxSts-]{9}[.+]?$/.test(mode)) continue;
    const name = tokens[tokens.length - 1].split(' -> ')[0].replace(/\/+$/, '');
    if (name.length === 0 || name === '.' || name === './') continue;
    entries.push({ name, mode });
  }
  return entries;
}

export interface ChecksumSidecar {
  sha256: string;
  name: string;
}

/** Accept the `sha256sum -c` layout `<digest>  <name>` (one or two spaces). */
export function parseChecksumSidecar(text: string): ChecksumSidecar {
  const match = /^([0-9a-f]{64})[ \t]{1,2}(\S+)[ \t]*(?:\r?\n)?$/.exec(text);
  if (!match) throw new PackagingError(`malformed checksum sidecar: ${JSON.stringify(text.slice(0, 120))}`);
  return { sha256: match[1], name: match[2] };
}

export interface ArtifactIndex {
  /** required file base name → absolute path */
  found: Map<string, string>;
  missing: string[];
  /** required file base name appearing more than once under the artifacts dir */
  duplicates: string[];
}

/** Locate required artifacts anywhere under `artifactsDir` (download layout nests them). */
export function indexArtifactFiles(artifactsDir: string, required: readonly string[]): ArtifactIndex {
  const index: ArtifactIndex = { found: new Map(), missing: [], duplicates: [] };
  if (!existsSync(artifactsDir) || !statSync(artifactsDir).isDirectory()) {
    return { found: index.found, missing: [...required], duplicates: index.duplicates };
  }
  const seen = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else if (dirent.isFile()) {
        const paths = seen.get(dirent.name) ?? [];
        paths.push(full);
        seen.set(dirent.name, paths);
      }
    }
  };
  walk(artifactsDir);
  for (const name of required) {
    const paths = seen.get(name) ?? [];
    if (paths.length === 0) index.missing.push(name);
    else if (paths.length > 1) {
      index.duplicates.push(name);
      index.found.set(name, paths[0]);
    } else index.found.set(name, paths[0]);
  }
  return index;
}

export function readManifests(index: ArtifactIndex): Map<string, NativeArchiveManifest> {
  const manifests = new Map<string, NativeArchiveManifest>();
  for (const key of Object.values(MANIFEST_FILE_NAMES)) {
    const path = index.found.get(key);
    if (path === undefined) continue;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const manifest = parsed as NativeArchiveManifest;
    if (manifest.schema !== 1 || manifest.archive?.name === undefined || manifest.helper?.bundleDigest === undefined) {
      throw new PackagingError(`manifest does not match schema 1: ${path}`);
    }
    manifests.set(key, manifest);
  }
  return manifests;
}

/** Recompute digests and require sidecar == manifest == actual bytes. */
export async function verifyChecksums(index: ArtifactIndex, manifests: Map<string, NativeArchiveManifest>): Promise<string[]> {
  const failures: string[] = [];
  for (const [fileName, path] of index.found) {
    if (!fileName.endsWith('.tar.gz')) continue;
    const sidecarPath = index.found.get(`${fileName}.sha256`);
    if (sidecarPath === undefined) continue; // reported as missing separately
    let sidecar: ChecksumSidecar;
    try {
      sidecar = parseChecksumSidecar(readFileSync(sidecarPath, 'utf8'));
    } catch (error) {
      failures.push(`${fileName}.sha256: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (sidecar.name !== fileName) {
      failures.push(`${fileName}.sha256 names "${sidecar.name}" instead of "${fileName}"`);
    }
    const actual = await sha256File(path);
    if (sidecar.sha256 !== actual) {
      failures.push(`${fileName}: sidecar sha256 ${sidecar.sha256} does not match actual ${actual}`);
    }
    const manifest = [...manifests.values()].find((entry) => entry.archive.name === fileName);
    if (manifest === undefined) {
      failures.push(`${fileName}: no packaging manifest records its digest`);
    } else if (manifest.archive.sha256 !== actual) {
      failures.push(`${fileName}: manifest sha256 ${manifest.archive.sha256} does not match actual ${actual}`);
    }
  }
  return failures;
}

export function verifyManifestCommit(
  manifests: Map<string, NativeArchiveManifest>,
  expectedSha: string,
): string[] {
  const failures: string[] = [];
  for (const [fileName, manifest] of manifests) {
    if (manifest.sourceSha !== expectedSha) {
      failures.push(`${fileName}: source SHA ${manifest.sourceSha} does not match candidate ${expectedSha}`);
    }
  }
  if (manifests.size === 0) failures.push('no packaging manifests could be read');
  return failures;
}

/** The universal helper must be byte-identical in every artifact. */
export function verifyHelperIdentity(manifests: Map<string, NativeArchiveManifest>): string[] {
  const failures: string[] = [];
  const descriptors = [...manifests.values()].map((manifest) => ({
    name: manifest.archive.name,
    executableSha256: manifest.helper.executableSha256,
    bundleDigest: manifest.helper.bundleDigest,
    bundleId: manifest.helper.bundleId,
  }));
  const first = descriptors[0];
  for (const descriptor of descriptors.slice(1)) {
    if (descriptor.executableSha256 !== first.executableSha256) {
      failures.push(
        `${descriptor.name}: helper executable sha256 ${descriptor.executableSha256} differs from ${first.name} (${first.executableSha256})`,
      );
    }
    if (descriptor.bundleDigest !== first.bundleDigest) {
      failures.push(
        `${descriptor.name}: helper bundle digest ${descriptor.bundleDigest} differs from ${first.name} (${first.bundleDigest})`,
      );
    }
    if (descriptor.bundleId !== first.bundleId) {
      failures.push(`${descriptor.name}: helper bundle id ${descriptor.bundleId} differs from ${first.name} (${first.bundleId})`);
    }
  }
  return failures;
}

export interface ObservedHelper {
  executableSha256: string;
  bundleDigest: string;
}

/**
 * Tie every archive's actual payload to its manifest: extract the tar into a
 * scratch directory and recompute the helper executable digest, whole-bundle
 * digest and player binary digest from the extracted bytes. Also proves the
 * same universal helper build is physically inside every artifact, not merely
 * claimed by the manifests.
 */
export async function verifyArchiveContents(
  index: ArtifactIndex,
  manifests: Map<string, NativeArchiveManifest>,
): Promise<string[]> {
  const failures: string[] = [];
  const observed = new Map<string, ObservedHelper>();
  for (const [fileName, archivePath] of index.found) {
    if (!fileName.endsWith('.tar.gz')) continue;
    const manifest = [...manifests.values()].find((entry) => entry.archive.name === fileName);
    if (manifest === undefined) continue; // already flagged as digest-less
    const staging = mkdtempSync(join(tmpdir(), 'check-native-release-'));
    try {
      const extracted = Bun.spawnSync(['tar', '-xzf', archivePath, '-C', staging], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (extracted.exitCode !== 0) {
        failures.push(
          `cannot extract ${fileName} (exit ${extracted.exitCode}): ${extracted.stderr.toString().trim()}`,
        );
        continue;
      }
      const appPath =
        manifest.kind === 'helper' ? join(staging, HELPER_APP_RELATIVE_PATH) : join(staging, HELPER_APP_DIR);
      try {
        const info = inspectHelperBundle(appPath);
        const executableSha256 = await sha256File(info.executablePath);
        const digest = await bundleDigest(appPath);
        observed.set(fileName, { executableSha256, bundleDigest: digest });
        if (executableSha256 !== manifest.helper.executableSha256) {
          failures.push(
            `${fileName}: archived helper executable sha256 ${executableSha256} differs from manifest ${manifest.helper.executableSha256}`,
          );
        }
        if (digest !== manifest.helper.bundleDigest) {
          failures.push(
            `${fileName}: archived helper bundle digest ${digest} differs from manifest ${manifest.helper.bundleDigest}`,
          );
        }
      } catch (error) {
        failures.push(
          `${fileName}: archived helper bundle failed inspection: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (manifest.player !== null) {
        const playerPath = join(staging, manifest.player.name);
        const playerSha256 = await sha256File(playerPath);
        if (playerSha256 !== manifest.player.sha256) {
          failures.push(
            `${fileName}: archived player sha256 ${playerSha256} differs from manifest ${manifest.player.sha256}`,
          );
        }
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const artifacts = [...observed.entries()];
  const [firstFileName, firstHelper] = artifacts[0] ?? [null, null];
  for (const [fileName, helper] of artifacts.slice(1)) {
    if (helper.executableSha256 !== firstHelper?.executableSha256 || helper.bundleDigest !== firstHelper?.bundleDigest) {
      failures.push(
        `${fileName}: archived helper bytes differ from ${firstFileName} — expected the single universal build`,
      );
    }
  }
  return failures;
}

const APPLE_DOUBLE = /(^|\/)\._/;

/** Structural checks on tar listings so modes survive artifact transport. */
export function verifyTarEntries(entries: TarEntry[], kind: 'archive' | 'helper'): string[] {
  const failures: string[] = [];
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (APPLE_DOUBLE.test(entry.name)) {
      failures.push(`${kind} tar contains macOS metadata entry: ${entry.name}`);
    }
  }
  const executableChecks: Array<[string, string]> =
    kind === 'archive'
      ? [
          [PLAYER_BINARY_NAME, 'player binary'],
          [HELPER_EXECUTABLE_ARCHIVE_PATH, 'helper executable'],
        ]
      : [[HELPER_NPM_EXECUTABLE_ARCHIVE_PATH, 'helper executable']];
  for (const [name, label] of executableChecks) {
    if (!names.has(name)) {
      failures.push(`${kind} tar is missing ${label}: ${name}`);
      continue;
    }
    const mode = entries.find((entry) => entry.name === name)?.mode ?? '';
    if (!/^-rwx/.test(mode)) {
      failures.push(`${kind} tar entry ${name} lost its executable mode: ${mode}`);
    }
  }
  const plist = kind === 'archive' ? HELPER_INFO_PLIST_ARCHIVE_PATH : HELPER_NPM_INFO_PLIST_ARCHIVE_PATH;
  if (!names.has(plist)) {
    failures.push(`${kind} tar is missing helper Info.plist: ${plist}`);
  }
  return failures;
}

export function listTarEntries(archivePath: string): TarEntry[] {
  const result = Bun.spawnSync(['tar', '-tvzf', archivePath], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new PackagingError(`cannot list ${archivePath} (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return parseTarListing(result.stdout.toString());
}

/** The checkout under verification must be exactly the candidate commit. */
export function verifyHeadCommit(repoRoot: string, expectedSha: string): string[] {
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  if (git.exitCode !== 0) {
    return [`cannot read checkout HEAD in ${repoRoot}: ${git.stderr.toString().trim()}`];
  }
  const head = git.stdout.toString().trim();
  return head === expectedSha ? [] : [`checkout HEAD ${head} is not the candidate ${expectedSha}`];
}

export interface GithubResponse {
  status: number;
  body: unknown;
}

function apiUrl(path: string): string {
  return `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`;
}

export async function fetchGithubJson(token: string, path: string): Promise<GithubResponse> {
  const response = await fetch(apiUrl(path), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

interface EnvironmentPayload {
  environment_name?: string;
  protection_rules?: Array<{ type?: string; reviewers?: unknown[] }>;
}

/**
 * Fail-closed required-reviewer check. 404 means the environment was never
 * configured; 401/403 means verification is impossible. Neither is skippable:
 * a YAML environment name alone is not an approval gate, and this tool never
 * creates protection or secrets.
 */
export async function verifyEnvironmentProtection(
  token: string,
  repo: string,
  environment: string,
): Promise<string[]> {
  const response = await fetchGithubJson(token, `/repos/${repo}/environments/${environment}`);
  if (response.status === 404) {
    return [
      `environment "${environment}" does not exist; create it on GitHub with a required maintainer reviewer before publication`,
    ];
  }
  if (response.status !== 200) {
    return [`cannot verify protection of environment "${environment}" (HTTP ${response.status}); failing closed`];
  }
  const payload = response.body as EnvironmentPayload | null;
  const rules = payload?.protection_rules ?? [];
  const reviewerRules = rules.filter((rule) => rule.type === 'required_reviewers');
  if (reviewerRules.length === 0) {
    return [
      `environment "${environment}" has no required-reviewer protection rule; configure it externally (this check never creates protection or secrets)`,
    ];
  }
  if (reviewerRules.every((rule) => (rule.reviewers ?? []).length === 0)) {
    return [`environment "${environment}" has a required-reviewer rule with no reviewers configured; failing closed`];
  }
  return [];
}

interface WorkflowRunPayload {
  name?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  head_repository?: { full_name?: string };
}

/** Provenance of the artifacts: this exact CI run succeeded for this push. */
export async function verifyWorkflowRunProvenance(
  token: string,
  repo: string,
  runId: string,
  expectedSha: string,
): Promise<string[]> {
  const response = await fetchGithubJson(token, `/repos/${repo}/actions/runs/${runId}`);
  if (response.status !== 200) {
    return [`cannot read CI run ${runId} (HTTP ${response.status}); failing closed`];
  }
  const run = response.body as WorkflowRunPayload | null;
  if (!run) return [`CI run ${runId} returned an empty payload; failing closed`];
  const failures: string[] = [];
  if (run.name !== CI_WORKFLOW_NAME) failures.push(`CI run ${runId} is workflow "${run.name}", expected "${CI_WORKFLOW_NAME}"`);
  if (run.event !== 'push') failures.push(`CI run ${runId} was triggered by "${run.event}", expected a push (not a PR)`);
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    failures.push(`CI run ${runId} is ${run.status}/${run.conclusion}, expected completed/success`);
  }
  if (run.head_sha !== expectedSha) {
    failures.push(`CI run ${runId} head SHA ${run.head_sha} is not the candidate ${expectedSha}`);
  }
  if (run.head_repository?.full_name !== repo) {
    failures.push(`CI run ${runId} belongs to "${run.head_repository?.full_name}", expected "${repo}" (fork candidates rejected)`);
  }
  return failures;
}

function usage(): string {
  return [
    'usage: bun scripts/check-native-release.ts --expected-sha <sha> --run-id <ci-run-id> --repo <owner/repo>',
    '          [--artifacts <dir>] [--environment <name>]',
    '',
    'reads GITHUB_TOKEN from the environment; every check is read-only and fail-closed',
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
  const flags = parseFlags(argv);
  const expectedSha = flags.get('expected-sha');
  const runId = flags.get('run-id');
  const repo = flags.get('repo') ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (expectedSha === undefined || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    process.stderr.write(`--expected-sha <40-hex candidate sha> is required\n\n${usage()}\n`);
    return 2;
  }
  if (!runId || !repo || !token) {
    process.stderr.write(`--run-id, --repo (or GITHUB_REPOSITORY) and GITHUB_TOKEN are required\n\n${usage()}\n`);
    return 2;
  }
  const environment = flags.get('environment') ?? REQUIRED_ENVIRONMENT;
  const repoRoot = resolveRepoRoot(import.meta.dir);
  const artifactsDir = flags.get('artifacts')
    ? resolve(repoRoot, flags.get('artifacts') as string)
    : join(repoRoot, 'artifacts');
  const required = requiredArtifactNames();

  const index = indexArtifactFiles(artifactsDir, required);
  let manifests: Map<string, NativeArchiveManifest> | null = null;
  const failures: string[] = [];
  if (index.missing.length > 0) {
    failures.push(`missing artifacts: ${index.missing.join(', ')}`);
  }
  if (index.duplicates.length > 0) {
    failures.push(`ambiguous artifacts (multiple copies): ${index.duplicates.join(', ')}`);
  }
  if (index.missing.length === 0) {
    try {
      manifests = readManifests(index);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    failures.push(...(await verifyChecksums(index, manifests ?? new Map())));
    if (manifests !== null) {
      failures.push(...verifyManifestCommit(manifests, expectedSha));
      failures.push(...verifyHelperIdentity(manifests));
      failures.push(...(await verifyArchiveContents(index, manifests)));
    }
    for (const [fileName, path] of index.found) {
      if (!fileName.endsWith('.tar.gz')) continue;
      const kind = fileName === HELPER_ARCHIVE_NAME ? 'helper' : 'archive';
      try {
        failures.push(...verifyTarEntries(listTarEntries(path), kind));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  failures.push(...verifyHeadCommit(repoRoot, expectedSha));
  failures.push(...(await verifyEnvironmentProtection(token, repo, environment)));
  failures.push(...(await verifyWorkflowRunProvenance(token, repo, runId, expectedSha)));

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
    process.stderr.write(`prepublish verification FAILED (${failures.length} problem(s)); publication blocked\n`);
    return 1;
  }
  process.stdout.write(
    `prepublish verification passed: environment "${environment}" has required reviewers, ` +
      `CI run ${runId} succeeded at ${expectedSha.slice(0, 12)}, artifacts and digests match\n`,
  );
  return 0;
}

if (import.meta.main) {
  // exitCode (not process.exit) so stdout/stderr writes flush before exit.
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`prepublish verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
