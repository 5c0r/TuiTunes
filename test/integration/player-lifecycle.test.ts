import { expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStore } from 'jotai';
import { createMpvProcessPort, PlayerController } from '../../src/player/controller';
import { getTrackedPids, killMpv, spawnMpv } from '../../src/player/process';
import {
  playerAudioBackendAtom,
  playerDurationAtom,
  playerMuteAtom,
  playerNoticeAtom,
  playerPositionAtom,
  playerProcessIdentityAtom,
  playerSeekableRequestAtom,
  playerStateAtom,
  playerSpeedAtom,
  playerVolumeAtom,
} from '../../src/store/player';
import type { PlaybackTarget } from '../../src/providers/types';

/**
 * Real-process mpv lifecycle proof: play/pause/seek a local WAV fixture
 * (including a load-time startPosition resume), SIGKILL mpv, verify crash
 * recovery to the same source/position (seekable confirmation included),
 * and verify deterministic teardown. Opt-in via TUITUNES_MPV_INTEGRATION=1
 * because it needs a real mpv binary.
 */
const INTEGRATION = process.env.TUITUNES_MPV_INTEGRATION === '1';
const mpvTest = INTEGRATION ? test : test.skip;

/** Poll a real-state condition with a bounded deadline; mpv timing is the system under test. */
async function until(cond: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await Bun.sleep(25);
  }
}

/** Small PCM WAV: 8 s, 8 kHz, mono 16-bit square wave. */
function writeWavFixture(dir: string): string {
  const sampleRate = 8000;
  const seconds = 8;
  const samples = sampleRate * seconds;
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 1200 : -1200, 44 + i * 2);
  const wavPath = path.join(dir, 'fixture.wav');
  writeFileSync(wavPath, buf);
  return wavPath;
}

function leftoverSockets(): string[] {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  if (!existsSync(runtimeDir)) return [];
  return readdirSync(runtimeDir).filter((name) => name.startsWith(`tuimusic-mpv-${process.pid}-`));
}

/**
 * Stub-binary spawn proof (no real mpv needed): every actual spawn gets a
 * unique --audio-client-name and a full identity handle, reuse returns the
 * existing identity, and the socket/args wiring is what mpv receives.
 */
test('spawnMpv passes a unique --audio-client-name per actual spawn', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tuimusic-mpvstub-'));
  const argsPath = path.join(dir, 'argv.txt');
  const stubPath = path.join(dir, 'mpv-stub.sh');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > '${argsPath}'`,
      `sock=$(printf '%s\\n' "$@" | sed -n 's/^--input-ipc-server=//p')`,
      ': > "$sock"',
      'while :; do sleep 0.2; done',
      '',
    ].join('\n'),
  );
  chmodSync(stubPath, 0o755);

  try {
    const handle1 = await spawnMpv({ binary: stubPath });
    expect(handle1.clientName).toMatch(/^TuiTunes-[0-9a-f-]{36}$/);
    const argv1 = readFileSync(argsPath, 'utf8');
    expect(argv1).toContain(`--audio-client-name=${handle1.clientName}\n`);
    expect(argv1).toContain(`--input-ipc-server=${handle1.socketPath}\n`);

    // An already-running process is reused with its existing identity.
    const reused = await spawnMpv({ binary: stubPath });
    expect(reused).toEqual(handle1);

    await killMpv();

    // Every actual spawn gets a fresh identity.
    const handle2 = await spawnMpv({ binary: stubPath });
    expect(handle2.clientName).not.toBe(handle1.clientName);
    expect(handle2.pid).not.toBe(handle1.pid);
    await killMpv();
    expect(getTrackedPids()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

mpvTest(
  'real mpv: play/pause/seek, crash recovery, clean teardown',
  async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'tuimusic-mpvit-'));
    const wavPath = writeWavFixture(scratch);
    const store = createStore();
    const controller = new PlayerController(
      store,
      createMpvProcessPort({ extraArgs: ['--ao=null'] }),
    );
    const loaded = new Set<number>();
    controller.onTrackLoaded((target) => loaded.add(target.requestId));

    try {
      await controller.init();
      const firstIdentity = store.get(playerProcessIdentityAtom);
      expect(firstIdentity?.clientName).toMatch(/^TuiTunes-/);
      expect(firstIdentity?.pid).toBe(getTrackedPids()[0]);

      // The local fixture is supplied directly as a resolved playback source;
      // it is not a new supported provider.
      const target: PlaybackTarget = {
        track: {
          id: 'wav-fixture',
          provider: 'fixture',
          source: null,
          title: 'PCM fixture',
          artist: 'integration',
          duration: 8,
        },
        source: { kind: 'rss', url: `file://${wavPath}`, selection: 'auto' },
        requestId: 1,
        origin: { kind: 'direct' },
      };
      await controller.play(target);

      await until(() => store.get(playerStateAtom) === 'playing', 'initial playback', 15_000);
      await until(() => store.get(playerDurationAtom) >= 5, 'duration reported', 10_000);
      await until(
        () => store.get(playerPositionAtom) > 2.5,
        'position past seek threshold',
        10_000,
      );

      // Observer 15 (seekable) confirms the local file once no
      // request-bound seek is outstanding.
      await until(
        () => store.get(playerSeekableRequestAtom) === 1,
        'seekable confirmed for initial playback',
        5_000,
      );

      // Observer 14 (current-ao) publishes the real backend; --ao=null is a
      // known-uncapturable output, never a missing report.
      await until(
        () => store.get(playerAudioBackendAtom) !== null,
        'audio backend observed',
        5_000,
      );

      // Pause / resume.
      await controller.togglePause();
      await until(() => store.get(playerStateAtom) === 'paused', 'paused', 5_000);
      await controller.setVolume(47);
      await controller.toggleMute();
      await controller.setSpeed(1.5);
      const replacementPath = path.join(scratch, 'replacement.wav');
      cpSync(wavPath, replacementPath);
      await controller.play(
        {
          ...target,
          requestId: 2,
          track: { ...target.track, id: 'replacement', title: 'Replacement fixture' },
          source: { kind: 'rss', url: `file://${replacementPath}`, selection: 'auto' },
        },
        // Load-start resume: the seek lands once the file loads; readiness
        // is confirmed through the seekable atom below, not this promise.
        { preservePause: true, startPosition: 4 },
      );
      await until(() => loaded.has(2), 'replacement loaded while paused', 10_000);
      expect(store.get(playerStateAtom)).toBe('paused');
      await until(
        () => store.get(playerPositionAtom) >= 3.5,
        'load-start seek applied while paused',
        5_000,
      );
      expect(store.get(playerNoticeAtom)).toBe('Resumed at 0:04');
      await until(
        () => store.get(playerSeekableRequestAtom) === 2,
        'seekable confirmed after load-start seek',
        5_000,
      );
      expect(store.get(playerVolumeAtom)).toBe(47);
      expect(store.get(playerMuteAtom)).toBe(true);
      expect(store.get(playerSpeedAtom)).toBe(1.5);
      await controller.toggleMute();
      await controller.setSpeed(1);
      await controller.togglePause();
      await until(() => store.get(playerStateAtom) === 'playing', 'resumed', 5_000);
      await until(
        () => store.get(playerPositionAtom) > 2.5,
        'replacement position before recovery',
        10_000,
      );

      // Relative seek.
      const beforeSeek = store.get(playerPositionAtom);
      await controller.seekRelative(1);
      await until(
        () => store.get(playerPositionAtom) >= beforeSeek + 0.5,
        'relative seek applied',
        5_000,
      );

      // Force a crash: SIGKILL the real mpv child.
      const crashPids = getTrackedPids();
      expect(crashPids.length).toBe(1);
      process.kill(crashPids[0], 'SIGKILL');
      await until(() => store.get(playerStateAtom) === 'stopped', 'disconnect observed', 5_000);
      const crashPosition = store.get(playerPositionAtom);
      // Disconnect invalidates the seekable confirmation before recovery.
      expect(store.get(playerSeekableRequestAtom)).toBeNull();

      // Recovery reloads the same local source and restores position.
      await until(() => store.get(playerStateAtom) === 'playing', 'recovery playback', 20_000);
      await until(() => store.get(playerDurationAtom) >= 5, 'recovery duration', 10_000);
      await until(
        () => store.get(playerPositionAtom) >= crashPosition - 1.5,
        'recovery seek restores position',
        10_000,
      );

      // The rebinding plus its recovery seek restore the confirmation and
      // surface the nonfatal resume notice.
      await until(
        () => store.get(playerSeekableRequestAtom) === 2,
        'seekable restored after recovery',
        10_000,
      );
      expect(store.get(playerNoticeAtom)).toMatch(/^Resumed at /);

      // Respawn publishes a fresh identity even though the source is unchanged.
      const secondIdentity = store.get(playerProcessIdentityAtom);
      expect(secondIdentity?.clientName).not.toBe(firstIdentity?.clientName);

      // Normal replacement also needs fresh confirmation, even when the
      // seekable property is true on both sides of the transition.
      await controller.play({ ...target, requestId: 3 });
      await until(
        () => store.get(playerSeekableRequestAtom) === 3,
        'click-to-seek available after replacing a seekable file',
        5_000,
      );
      await controller.seekAbsolute(2);
      await until(() => store.get(playerPositionAtom) >= 1.8, 'absolute seek applied', 5_000);
    } finally {
      const livePids = getTrackedPids();
      await controller.destroy();
      expect(store.get(playerProcessIdentityAtom)).toBeNull();

      // The owned subprocess exited and every socket for this process is gone.
      expect(getTrackedPids()).toHaveLength(0);
      expect(leftoverSockets()).toEqual([]);
      for (const pid of livePids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  60_000,
);
