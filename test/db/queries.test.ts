import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/db/index';
import {
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavorites,
  addToHistory,
  getHistory,
  clearHistory,
} from '../../src/db/queries';
import type { Track } from '../../src/providers/types';

const testTrack: Track = {
  id: 'abc123',
  provider: 'youtube',
  title: 'Test',
  artist: 'Artist',
  duration: 200,
};

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

describe('favorites', () => {
  test('addFavorite + isFavorite returns true', () => {
    addFavorite(db, testTrack);
    expect(isFavorite(db, testTrack)).toBe(true);
  });

  test('removeFavorite + isFavorite returns false', () => {
    addFavorite(db, testTrack);
    removeFavorite(db, testTrack);
    expect(isFavorite(db, testTrack)).toBe(false);
  });

  test('getFavorites returns tracks in added_at DESC order', async () => {
    const trackA: Track = { ...testTrack, id: 'a', title: 'First' };
    const trackB: Track = { ...testTrack, id: 'b', title: 'Second' };

    addFavorite(db, trackA);
    // Small delay so added_at differs
    await Bun.sleep(5);
    addFavorite(db, trackB);

    const favs = getFavorites(db);
    expect(favs.length).toBe(2);
    expect(favs[0].title).toBe('Second');
    expect(favs[1].title).toBe('First');
  });

  test('addFavorite same track twice does not duplicate', () => {
    addFavorite(db, testTrack);
    addFavorite(db, testTrack);
    const favs = getFavorites(db);
    expect(favs.length).toBe(1);
  });
});

describe('history', () => {
  test('addToHistory + getHistory returns track', () => {
    addToHistory(db, testTrack);
    const history = getHistory(db);
    expect(history.length).toBe(1);
    expect(history[0].id).toBe('abc123');
    expect(history[0].provider).toBe('youtube');
    expect(history[0].title).toBe('Test');
    expect(history[0].artist).toBe('Artist');
  });

  test('getHistory limit works', () => {
    for (let i = 0; i < 5; i++) {
      addToHistory(db, { ...testTrack, id: `track${i}` });
    }
    const history = getHistory(db, 3);
    expect(history.length).toBe(3);
  });

  test('clearHistory empties table', () => {
    addToHistory(db, testTrack);
    clearHistory(db);
    const history = getHistory(db);
    expect(history.length).toBe(0);
  });
});
