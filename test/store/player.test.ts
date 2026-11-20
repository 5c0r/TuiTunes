import { beforeEach, describe, expect, test } from 'bun:test';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import type { Track } from '../../src/providers/types';
import {
  playerDurationAtom,
  playerErrorAtom,
  playerMuteAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerProgressAtom,
  playerStateAtom,
  playerTrackAtom,
  playerVolumeAtom,
} from '../../src/store/player';

function makeTrack(id: string): Track {
  return {
    id,
    provider: 'youtube',
    source: { kind: 'youtube', videoId: id },
    title: `Track ${id}`,
    artist: 'Artist',
    duration: 100,
  };
}

describe('player store', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  describe('initial values', () => {
    test('position is 0', () => {
      expect(store.get(playerPositionAtom)).toBe(0);
    });

    test('duration is 0', () => {
      expect(store.get(playerDurationAtom)).toBe(0);
    });

    test('volume is 100', () => {
      expect(store.get(playerVolumeAtom)).toBe(100);
    });

    test('mute is false', () => {
      expect(store.get(playerMuteAtom)).toBe(false);
    });

    test('state is stopped', () => {
      expect(store.get(playerStateAtom)).toBe('stopped');
    });

    test('playback target is null', () => {
      expect(store.get(playerPlaybackAtom)).toBeNull();
    });

    test('track is null', () => {
      expect(store.get(playerTrackAtom)).toBeNull();
    });

    test('error is null', () => {
      expect(store.get(playerErrorAtom)).toBeNull();
    });
  });

  describe('playerTrackAtom derives from playerPlaybackAtom', () => {
    test('setting a playback target publishes its track', () => {
      const track = makeTrack('abc');
      store.set(playerPlaybackAtom, {
        track,
        source: {
          kind: 'youtube',
          url: 'https://example.com/stream',
          videoId: 'abc',
          selection: 'auto',
        },
        requestId: 1,
        origin: { kind: 'direct' },
      });
      expect(store.get(playerTrackAtom)).toBe(track);
    });

    test('clearing the playback target clears the track', () => {
      store.set(playerPlaybackAtom, {
        track: makeTrack('abc'),
        source: {
          kind: 'youtube',
          url: 'https://example.com/stream',
          videoId: 'abc',
          selection: 'auto',
        },
        requestId: 1,
        origin: { kind: 'direct' },
      });
      store.set(playerPlaybackAtom, null);
      expect(store.get(playerTrackAtom)).toBeNull();
    });

    test('playerTrackAtom is read-only', () => {
      expect(() => {
        // @ts-expect-error — derived atom is read-only
        store.set(playerTrackAtom, makeTrack('abc'));
      }).toThrow();
    });
  });

  describe('playerProgressAtom', () => {
    test('default: position=0, duration=0 → progress=0', () => {
      expect(store.get(playerProgressAtom)).toBe(0);
    });

    test('position=50, duration=100 → progress=0.5', () => {
      store.set(playerPositionAtom, 50);
      store.set(playerDurationAtom, 100);
      expect(store.get(playerProgressAtom)).toBe(0.5);
    });

    test('position=100, duration=100 → progress=1', () => {
      store.set(playerPositionAtom, 100);
      store.set(playerDurationAtom, 100);
      expect(store.get(playerProgressAtom)).toBe(1);
    });

    test('position past duration clamps progress to 1', () => {
      store.set(playerPositionAtom, 102);
      store.set(playerDurationAtom, 100);
      expect(store.get(playerProgressAtom)).toBe(1);
    });

    test('negative position clamps progress to 0', () => {
      store.set(playerPositionAtom, -1);
      store.set(playerDurationAtom, 100);
      expect(store.get(playerProgressAtom)).toBe(0);
    });

    test('duration=0 → progress=0 regardless of position', () => {
      store.set(playerPositionAtom, 999);
      store.set(playerDurationAtom, 0);
      expect(store.get(playerProgressAtom)).toBe(0);
    });

    test('position=0, duration=200 → progress=0', () => {
      store.set(playerPositionAtom, 0);
      store.set(playerDurationAtom, 200);
      expect(store.get(playerProgressAtom)).toBe(0);
    });
  });

  describe('playerProgressAtom is read-only', () => {
    test('setting it throws', () => {
      expect(() => {
        // @ts-expect-error — derived atom is read-only
        store.set(playerProgressAtom, 0.5);
      }).toThrow();
    });
  });
});
