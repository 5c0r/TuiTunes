import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import {
  activeLyricIndex,
  clampLyricDelay,
  createLyricTiming,
  effectiveCueMs,
  type LyricTiming,
  lyricTimingAtom,
} from '../../src/application/lyric-timing';
import { runMigrations } from '../../src/db/index';
import type { LyricLine, LyricsResult } from '../../src/providers/lyrics';
import { mediaKey } from '../../src/providers/media';
import type { Episode } from '../../src/providers/podcast-types';
import type { PlaybackTarget, ResolvedPlaybackSource, Track } from '../../src/providers/types';
import { type LyricsDocument, lyricsDocumentAtom } from '../../src/store/lyrics';
import { playerPlaybackAtom, playerPositionAtom } from '../../src/store/player';

const musicTrack = (id: string): Track => ({
  id,
  provider: 'youtube',
  source: { kind: 'youtube', videoId: id },
  title: `Song ${id}`,
  artist: 'Artist',
  duration: 200,
});

const episodeTrack = (id: string): Track => ({
  id,
  provider: 'podcast',
  source: {
    kind: 'podcast',
    episode: {
      id,
      podcastId: 'feed-1',
      podcastTitle: 'The Feed',
      title: `Episode ${id}`,
      audioUrl: `https://audio.test/${id}.mp3`,
      duration: 600,
      publishDate: '2026-01-01',
    } satisfies Episode,
  },
  title: `Episode ${id}`,
  artist: 'The Feed',
  duration: 600,
});

const RESOLVED: ResolvedPlaybackSource = {
  kind: 'youtube',
  videoId: 'vid000000001',
  url: 'https://www.youtube.com/watch?v=vid000000001',
  selection: 'auto',
};

let requestSeq = 0;
const targetFor = (track: Track): PlaybackTarget => ({
  track,
  source: RESOLVED,
  requestId: ++requestSeq,
  origin: { kind: 'direct' },
});

function documentFor(
  track: Track,
  options: { synced?: boolean; sourceKey?: string; mediaKey?: string; lines?: LyricLine[] } = {},
): LyricsDocument {
  const lines = options.lines ?? [
    { time: 1, text: 'one' },
    { time: 2, text: 'two' },
  ];
  const original: LyricsResult = {
    lines,
    synced: options.synced ?? true,
    source: 'lrclib',
    sourceUrl: `https://lrclib.test/${track.id}`,
  };
  const sourceKey = options.sourceKey ?? JSON.stringify(['lrclib', original.sourceUrl]);
  return {
    mediaKey: options.mediaKey ?? mediaKey(track),
    sourceKey,
    contentHash: `hash:${sourceKey}`,
    original,
  };
}

interface Harness {
  store: Store;
  db: Database;
  timing: LyricTiming;
}

/** Fresh in-memory database; `db` reuses an already-migrated connection. */
function setup(db?: Database): Harness {
  const store = createStore();
  const connection = db ?? new Database(':memory:');
  if (db === undefined) runMigrations(connection);
  return { store, db: connection, timing: createLyricTiming(store, connection) };
}

function teardown(h: Harness): void {
  h.timing.dispose();
  h.db.close();
}

function play(h: Harness, track: Track, document: LyricsDocument): void {
  h.store.set(playerPlaybackAtom, targetFor(track));
  h.store.set(lyricsDocumentAtom, document);
}

interface TimingRow {
  media_key: string;
  source_key: string;
  delay_ms: number;
}

function rows(db: Database): TimingRow[] {
  return db
    .prepare(
      'SELECT media_key, source_key, delay_ms FROM lyric_timing ORDER BY media_key, source_key',
    )
    .all() as TimingRow[];
}

test('clampLyricDelay keeps integers inside ±10000 and resets non-finite input', () => {
  expect(clampLyricDelay(0)).toBe(0);
  expect(clampLyricDelay(10_000)).toBe(10_000);
  expect(clampLyricDelay(-10_000)).toBe(-10_000);
  expect(clampLyricDelay(10_001)).toBe(10_000);
  expect(clampLyricDelay(-10_001)).toBe(-10_000);
  expect(clampLyricDelay(Number.POSITIVE_INFINITY)).toBe(10_000);
  expect(clampLyricDelay(Number.NEGATIVE_INFINITY)).toBe(-10_000);
  expect(clampLyricDelay(Number.NaN)).toBe(0);
  expect(clampLyricDelay(123.4)).toBe(123);
  expect(clampLyricDelay(123.5)).toBe(124);
  expect(clampLyricDelay(-123.5)).toBe(-123);
  expect(Object.is(clampLyricDelay(-0.4), 0)).toBe(true);
  expect(Object.is(clampLyricDelay(-0.5), 0)).toBe(true);
});

test('effectiveCueMs converts seconds to integer milliseconds shifted by the delay', () => {
  expect(effectiveCueMs(0, 0)).toBe(0);
  expect(effectiveCueMs(12.34, 0)).toBe(12_340);
  expect(effectiveCueMs(1.5, -500)).toBe(1_000);
  expect(effectiveCueMs(0, 750)).toBe(750);
  expect(effectiveCueMs(0.0004, 0)).toBe(0);
  expect(effectiveCueMs(0.0006, 0)).toBe(1);
});

test('activeLyricIndex follows effective cue times at exact boundaries', () => {
  const lines: LyricLine[] = [
    { time: 0.5, text: 'a' },
    { time: 2, text: 'b' },
    { time: 3.25, text: 'c' },
  ];
  expect(activeLyricIndex([], 10, 0)).toBe(-1);
  expect(activeLyricIndex(lines, 0.2, 0)).toBe(-1);
  expect(activeLyricIndex(lines, 0.5, 0)).toBe(0);
  expect(activeLyricIndex(lines, 1.9, 0)).toBe(0);
  expect(activeLyricIndex(lines, 2, 0)).toBe(1);
  expect(activeLyricIndex(lines, 3.25, 0)).toBe(2);
  expect(activeLyricIndex(lines, 99, 0)).toBe(2);
  // A positive delay delays activation; a negative one activates earlier.
  expect(activeLyricIndex(lines, 0.9999, 500)).toBe(-1);
  expect(activeLyricIndex(lines, 1, 500)).toBe(0);
  expect(activeLyricIndex(lines, 2.4, 500)).toBe(0);
  expect(activeLyricIndex(lines, 2.5, 500)).toBe(1);
  expect(activeLyricIndex(lines, 0, -500)).toBe(0);
  expect(activeLyricIndex(lines, 2.74, -500)).toBe(1);
  expect(activeLyricIndex(lines, 2.75, -500)).toBe(2);
});

test('tracks the current request for synced music lyrics with no saved delay', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    const document = documentFor(track);
    play(h, track, document);
    const context = h.store.get(lyricTimingAtom);
    expect(context).not.toBeNull();
    expect(context?.document).toBe(document);
    expect(context?.requestId).toBe(h.store.get(playerPlaybackAtom)?.requestId);
    expect(context?.delayMs).toBe(0);
    // Position ticks never re-track or disturb the active context.
    h.store.set(playerPositionAtom, 42);
    h.store.set(playerPositionAtom, 42.3);
    expect(h.store.get(lyricTimingAtom)).toBe(context);
  } finally {
    teardown(h);
  }
});

test('clears timing for podcasts, unsynced lyrics, mismatched media, and stopped playback', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    h.store.set(playerPlaybackAtom, targetFor(track));
    h.store.set(lyricsDocumentAtom, documentFor(track, { synced: false }));
    expect(h.store.get(lyricTimingAtom)).toBeNull();

    h.store.set(lyricsDocumentAtom, documentFor(track));
    expect(h.store.get(lyricTimingAtom)).not.toBeNull();

    // A document belonging to different media is never adoptable.
    h.store.set(lyricsDocumentAtom, documentFor(musicTrack('v2')));
    expect(h.store.get(lyricTimingAtom)).toBeNull();
    h.store.set(lyricsDocumentAtom, documentFor(track));
    expect(h.store.get(lyricTimingAtom)).not.toBeNull();

    // Podcast playback gets no timing even with a synced transcript.
    const podcast = episodeTrack('e1');
    h.store.set(playerPlaybackAtom, targetFor(podcast));
    h.store.set(lyricsDocumentAtom, documentFor(podcast));
    expect(h.store.get(lyricTimingAtom)).toBeNull();

    play(h, track, documentFor(track));
    expect(h.store.get(lyricTimingAtom)).not.toBeNull();
    h.store.set(playerPlaybackAtom, null);
    expect(h.store.get(lyricTimingAtom)).toBeNull();
  } finally {
    teardown(h);
  }
});

test('a new playback request re-tracks with a fresh context', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    play(h, track, documentFor(track));
    const first = h.store.get(lyricTimingAtom);
    expect(first).not.toBeNull();
    const second = targetFor(track);
    h.store.set(playerPlaybackAtom, second);
    h.store.set(lyricsDocumentAtom, documentFor(track));
    const tracked = h.store.get(lyricTimingAtom);
    expect(tracked).not.toBe(first);
    expect(tracked?.requestId).toBe(second.requestId);
    expect(tracked?.document).toBe(h.store.get(lyricsDocumentAtom) ?? undefined);
  } finally {
    teardown(h);
  }
});

test('save persists a bounded delay, updates the atom after success, and keeps the document', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    const document = documentFor(track);
    play(h, track, document);
    const context = h.store.get(lyricTimingAtom)!;
    const documentSnapshot = JSON.stringify(document.original);

    expect(h.timing.save(context, 750)).toBe(true);
    expect(rows(h.db)).toEqual([
      { media_key: document.mediaKey, source_key: document.sourceKey, delay_ms: 750 },
    ]);
    const saved = h.store.get(lyricTimingAtom);
    expect(saved).not.toBe(context);
    expect(saved).toEqual({ document, requestId: context.requestId, delayMs: 750 });
    // The lyrics document and its identity are untouched.
    expect(h.store.get(lyricsDocumentAtom)).toBe(document);
    expect(JSON.stringify(document.original)).toBe(documentSnapshot);

    // Out-of-range and fractional inputs are clamped, not rejected.
    expect(h.timing.save(saved!, 20_000)).toBe(true);
    expect(rows(h.db)[0]?.delay_ms).toBe(10_000);
    expect(h.timing.save(h.store.get(lyricTimingAtom)!, -20_000)).toBe(true);
    expect(rows(h.db)[0]?.delay_ms).toBe(-10_000);
    expect(h.timing.save(h.store.get(lyricTimingAtom)!, 123.6)).toBe(true);
    expect(rows(h.db)[0]?.delay_ms).toBe(124);
  } finally {
    teardown(h);
  }
});

test('saving zero deletes the stored offset', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    const document = documentFor(track);
    play(h, track, document);
    expect(h.timing.save(h.store.get(lyricTimingAtom)!, 750)).toBe(true);
    expect(rows(h.db)).toHaveLength(1);

    expect(h.timing.save(h.store.get(lyricTimingAtom)!, 0)).toBe(true);
    expect(rows(h.db)).toEqual([]);
    expect(h.store.get(lyricTimingAtom)?.delayMs).toBe(0);

    // Deleting when nothing is stored stays a successful no-op.
    expect(h.timing.save(h.store.get(lyricTimingAtom)!, 0)).toBe(true);
    expect(rows(h.db)).toEqual([]);
  } finally {
    teardown(h);
  }
});

test('stale contexts are rejected without writing', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    play(h, track, documentFor(track));
    const context = h.store.get(lyricTimingAtom)!;
    expect(h.timing.save(context, 500)).toBe(true);

    // A hand-built lookalike is not the tracked context.
    expect(h.timing.save({ ...context, delayMs: 0 }, 0)).toBe(false);
    expect(rows(h.db)).toHaveLength(1);

    // A newer request invalidates the old context even before the document
    // is replaced; the re-tracked context still saves against the stable key.
    const newer = targetFor(track);
    h.store.set(playerPlaybackAtom, newer);
    expect(h.timing.save(context, 900)).toBe(false);
    expect(rows(h.db)[0]?.delay_ms).toBe(500);
    const reTracked = h.store.get(lyricTimingAtom)!;
    expect(reTracked.requestId).toBe(newer.requestId);
    expect(h.timing.save(reTracked, 900)).toBe(true);
    expect(rows(h.db)[0]?.delay_ms).toBe(900);

    // A replaced document invalidates the previous context as well.
    const reloaded = documentFor(track);
    h.store.set(lyricsDocumentAtom, reloaded);
    expect(h.timing.save(reTracked, 900)).toBe(false);
    const tracked = h.store.get(lyricTimingAtom)!;
    expect(tracked.document).toBe(reloaded);
    expect(tracked.delayMs).toBe(900);
    expect(rows(h.db)[0]?.delay_ms).toBe(900);

    // Stopped playback rejects everything.
    h.store.set(playerPlaybackAtom, null);
    expect(h.store.get(lyricTimingAtom)).toBeNull();
    expect(h.timing.save(tracked, 900)).toBe(false);
    expect(rows(h.db)[0]?.delay_ms).toBe(900);
  } finally {
    teardown(h);
  }
});

test('failed writes throw and leave the atom on its last successful value', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    play(h, track, documentFor(track));
    expect(h.timing.save(h.store.get(lyricTimingAtom)!, 300)).toBe(true);
    const saved = h.store.get(lyricTimingAtom);

    h.db.exec('DROP TABLE lyric_timing');
    expect(() => h.timing.save(saved!, 900)).toThrow(/Failed to save the lyric delay/);
    const after = h.store.get(lyricTimingAtom);
    expect(after).toBe(saved);
    expect(after?.delayMs).toBe(300);
  } finally {
    teardown(h);
  }
});

test('delays are keyed per document source and restore on reload', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    const first = documentFor(track, { sourceKey: '["lrclib","a"]' });
    play(h, track, first);
    expect(h.timing.save(h.store.get(lyricTimingAtom)!, 600)).toBe(true);

    const second = documentFor(track, { sourceKey: '["lrclib","b"]' });
    h.store.set(lyricsDocumentAtom, second);
    expect(h.store.get(lyricTimingAtom)?.delayMs).toBe(0);
    expect(h.timing.save(h.store.get(lyricTimingAtom)!, -300)).toBe(true);

    const expected = [
      { media_key: first.mediaKey, source_key: first.sourceKey, delay_ms: 600 },
      { media_key: second.mediaKey, source_key: second.sourceKey, delay_ms: -300 },
    ];
    expect(rows(h.db)).toEqual(expected);

    // Reloading the same source (fresh document object) restores its delay.
    h.store.set(lyricsDocumentAtom, documentFor(track, { sourceKey: '["lrclib","a"]' }));
    expect(h.store.get(lyricTimingAtom)?.delayMs).toBe(600);
    h.store.set(lyricsDocumentAtom, documentFor(track, { sourceKey: '["lrclib","b"]' }));
    expect(h.store.get(lyricTimingAtom)?.delayMs).toBe(-300);
  } finally {
    teardown(h);
  }
});

test('a saved delay survives a database restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lyric-timing-'));
  let external: Database | null = null;
  try {
    const dbPath = join(dir, 'timing.db');
    const first = new Database(dbPath);
    runMigrations(first);
    external = first;
    const h = setup(first);
    const track = musicTrack('v1');
    play(h, track, documentFor(track));
    expect(h.timing.save(h.store.get(lyricTimingAtom)!, -1_250)).toBe(true);
    h.timing.dispose();
    first.close();
    external = null;

    const reopened = new Database(dbPath);
    runMigrations(reopened);
    external = reopened;
    const second = setup(reopened);
    const replayed = documentFor(track);
    play(second, track, replayed);
    const restored = second.store.get(lyricTimingAtom);
    expect(restored?.document).toBe(replayed);
    expect(restored?.delayMs).toBe(-1_250);
    second.timing.dispose();
  } finally {
    external?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispose stops tracking and rejects further saves', () => {
  const h = setup();
  try {
    const track = musicTrack('v1');
    play(h, track, documentFor(track));
    const context = h.store.get(lyricTimingAtom)!;
    h.timing.dispose();
    expect(h.store.get(lyricTimingAtom)).toBeNull();
    expect(h.timing.save(context, 500)).toBe(false);
    expect(rows(h.db)).toEqual([]);

    // Later playback/document changes cannot resurrect a disposed owner.
    h.store.set(playerPlaybackAtom, targetFor(track));
    h.store.set(lyricsDocumentAtom, documentFor(track));
    expect(h.store.get(lyricTimingAtom)).toBeNull();
    expect(h.timing.save(h.store.get(lyricTimingAtom) ?? context, 500)).toBe(false);
    expect(rows(h.db)).toEqual([]);
  } finally {
    h.db.close();
  }
});

test('migration 6 adds lyric timing without touching version-5 data', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE lyric_timing; PRAGMA user_version = 5;');
    db.exec("INSERT INTO queue_snapshot (id, revision, payload) VALUES (1, 3, '{}')");

    runMigrations(db);
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    expect(version).toEqual({ user_version: 6 });
    expect(
      db.prepare('SELECT revision, payload FROM queue_snapshot WHERE id = 1').get() as {
        revision: number;
        payload: string;
      },
    ).toEqual({ revision: 3, payload: '{}' });

    const insert = db.prepare(
      'INSERT INTO lyric_timing (media_key, source_key, delay_ms) VALUES (?, ?, ?)',
    );
    insert.run('m', 's', 500);
    expect(() => insert.run('m', 'zero', 0)).toThrow();
    expect(() => insert.run('m', 'positive', 10_001)).toThrow();
    expect(() => insert.run('m', 'negative', -10_001)).toThrow();
    expect(() => insert.run('m', 'fraction', 100.25)).toThrow();

    // Re-running migrations is idempotent and preserves stored rows.
    runMigrations(db);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
      user_version: 6,
    });
    expect(rows(db)).toEqual([{ media_key: 'm', source_key: 's', delay_ms: 500 }]);
  } finally {
    db.close();
  }
});
