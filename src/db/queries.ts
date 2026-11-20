import type { Database } from 'bun:sqlite';
import { Logger } from '../utils/logger';
import {
  mediaKey,
  parseResolvedSource,
  parseSource,
  parseYouTubeVideoId,
  serializeResolvedSource,
  serializeSource,
} from '../providers/media';
import type { Podcast } from '../providers/podcast-types';
import type { PlaybackSourcePreference, Track } from '../providers/types';

export function addFavorite(db: Database, track: Track): void {
  const stmt = db.prepare(`
    INSERT INTO favorites (id, media_key, provider, track_id, title, artist, album, artist_id, album_id, duration, added_at, source_json, resolved_source_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_key) DO UPDATE SET title=excluded.title, artist=excluded.artist,
      album=excluded.album, artist_id=excluded.artist_id, album_id=excluded.album_id,
      duration=excluded.duration, source_json=excluded.source_json,
      resolved_source_json=excluded.resolved_source_json
  `);
  stmt.run(
    mediaKey(track),
    mediaKey(track),
    track.provider,
    track.id,
    track.title,
    track.artist,
    track.album ?? null,
    track.artistId ?? null,
    track.albumId ?? null,
    track.duration,
    Date.now(),
    serializeSource(track.source),
    serializeResolvedSource(track.resolvedSource),
  );
}

export function removeFavorite(db: Database, track: Track): void {
  db.prepare('DELETE FROM favorites WHERE media_key = ?').run(mediaKey(track));
}

export function isFavorite(db: Database, track: Track): boolean {
  const row = db.prepare('SELECT 1 FROM favorites WHERE media_key = ?').get(mediaKey(track));
  return row !== null;
}

export function getFavorites(db: Database, limit?: number): Track[] {
  const rows = db
    .prepare('SELECT * FROM favorites ORDER BY added_at DESC LIMIT ?')
    .all(limit ?? 100) as FavoriteRow[];
  return rows.map(rowToTrack);
}

export function addToHistory(db: Database, track: Track): void {
  const stmt = db.prepare(`
    INSERT INTO history (provider, track_id, title, artist, album, artist_id, album_id, played_at, source_json, resolved_source_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    track.provider,
    track.id,
    track.title,
    track.artist,
    track.album ?? null,
    track.artistId ?? null,
    track.albumId ?? null,
    Date.now(),
    serializeSource(track.source),
    serializeResolvedSource(track.resolvedSource),
  );
}

export function getHistory(db: Database, limit?: number): Track[] {
  const rows = db
    .prepare('SELECT * FROM history ORDER BY played_at DESC LIMIT ?')
    .all(limit ?? 50) as HistoryRow[];
  return rows.map(rowToTrack);
}

export function clearHistory(db: Database): void {
  db.exec('DELETE FROM history');
}

// Internal row types matching the DB schema
interface FavoriteRow {
  id: string;
  provider: string;
  track_id: string;
  title: string;
  artist: string;
  album: string | null;
  artist_id: string | null;
  album_id: string | null;
  duration: number;
  added_at: number;
  source_json: string | null;
  resolved_source_json: string | null;
}

interface HistoryRow {
  id: number;
  provider: string;
  track_id: string;
  title: string;
  artist: string;
  album: string | null;
  artist_id: string | null;
  album_id: string | null;
  played_at: number;
  position: number;
  source_json: string | null;
  resolved_source_json: string | null;
}

function rowToTrack(row: FavoriteRow | HistoryRow): Track {
  const source = parseSource(row.source_json, row.provider, row.track_id);
  const track: Track = {
    id: row.track_id,
    provider: row.provider,
    source,
    resolvedSource: parseResolvedSource(row.resolved_source_json, source),
    title: row.title,
    artist: row.artist,
    duration:
      'duration' in row && typeof row.duration === 'number'
        ? row.duration
        : source?.kind === 'podcast'
          ? source.episode.duration
          : 0,
  };
  if (row.album !== null) track.album = row.album;
  if (row.artist_id !== null) track.artistId = row.artist_id;
  if (row.album_id !== null) track.albumId = row.album_id;
  return track;
}

// ---------------------------------------------------------------------------
// Playback-source preferences
// ---------------------------------------------------------------------------

interface PreferenceRow {
  mode: string;
  youtube_video_id: string | null;
}

/**
 * Saved per-episode playback-source policy. Auto is the absence of a row;
 * invalid persisted rows warn once and behave as Auto.
 */
export function getPlaybackSourcePreference(db: Database, key: string): PlaybackSourcePreference {
  const row = db
    .prepare('SELECT mode, youtube_video_id FROM playback_source_preferences WHERE media_key = ?')
    .get(key) as PreferenceRow | null;
  if (row === null) return { mode: 'auto' };
  if (row.mode === 'rss' || row.mode === 'youtube-match') return { mode: row.mode };
  const videoId = row.youtube_video_id;
  if (row.mode === 'youtube-video' && typeof videoId === 'string') {
    const normalized = parseYouTubeVideoId(videoId);
    if (normalized !== null && normalized === videoId) return { mode: 'youtube-video', videoId };
  }
  Logger.warn(`Ignoring invalid saved playback source preference for ${key}`);
  return { mode: 'auto' };
}

/**
 * Persist a per-episode policy. Auto deletes the row; explicit modes store the
 * normalized video ID (never an arbitrary input URL). Invalid video IDs throw.
 */
export function setPlaybackSourcePreference(
  db: Database,
  key: string,
  preference: PlaybackSourcePreference,
): void {
  if (preference.mode === 'auto') {
    db.prepare('DELETE FROM playback_source_preferences WHERE media_key = ?').run(key);
    return;
  }
  const videoId =
    preference.mode === 'youtube-video' ? parseYouTubeVideoId(preference.videoId) : null;
  if (preference.mode === 'youtube-video' && videoId === null)
    throw new Error('Invalid YouTube video ID for playback source preference.');
  db.prepare(`
    INSERT INTO playback_source_preferences (media_key, mode, youtube_video_id)
    VALUES (?, ?, ?)
    ON CONFLICT(media_key) DO UPDATE SET mode = excluded.mode,
      youtube_video_id = excluded.youtube_video_id
  `).run(key, preference.mode, videoId);
}

// Internal row type for podcast_feeds table
interface PodcastFeedRow {
  id: string;
  title: string;
  author: string;
  description: string | null;
  feed_url: string;
  artwork_url: string | null;
  added_at: number;
}

export function subscribeFeed(db: Database, podcast: Podcast): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO podcast_feeds (id, title, author, description, feed_url, artwork_url, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    podcast.id,
    podcast.title,
    podcast.author,
    podcast.description ?? null,
    podcast.feedUrl,
    podcast.artworkUrl ?? null,
    Date.now(),
  );
}

export function unsubscribeFeed(db: Database, feedUrl: string): void {
  db.prepare('DELETE FROM podcast_feeds WHERE feed_url = ?').run(feedUrl);
}

export function getSubscribedFeeds(db: Database): Podcast[] {
  const rows = db
    .prepare('SELECT * FROM podcast_feeds ORDER BY added_at DESC')
    .all() as PodcastFeedRow[];
  return rows.map(rowToPodcast);
}

export function isSubscribed(db: Database, feedUrl: string): boolean {
  const row = db.prepare('SELECT 1 FROM podcast_feeds WHERE feed_url = ?').get(feedUrl);
  return row !== null;
}

function rowToPodcast(row: PodcastFeedRow): Podcast {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    description: row.description ?? undefined,
    feedUrl: row.feed_url,
    artworkUrl: row.artwork_url ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Translation cache
// ---------------------------------------------------------------------------

export interface TranslationCacheKey {
  mediaKey: string;
  sourceKey: string;
  contentSha256: string;
  requestSha256: string;
  translationProvider: string;
  sourceLang: string;
  targetLang: string;
}

export function getTranslation(
  db: Database,
  key: TranslationCacheKey,
  expectedLineCount: number,
): string[] | null {
  const args = [key.mediaKey, key.sourceKey, key.contentSha256, key.requestSha256];
  const row = db
    .query<{ translated_lines: string }, string[]>(
      'SELECT translated_lines FROM translations WHERE media_key=? AND source_key=? AND content_sha256=? AND request_sha256=?',
    )
    .get(...args);
  if (!row) return null;
  try {
    const lines: unknown = JSON.parse(row.translated_lines);
    if (
      Array.isArray(lines) &&
      lines.length === expectedLineCount &&
      lines.every((line) => typeof line === 'string')
    )
      return lines;
  } catch {
    /* Remove only the corrupt cache entry below. */
  }
  db.prepare(
    'DELETE FROM translations WHERE media_key=? AND source_key=? AND content_sha256=? AND request_sha256=?',
  ).run(...args);
  return null;
}

export function saveTranslation(
  db: Database,
  key: TranslationCacheKey,
  lines: readonly string[],
): void {
  db.prepare(`INSERT OR REPLACE INTO translations
    (media_key,source_key,content_sha256,request_sha256,translation_provider,source_lang,target_lang,translated_lines)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    key.mediaKey,
    key.sourceKey,
    key.contentSha256,
    key.requestSha256,
    key.translationProvider,
    key.sourceLang,
    key.targetLang,
    JSON.stringify(lines),
  );
}
