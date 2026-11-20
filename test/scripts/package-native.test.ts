import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DARWIN_ARCHES,
  HELPER_APP_DIR,
  HELPER_ARCHIVE_NAME,
  HELPER_BUNDLE_ID,
  HELPER_EXECUTABLE_RELATIVE_PATH,
  HELPER_INFO_PLIST_RELATIVE_PATH,
  PackagingError,
  bundleDigest,
  createDarwinArchive,
  createHelperArtifact,
  inspectHelperBundle,
  resolveRepoRoot,
  sha256File,
  validatePlayerBinary,
  type NativeArchiveManifest,
} from '../../scripts/package-native';
import {
  indexArtifactFiles,
  listTarEntries,
  parseChecksumSidecar,
  parseTarListing,
  readManifests,
  requiredArtifactNames,
  verifyArchiveContents,
  verifyHelperIdentity,
  verifyManifestCommit,
  verifyTarEntries,
} from '../../scripts/check-native-release';

const scratchRoots: string[] = [];

function makeScratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'package-native-test-'));
  scratchRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${HELPER_BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>
  <string>tuitunes-spectrum-tap</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>TuiTunes captures the audio of its own mpv process to draw the spectrum.</string>
</dict>
</plist>
`;

function writeHelperBundle(root: string, overrides: { executableMode?: number } = {}): string {
  const appPath = join(root, 'native', 'bin', HELPER_APP_DIR);
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(appPath, 'Contents', '_CodeSignature'), { recursive: true });
  const executablePath = join(appPath, HELPER_EXECUTABLE_RELATIVE_PATH);
  writeFileSync(executablePath, '#!/bin/sh\nexit 0\n');
  chmodSync(executablePath, overrides.executableMode ?? 0o755);
  writeFileSync(join(appPath, HELPER_INFO_PLIST_RELATIVE_PATH), INFO_PLIST);
  writeFileSync(
    join(appPath, 'Contents', '_CodeSignature', 'CodeResources'),
    '<?xml version="1.0"?>\n',
  );
  return appPath;
}

function writePlayerBinary(root: string, mode = 0o755): string {
  const binaryPath = join(root, 'dist', 'tuimusic');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(binaryPath, 'fake mach-o\n');
  chmodSync(binaryPath, mode);
  return binaryPath;
}

function readJson(path: string): NativeArchiveManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as NativeArchiveManifest;
}

describe('resolveRepoRoot', () => {
  test('resolves the checkout from the script location regardless of nesting', () => {
    const root = resolveRepoRoot(join(import.meta.dir, '..', '..', 'test'));
    expect(root.endsWith('tunefork')).toBe(true);
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });

  test('fails outside a checkout instead of guessing', () => {
    expect(() => resolveRepoRoot('/')).toThrow(PackagingError);
  });
});

describe('helper bundle inspection', () => {
  test('accepts a bundle with executable, purpose string and bundle id', () => {
    const root = makeScratch();
    const appPath = writeHelperBundle(root);
    const info = inspectHelperBundle(appPath);
    expect(info.bundleId).toBe(HELPER_BUNDLE_ID);
    expect(info.signaturePresent).toBe(true);
  });

  test('rejects a helper executable that lost its executable mode', () => {
    const root = makeScratch();
    const appPath = writeHelperBundle(root, { executableMode: 0o644 });
    expect(() => inspectHelperBundle(appPath)).toThrow(/not an executable file/);
  });

  test('rejects a missing Info.plist and a foreign bundle id', () => {
    const root = makeScratch();
    const appPath = writeHelperBundle(root);
    rmSync(join(appPath, HELPER_INFO_PLIST_RELATIVE_PATH));
    expect(() => inspectHelperBundle(appPath)).toThrow(/Info.plist missing/);

    const other = writeHelperBundle(join(root, 'other'));
    const plistPath = join(other, HELPER_INFO_PLIST_RELATIVE_PATH);
    writeFileSync(plistPath, INFO_PLIST.split(HELPER_BUNDLE_ID).join('com.example.other'));
    expect(() => inspectHelperBundle(other)).toThrow(/bundle id/);
  });

  test('rejects a player binary that is not executable', () => {
    const root = makeScratch();
    const binaryPath = writePlayerBinary(root, 0o644);
    expect(() => validatePlayerBinary(binaryPath)).toThrow(/not an executable file/);
    expect(() => validatePlayerBinary(join(root, 'dist', 'missing'))).toThrow(/not found/);
  });
});

describe('helper artifact staging', () => {
  test('tars the bundle under native/bin with modes preserved', async () => {
    const root = makeScratch();
    const appPath = writeHelperBundle(root);
    const outDir = join(root, 'artifacts');
    const manifest = await createHelperArtifact({
      helperPath: appPath,
      outDir,
      sourceSha: 'a'.repeat(40),
    });

    const archivePath = join(outDir, HELPER_ARCHIVE_NAME);
    expect(manifest.archive.sha256).toBe(await sha256File(archivePath));
    const sidecar = parseChecksumSidecar(readFileSync(`${archivePath}.sha256`, 'utf8'));
    expect(sidecar).toEqual({ sha256: manifest.archive.sha256, name: HELPER_ARCHIVE_NAME });
    const entries = listTarEntries(archivePath);
    expect(verifyTarEntries(entries, 'helper')).toEqual([]);
    // Regression: staging into a fresh directory must create the native/bin
    // parents instead of failing with ENOENT before the tar is written.
    const names = new Set(entries.map((entry) => entry.name));
    expect(names.has('native')).toBe(true);
    expect(names.has('native/bin')).toBe(true);
    expect(readJson(join(outDir, 'native-release-helper.json')).helper.bundleDigest).toBe(
      manifest.helper.bundleDigest,
    );
  });

  test('bundle digest is stable across paths and sensitive to mode changes', async () => {
    const first = makeScratch();
    const second = makeScratch();
    writeHelperBundle(first);
    writeHelperBundle(second);
    expect(await bundleDigest(join(first, 'native', 'bin', HELPER_APP_DIR))).toBe(
      await bundleDigest(join(second, 'native', 'bin', HELPER_APP_DIR)),
    );
    chmodSync(
      join(second, 'native', 'bin', HELPER_APP_DIR, HELPER_EXECUTABLE_RELATIVE_PATH),
      0o700,
    );
    expect(await bundleDigest(join(first, 'native', 'bin', HELPER_APP_DIR))).not.toBe(
      await bundleDigest(join(second, 'native', 'bin', HELPER_APP_DIR)),
    );
  });
});

describe('darwin archive staging', () => {
  test('keeps tuimusic and the .app adjacent with executable modes', async () => {
    const root = makeScratch();
    const appPath = writeHelperBundle(root);
    const binaryPath = writePlayerBinary(root);
    const outDir = join(root, 'artifacts');
    const manifest = await createDarwinArchive({
      arch: 'arm64',
      binaryPath,
      helperPath: appPath,
      outDir,
      sourceSha: 'b'.repeat(40),
    });

    const archivePath = join(outDir, 'tui-tunes-darwin-arm64.tar.gz');
    expect(manifest.archive.sha256).toBe(await sha256File(archivePath));
    const entries = listTarEntries(archivePath);
    expect(verifyTarEntries(entries, 'archive')).toEqual([]);
    const rootEntries = entries
      .filter((entry) => !entry.name.includes('/'))
      .map((entry) => entry.name)
      .sort();
    expect(rootEntries).toEqual([HELPER_APP_DIR, 'tuimusic']);
    const onDisk = readJson(join(outDir, 'native-release-arm64.json'));
    expect(onDisk.sourceSha).toBe('b'.repeat(40));
    expect(onDisk.player?.sha256).toBe(manifest.player?.sha256);
  });

  test('rejects an unsupported architecture before staging', async () => {
    const root = makeScratch();
    const appPath = writeHelperBundle(root);
    const binaryPath = writePlayerBinary(root);
    expect(
      createDarwinArchive({
        arch: 'ppc' as unknown as (typeof DARWIN_ARCHES)[number],
        binaryPath,
        helperPath: appPath,
        outDir: join(root, 'artifacts'),
        sourceSha: 'c'.repeat(40),
      }),
    ).rejects.toThrow(/unsupported darwin arch/);
  });
});

describe('tar listing and checksum parsing', () => {
  test('parses GNU and bsdtar verbose listings', () => {
    const gnu = `-rwxr-xr-x runner/runner     64480 2026-11-15 10:00 tuimusic
drwxr-xr-x runner/runner         0 2026-11-15 10:00 TuiTunesSpectrum.app/
-rwxr-xr-x runner/runner    221184 2026-11-15 10:00 TuiTunesSpectrum.app/Contents/MacOS/tuitunes-spectrum-tap
-rw-r--r-- runner/runner       901 2026-11-15 10:00 TuiTunesSpectrum.app/Contents/Info.plist
total 4 entries`;
    const bsdtar = `-rwxr-xr-x  0 runner  staff  64480 Nov 15 10:00 tuimusic
-rwxr-xr-x  0 runner  staff 221184 Nov 15 10:00 TuiTunesSpectrum.app/Contents/MacOS/tuitunes-spectrum-tap`;
    expect(parseTarListing(gnu)).toHaveLength(4);
    expect(parseTarListing(bsdtar)).toEqual([
      { name: 'tuimusic', mode: '-rwxr-xr-x' },
      {
        name: 'TuiTunesSpectrum.app/Contents/MacOS/tuitunes-spectrum-tap',
        mode: '-rwxr-xr-x',
      },
    ]);
  });

  test('parses only sha256sum-style sidecars', () => {
    const sha = 'a'.repeat(64);
    expect(parseChecksumSidecar(`${sha}  tui-tunes-darwin-arm64.tar.gz\n`)).toEqual({
      sha256: sha,
      name: 'tui-tunes-darwin-arm64.tar.gz',
    });
    expect(() => parseChecksumSidecar(`${sha} name extra\n`)).toThrow(PackagingError);
    expect(() => parseChecksumSidecar('deadbeef  name\n')).toThrow(PackagingError);
  });

  test('rejects archives that lost modes or gained AppleDouble entries', () => {
    expect(
      verifyTarEntries(
        [
          { name: 'tuimusic', mode: '-rw-r--r--' },
          { name: '._tuimusic', mode: '-rw-r--r--' },
          { name: 'TuiTunesSpectrum.app/Contents/MacOS/tuitunes-spectrum-tap', mode: '-rwxr-xr-x' },
          { name: 'TuiTunesSpectrum.app/Contents/Info.plist', mode: '-rw-r--r--' },
        ],
        'archive',
      ),
    ).toEqual([
      'archive tar contains macOS metadata entry: ._tuimusic',
      'archive tar entry tuimusic lost its executable mode: -rw-r--r--',
    ]);
    expect(
      verifyTarEntries(
        [{ name: 'native/bin/TuiTunesSpectrum.app/Contents/Info.plist', mode: '-rw-r--r--' }],
        'helper',
      ),
    ).toEqual([
      'helper tar is missing helper executable: native/bin/TuiTunesSpectrum.app/Contents/MacOS/tuitunes-spectrum-tap',
    ]);
  });
});

describe('artifact index and manifest agreement', () => {
  test('reports missing and duplicated required files', async () => {
    const root = makeScratch();
    const outDir = join(root, 'artifacts');
    const appPath = writeHelperBundle(root);
    const binaryPath = writePlayerBinary(root);
    await createHelperArtifact({ helperPath: appPath, outDir, sourceSha: 'd'.repeat(40) });
    await createDarwinArchive({
      arch: DARWIN_ARCHES[0],
      binaryPath,
      helperPath: appPath,
      outDir,
      sourceSha: 'd'.repeat(40),
    });

    const complete = indexArtifactFiles(outDir, requiredArtifactNames());
    expect(complete.missing.sort()).toEqual(
      [
        'native-release-x64.json',
        'tui-tunes-darwin-x64.tar.gz',
        'tui-tunes-darwin-x64.tar.gz.sha256',
      ].sort(),
    );

    mkdirSync(join(outDir, 'nested'));
    writeFileSync(join(outDir, 'nested', HELPER_ARCHIVE_NAME), 'duplicate');
    const duplicated = indexArtifactFiles(outDir, requiredArtifactNames());
    expect(duplicated.duplicates).toEqual([HELPER_ARCHIVE_NAME]);
  });

  test('verifies manifest commit and helper identity across artifacts', async () => {
    const root = makeScratch();
    const outDir = join(root, 'artifacts');
    const appPath = writeHelperBundle(root);
    const binaryPath = writePlayerBinary(root);
    const manifests = new Map<string, NativeArchiveManifest>();
    manifests.set(
      'native-release-helper.json',
      await createHelperArtifact({ helperPath: appPath, outDir, sourceSha: 'e'.repeat(40) }),
    );
    manifests.set(
      'native-release-arm64.json',
      await createDarwinArchive({
        arch: 'arm64',
        binaryPath,
        helperPath: appPath,
        outDir,
        sourceSha: 'e'.repeat(40),
      }),
    );
    expect(verifyManifestCommit(manifests, 'e'.repeat(40))).toEqual([]);
    expect(verifyHelperIdentity(manifests)).toEqual([]);

    expect(verifyManifestCommit(manifests, 'f'.repeat(40))).toHaveLength(2);
    const tampered = manifests.get('native-release-arm64.json') as NativeArchiveManifest;
    tampered.helper = { ...tampered.helper, executableSha256: '0'.repeat(64) };
    expect(verifyHelperIdentity(manifests)).toHaveLength(1);
  });
});

describe('archived payload ties to manifests', () => {
  test('recomputed archive bytes match manifests and each other', async () => {
    const root = makeScratch();
    const outDir = join(root, 'artifacts');
    const appPath = writeHelperBundle(root);
    const binaryPath = writePlayerBinary(root);
    await createHelperArtifact({ helperPath: appPath, outDir, sourceSha: 'g'.repeat(40) });
    for (const arch of DARWIN_ARCHES) {
      await createDarwinArchive({
        arch,
        binaryPath,
        helperPath: appPath,
        outDir,
        sourceSha: 'g'.repeat(40),
      });
    }
    const index = indexArtifactFiles(outDir, requiredArtifactNames());
    expect(index.missing).toEqual([]);
    expect(await verifyArchiveContents(index, readManifests(index))).toEqual([]);
  });

  test('flags manifest fields that misdescribe the archived bytes', async () => {
    const root = makeScratch();
    const outDir = join(root, 'artifacts');
    const appPath = writeHelperBundle(root);
    const binaryPath = writePlayerBinary(root);
    await createHelperArtifact({ helperPath: appPath, outDir, sourceSha: 'h'.repeat(40) });
    await createDarwinArchive({
      arch: 'arm64',
      binaryPath,
      helperPath: appPath,
      outDir,
      sourceSha: 'h'.repeat(40),
    });

    const helperManifest = readJson(join(outDir, 'native-release-helper.json'));
    helperManifest.helper.executableSha256 = '0'.repeat(64);
    writeFileSync(join(outDir, 'native-release-helper.json'), JSON.stringify(helperManifest));
    const arm64Manifest = readJson(join(outDir, 'native-release-arm64.json'));
    if (arm64Manifest.player !== null) {
      arm64Manifest.player = { ...arm64Manifest.player, sha256: '0'.repeat(64) };
    }
    writeFileSync(join(outDir, 'native-release-arm64.json'), JSON.stringify(arm64Manifest));

    const index = indexArtifactFiles(outDir, requiredArtifactNames());
    const failures = (await verifyArchiveContents(index, readManifests(index))).join('\n');
    expect(failures).toMatch(
      /archived helper executable sha256 [0-9a-f]{64} differs from manifest/,
    );
    expect(failures).toMatch(/archived player sha256 [0-9a-f]{64} differs from manifest/);
  });

  test('flags archives built from different helper builds', async () => {
    const root = makeScratch();
    const outDir = join(root, 'artifacts');
    const helperA = writeHelperBundle(join(root, 'a'));
    const helperB = writeHelperBundle(join(root, 'b'));
    const executableB = join(helperB, HELPER_EXECUTABLE_RELATIVE_PATH);
    writeFileSync(executableB, '#!/bin/sh\nexit 1\n');
    chmodSync(executableB, 0o755);
    await createHelperArtifact({ helperPath: helperA, outDir, sourceSha: 'i'.repeat(40) });
    await createDarwinArchive({
      arch: 'arm64',
      binaryPath: writePlayerBinary(root),
      helperPath: helperB,
      outDir,
      sourceSha: 'i'.repeat(40),
    });

    const index = indexArtifactFiles(outDir, requiredArtifactNames());
    const failures = await verifyArchiveContents(index, readManifests(index));
    expect(failures).toEqual([
      'tui-tunes-darwin-arm64.tar.gz: archived helper bytes differ from tuitunes-spectrum-helper.tar.gz — expected the single universal build',
    ]);
  });
});

describe('release workflow guards', () => {
  const workflow = readFileSync(
    join(import.meta.dir, '..', '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );

  test('stages the verified helper between verification and publication', () => {
    const verification = workflow.indexOf('Fail-closed prepublish verification');
    const staging = workflow.indexOf('Stage the verified helper for npm packaging');
    const executableCheck = workflow.indexOf(
      'test -x native/bin/TuiTunesSpectrum.app/Contents/MacOS/tuitunes-spectrum-tap',
      staging,
    );
    const release = workflow.indexOf('- name: Release');
    expect(verification).toBeGreaterThan(-1);
    expect(staging).toBeGreaterThan(verification);
    expect(executableCheck).toBeGreaterThan(staging);
    expect(release).toBeGreaterThan(executableCheck);
  });

  test('requires the candidate to be the current main tip, rechecked before publishing', () => {
    expect(workflow).not.toContain('merge-base');
    const reject = workflow.indexOf('Reject stale or superseded candidates');
    const recheck = workflow.indexOf('Recheck the candidate is still the main tip');
    const release = workflow.indexOf('- name: Release');
    expect(workflow.match(/git rev-parse origin\/main/g)).toHaveLength(2);
    expect(reject).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(workflow.indexOf('Fail-closed prepublish verification'));
    expect(release).toBeGreaterThan(recheck);
  });
});
