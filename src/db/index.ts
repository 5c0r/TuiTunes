import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from '../utils/config';
import { Logger } from '../utils/logger';

const DB_PATH = path.join(CONFIG_DIR, 'tunefork.db');

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
`;

let db: Database | null = null;

export function runMigrations(database: Database): void {
  database.exec(MIGRATION_SQL);
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
