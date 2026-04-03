import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations, getDb, initDb } from '../../src/db/index';
import {
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavorites,
  addToHistory,
  getHistory,
  clearHistory,
  subscribeFeed,
  unsubscribeFeed,
  getSubscribedFeeds,
  isSubscribed,
} from '../../src/db/queries';
import type { Track } from '../../src/providers/types';
import type { Podcast } from '../../src/providers/podcast-types';

const testTrack: Track = {
  id: 'abc123',
  provider: 'youtube',
  title: 'Test',
  artist: 'Artist',
  duration: 200,
};

const testPodcast: Podcast = {
  id: 'pod123',
  title: 'Test Podcast',
  author: 'Test Author',
  description: 'A test podcast',
  feedUrl: 'https://example.com/feed.xml',
  artworkUrl: 'https://example.com/art.jpg',
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

describe('podcast feeds', () => {
  test('subscribeFeed + isSubscribed returns true', () => {
    subscribeFeed(db, testPodcast);
    expect(isSubscribed(db, testPodcast.feedUrl)).toBe(true);
  });

  test('unsubscribeFeed + isSubscribed returns false', () => {
    subscribeFeed(db, testPodcast);
    unsubscribeFeed(db, testPodcast.feedUrl);
    expect(isSubscribed(db, testPodcast.feedUrl)).toBe(false);
  });

  test('getSubscribedFeeds returns podcasts in added_at DESC order', async () => {
    const podA: Podcast = { ...testPodcast, id: 'a', title: 'First Pod', feedUrl: 'https://example.com/a.xml' };
    const podB: Podcast = { ...testPodcast, id: 'b', title: 'Second Pod', feedUrl: 'https://example.com/b.xml' };

    subscribeFeed(db, podA);
    await Bun.sleep(5);
    subscribeFeed(db, podB);

    const feeds = getSubscribedFeeds(db);
    expect(feeds.length).toBe(2);
    expect(feeds[0].title).toBe('Second Pod');
    expect(feeds[1].title).toBe('First Pod');
  });

  test('subscribeFeed same podcast twice does not duplicate', () => {
    subscribeFeed(db, testPodcast);
    subscribeFeed(db, testPodcast);
    const feeds = getSubscribedFeeds(db);
    expect(feeds.length).toBe(1);
  });

  test('getSubscribedFeeds returns correct shape', () => {
    subscribeFeed(db, testPodcast);
    const feeds = getSubscribedFeeds(db);
    expect(feeds.length).toBe(1);
    const feed = feeds[0];
    expect(feed.id).toBe('pod123');
    expect(feed.title).toBe('Test Podcast');
    expect(feed.author).toBe('Test Author');
    expect(feed.description).toBe('A test podcast');
    expect(feed.feedUrl).toBe('https://example.com/feed.xml');
    expect(feed.artworkUrl).toBe('https://example.com/art.jpg');
  });

  test('isSubscribed returns false for unknown feed', () => {
    expect(isSubscribed(db, 'https://example.com/nonexistent.xml')).toBe(false);
  });

  test('unsubscribeFeed non-existent does not throw', () => {
    expect(() => unsubscribeFeed(db, 'https://example.com/nonexistent.xml')).not.toThrow();
  });
});

describe('db initialization', () => {
  test('getDb returns a Database instance', () => {
    const database = getDb();
    expect(database).toBeInstanceOf(Database);
  });

  test('getDb returns same instance on repeated calls', () => {
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  test('initDb does not throw', () => {
    expect(() => initDb()).not.toThrow();
  });
});
