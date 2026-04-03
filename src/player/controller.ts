import type { Store } from 'jotai/vanilla/store';
import { MpvIPC } from './ipc';
import { spawnMpv, killMpv, SOCKET_PATH } from './process';
import type { MpvEvent, PlayerState } from './types';
import type { Track } from '../providers/types';
import { getDb } from '../db/index';
import { addToHistory } from '../db/queries';
import {
  playerPositionAtom,
  playerDurationAtom,
  playerVolumeAtom,
  playerMuteAtom,
  playerSpeedAtom,
  playerStateAtom,
  playerTrackAtom,
} from '../store/player';
import { Logger } from '../utils/logger';

/**
 * High-level playback controller.
 * Owns the mpv process lifecycle and IPC connection.
 * Pushes state into the Jotai store so UI components re-render reactively.
 */
export class PlayerController {
  private ipc = new MpvIPC();
  private store: Store;
  private currentTrack: Track | null = null;
  private lastPosition = 0;
  private _destroyed = false;
  private _onTrackEnd: (() => void) | null = null;
  private _recovering = false;
  private _lastRecoveryAttempt = 0;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * Register a callback for when the current track finishes (EOF).
   * Used by the UI layer to auto-advance the queue.
   */
  onTrackEnd(handler: () => void): void {
    this._onTrackEnd = handler;
  }

  /**
   * Spawn mpv, connect IPC, subscribe to property changes.
   * Must be called once at startup before any playback commands.
   */
  async init(): Promise<void> {
    await spawnMpv();
    await this.ipc.connect(SOCKET_PATH);

    this.ipc.onPropertyChange((name, value) => this.onPropertyChange(name, value));
    this.ipc.onEvent((event) => this.onEvent(event));
    this.ipc.onDisconnect(() => this.onDisconnect());

    await this.ipc.observeAll();
    Logger.info('PlayerController initialized');
  }

  /**
   * Load and play a track. Fetches the stream URL externally
   * (caller provides it), then sends loadfile to mpv.
   */
  async play(track: Track, streamUrl: string): Promise<void> {
    this.currentTrack = track;
    this.store.set(playerTrackAtom, track);
    this.store.set(playerStateAtom, 'buffering');

    try {
      await this.ipc.loadfile(streamUrl);
      // mpv will emit file-loaded → we set 'playing' there
    } catch (err) {
      Logger.error(`Failed to load track: ${err}`);
      this.store.set(playerStateAtom, 'stopped');
      throw err;
    }
  }

  async togglePause(): Promise<void> {
    await this.ipc.togglePause();
  }

  async seekRelative(seconds: number): Promise<void> {
    try {
      await this.ipc.seek(seconds, 'relative');
    } catch (err) {
      Logger.error(`Seek failed: ${err}`);
    }
  }

  async seekAbsolute(seconds: number): Promise<void> {
    // Clamp to valid range
    const duration = this.store.get(playerDurationAtom);
    const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    try {
      await this.ipc.seek(clamped, 'absolute+exact');
    } catch (err) {
      Logger.error(`Seek failed: ${err}`);
    }
  }

  async setVolume(volume: number): Promise<void> {
    await this.ipc.setVolume(volume);
  }

  async addVolume(delta: number): Promise<void> {
    await this.ipc.addVolume(delta);
  }

  async toggleMute(): Promise<void> {
    await this.ipc.toggleMute();
  }

  static readonly SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;

  async setSpeed(speed: number): Promise<void> {
    const clamped = Math.max(0.25, Math.min(4.0, speed));
    try {
      await this.ipc.command('set_property', 'speed', clamped);
    } catch (err) {
      Logger.error(`Set speed failed: ${err}`);
    }
  }

  async cycleSpeedUp(): Promise<void> {
    const current = this.store.get(playerSpeedAtom);
    const presets = PlayerController.SPEED_PRESETS;
    const next = presets.find((s) => s > current) ?? presets[presets.length - 1];
    await this.setSpeed(next);
  }

  async cycleSpeedDown(): Promise<void> {
    const current = this.store.get(playerSpeedAtom);
    const presets = PlayerController.SPEED_PRESETS;
    const prev = [...presets].reverse().find((s) => s < current) ?? presets[0];
    await this.setSpeed(prev);
  }

  async stop(): Promise<void> {
    await this.ipc.stop();
    this.currentTrack = null;
    this.store.set(playerStateAtom, 'stopped');
    this.store.set(playerTrackAtom, null);
    this.store.set(playerPositionAtom, 0);
    this.store.set(playerDurationAtom, 0);
  }

  /**
   * Gracefully shut down: stop playback, quit mpv, clean up.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      await this.ipc.quit();
    } catch {
      // mpv may already be dead
    }
    killMpv();
    Logger.info('PlayerController destroyed');
  }

  // --- Internal: mpv property/event handlers ---

  private onPropertyChange(name: string, value: unknown): void {
    // value is undefined when property is unavailable (no file loaded)
    if (value === undefined) return;

    switch (name) {
      case 'time-pos':
        this.lastPosition = value as number;
        this.store.set(playerPositionAtom, value as number);
        break;
      case 'duration':
        this.store.set(playerDurationAtom, value as number);
        break;
      case 'pause':
        this.store.set(
          playerStateAtom,
          (value as boolean) ? 'paused' : 'playing'
        );
        break;
      case 'volume':
        this.store.set(playerVolumeAtom, value as number);
        break;
      case 'mute':
        this.store.set(playerMuteAtom, value as boolean);
        break;
      case 'paused-for-cache':
        if (value as boolean) {
          this.store.set(playerStateAtom, 'buffering');
        }
        break;
      case 'speed':
        this.store.set(playerSpeedAtom, value as number);
        break;
    }
  }

  private onEvent(event: MpvEvent): void {
    switch (event.event) {
      case 'file-loaded':
        this.store.set(playerStateAtom, 'playing');
        // Log to history
        if (this.currentTrack) {
          try {
            addToHistory(getDb(), this.currentTrack);
          } catch (err) {
            Logger.error(`Failed to log history: ${err}`);
          }
        }
        break;

      case 'end-file': {
        const reason = event.reason as string | undefined;
        if (reason === 'eof') {
          Logger.info('Track ended (EOF)');
          this.store.set(playerStateAtom, 'stopped');
          this._onTrackEnd?.();
        } else if (reason === 'error') {
          const fileError = event.file_error as string | undefined;
          Logger.error(`mpv playback error: ${fileError ?? 'unknown'}`);
          this.store.set(playerStateAtom, 'stopped');
        }
        break;
      }

      case 'shutdown':
        Logger.warn('mpv shutdown event received');
        this.store.set(playerStateAtom, 'stopped');
        break;
    }
  }

  private onDisconnect(): void {
    if (this._destroyed) return;
    Logger.warn('mpv IPC disconnected unexpectedly');
    this.store.set(playerStateAtom, 'stopped');
    void this.attemptRecovery();
  }

  private async attemptRecovery(): Promise<void> {
    if (this._destroyed || this._recovering) return;

    const now = Date.now();
    if (now - this._lastRecoveryAttempt < 5000) {
      Logger.error('mpv crashed again within 5s \u2014 giving up recovery');
      return;
    }

    this._recovering = true;
    this._lastRecoveryAttempt = now;
    Logger.warn('Attempting mpv crash recovery...');

    try {
      await Bun.sleep(500);
      if (this._destroyed) {
        this._recovering = false;
        return;
      }

      await spawnMpv();
      await this.ipc.connect(SOCKET_PATH);
      this.ipc.onPropertyChange((name, value) => this.onPropertyChange(name, value));
      this.ipc.onEvent((event) => this.onEvent(event));
      this.ipc.onDisconnect(() => this.onDisconnect());
      await this.ipc.observeAll();

      if (this.currentTrack) {
        const track = this.currentTrack;
        const position = this.lastPosition;
        this.store.set(playerStateAtom, 'buffering');

        const { getActiveProvider } = await import('../providers/registry');
        const provider = getActiveProvider();
        const url = await provider.getStreamUrl(track);
        await this.ipc.loadfile(url);

        if (position > 2) {
          setTimeout(async () => {
            try {
              await this.ipc.seek(position, 'absolute+exact');
            } catch {
              // Seek may fail if file isn't loaded yet
            }
          }, 2000);
        }

        Logger.info(`Recovery complete \u2014 resumed ${track.title} at ${position.toFixed(0)}s`);
      } else {
        Logger.info('Recovery complete \u2014 no track to resume');
      }
    } catch (err) {
      Logger.error(`Recovery failed: ${err}`);
      this.store.set(playerStateAtom, 'stopped');
    } finally {
      this._recovering = false;
    }
  }
}
