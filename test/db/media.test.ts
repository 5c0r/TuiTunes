import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { runMigrations } from '../../src/db/index';
import {
  addFavorite,
  addToHistory,
  getFavorites,
  getHistory,
  removeFavorite,
} from '../../src/db/queries';
import {
  episodeToTrack,
  mediaKey,
  parseResolvedSource,
  parseSource,
  parseYouTubeVideoId,
  resolvePlaybackSource,
  serializeResolvedSource,
} from '../../src/providers/media';
import type { Episode } from '../../src/providers/podcast-types';
import type { Track } from '../../src/providers/types';

const episode: Episode = {
  id: 'same',
  podcastId: 'feed-a',
  podcastTitle: 'Podcast',
  title: 'Episode',
  audioUrl: 'https://audio.test/a?x=1&y=2',
  duration: 15,
  publishDate: '2026-01-01',
};
test('feed-scoped podcast identities and resolved sources survive library round trips', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const a = episodeToTrack(episode),
      b = episodeToTrack({ ...episode, podcastId: 'feed-b' });
    a.resolvedSource = { kind: 'rss', url: episode.audioUrl, selection: 'rss' };
    addFavorite(db, a);
    addFavorite(db, b);
    addToHistory(db, a);
    expect(new Set(getFavorites(db).map(mediaKey)).size).toBe(2);
    expect(getHistory(db)[0].resolvedSource).toEqual(a.resolvedSource);
    expect(getHistory(db)[0].source).toEqual(a.source);
    expect(getHistory(db)[0].duration).toBe(episode.duration);
    removeFavorite(db, a);
    expect(getFavorites(db).map(mediaKey)).toEqual([mediaKey(b)]);
  } finally {
    db.close();
  }
});
test('legacy migration preserves IDs and unavailable podcast records across repeated initialization', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE favorites(id TEXT PRIMARY KEY,provider TEXT NOT NULL,track_id TEXT NOT NULL,title TEXT NOT NULL,artist TEXT NOT NULL,album TEXT,duration INTEGER,added_at INTEGER NOT NULL);
      INSERT INTO favorites VALUES('old-podcast','podcast','guid','Old','Show',NULL,30,123);
      INSERT INTO favorites VALUES('youtube:video','youtube','video','Music','Artist',NULL,30,124);
      CREATE TABLE history(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT NOT NULL,track_id TEXT NOT NULL,title TEXT NOT NULL,artist TEXT NOT NULL,played_at INTEGER NOT NULL,position INTEGER DEFAULT 0);
      INSERT INTO history VALUES(42,'podcast','guid','Old','Show',456,5);
      CREATE TABLE podcast_feeds(id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL,description TEXT,feed_url TEXT NOT NULL UNIQUE,artwork_url TEXT,added_at INTEGER NOT NULL);
      INSERT INTO podcast_feeds VALUES('feed','Show','Author',NULL,'https://feed.test/rss',NULL,789);
      CREATE TABLE translations(track_id TEXT,provider TEXT,target_lang TEXT,translation_provider TEXT,translated_lines TEXT,created_at TEXT,PRIMARY KEY(track_id,provider,target_lang));
      INSERT INTO translations VALUES('video','youtube','en','lingva','["stale"]','old');`);
    runMigrations(db);
    runMigrations(db);
    const tracks = getFavorites(db);
    expect(tracks.find((t) => t.provider === 'podcast')?.source).toBeNull();
    expect(tracks.find((t) => t.provider === 'youtube')?.source).toEqual({
      kind: 'youtube',
      videoId: 'video',
    });
    expect(db.query('SELECT id,added_at FROM favorites WHERE id = ?').get('old-podcast')).toEqual({
      id: 'old-podcast',
      added_at: 123,
    });
    expect(db.query('SELECT id,played_at,position FROM history').all()).toEqual([
      { id: 42, played_at: 456, position: 5 },
    ]);
    expect(db.query('SELECT id,feed_url,added_at FROM podcast_feeds').all()).toEqual([
      { id: 'feed', feed_url: 'https://feed.test/rss', added_at: 789 },
    ]);
    expect(db.query('SELECT * FROM translations').all()).toEqual([]);
    addFavorite(db, tracks.find((t) => t.provider === 'youtube')!);
    expect(db.query('SELECT id FROM favorites WHERE provider = ?').get('youtube')).toEqual({
      id: 'youtube:video',
    });
  } finally {
    db.close();
  }
});
test('malformed media payloads are not reinterpreted as YouTube episodes', () => {
  expect(parseSource('{"kind":"podcast","episode":{}}', 'podcast', 'guid')).toBeNull();
  expect(parseSource('{broken', 'youtube', 'video')).toBeNull();
  expect(
    parseResolvedSource('{"kind":"rss","url":"https://audio.test"}', {
      kind: 'youtube',
      videoId: 'v',
    }),
  ).toBeUndefined();
});

test('resolved-source selection tags round-trip; legacy and invalid tags decode safely', () => {
  const podcastSource = { kind: 'podcast', episode } as const;
  const rss = {
    kind: 'rss',
    url: episode.audioUrl,
    transcriptUrl: 'https://transcript.test/t',
    selection: 'rss',
  } as const;
  expect(parseResolvedSource(serializeResolvedSource(rss), podcastSource)).toEqual(rss);
  // An explicit 'auto' tag decodes exactly like a legacy missing tag.
  expect(
    parseResolvedSource(
      JSON.stringify({ kind: 'rss', url: episode.audioUrl, selection: 'auto' }),
      podcastSource,
    ),
  ).toEqual({ kind: 'rss', url: episode.audioUrl, selection: 'auto' });
  expect(
    parseResolvedSource(
      JSON.stringify({
        kind: 'youtube',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        videoId: 'dQw4w9WgXcQ',
        selection: 'auto',
      }),
      podcastSource,
    ),
  ).toEqual({
    kind: 'youtube',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    videoId: 'dQw4w9WgXcQ',
    selection: 'auto',
  });
  // Invalid tags and incompatible source/tag combinations are rejected.
  expect(
    parseResolvedSource(
      JSON.stringify({ kind: 'rss', url: episode.audioUrl, selection: 'youtube-match' }),
      podcastSource,
    ),
  ).toBeUndefined();
  expect(
    parseResolvedSource(
      JSON.stringify({
        kind: 'rss',
        url: episode.audioUrl,
        selection: 'bogus',
      }),
      podcastSource,
    ),
  ).toBeUndefined();
  expect(
    parseResolvedSource(
      JSON.stringify({
        kind: 'youtube',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        videoId: 'dQw4w9WgXcQ',
        selection: 'rss',
      }),
      podcastSource,
    ),
  ).toBeUndefined();
  // A manual podcast resolution stays cached for its episode.
  const manual = {
    kind: 'youtube',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    videoId: 'dQw4w9WgXcQ',
    selection: 'youtube-video',
  } as const;
  expect(parseResolvedSource(serializeResolvedSource(manual), podcastSource)).toEqual(manual);
  // Music caches still require the video ID to match the durable source.
  const musicSource = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } as const;
  expect(parseResolvedSource(serializeResolvedSource(manual), musicSource)).toBeUndefined();
  expect(
    parseResolvedSource(serializeResolvedSource({ ...manual, selection: 'auto' }), musicSource),
  ).toEqual({ ...manual, selection: 'auto' });
});

describe('parseYouTubeVideoId', () => {
  const ID = 'dQw4w9WgXcQ';
  test('accepts bare IDs and every supported URL shape, normalizing to the ID', () => {
    expect(parseYouTubeVideoId(ID)).toBe(ID);
    expect(parseYouTubeVideoId(` ${ID} `)).toBe(ID);
    expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
    // Timestamps and extra parameters are ignored; timelines restart at zero.
    expect(parseYouTubeVideoId(`http://youtube.com/watch?v=${ID}&t=90s`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://music.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://YOUTUBE.COM/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://www.youtube.com/live/${ID}?feature=share`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://youtu.be/${ID}?t=42`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://www.youtu.be/${ID}`)).toBe(ID);
  });
  test('rejects malformed IDs, credentials, ports, duplicates and lookalikes', () => {
    expect(parseYouTubeVideoId('short4id!')).toBeNull();
    expect(parseYouTubeVideoId('dQw4w9WgXcQExtra')).toBeNull();
    expect(parseYouTubeVideoId('dQw4w9WgXc!')).toBeNull();
    expect(parseYouTubeVideoId('')).toBeNull();
    expect(parseYouTubeVideoId(`ftp://youtube.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeVideoId(`https://youtube.com:8080/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeVideoId(`https://user:pass@youtube.com/watch?v=${ID}`)).toBeNull();
    // Malformed or duplicate v values.
    expect(parseYouTubeVideoId('https://youtube.com/watch?v=')).toBeNull();
    expect(parseYouTubeVideoId(`https://youtube.com/watch?v=${ID}&v=${ID}`)).toBeNull();
    // Playlist-only links, unrelated paths and arbitrary media URLs.
    expect(parseYouTubeVideoId('https://youtube.com/playlist?list=PLxyz12345')).toBeNull();
    expect(parseYouTubeVideoId('https://youtube.com/watch/?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseYouTubeVideoId('https://youtube.com/video/dQw4w9WgXcQ')).toBeNull();
    expect(parseYouTubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ/extra')).toBeNull();
    // Lookalike hosts never match.
    expect(parseYouTubeVideoId(`https://youtube.com.evil.test/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeVideoId(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeVideoId('https://soundcloud.com/artist/track')).toBeNull();
  });
});

describe('resolvePlaybackSource policy matrix', () => {
  // Empty podcast+title keeps the episode→YouTube matcher offline: its query
  // is empty, so it deterministically reports "no match" without yt-dlp.
  const offline: Episode = {
    ...episode,
    id: 'ep1',
    podcastTitle: '',
    title: '',
    audioUrl: 'https://audio.test/ep1.mp3',
    transcriptUrl: 'https://audio.test/ep1.txt',
  };
  const offlineTrack = episodeToTrack(offline);
  const signal = () => new AbortController().signal;
  const rssFallback = {
    kind: 'rss',
    url: offline.audioUrl,
    transcriptUrl: offline.transcriptUrl,
    selection: 'auto',
  } as const;

  test('music tracks stay Auto-only', async () => {
    const music: Track = {
      id: 'v1',
      provider: 'youtube',
      source: { kind: 'youtube', videoId: 'v1' },
      title: 'T',
      artist: 'A',
      duration: 1,
    };
    expect(await resolvePlaybackSource(music, signal())).toEqual({
      kind: 'youtube',
      videoId: 'v1',
      url: 'https://music.youtube.com/watch?v=v1',
      selection: 'auto',
    });
    await expect(resolvePlaybackSource(music, signal(), { mode: 'rss' })).rejects.toThrow(
      'Music tracks only support automatic source selection.',
    );
  });
  test('Auto reuses only Auto-tagged caches; a manual cache never becomes a match', async () => {
    const manual = {
      kind: 'youtube',
      videoId: 'manualvid01',
      url: 'https://www.youtube.com/watch?v=manualvid01',
      selection: 'youtube-video',
    } as const;
    expect(
      await resolvePlaybackSource({ ...offlineTrack, resolvedSource: manual }, signal()),
    ).toEqual(rssFallback);
    const automatic = { ...manual, selection: 'auto' } as const;
    expect(
      await resolvePlaybackSource({ ...offlineTrack, resolvedSource: automatic }, signal()),
    ).toEqual(automatic);
  });
  test('RSS uses the original audio and transcript without any lookup', async () => {
    const cached = {
      kind: 'youtube',
      videoId: 'cachedvid01',
      url: 'https://www.youtube.com/watch?v=cachedvid01',
      selection: 'auto',
    } as const;
    const resolved = await resolvePlaybackSource(
      { ...offlineTrack, resolvedSource: cached },
      signal(),
      { mode: 'rss' },
    );
    expect(resolved).toEqual({ ...rssFallback, selection: 'rss' });
  });
  test('YouTube-video builds the canonical HTTPS URL; invalid IDs throw', async () => {
    expect(
      await resolvePlaybackSource(offlineTrack, signal(), {
        mode: 'youtube-video',
        videoId: 'https://youtu.be/dQw4w9WgXcQ?t=30',
      }),
    ).toEqual({
      kind: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      selection: 'youtube-video',
    });
    await expect(
      resolvePlaybackSource(offlineTrack, signal(), { mode: 'youtube-video', videoId: 'nope' }),
    ).rejects.toThrow('Invalid YouTube video ID.');
  });
  test('YouTube-match reuses non-manual resolutions and never falls back to RSS', async () => {
    const automatic = {
      kind: 'youtube',
      videoId: 'matchvid001',
      url: 'https://www.youtube.com/watch?v=matchvid001',
      selection: 'auto',
    } as const;
    expect(
      await resolvePlaybackSource({ ...offlineTrack, resolvedSource: automatic }, signal(), {
        mode: 'youtube-match',
      }),
    ).toEqual(automatic);
    await expect(
      resolvePlaybackSource(offlineTrack, signal(), { mode: 'youtube-match' }),
    ).rejects.toThrow('No YouTube match found for this episode.');
    const manual = { ...automatic, selection: 'youtube-video' } as const;
    await expect(
      resolvePlaybackSource({ ...offlineTrack, resolvedSource: manual }, signal(), {
        mode: 'youtube-match',
      }),
    ).rejects.toThrow('No YouTube match found for this episode.');
  });
  test('cancellation is respected before any external work', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(resolvePlaybackSource(offlineTrack, aborted.signal)).rejects.toThrow();
    await expect(
      resolvePlaybackSource(offlineTrack, aborted.signal, {
        mode: 'youtube-video',
        videoId: 'dQw4w9WgXcQ',
      }),
    ).rejects.toThrow();
  });
});

test('upgrading from version 2 preserves library rows and accepts persisted listening state', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE favorites(id TEXT PRIMARY KEY,provider TEXT NOT NULL,track_id TEXT NOT NULL,title TEXT NOT NULL,artist TEXT NOT NULL,album TEXT,duration INTEGER,added_at INTEGER NOT NULL,source_json TEXT,resolved_source_json TEXT,media_key TEXT);
      INSERT INTO favorites VALUES('f1','youtube','v1','T','A','Album',30,123,NULL,NULL,'["youtube","v1"]');
      CREATE TABLE history(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT NOT NULL,track_id TEXT NOT NULL,title TEXT NOT NULL,artist TEXT NOT NULL,played_at INTEGER NOT NULL,position INTEGER DEFAULT 0,source_json TEXT,resolved_source_json TEXT);
      INSERT INTO history VALUES(1,'youtube','v1','T','A',456,0,NULL,NULL);
      CREATE TABLE translations(media_key TEXT NOT NULL,source_key TEXT NOT NULL,content_sha256 TEXT NOT NULL,request_sha256 TEXT NOT NULL,translation_provider TEXT NOT NULL,source_lang TEXT NOT NULL,target_lang TEXT NOT NULL,translated_lines TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(media_key,source_key,content_sha256,request_sha256));
      PRAGMA user_version = 2;`);
    runMigrations(db);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
      user_version: 5,
    });
    const columns = (table: string) =>
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
    expect(columns('favorites')).toContain('artist_id');
    expect(columns('favorites')).toContain('album_id');
    for (const column of ['album', 'artist_id', 'album_id'])
      expect(columns('history')).toContain(column);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playback_source_preferences'",
        )
        .get(),
    ).toEqual({ name: 'playback_source_preferences' });
    // Existing v2 rows survive the transaction untouched.
    expect(db.query('SELECT id,album FROM favorites').all()).toEqual([
      { id: 'f1', album: 'Album' },
    ]);
    expect(db.query('SELECT id FROM history').all()).toEqual([{ id: 1 }]);
    db.exec(`INSERT INTO episode_progress VALUES('episode', 'rss:v1', 25000, 50000, 0, 1);
      INSERT INTO queue_snapshot VALUES(1, 1, '{"version":1}');`);
    // Re-running the migration sequence is a no-op.
    runMigrations(db);
    expect(db.query('SELECT position_ms FROM episode_progress').get()).toEqual({
      position_ms: 25_000,
    });
    expect(db.query('SELECT revision FROM queue_snapshot').get()).toEqual({ revision: 1 });
  } finally {
    db.close();
  }
});
