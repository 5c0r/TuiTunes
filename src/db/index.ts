import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { mediaKey, parseSource } from '../providers/media';
import { CONFIG_DIR } from '../utils/config';
import { Logger } from '../utils/logger';

const DB_PATH = path.join(CONFIG_DIR, 'tuimusic.db');

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  track_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  duration INTEGER,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  track_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  position INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_history_played ON history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_favorites_added ON favorites(added_at DESC);

CREATE TABLE IF NOT EXISTS podcast_feeds (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT,
  feed_url TEXT NOT NULL UNIQUE,
  artwork_url TEXT,
  added_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_podcast_feeds_added ON podcast_feeds(added_at DESC);

CREATE TABLE IF NOT EXISTS translations (
  track_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  translation_provider TEXT NOT NULL,
  translated_lines TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (track_id, provider, target_lang)
);
`;

let db: Database | null = null;

export function runMigrations(database: Database): void {
  database.transaction(() => {
    database.exec(MIGRATION_SQL);
    const version = database
      .query<{ user_version: number }, []>('PRAGMA user_version')
      .get()!.user_version;
    if (version < 1) {
      for (const table of ['favorites', 'history']) {
        const columns = new Set(
          database
            .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => row.name),
        );
        for (const name of ['source_json', 'resolved_source_json']) {
          if (!columns.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
        }
        if (table === 'favorites' && !columns.has('media_key'))
          database.exec('ALTER TABLE favorites ADD COLUMN media_key TEXT');
      }
      const rows = database
        .query<{ id: string; provider: string; track_id: string; source_json: string | null }, []>(
          'SELECT id,provider,track_id,source_json FROM favorites',
        )
        .all();
      const update = database.prepare('UPDATE favorites SET media_key = ? WHERE id = ?');
      for (const row of rows)
        update.run(
          mediaKey({
            id: row.track_id,
            provider: row.provider,
            source: parseSource(row.source_json, row.provider, row.track_id),
            title: '',
            artist: '',
            duration: 0,
          }),
          row.id,
        );
      database.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_media_key ON favorites(media_key); PRAGMA user_version = 1',
      );
    }
    if (version < 2) {
      database.exec(`DROP TABLE IF EXISTS translations;
        CREATE TABLE translations (
          media_key TEXT NOT NULL, source_key TEXT NOT NULL, content_sha256 TEXT NOT NULL,
          request_sha256 TEXT NOT NULL, translation_provider TEXT NOT NULL, source_lang TEXT NOT NULL,
          target_lang TEXT NOT NULL, translated_lines TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (media_key, source_key, content_sha256, request_sha256)
        ); PRAGMA user_version = 2`);
    }
    if (version < 3) {
      // One version-3 transaction: playback-source preferences plus catalog
      // metadata on favorites/history. Auto is represented by no row.
      database.exec(`CREATE TABLE IF NOT EXISTS playback_source_preferences (
          media_key TEXT PRIMARY KEY NOT NULL,
          mode TEXT NOT NULL,
          youtube_video_id TEXT,
          CHECK (mode IN ('rss', 'youtube-match', 'youtube-video')),
          CHECK ((mode = 'youtube-video') = (youtube_video_id IS NOT NULL))
        );`);
      const catalogColumns: Record<string, readonly string[]> = {
        favorites: ['artist_id', 'album_id'],
        history: ['artist_id', 'album_id', 'album'],
      };
      for (const [table, columns] of Object.entries(catalogColumns)) {
        const present = new Set(
          database
            .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => row.name),
        );
        for (const name of columns)
          if (!present.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
      }
      database.exec('PRAGMA user_version = 3');
    }
  })();
}

export function getDb(): Database {
  if (db) return db;
  db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  runMigrations(db);
  return db;
}

export function initDb(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  getDb();
  Logger.info('Database initialized');
}

export function closeDb(): void {
  db?.close();
  db = null;
}
