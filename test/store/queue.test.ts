import { describe, test, expect, beforeEach } from 'bun:test';
import { createStore } from 'jotai';
import type { Track } from '../../src/providers/types';
import {
  queueAtom,
  queueIndexAtom,
  repeatAtom,
  shuffleAtom,
  shuffledIndicesAtom,
  currentTrackAtom,
} from '../../src/store/queue';

function makeTrack(n: number): Track {
  return {
    id: String(n),
    provider: 'youtube',
    title: `Track ${n}`,
    artist: 'Artist',
    duration: 200,
  };
}

const tracks = [makeTrack(1), makeTrack(2), makeTrack(3)];

describe('queue store', () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  describe('initial values', () => {
    test('queue is empty', () => {
      expect(store.get(queueAtom)).toEqual([]);
    });

    test('index is 0', () => {
      expect(store.get(queueIndexAtom)).toBe(0);
    });

    test('repeat is off', () => {
      expect(store.get(repeatAtom)).toBe('off');
    });

    test('shuffle is false', () => {
      expect(store.get(shuffleAtom)).toBe(false);
    });

    test('shuffledIndices is empty', () => {
      expect(store.get(shuffledIndicesAtom)).toEqual([]);
    });
  });

  describe('currentTrackAtom', () => {
    test('empty queue returns null', () => {
      expect(store.get(currentTrackAtom)).toBeNull();
    });

    test('index 0 returns first track', () => {
      store.set(queueAtom, tracks);
      store.set(queueIndexAtom, 0);
      expect(store.get(currentTrackAtom)).toEqual(tracks[0]);
    });

    test('index 2 returns third track', () => {
      store.set(queueAtom, tracks);
      store.set(queueIndexAtom, 2);
      expect(store.get(currentTrackAtom)).toEqual(tracks[2]);
    });

    test('index out of bounds returns null', () => {
      store.set(queueAtom, tracks);
      store.set(queueIndexAtom, 5);
      expect(store.get(currentTrackAtom)).toBeNull();
    });

    test('negative index returns null', () => {
      store.set(queueAtom, tracks);
      store.set(queueIndexAtom, -1);
      expect(store.get(currentTrackAtom)).toBeNull();
    });

    describe('shuffle mode', () => {
      beforeEach(() => {
        store.set(queueAtom, tracks);
        store.set(shuffleAtom, true);
        store.set(shuffledIndicesAtom, [2, 0, 1]);
      });

      test('index 0 maps through shuffledIndices to queue[2]', () => {
        store.set(queueIndexAtom, 0);
        expect(store.get(currentTrackAtom)).toEqual(tracks[2]);
      });

      test('index 1 maps through shuffledIndices to queue[0]', () => {
        store.set(queueIndexAtom, 1);
        expect(store.get(currentTrackAtom)).toEqual(tracks[0]);
      });

      test('index beyond shuffledIndices length returns null', () => {
        store.set(queueIndexAtom, 5);
        expect(store.get(currentTrackAtom)).toBeNull();
      });

      test('shuffledIndices points to out-of-bounds queue index returns null', () => {
        store.set(shuffledIndicesAtom, [99, 0, 1]);
        store.set(queueIndexAtom, 0);
        expect(store.get(currentTrackAtom)).toBeNull();
      });
    });
  });

  describe('currentTrackAtom is read-only', () => {
    test('setting it throws', () => {
      expect(() => {
        // @ts-expect-error — derived atom is read-only
        store.set(currentTrackAtom, null);
      }).toThrow();
    });
  });
});
