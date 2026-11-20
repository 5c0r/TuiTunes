import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDb, runMigrations } from '../../src/db/index';
import {
  addFavorite,
  addToHistory,
  clearHistory,
  getFavorites,
  getHistory,
  getPlaybackSourcePreference,
  getSubscribedFeeds,
  getTranslation,
  isFavorite,
  isSubscribed,
  removeFavorite,
  saveTranslation,
  setPlaybackSourcePreference,
  subscribeFeed,
  unsubscribeFeed,
} from '../../src/db/queries';
import type { Podcast } from '../../src/providers/podcast-types';
import type { Track } from '../../src/providers/types';

const testTrack: Track = {
  id: 'abc123',
  provider: 'youtube',
  source: { kind: 'youtube', videoId: 'abc123' },
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

afterEach(() => {
  db.close();
  closeDb();
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
    const podA: Podcast = {
      ...testPodcast,
      id: 'a',
      title: 'First Pod',
      feedUrl: 'https://example.com/a.xml',
    };
    const podB: Podcast = {
      ...testPodcast,
      id: 'b',
      title: 'Second Pod',
      feedUrl: 'https://example.com/b.xml',
    };

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

describe('translations', () => {
  const key = {
    mediaKey: 'track1',
    sourceKey: 'lrclib',
    contentSha256: 'content',
    requestSha256: 'lingva-en',
    translationProvider: 'lingva',
    sourceLang: 'auto',
    targetLang: 'en',
  };
  test('cache identity separates backend, content, and language', () => {
    saveTranslation(db, key, ['Hello']);
    const deepL = { ...key, requestSha256: 'deepl-en', translationProvider: 'deepl' };
    saveTranslation(db, deepL, ['Different backend']);
    expect(getTranslation(db, key, 1)).toEqual(['Hello']);
    expect(getTranslation(db, deepL, 1)).toEqual(['Different backend']);
    expect(getTranslation(db, { ...key, contentSha256: 'changed' }, 1)).toBeNull();
    expect(
      getTranslation(db, { ...key, requestSha256: 'lingva-de', targetLang: 'de' }, 1),
    ).toBeNull();
  });
  test('corrupt rows and cardinality mismatches are evicted without deleting valid rows', () => {
    saveTranslation(db, key, ['Hello']);
    const other = { ...key, mediaKey: 'other' };
    saveTranslation(db, other, ['World']);
    db.prepare('UPDATE translations SET translated_lines=? WHERE media_key=?').run(
      '[42]',
      key.mediaKey,
    );
    expect(getTranslation(db, key, 1)).toBeNull();
    expect(getTranslation(db, other, 1)).toEqual(['World']);
    saveTranslation(db, key, ['Too', 'many']);
    expect(getTranslation(db, key, 1)).toBeNull();
  });
  test('versioned migration keeps newly cached values on later initialization', () => {
    saveTranslation(db, key, ['日本語']);
    runMigrations(db);
    expect(getTranslation(db, key, 1)).toEqual(['日本語']);
  });
});

describe('playback source preferences', () => {
  test('missing rows read as Auto', () => {
    expect(getPlaybackSourcePreference(db, '["youtube","v1"]')).toEqual({ mode: 'auto' });
  });

  test('explicit policies round-trip; Auto deletes the row', () => {
    setPlaybackSourcePreference(db, 'k1', { mode: 'rss' });
    expect(getPlaybackSourcePreference(db, 'k1')).toEqual({ mode: 'rss' });
    setPlaybackSourcePreference(db, 'k1', { mode: 'youtube-match' });
    expect(getPlaybackSourcePreference(db, 'k1')).toEqual({ mode: 'youtube-match' });
    setPlaybackSourcePreference(db, 'k1', { mode: 'youtube-video', videoId: 'dQw4w9WgXcQ' });
    expect(getPlaybackSourcePreference(db, 'k1')).toEqual({
      mode: 'youtube-video',
      videoId: 'dQw4w9WgXcQ',
    });
    setPlaybackSourcePreference(db, 'k1', { mode: 'auto' });
    expect(getPlaybackSourcePreference(db, 'k1')).toEqual({ mode: 'auto' });
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM playback_source_preferences').get(),
    ).toEqual({ n: 0 });
  });

  test('URL inputs normalize to the stored video ID; invalid IDs throw without writing', () => {
    setPlaybackSourcePreference(db, 'k2', {
      mode: 'youtube-video',
      videoId: 'https://youtu.be/dQw4w9WgXcQ?t=30',
    });
    expect(
      db
        .query<{ youtube_video_id: string }, [string]>(
          'SELECT youtube_video_id FROM playback_source_preferences WHERE media_key = ?',
        )
        .get('k2'),
    ).toEqual({ youtube_video_id: 'dQw4w9WgXcQ' });
    expect(() =>
      setPlaybackSourcePreference(db, 'k3', {
        mode: 'youtube-video',
        videoId: 'https://soundcloud.com/x',
      }),
    ).toThrow('Invalid YouTube video ID');
    expect(getPlaybackSourcePreference(db, 'k3')).toEqual({ mode: 'auto' });
  });

  test('invalid persisted video IDs warn and behave as Auto', () => {
    db.prepare(
      'INSERT INTO playback_source_preferences (media_key, mode, youtube_video_id) VALUES (?, ?, ?)',
    ).run('url-id', 'youtube-video', 'https://youtu.be/dQw4w9WgXcQ');
    db.prepare(
      'INSERT INTO playback_source_preferences (media_key, mode, youtube_video_id) VALUES (?, ?, ?)',
    ).run('short-id', 'youtube-video', 'short');
    expect(getPlaybackSourcePreference(db, 'url-id')).toEqual({ mode: 'auto' });
    expect(getPlaybackSourcePreference(db, 'short-id')).toEqual({ mode: 'auto' });
  });

  test('the schema constrains mode values and video-ID pairing', () => {
    expect(() =>
      db.exec("INSERT INTO playback_source_preferences VALUES ('x', 'auto', NULL)"),
    ).toThrow();
    expect(() =>
      db.exec("INSERT INTO playback_source_preferences VALUES ('x', 'youtube-video', NULL)"),
    ).toThrow();
    expect(() =>
      db.exec("INSERT INTO playback_source_preferences VALUES ('x', 'rss', 'dQw4w9WgXcQ')"),
    ).toThrow();
  });
});

describe('catalog metadata', () => {
  test('favorites round-trip artist/album IDs and refresh them on conflict', () => {
    addFavorite(db, { ...testTrack, artistId: 'UCartist', albumId: 'MPREbalbum' });
    const [first] = getFavorites(db);
    expect(first.artistId).toBe('UCartist');
    expect(first.albumId).toBe('MPREbalbum');
    addFavorite(db, { ...testTrack, albumId: 'MPREbother' });
    const [updated] = getFavorites(db);
    expect(updated.artistId).toBeUndefined();
    expect(updated.albumId).toBe('MPREbother');
    expect(getFavorites(db)).toHaveLength(1);
  });

  test('history round-trips album name and IDs; legacy NULLs stay hidden', () => {
    addToHistory(db, {
      ...testTrack,
      album: 'Album',
      artistId: 'UCartist',
      albumId: 'MPREbalbum',
    });
    expect(getHistory(db)[0]).toMatchObject({
      album: 'Album',
      artistId: 'UCartist',
      albumId: 'MPREbalbum',
    });
    db.prepare(
      `INSERT INTO history (provider, track_id, title, artist, album, artist_id, album_id, played_at, source_json, resolved_source_json)
       VALUES ('youtube', 'legacy', 'Legacy', 'Artist', NULL, NULL, NULL, 1, NULL, NULL)`,
    ).run();
    const legacy = getHistory(db).find((track) => track.id === 'legacy');
    expect(legacy?.album).toBeUndefined();
    expect(legacy?.artistId).toBeUndefined();
    expect(legacy?.albumId).toBeUndefined();
  });
});
