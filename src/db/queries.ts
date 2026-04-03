import type { Database } from 'bun:sqlite';
import type { Track } from '../providers/types';
import type { Podcast } from '../providers/podcast-types';

export function addFavorite(db: Database, track: Track): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO favorites (id, provider, track_id, title, artist, album, duration, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    `${track.provider}:${track.id}`,
    track.provider,
    track.id,
    track.title,
    track.artist,
    track.album ?? null,
    track.duration,
    Date.now()
  );
}

export function removeFavorite(db: Database, track: Track): void {
  db.prepare('DELETE FROM favorites WHERE id = ?').run(`${track.provider}:${track.id}`);
}

export function isFavorite(db: Database, track: Track): boolean {
  const row = db.prepare('SELECT 1 FROM favorites WHERE id = ?').get(`${track.provider}:${track.id}`);
  return row !== null;
}

export function getFavorites(db: Database, limit?: number): Track[] {
  const rows = db.prepare('SELECT * FROM favorites ORDER BY added_at DESC LIMIT ?').all(limit ?? 100) as FavoriteRow[];
  return rows.map(rowToTrack);
}

export function addToHistory(db: Database, track: Track): void {
  const stmt = db.prepare(`
    INSERT INTO history (provider, track_id, title, artist, played_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(track.provider, track.id, track.title, track.artist, Date.now());
}

export function getHistory(db: Database, limit?: number): Track[] {
  const rows = db.prepare('SELECT * FROM history ORDER BY played_at DESC LIMIT ?').all(limit ?? 50) as HistoryRow[];
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
  duration: number;
  added_at: number;
}

interface HistoryRow {
  id: number;
  provider: string;
  track_id: string;
  title: string;
  artist: string;
  played_at: number;
  position: number;
}

function rowToTrack(row: FavoriteRow | HistoryRow): Track {
  const track: Track = {
    id: row.track_id,
    provider: row.provider,
    title: row.title,
    artist: row.artist,
    duration: 'duration' in row && typeof row.duration === 'number' ? row.duration : 0,
  };
  if ('album' in row && row.album !== null) {
    track.album = row.album;
  }
  return track;
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
    Date.now()
  );
}

export function unsubscribeFeed(db: Database, feedUrl: string): void {
  db.prepare('DELETE FROM podcast_feeds WHERE feed_url = ?').run(feedUrl);
}

export function getSubscribedFeeds(db: Database): Podcast[] {
  const rows = db.prepare('SELECT * FROM podcast_feeds ORDER BY added_at DESC').all() as PodcastFeedRow[];
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