import type { Store } from 'jotai/vanilla/store';
import type { PlayerPort } from '../../src/player/controller';
import type { PlayerLoadOptions } from '../../src/player/types';
import type { PlaybackTarget } from '../../src/providers/types';
import {
  playerDurationAtom,
  playerNoticeAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerSeekableRequestAtom,
  playerStateAtom,
} from '../../src/store/player';

export interface TestPlayer {
  player: PlayerPort;
  played: PlaybackTarget[];
  loadOptions: PlayerLoadOptions[];
  readonly stopCalls: number;
  emitLoaded(target: PlaybackTarget): void;
  emitEnd(target: PlaybackTarget): void;
  /**
   * Simulate confirmed playback progress: position (and optionally
   * duration), confirming seekability for the current playback unless
   * `seekable: false` is given.
   */
  emitPosition(position: number, options?: { duration?: number; seekable?: boolean }): void;
}

export function createTestPlayer(store: Store): TestPlayer {
  const played: PlaybackTarget[] = [];
  const loadOptions: Array<{ preservePause?: boolean }> = [];
  let paused = false;
  const ended = new Set<(target: PlaybackTarget) => void>();
  const loaded = new Set<(target: PlaybackTarget) => void>();
  let stopCalls = 0;
  const player: PlayerPort = {
    async play(target, options = {}) {
      played.push(target);
      loadOptions.push(options);
      if (!options.preservePause) paused = false;
      // Readiness and notices are cleared before the visible reset, like
      // the real controller.
      store.set(playerNoticeAtom, null);
      store.set(playerSeekableRequestAtom, null);
      store.set(playerPlaybackAtom, target);
      store.set(playerPositionAtom, 0);
      store.set(playerDurationAtom, 0);
      store.set(playerStateAtom, 'buffering');
    },
    async stop() {
      ++stopCalls;
      store.set(playerPlaybackAtom, null);
      store.set(playerSeekableRequestAtom, null);
      store.set(playerStateAtom, 'stopped');
    },
    async togglePause() {
      paused = !paused;
      if (store.get(playerPlaybackAtom)) store.set(playerStateAtom, paused ? 'paused' : 'playing');
    },
    async seekRelative() {},
    async seekAbsolute() {},
    async setVolume() {},
    async addVolume() {},
    async toggleMute() {},
    async setSpeed() {},
    async cycleSpeedUp() {},
    async cycleSpeedDown() {},
    onTrackEnd(handler) {
      ended.add(handler);
      return () => {
        ended.delete(handler);
      };
    },
    onTrackLoaded(handler) {
      loaded.add(handler);
      return () => {
        loaded.delete(handler);
      };
    },
  };
  return {
    player,
    played,
    loadOptions,
    get stopCalls() {
      return stopCalls;
    },
    emitLoaded(target: PlaybackTarget) {
      if (store.get(playerPlaybackAtom)?.requestId === target.requestId) {
        store.set(playerStateAtom, paused ? 'paused' : 'playing');
      }
      for (const callback of loaded) callback(target);
    },
    emitPosition(position: number, options?: { duration?: number; seekable?: boolean }): void {
      store.set(playerPositionAtom, position);
      if (typeof options?.duration === 'number') {
        store.set(playerDurationAtom, options.duration);
      }
      const target = store.get(playerPlaybackAtom);
      if (target && options?.seekable !== false) {
        store.set(playerSeekableRequestAtom, target.requestId);
      }
    },
    emitEnd(target: PlaybackTarget) {
      if (store.get(playerPlaybackAtom)?.requestId === target.requestId)
        store.set(playerStateAtom, 'stopped');
      for (const callback of ended) callback(target);
    },
  };
}
