import { describe, test, expect, beforeEach } from 'bun:test';
import { createStore } from 'jotai';
import {
  playerPositionAtom,
  playerDurationAtom,
  playerVolumeAtom,
  playerMuteAtom,
  playerStateAtom,
  playerTrackAtom,
  playerProgressAtom,
} from '../../src/store/player';

describe('player store', () => {
  let store: ReturnType<typeof createStore>;

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

    test('track is null', () => {
      expect(store.get(playerTrackAtom)).toBeNull();
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
