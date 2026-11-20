import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Socket } from 'bun';
import type { Atom } from 'jotai';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { PlayerController, type PlayerProcessPort } from '../../src/player/controller';
import type { MpvProcessHandle } from '../../src/player/process';
import type { PlaybackTarget, Track } from '../../src/providers/types';
import {
  playerAudioBackendAtom,
  playerDurationAtom,
  playerErrorAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerProcessIdentityAtom,
  playerStateAtom,
  playerTrackAtom,
  playerVolumeAtom,
} from '../../src/store/player';

// ---------------------------------------------------------------------------
// Fake mpv: a real Unix-socket server speaking the mpv JSON IPC protocol.
// Commands are auto-ACKed with success (loadfile ACKs carry a fresh
// playlist_entry_id, exactly like mpv ≥0.35); events/properties are pushed
// by the test, so every state transition is driven by awaited events, never
// sleeps. manualLoadAck defers the loadfile ACK so tests can reorder events
// ahead of it.
// ---------------------------------------------------------------------------

interface RecordedCommand {
  command: unknown[];
}

class FakeMpv {
  readonly socketPath: string;
  readonly commands: RecordedCommand[] = [];
  /** playlist_entry_id assigned to each loadfile ACK, in command order. */
  readonly loadEntryIds: number[] = [];
  manualLoadAck = false;
  private entryCounter = 0;
  private pendingLoadAcks: number[] = [];
  private readonly server: ReturnType<typeof Bun.listen>;
  private sockets: Socket<unknown>[] = [];
  private waiters: Array<{
    pred: (cmd: RecordedCommand) => boolean;
    resolve: (cmd: RecordedCommand) => void;
  }> = [];

  constructor(name: string) {
    this.socketPath = path.join(
      os.tmpdir(),
      `tuimusic-fakempv-${process.pid}-${name}-${Math.random().toString(36).slice(2)}.sock`,
    );
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open: (socket) => {
          this.sockets.push(socket);
        },
        data: (_socket, data) => {
          this.onData(data);
        },
        close: (socket) => {
          this.sockets = this.sockets.filter((s) => s !== socket);
        },
      },
    });
  }

  private onData(data: Uint8Array): void {
    const text = new TextDecoder().decode(data);
    for (const line of text.split('\n')) {
      if (!line) continue;
      let msg: { command?: unknown[]; request_id?: number };
      try {
        msg = JSON.parse(line) as { command?: unknown[]; request_id?: number };
      } catch {
        continue;
      }
      if (!Array.isArray(msg.command)) continue;
      const cmd = { command: msg.command };
      this.commands.push(cmd);
      const requestId = msg.request_id ?? 0;
      if (cmd.command[0] === 'loadfile') {
        if (this.manualLoadAck) {
          this.pendingLoadAcks.push(requestId);
        } else {
          const entryId = ++this.entryCounter;
          this.loadEntryIds.push(entryId);
          this.write({
            error: 'success',
            request_id: requestId,
            data: { playlist_entry_id: entryId },
          });
        }
      } else {
        this.write({ error: 'success', request_id: requestId, data: null });
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.pred(cmd)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(cmd);
        }
      }
    }
  }

  write(obj: unknown): void {
    const line = `${JSON.stringify(obj)}\n`;
    for (const socket of this.sockets) socket.write(line);
  }

  /** Simulate a property-change push; omit `data` for "unavailable". */
  pushProperty(id: number, name: string, data?: unknown): void {
    const event: Record<string, unknown> = { event: 'property-change', id, name };
    if (data !== undefined) event.data = data;
    this.write(event);
  }

  pushEvent(event: Record<string, unknown>): void {
    this.write({ event: event.event, ...event });
  }

  /** start-file naming its native playlist entry. */
  pushStartFile(entryId: number): void {
    this.pushEvent({ event: 'start-file', playlist_entry_id: entryId });
  }

  /** ID-less file-loaded, attributed to the stream-ordered start-file entry. */
  pushFileLoaded(): void {
    this.pushEvent({ event: 'file-loaded' });
  }

  /** end-file carrying its explicit native entry id. */
  pushEndFile(entryId: number, reason: string, extra: Record<string, unknown> = {}): void {
    this.pushEvent({ event: 'end-file', reason, playlist_entry_id: entryId, ...extra });
  }

  /** Entry id the fake assigned to the n-th (1-based) loadfile ACK. */
  entryIdForLoad(n: number): number {
    const id = this.loadEntryIds[n - 1];
    if (id === undefined) throw new Error(`no loadfile #${n} recorded on this fake`);
    return id;
  }

  /** With manualLoadAck: deliver the pending loadfile success ACK. */
  ackLoadfile(entryId?: number): number {
    const requestId = this.pendingLoadAcks.shift();
    if (requestId === undefined) throw new Error('no pending loadfile to ACK');
    const id = entryId ?? ++this.entryCounter;
    this.loadEntryIds.push(id);
    this.write({ error: 'success', request_id: requestId, data: { playlist_entry_id: id } });
    return id;
  }

  /** With manualLoadAck: success ACK whose data carries no usable identity. */
  ackLoadfileWithoutIdentity(data: unknown = null): void {
    const requestId = this.pendingLoadAcks.shift();
    if (requestId === undefined) throw new Error('no pending loadfile to ACK');
    this.write({ error: 'success', request_id: requestId, data });
  }

  commandNames(): string[] {
    return this.commands.map((c) => String(c.command[0]));
  }

  loadfileUrls(): string[] {
    return this.commands
      .filter((c) => c.command[0] === 'loadfile')
      .map((c) => String(c.command[1]));
  }

  /** Resolve when a command matching `pred` arrives (or already arrived). */
  expectCommand(
    pred: (cmd: RecordedCommand) => boolean,
    timeoutMs = 5000,
  ): Promise<RecordedCommand> {
    const existing = this.commands.find(pred);
    if (existing) return Promise.resolve(existing);
    const { promise, resolve, reject } = Promise.withResolvers<RecordedCommand>();
    const timer = setTimeout(() => {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      reject(new Error(`Timed out waiting for command; got: ${JSON.stringify(this.commands)}`));
    }, timeoutMs);
    const waiter = {
      pred,
      resolve: (cmd: RecordedCommand) => {
        clearTimeout(timer);
        resolve(cmd);
      },
    };
    this.waiters.push(waiter);
    return promise;
  }

  /** Simulate an mpv crash: drop every client connection. */
  crash(): void {
    for (const socket of this.sockets) {
      try {
        socket.end();
      } catch {
        // Already closed
      }
    }
    this.sockets = [];
  }

  close(): void {
    this.crash();
    this.server.stop();
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Already gone
    }
  }
}

/** A process port whose start() spawns a fresh FakeMpv each call. */
class FakeProcessPort implements PlayerProcessPort {
  readonly instances: FakeMpv[] = [];
  stopCalls = 0;
  private pidCounter = 4000;

  async start(_signal?: AbortSignal): Promise<MpvProcessHandle> {
    _signal?.throwIfAborted();
    const fake = new FakeMpv(String(this.instances.length));
    this.instances.push(fake);
    return {
      socketPath: fake.socketPath,
      pid: ++this.pidCounter,
      clientName: `TuiTunes-${crypto.randomUUID()}`,
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    // Instances stay listed so tests can inspect the full spawn history.
    for (const instance of this.instances) instance.close();
  }
}

// ---------------------------------------------------------------------------
// Deterministic event waits
// ---------------------------------------------------------------------------

function waitForAtom<T>(store: Store, theAtom: Atom<T>, expected: T, timeoutMs = 5000): Promise<T> {
  if (store.get(theAtom) === expected) return Promise.resolve(expected);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    unsub();
    reject(new Error(`Timed out waiting for atom value ${JSON.stringify(expected)}`));
  }, timeoutMs);
  const unsub = store.sub(theAtom, () => {
    if (store.get(theAtom) === expected) {
      clearTimeout(timer);
      unsub();
      resolve(expected);
    }
  });
  return promise;
}

/**
 * Wait for an arbitrary condition. Polls on a short interval because the
 * condition source (e.g. FakeMpv socket traffic) has no exposed event.
 */
async function waitUntil(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await Bun.sleep(10);
  }
}

function makeTarget(id: string, url: string, requestId = 1): PlaybackTarget {
  const track: Track = {
    id,
    provider: 'youtube',
    source: { kind: 'youtube', videoId: id },
    title: `Track ${id}`,
    artist: 'Artist',
    duration: 200,
  };
  return {
    track,
    source: { kind: 'youtube', url, videoId: id, selection: 'auto' },
    requestId,
    origin: { kind: 'direct' },
  };
}

describe('PlayerController', () => {
  let store: Store;
  let port: FakeProcessPort;
  let controller: PlayerController;

  beforeEach(() => {
    store = createStore();
    port = new FakeProcessPort();
    controller = new PlayerController(store, port);
  });

  afterEach(async () => {
    try {
      await controller.destroy();
    } catch {
      // Already destroyed
    }
    for (const instance of port.instances.splice(0)) instance.close();
  });

  /** Drive one target to a natively committed 'playing' state (load #1). */
  async function startPlaying(target: PlaybackTarget): Promise<FakeMpv> {
    await controller.init();
    await controller.play(target);
    const mpv = port.instances[0];
    await mpv.expectCommand((c) => c.command[0] === 'loadfile');
    // The ACK precedes mpv's load events, as with a real mpv.
    mpv.pushProperty(3, 'pause', false);
    mpv.pushStartFile(mpv.entryIdForLoad(1));
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    return mpv;
  }

  test('init connects through the process port and observes properties', async () => {
    await controller.init();
    const mpv = port.instances[0];
    await mpv.expectCommand((c) => c.command[0] === 'observe_property');
    expect(port.instances).toHaveLength(1);
  });

  test('play loads the resolved source URL and publishes the target', async () => {
    await controller.init();
    const target = makeTarget('abc', 'https://example.com/stream');
    await controller.play(target);

    const mpv = port.instances[0];
    await mpv.expectCommand((c) => c.command[0] === 'loadfile');
    expect(mpv.loadfileUrls()).toEqual(['https://example.com/stream']);
    // New playback starts unpaused: set_property pause=false precedes loadfile.
    const unpauseIdx = mpv.commands.findIndex(
      (c) => c.command[0] === 'set_property' && c.command[1] === 'pause' && c.command[2] === false,
    );
    const loadIdx = mpv.commands.findIndex((c) => c.command[0] === 'loadfile');
    expect(unpauseIdx).toBeGreaterThanOrEqual(0);
    expect(unpauseIdx).toBeLessThan(loadIdx);

    expect(store.get(playerPlaybackAtom)).toBe(target);
    expect(store.get(playerTrackAtom)).toBe(target.track);
    expect(store.get(playerErrorAtom)).toBeNull();
    // Buffering until the file-loaded event arrives.
    expect(store.get(playerStateAtom)).toBe('buffering');
  });

  test('play resets position and duration from the previous track', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushProperty(1, 'time-pos', 42);
    mpv.pushProperty(2, 'duration', 200);
    await waitForAtom(store, playerPositionAtom, 42);
    await waitForAtom(store, playerDurationAtom, 200);

    await controller.play(makeTarget('b', 'https://example.com/b', 2));
    expect(store.get(playerPositionAtom)).toBe(0);
    expect(store.get(playerDurationAtom)).toBe(0);
    expect(store.get(playerStateAtom)).toBe('buffering');
  });

  test('deterministic pause/cache state derivation', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));

    // cache pause → buffering, cache recovery → playing again
    mpv.pushProperty(12, 'paused-for-cache', true);
    await waitForAtom(store, playerStateAtom, 'buffering');
    mpv.pushProperty(12, 'paused-for-cache', false);
    await waitForAtom(store, playerStateAtom, 'playing');

    // user pause wins; cache recovery must not show playing while paused
    mpv.pushProperty(3, 'pause', true);
    await waitForAtom(store, playerStateAtom, 'paused');
    mpv.pushProperty(12, 'paused-for-cache', true);
    mpv.pushProperty(12, 'paused-for-cache', false);
    // A volume marker proves both cache events were processed.
    mpv.pushProperty(4, 'volume', 77);
    await waitForAtom(store, playerVolumeAtom, 77);
    expect(store.get(playerStateAtom)).toBe('paused');
  });

  test('pause before any file loads stays stopped', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.pushProperty(3, 'pause', false);
    mpv.pushProperty(4, 'volume', 55);
    await waitForAtom(store, playerVolumeAtom, 55);
    expect(store.get(playerStateAtom)).toBe('stopped');
  });

  test('invalid property payloads do not overwrite state', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushProperty(1, 'time-pos', 'not-a-number');
    mpv.pushProperty(2, 'duration', Number.NaN);
    mpv.pushProperty(3, 'pause', 'yes');
    mpv.pushProperty(12, 'paused-for-cache', 1);
    // Volume marker proves the malformed messages were consumed.
    mpv.pushProperty(4, 'volume', 66);
    await waitForAtom(store, playerVolumeAtom, 66);
    expect(store.get(playerStateAtom)).toBe('playing');
    expect(store.get(playerPositionAtom)).toBe(0);
    expect(store.get(playerDurationAtom)).toBe(0);
  });

  test('unavailable (absent-data) properties are ignored', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    // mpv omits `data` when a property is unavailable (e.g. going idle).
    mpv.pushProperty(1, 'time-pos');
    mpv.pushProperty(4, 'volume', 88);
    await waitForAtom(store, playerVolumeAtom, 88);
    expect(store.get(playerPositionAtom)).toBe(0);
  });

  test('EOF fires onTrackEnd with the ended target and preserves metadata', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    const mpv = await startPlaying(target);

    const ended: PlaybackTarget[] = [];
    const unregister = controller.onTrackEnd((t) => ended.push(t));
    mpv.pushEndFile(mpv.entryIdForLoad(1), 'eof');
    await waitForAtom(store, playerStateAtom, 'stopped');
    expect(ended).toEqual([target]);
    // Last metadata stays visible at natural EOF.
    expect(store.get(playerPlaybackAtom)).toBe(target);
    expect(store.get(playerTrackAtom)).toBe(target.track);

    // Unregistering is safe: a further EOF no longer invokes the handler.
    unregister();
    mpv.pushEndFile(mpv.entryIdForLoad(1), 'eof');
    mpv.pushProperty(4, 'volume', 44);
    await waitForAtom(store, playerVolumeAtom, 44);
    expect(ended).toHaveLength(1);
  });

  test('file-loaded fires onTrackLoaded with the target; unregister works', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    await controller.init();
    await controller.play(target);
    const mpv = port.instances[0];

    const loaded: PlaybackTarget[] = [];
    const unregister = controller.onTrackLoaded((t) => loaded.push(t));
    mpv.pushStartFile(mpv.entryIdForLoad(1));
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(loaded).toEqual([target]);

    unregister();
    await controller.play(makeTarget('b', 'https://example.com/b', 2));
    await mpv.expectCommand(
      (c) => c.command[0] === 'loadfile' && c.command[1] === 'https://example.com/b',
    );
    mpv.pushStartFile(mpv.entryIdForLoad(2));
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(store.get(playerTrackAtom)?.id).toBe('b');
    expect(loaded).toHaveLength(1);
  });

  test('mpv playback error sets playerErrorAtom and stops', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    const mpv = await startPlaying(target);

    mpv.pushEndFile(mpv.entryIdForLoad(1), 'error', { file_error: 'unable to open resource' });
    await waitForAtom(store, playerStateAtom, 'stopped');
    expect(store.get(playerErrorAtom)).toBe('Playback failed: unable to open resource');
    expect(store.get(playerPlaybackAtom)).toBe(target);
  });

  test('stop clears track, position and duration synchronously before the ACK', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    const mpv = await startPlaying(target);
    mpv.pushProperty(1, 'time-pos', 42);
    await waitForAtom(store, playerPositionAtom, 42);

    const stopPromise = controller.stop();
    // State is cleared synchronously — a delayed stop ACK cannot null a
    // newer target started right after stop() returns to its caller.
    expect(store.get(playerPlaybackAtom)).toBeNull();
    expect(store.get(playerTrackAtom)).toBeNull();
    expect(store.get(playerStateAtom)).toBe('stopped');
    expect(store.get(playerPositionAtom)).toBe(0);
    expect(store.get(playerDurationAtom)).toBe(0);
    await stopPromise;
    await mpv.expectCommand((c) => c.command[0] === 'stop');
  });

  test('delayed end-file(stop) from a replaced file cannot clobber a newer play', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    await controller.play(makeTarget('b', 'https://example.com/b', 2));
    await mpv.expectCommand((c) => c.command[1] === 'https://example.com/b');
    expect(store.get(playerStateAtom)).toBe('buffering');

    // mpv emits end-file for the replaced file after loadfile(B) was sent.
    mpv.pushEndFile(mpv.entryIdForLoad(1), 'stop');
    mpv.pushProperty(4, 'volume', 99);
    await waitForAtom(store, playerVolumeAtom, 99);
    expect(store.get(playerStateAtom)).toBe('buffering');
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('b');

    mpv.pushStartFile(mpv.entryIdForLoad(2));
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('b');
  });

  test('seekAbsolute clamps to the known duration', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushProperty(2, 'duration', 100);
    await waitForAtom(store, playerDurationAtom, 100);

    await controller.seekAbsolute(500);
    const seek = await mpv.expectCommand((c) => c.command[0] === 'seek');
    expect(seek.command[1]).toBe(100);
    expect(seek.command[2]).toBe('absolute+exact');
  });

  test('crash recovery reloads the same resolved source, seeking only after file-loaded', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    const mpv = await startPlaying(target);
    mpv.pushProperty(1, 'time-pos', 42);
    await waitForAtom(store, playerPositionAtom, 42);

    mpv.crash();
    await waitForAtom(store, playerStateAtom, 'stopped');
    await waitUntil(() => port.instances.length >= 2, 'recovery respawn');
    const revived = port.instances[1];

    const reload = await revived.expectCommand((c) => c.command[0] === 'loadfile');
    expect(reload.command[1]).toBe('https://example.com/a');
    // No unconditional seek timer: nothing seeks before file-loaded.
    expect(revived.commandNames().includes('seek')).toBe(false);

    revived.pushStartFile(revived.entryIdForLoad(1));
    revived.pushFileLoaded();
    const seek = await revived.expectCommand((c) => c.command[0] === 'seek');
    expect(seek.command[1]).toBe(42);
    expect(seek.command[2]).toBe('absolute+exact');
    revived.pushProperty(3, 'pause', false);
    await waitForAtom(store, playerStateAtom, 'playing');
    // One seek only — the intent is consumed.
    expect(revived.commands.filter((c) => c.command[0] === 'seek')).toHaveLength(1);
  });

  test('recovery does not replay a position below the seek threshold', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    const mpv = await startPlaying(target);
    mpv.pushProperty(1, 'time-pos', 1);
    await waitForAtom(store, playerPositionAtom, 1);

    mpv.crash();
    await waitForAtom(store, playerStateAtom, 'stopped');
    await waitUntil(() => port.instances.length >= 2, 'recovery respawn');
    const revived = port.instances[1];
    await revived.expectCommand((c) => c.command[0] === 'loadfile');
    revived.pushStartFile(revived.entryIdForLoad(1));
    revived.pushFileLoaded();
    revived.pushProperty(3, 'pause', false);
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(revived.commandNames().includes('seek')).toBe(false);
  });

  test('a newer play during recovery supersedes the reload and its seek', async () => {
    const targetA = makeTarget('a', 'https://example.com/a', 1);
    const mpv = await startPlaying(targetA);
    mpv.pushProperty(1, 'time-pos', 42);
    await waitForAtom(store, playerPositionAtom, 42);

    mpv.crash();
    await waitForAtom(store, playerStateAtom, 'stopped'); // disconnect seen; recovery pending

    // Start B while the recovery respawn is still in flight.
    const targetB = makeTarget('b', 'https://example.com/b', 2);
    const playB = controller.play(targetB);
    await playB;

    await waitUntil(() => port.instances.length >= 2, 'recovery respawn');
    const revived = port.instances[1];
    // The old target is never reloaded; only B's source plays.
    expect(revived.loadfileUrls()).toEqual(['https://example.com/b']);
    revived.pushStartFile(revived.entryIdForLoad(1));
    revived.pushFileLoaded();
    revived.pushProperty(3, 'pause', false);
    await waitForAtom(store, playerStateAtom, 'playing');
    // A's recovery-seek intent was dropped: no seek at all.
    expect(revived.commandNames().includes('seek')).toBe(false);
    expect(store.get(playerPlaybackAtom)).toBe(targetB);
  });

  test('anti-flap: a second crash within the window gives up instead of respawning', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));

    mpv.crash();
    await waitForAtom(store, playerStateAtom, 'stopped');
    await waitUntil(() => port.instances.length >= 2, 'first recovery');
    const revived = port.instances[1];
    await revived.expectCommand((c) => c.command[0] === 'loadfile');

    revived.crash();
    await waitForAtom(store, playerErrorAtom, 'mpv crashed repeatedly — playback stopped');
    expect(port.instances).toHaveLength(2);
    // Negative assertion: recovery would respawn after its 500 ms retry delay,
    // so real time is the only witness. A bounded window slightly past that
    // delay proves no third instance appears.
    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      await Bun.sleep(50);
      expect(port.instances).toHaveLength(2);
    }
  }, 10_000);

  test('destroy aborts a pending recovery and awaits the process stop', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));

    mpv.crash();
    await waitForAtom(store, playerStateAtom, 'stopped'); // recovery scheduled, sleeping
    await controller.destroy();

    // Recovery was aborted before its respawn: no second instance.
    expect(port.instances).toHaveLength(1);
    expect(port.stopCalls).toBe(1);
    expect(store.get(playerPlaybackAtom)).toBeNull();
    expect(store.get(playerStateAtom)).toBe('stopped');

    // Idempotent.
    await controller.destroy();
    expect(port.stopCalls).toBe(1);
  }, 10_000);

  test('unregister functions are safe to call twice', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    const mpv = await startPlaying(target);
    const ended: PlaybackTarget[] = [];
    const unregister = controller.onTrackEnd((t) => ended.push(t));
    unregister();
    unregister();
    mpv.pushEndFile(mpv.entryIdForLoad(1), 'eof');
    await waitForAtom(store, playerStateAtom, 'stopped');
    expect(ended).toHaveLength(0);
  });

  test('play rejects when the controller is destroyed', async () => {
    await startPlaying(makeTarget('a', 'https://example.com/a'));
    await controller.destroy();
    await expect(controller.play(makeTarget('b', 'https://example.com/b'))).rejects.toThrow(
      'destroyed',
    );
  });

  // ── Native load correlation ───────────────────────────────────────────

  test('events before the ACK: buffered lifecycle and properties commit only after the binding', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.manualLoadAck = true;
    const target = makeTarget('a', 'https://example.com/a');
    const loaded: PlaybackTarget[] = [];
    controller.onTrackLoaded((t) => loaded.push(t));

    const playing = controller.play(target);
    await mpv.expectCommand((c) => c.command[0] === 'loadfile');
    // mpv starts and finishes loading before the loadfile ACK is written.
    mpv.pushStartFile(7);
    mpv.pushFileLoaded();
    mpv.pushProperty(2, 'duration', 180);
    mpv.pushProperty(1, 'time-pos', 3);
    expect(store.get(playerStateAtom)).toBe('buffering');
    expect(loaded).toEqual([]);
    expect(store.get(playerDurationAtom)).toBe(0);

    mpv.ackLoadfile(7);
    await playing;
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(loaded).toEqual([target]);
    // The latest buffered file-scoped values landed with the commit.
    expect(store.get(playerDurationAtom)).toBe(180);
    expect(store.get(playerPositionAtom)).toBe(3);
  });

  test('a file that ends before its ACK never commits a loaded state', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.manualLoadAck = true;
    const target = makeTarget('a', 'https://example.com/a');
    const loaded: PlaybackTarget[] = [];
    const ended: PlaybackTarget[] = [];
    controller.onTrackLoaded((t) => loaded.push(t));
    controller.onTrackEnd((t) => ended.push(t));

    const playing = controller.play(target);
    await mpv.expectCommand((c) => c.command[0] === 'loadfile');
    mpv.pushStartFile(5);
    mpv.pushEndFile(5, 'eof');
    mpv.ackLoadfile(5);
    await playing;

    expect(ended).toEqual([target]);
    expect(loaded).toEqual([]);
    expect(store.get(playerStateAtom)).toBe('stopped');
  });

  test('superseded unsent loads are skipped; the newest intent wins', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.manualLoadAck = true;

    const playA = controller.play(makeTarget('a', 'https://example.com/a', 1));
    await mpv.expectCommand((c) => c.command[1] === 'https://example.com/a');
    // While A's handshake is unbound, B then C supersede each other before
    // their commands are ever sent.
    const playB = controller.play(makeTarget('b', 'https://example.com/b', 2));
    const playC = controller.play(makeTarget('c', 'https://example.com/c', 3));

    mpv.ackLoadfile(1); // A's late ACK finally arrives
    await mpv.expectCommand((c) => c.command[1] === 'https://example.com/c');
    mpv.ackLoadfile(2);

    // All three settle: B as a cancellation outcome, never a playback error.
    await Promise.all([playA, playB, playC]);
    expect(mpv.loadfileUrls()).toEqual(['https://example.com/a', 'https://example.com/c']);
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('c');
  });

  test('a loadfile ACK without a valid entry identity is a protocol failure', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.manualLoadAck = true;
    const target = makeTarget('a', 'https://example.com/a');

    const playing = controller.play(target);
    await mpv.expectCommand((c) => c.command[0] === 'loadfile');
    mpv.ackLoadfileWithoutIdentity(null);
    await expect(playing).rejects.toThrow('playlist_entry_id');

    // No binding was established: later events for that entry commit nothing.
    mpv.pushStartFile(1);
    mpv.pushFileLoaded();
    mpv.pushProperty(4, 'volume', 60);
    await waitForAtom(store, playerVolumeAtom, 60);
    expect(store.get(playerStateAtom)).toBe('stopped');
  });

  test('old-entry EOF and error after a newer load cannot advance or error the newer target', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    const ended: PlaybackTarget[] = [];
    controller.onTrackEnd((t) => ended.push(t));

    await controller.play(makeTarget('b', 'https://example.com/b', 2));
    mpv.pushStartFile(mpv.entryIdForLoad(2));
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');

    // The replaced file's explicit old-entry terminations arrive late.
    mpv.pushEndFile(mpv.entryIdForLoad(1), 'eof');
    mpv.pushEndFile(mpv.entryIdForLoad(1), 'error', { file_error: 'boom' });
    mpv.pushProperty(4, 'volume', 51);
    await waitForAtom(store, playerVolumeAtom, 51);
    expect(ended).toEqual([]);
    expect(store.get(playerErrorAtom)).toBeNull();
    expect(store.get(playerStateAtom)).toBe('playing');
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('b');
  });

  test('an old file-loaded before the new intent cannot commit the new source', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    const loaded: PlaybackTarget[] = [];
    controller.onTrackLoaded((t) => loaded.push(t));

    // The old file finishes loading right after B's intent was issued, so
    // its file-loaded belongs to A's stream-ordered entry — never to B.
    await controller.play(makeTarget('b', 'https://example.com/b', 2));
    await mpv.expectCommand((c) => c.command[1] === 'https://example.com/b');
    mpv.pushFileLoaded();
    mpv.pushProperty(4, 'volume', 52);
    await waitForAtom(store, playerVolumeAtom, 52);
    expect(loaded).toEqual([]); // the old entry's loaded event commits nothing new
    expect(store.get(playerStateAtom)).toBe('buffering');
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('b');
  });

  test('duplicate file-loaded events commit exactly once', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    await controller.init();
    await controller.play(target);
    const mpv = port.instances[0];
    const loaded: PlaybackTarget[] = [];
    controller.onTrackLoaded((t) => loaded.push(t));
    const entry = mpv.entryIdForLoad(1);
    mpv.pushStartFile(entry);
    mpv.pushFileLoaded();
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(loaded).toEqual([target]);
  });

  test('malformed event entry ids never mutate committed state', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    const ended: PlaybackTarget[] = [];
    controller.onTrackEnd((t) => ended.push(t));

    mpv.pushEvent({ event: 'end-file', reason: 'eof', playlist_entry_id: '1' });
    mpv.pushEvent({ event: 'end-file', reason: 'eof', playlist_entry_id: -1 });
    mpv.pushEvent({ event: 'end-file', reason: 'eof' });
    mpv.pushProperty(4, 'volume', 61);
    await waitForAtom(store, playerVolumeAtom, 61);
    expect(ended).toEqual([]);
    expect(store.get(playerStateAtom)).toBe('playing');

    // A start-file with a malformed id cannot seed attribution either.
    mpv.pushEvent({ event: 'start-file', playlist_entry_id: 1.5 });
    mpv.pushFileLoaded();
    mpv.pushProperty(4, 'volume', 62);
    await waitForAtom(store, playerVolumeAtom, 62);
    expect(store.get(playerStateAtom)).toBe('playing');
  });

  test('unknown start-file entries cannot commit a load or mutate the newer target', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    const loaded: PlaybackTarget[] = [];
    controller.onTrackLoaded((t) => loaded.push(t));

    await controller.play(makeTarget('b', 'https://example.com/b', 2));
    await mpv.expectCommand((c) => c.command[1] === 'https://example.com/b');
    // An entry mpv started that no unbound handshake of ours can own…
    mpv.pushStartFile(99);
    mpv.pushFileLoaded();
    // …and the previous file's ticks still flowing.
    mpv.pushProperty(1, 'time-pos', 77);
    mpv.pushProperty(2, 'duration', 300);
    mpv.pushProperty(4, 'volume', 63);
    await waitForAtom(store, playerVolumeAtom, 63);
    expect(store.get(playerStateAtom)).toBe('buffering');
    expect(loaded).toEqual([]);
    expect(store.get(playerPositionAtom)).toBe(0);
    expect(store.get(playerDurationAtom)).toBe(0);

    // B's real entry still commits normally afterwards.
    mpv.pushStartFile(mpv.entryIdForLoad(2));
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('b');
  });

  test('file-scoped values observed while loading land when the binding commits', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    await controller.play(makeTarget('b', 'https://example.com/b', 2));
    mpv.pushStartFile(mpv.entryIdForLoad(2));
    // B's duration arrives after its start-file but before file-loaded.
    mpv.pushProperty(2, 'duration', 222);
    mpv.pushProperty(4, 'volume', 65);
    await waitForAtom(store, playerVolumeAtom, 65);
    expect(store.get(playerDurationAtom)).toBe(0);
    expect(store.get(playerStateAtom)).toBe('buffering');

    mpv.pushFileLoaded();
    await waitForAtom(store, playerDurationAtom, 222);
    expect(store.get(playerStateAtom)).toBe('playing');
  });

  test('native entry ids are epoch-scoped: reuse after recovery binds fresh', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    const mpv = await startPlaying(target); // entry 1 in the first epoch

    mpv.crash();
    await waitForAtom(store, playerStateAtom, 'stopped');
    await waitUntil(() => port.instances.length >= 2, 'recovery respawn');
    const revived = port.instances[1];
    await revived.expectCommand((c) => c.command[0] === 'loadfile');
    // A fresh mpv hands out the same native id again.
    expect(revived.entryIdForLoad(1)).toBe(1);

    const loaded: PlaybackTarget[] = [];
    controller.onTrackLoaded((t) => loaded.push(t));
    revived.pushStartFile(1);
    revived.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    // Committed through the NEW epoch's binding, not a stale one.
    expect(loaded).toEqual([target]);

    const ended: PlaybackTarget[] = [];
    controller.onTrackEnd((t) => ended.push(t));
    revived.pushEndFile(1, 'eof');
    await waitForAtom(store, playerStateAtom, 'stopped');
    expect(ended).toEqual([target]);
  });

  test('terminal facts buffered before the ACK apply only when the identity matches', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.manualLoadAck = true;
    const target = makeTarget('a', 'https://example.com/a');
    const ended: PlaybackTarget[] = [];
    controller.onTrackEnd((t) => ended.push(t));

    const playing = controller.play(target);
    await mpv.expectCommand((c) => c.command[0] === 'loadfile');
    mpv.pushStartFile(9);
    mpv.pushEndFile(9, 'eof');
    // The eventual ACK names a different entry: 9 was never ours to end.
    mpv.ackLoadfile(10);
    await playing;

    expect(ended).toEqual([]);
    // Our own acknowledged entry (10) is still legitimately loading.
    expect(store.get(playerStateAtom)).toBe('buffering');
    expect(store.get(playerPlaybackAtom)).toBe(target);

    mpv.pushStartFile(10);
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
  });

  test('terminal facts buffered before a malformed ACK are never applied', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.manualLoadAck = true;
    const target = makeTarget('a', 'https://example.com/a');
    const ended: PlaybackTarget[] = [];
    controller.onTrackEnd((t) => ended.push(t));

    const playing = controller.play(target);
    await mpv.expectCommand((c) => c.command[0] === 'loadfile');
    mpv.pushStartFile(9);
    mpv.pushEndFile(9, 'error', { file_error: 'the old file broke' });
    mpv.ackLoadfileWithoutIdentity(null);
    await expect(playing).rejects.toThrow('playlist_entry_id');

    expect(ended).toEqual([]);
    expect(store.get(playerErrorAtom)).toBeNull();
    expect(store.get(playerStateAtom)).toBe('stopped');
  });

  test('a native single-entry redirect transfers ownership to the inserted child', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    await controller.init();
    await controller.play(target);
    const mpv = port.instances[0];
    const loaded: PlaybackTarget[] = [];
    const ended: PlaybackTarget[] = [];
    controller.onTrackLoaded((t) => loaded.push(t));
    controller.onTrackEnd((t) => ended.push(t));

    const parent = mpv.entryIdForLoad(1);
    mpv.pushStartFile(parent);
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(loaded).toEqual([target]);

    // mpv redirects the stream: the acknowledged entry ends and one child is
    // inserted natively — no loadfile of ours ever happens for it.
    mpv.pushEvent({
      event: 'end-file',
      reason: 'redirect',
      playlist_entry_id: parent,
      playlist_insert_id: 2,
      playlist_insert_num_entries: 1,
    });
    mpv.pushStartFile(2);
    mpv.pushFileLoaded();
    mpv.pushProperty(1, 'time-pos', 12);
    await waitForAtom(store, playerPositionAtom, 12);
    // The inherited child keeps the stream alive without re-announcing it.
    expect(loaded).toEqual([target]);
    expect(store.get(playerStateAtom)).toBe('playing');

    // The child's EOF still advances the queue exactly once.
    mpv.pushEndFile(2, 'eof');
    await waitForAtom(store, playerStateAtom, 'stopped');
    expect(ended).toEqual([target]);
  });

  test('a redirect observed before its ACK inherits through the matching binding', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.manualLoadAck = true;
    const target = makeTarget('a', 'https://example.com/a');
    const loaded: PlaybackTarget[] = [];
    const ended: PlaybackTarget[] = [];
    controller.onTrackLoaded((t) => loaded.push(t));
    controller.onTrackEnd((t) => ended.push(t));

    const playing = controller.play(target);
    await mpv.expectCommand((c) => c.command[0] === 'loadfile');
    // The parent never loads: mpv redirects immediately, before the ACK.
    mpv.pushStartFile(4);
    mpv.pushEvent({
      event: 'end-file',
      reason: 'redirect',
      playlist_entry_id: 4,
      playlist_insert_id: 5,
      playlist_insert_num_entries: 1,
    });
    mpv.ackLoadfile(4);
    await playing;

    mpv.pushStartFile(5);
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'playing');
    expect(loaded).toEqual([target]);

    mpv.pushEndFile(5, 'eof');
    await waitForAtom(store, playerStateAtom, 'stopped');
    expect(ended).toEqual([target]);
  });

  test('an ambiguous multi-entry redirect expansion fails safely instead of hanging', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushEvent({
      event: 'end-file',
      reason: 'redirect',
      playlist_entry_id: mpv.entryIdForLoad(1),
      playlist_insert_id: 2,
      playlist_insert_num_entries: 3,
    });
    await waitForAtom(
      store,
      playerErrorAtom,
      'mpv redirected playback to an untrackable playlist — playback stopped',
    );
    // The unowned native audio is stopped, not left playing.
    await mpv.expectCommand((c) => c.command[0] === 'stop');
    expect(store.get(playerStateAtom)).toBe('stopped');

    // The inserted children commit nothing afterwards.
    mpv.pushStartFile(2);
    mpv.pushFileLoaded();
    mpv.pushProperty(4, 'volume', 78);
    await waitForAtom(store, playerVolumeAtom, 78);
    expect(store.get(playerStateAtom)).toBe('stopped');
  });

  test('a redirect without a usable insert identity fails safely', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushEvent({
      event: 'end-file',
      reason: 'redirect',
      playlist_entry_id: mpv.entryIdForLoad(1),
    });
    await waitForAtom(
      store,
      playerErrorAtom,
      'mpv redirected playback to an untrackable playlist — playback stopped',
    );
    await mpv.expectCommand((c) => c.command[0] === 'stop');
    expect(store.get(playerStateAtom)).toBe('stopped');
  });

  // ── Source-switch pause contract ──────────────────────────────────────

  test('preservePause keeps mpv pause across a source switch', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushProperty(3, 'pause', true);
    await waitForAtom(store, playerStateAtom, 'paused');

    const before = mpv.commands.length;
    await controller.play(makeTarget('b', 'https://example.com/b', 2), { preservePause: true });
    // No unpause is sent for the switch: only the loadfile command itself.
    const sent = mpv.commands.slice(before).map((c) => String(c.command[0]));
    expect(sent).toEqual(['loadfile']);

    mpv.pushStartFile(mpv.entryIdForLoad(2));
    mpv.pushFileLoaded();
    // The actual mpv pause carried through the load.
    await waitForAtom(store, playerStateAtom, 'paused');
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('b');
  });

  test('a user pause change during a preservePause load is preserved', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.manualLoadAck = true;

    const play = controller.play(makeTarget('b', 'https://example.com/b', 2), {
      preservePause: true,
    });
    await mpv.expectCommand((c) => c.command[1] === 'https://example.com/b');
    // The user pauses while the replacement is still loading.
    mpv.pushProperty(3, 'pause', true);
    mpv.ackLoadfile();
    await play;

    mpv.pushStartFile(mpv.entryIdForLoad(2));
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'paused');
  });

  test('a superseded ordinary load never flips the pause state it did not command', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushProperty(3, 'pause', true);
    await waitForAtom(store, playerStateAtom, 'paused');
    mpv.manualLoadAck = true;

    const mark = mpv.commands.length;
    // A preserve load blocks the pipeline on its unbound handshake…
    const playX = controller.play(makeTarget('x', 'https://example.com/x', 2), {
      preservePause: true,
    });
    await mpv.expectCommand((c) => c.command[1] === 'https://example.com/x');
    // …an ordinary intent is queued behind it…
    const playB = controller.play(makeTarget('b', 'https://example.com/b', 3));
    // …and is itself superseded before its command was ever sent.
    const playC = controller.play(makeTarget('c', 'https://example.com/c', 4), {
      preservePause: true,
    });

    mpv.ackLoadfile(); // X's ACK frees the pipeline for C
    await mpv.expectCommand((c) => c.command[1] === 'https://example.com/c');
    mpv.ackLoadfile();
    await Promise.all([playX, playB, playC]);

    // Nothing but the two loadfiles was sent: no unpause B never commanded.
    const sent = mpv.commands.slice(mark).map((c) => String(c.command[0]));
    expect(sent).toEqual(['loadfile', 'loadfile']);

    // mpv is still paused and the UI agrees once C loads.
    mpv.pushStartFile(mpv.entryIdForLoad(3));
    mpv.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'paused');
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('c');
  });

  test('a preserve load taking over a paused recovery reappears paused', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushProperty(1, 'time-pos', 30);
    await waitForAtom(store, playerPositionAtom, 30);
    mpv.pushProperty(3, 'pause', true);
    await waitForAtom(store, playerStateAtom, 'paused');

    mpv.crash();
    await waitForAtom(store, playerStateAtom, 'stopped');
    // The source switch rides the respawn instead of resuming A.
    await controller.play(makeTarget('b', 'https://example.com/b', 2), { preservePause: true });

    const revived = port.instances[1];
    // The dead process's pause cannot be inherited by a fresh process — the
    // recovery transfers it to the surviving preserve load's command.
    const pauseIdx = revived.commands.findIndex(
      (c) => c.command[0] === 'set_property' && c.command[1] === 'pause' && c.command[2] === true,
    );
    const loadIdx = revived.commands.findIndex((c) => c.command[0] === 'loadfile');
    expect(pauseIdx).toBeGreaterThanOrEqual(0);
    expect(pauseIdx).toBeLessThan(loadIdx);

    revived.pushStartFile(revived.entryIdForLoad(1));
    revived.pushFileLoaded();
    await waitForAtom(store, playerStateAtom, 'paused');
    expect(store.get(playerPlaybackAtom)?.track.id).toBe('b');
  });

  test('recovery reapplies the captured pause before the reload and the position after it', async () => {
    const target = makeTarget('a', 'https://example.com/a');
    const mpv = await startPlaying(target);
    mpv.pushProperty(1, 'time-pos', 50);
    await waitForAtom(store, playerPositionAtom, 50);
    mpv.pushProperty(3, 'pause', true);
    await waitForAtom(store, playerStateAtom, 'paused');

    mpv.crash();
    await waitForAtom(store, playerStateAtom, 'stopped');
    await waitUntil(() => port.instances.length >= 2, 'recovery respawn');
    const revived = port.instances[1];
    const load = await revived.expectCommand((c) => c.command[0] === 'loadfile');
    // Pause is reapplied before the reload so the file stands still.
    const pauseIdx = revived.commands.findIndex(
      (c) => c.command[0] === 'set_property' && c.command[1] === 'pause' && c.command[2] === true,
    );
    expect(pauseIdx).toBeGreaterThanOrEqual(0);
    expect(pauseIdx).toBeLessThan(revived.commands.indexOf(load));

    revived.pushStartFile(revived.entryIdForLoad(1));
    revived.pushFileLoaded();
    const seek = await revived.expectCommand((c) => c.command[0] === 'seek');
    expect(seek.command[1]).toBe(50);
    revived.pushProperty(3, 'pause', true);
    await waitForAtom(store, playerStateAtom, 'paused');
    expect(store.get(playerPositionAtom)).toBe(50);
  });

  // ── Process identity and audio backend ────────────────────────────────

  test('process identity is published per spawn and cleared on failure/destroy', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    const first = store.get(playerProcessIdentityAtom);
    expect(first).not.toBeNull();
    expect(first?.clientName).toMatch(/^TuiTunes-/);
    expect(first?.socketPath).toBe(port.instances[0].socketPath);

    mpv.crash();
    // The failed process's identity is cleared immediately.
    await waitForAtom(store, playerProcessIdentityAtom, null);
    await waitUntil(() => port.instances.length >= 2, 'recovery respawn');
    await waitUntil(
      () => store.get(playerProcessIdentityAtom)?.socketPath === port.instances[1].socketPath,
      'recovery identity published',
    );
    const second = store.get(playerProcessIdentityAtom);
    expect(second?.clientName).not.toBe(first?.clientName);
    expect(second?.pid).not.toBe(first?.pid);

    await controller.destroy();
    expect(store.get(playerProcessIdentityAtom)).toBeNull();
    expect(store.get(playerAudioBackendAtom)).toBeNull();
  });

  test('current-ao observations normalize into playerAudioBackendAtom', async () => {
    const mpv = await startPlaying(makeTarget('a', 'https://example.com/a'));
    mpv.pushProperty(14, 'current-ao', 'pulse');
    await waitForAtom(store, playerAudioBackendAtom, 'pulse');
    mpv.pushProperty(14, 'current-ao', 'alsa');
    await waitForAtom(store, playerAudioBackendAtom, 'unsupported');
    // Unavailable (absent data) and invalid payloads must not overwrite it.
    mpv.pushProperty(14, 'current-ao');
    mpv.pushProperty(14, 'current-ao', 42);
    mpv.pushProperty(4, 'volume', 70);
    await waitForAtom(store, playerVolumeAtom, 70);
    expect(store.get(playerAudioBackendAtom)).toBe('unsupported');
  });

  test('current-ao is file-scoped: reports before any commit do not publish', async () => {
    await controller.init();
    const mpv = port.instances[0];
    mpv.pushProperty(14, 'current-ao', 'pipewire');
    mpv.pushProperty(4, 'volume', 71);
    await waitForAtom(store, playerVolumeAtom, 71);
    expect(store.get(playerAudioBackendAtom)).toBeNull();
  });
});
