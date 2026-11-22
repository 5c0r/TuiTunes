import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { atom, type PrimitiveAtom } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import type { PlayerPort } from '../player/controller';
import { mediaKey } from '../providers/media';
import type { PlaybackTarget, ResolvedPlaybackSource, Track } from '../providers/types';
import {
  playerDurationAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerSeekableRequestAtom,
  playerStateAtom,
} from '../store/player';
import { formatTime } from '../utils/format';
import { Logger } from '../utils/logger';

/** A user bookmark inside one podcast episode's timeline. */
export interface EpisodeBookmark {
  id: string;
  mediaKey: string;
  audioKey: string;
  positionMs: number;
  label: string;
  createdAt: number;
  updatedAt: number;
}

/** Explicit episode playback intent: auto-resume, fresh start, or bookmark jump. */
export type EpisodePlayIntent =
  | { kind: 'resume' }
  | { kind: 'start' }
  | { kind: 'bookmark'; bookmark: EpisodeBookmark };

export interface EpisodeProgress {
  /**
   * Initial seek position (seconds) for a resolved target, or undefined to
   * start at zero. Called by the playback owner after resolution and before
   * `player.play`. Ordinary playback auto-resumes an eligible checkpoint;
   * explicit `resume`/`bookmark` intents reject with a diagnostic when no
   * eligible position exists. Non-podcast targets always pass through.
   */
  prepareStart(target: PlaybackTarget, intent?: EpisodePlayIntent): number | undefined;
  /** Bookmarks of one episode (all audio sources), timeline order. */
  listBookmarks(track: Track): EpisodeBookmark[];
  /**
   * Bookmark the latest confirmed position of the active seekable request.
   * Throws when the label is empty, the request is not the active seekable
   * one, or no confirmed position exists.
   */
  addBookmark(label: string, expectedRequestId: number): EpisodeBookmark;
  /** Rename within one episode's scope; throws when the bookmark is missing. */
  renameBookmark(track: Track, id: string, label: string): void;
  /** Delete within one episode's scope; throws when the bookmark is missing. */
  deleteBookmark(track: Track, id: string): void;
  /**
   * Display labels (`Played` / `Resume at m:ss`) keyed by media key. A pure
   * synchronous read safe to evaluate inside a derived atom: it never writes
   * atoms, and DB errors log and yield an empty map.
   */
  summaries(tracks: readonly Track[]): ReadonlyMap<string, string>;
  /** Flush the current checkpoint (quit write) and stop observing playback. */
  dispose(): void;
}

/**
 * Bumped on every durable progress/bookmark change so consumers can
 * invalidate summaries/list memos keyed on it.
 */
export const episodeProgressRevisionAtom: PrimitiveAtom<number> = atom(0);

/** Nonfatal persistence issue (e.g. a failed checkpoint read or write). */
export const episodeProgressErrorAtom: PrimitiveAtom<string | null> = atom<string | null>(null);

/** Confirmed playback moves this far between checkpoint writes. */
const SAVE_THRESHOLD_MS = 10_000;
/** Checkpoints below this position are never offered for resume. */
const RESUME_MIN_MS = 15_000;
/** Resume guard band at a known end: min(30 s, 5% of duration). */
const RESUME_TAIL_MAX_MS = 30_000;
const RESUME_TAIL_FRACTION = 0.05;
/** SQLite parameter budget for the scoped summary query. */
const SUMMARY_CHUNK = 400;

interface ProgressRow {
  media_key: string;
  audio_key: string;
  position_ms: number;
  duration_ms: number;
  completed: number;
  updated_at: number;
}

interface BookmarkRow {
  id: string;
  media_key: string;
  audio_key: string;
  position_ms: number;
  label: string;
  created_at: number;
  updated_at: number;
}

/** The podcast target currently being observed, with its confirmed facts. */
interface TrackedTarget {
  requestId: number;
  mediaKey: string;
  audioKey: string;
  /** Last sample accepted while the seekable binding was live. */
  positionMs: number | null;
  durationMs: number | null;
  /** Position of the last checkpoint attempt; failed writes obey the same cadence. */
  attemptedMs: number;
  /** Completion or retirement already written; no further writes. */
  finalized: boolean;
}

/**
 * Source-specific audio identity: the YouTube video actually playing, or a
 * digest of the episode's stable enclosure URL for RSS audio. Never derived
 * from titles or guessed identities, so the same episode via different audio
 * stays distinct.
 */
function audioKeyFor(track: Track, source: ResolvedPlaybackSource): string {
  if (source.kind === 'youtube') return `youtube:${source.videoId}`;
  const enclosure = track.source?.kind === 'podcast' ? track.source.episode.audioUrl : source.url;
  return `rss:${createHash('sha256').update(enclosure).digest('hex')}`;
}

function rowToBookmark(row: BookmarkRow): EpisodeBookmark {
  return {
    id: row.id,
    mediaKey: row.media_key,
    audioKey: row.audio_key,
    positionMs: row.position_ms,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Approved resume eligibility: >=15 s, unfinished, not inside the end guard band. */
function resumable(row: ProgressRow): boolean {
  if (row.completed !== 0 || row.position_ms < RESUME_MIN_MS) return false;
  if (row.duration_ms <= 0) return true;
  const guardMs = Math.min(RESUME_TAIL_MAX_MS, Math.floor(row.duration_ms * RESUME_TAIL_FRACTION));
  return row.position_ms <= row.duration_ms - guardMs;
}

export function createEpisodeProgress(
  store: Store,
  db: Database,
  player: PlayerPort,
): EpisodeProgress {
  let disposed = false;
  /** Mirrors episodeProgressRevisionAtom without touching atoms on read paths. */
  let revision = 0;
  let tracked: TrackedTarget | null = null;
  /** Start-over awaiting its request's committed file-loaded event. */
  let pendingStartOver: { requestId: number; mediaKey: string; audioKey: string } | null = null;
  let lastState = store.get(playerStateAtom);
  /** summaries memo: invalidated by any durable change or key-set change. */
  const memo = { revision: -1, keys: '', result: new Map<string, string>() };

  function report(error: unknown): void {
    const text = message(error);
    // After dispose the UI is gone; persistence issues still get logged.
    if (disposed) {
      Logger.warn(`Episode progress: ${text}`);
      return;
    }
    store.set(episodeProgressErrorAtom, text);
  }

  function bumpRevision(): void {
    revision += 1;
    if (!disposed) {
      store.set(episodeProgressErrorAtom, null);
      store.set(episodeProgressRevisionAtom, revision);
    }
  }

  function readRow(key: string, audio: string): ProgressRow | null {
    return (
      (db
        .prepare(
          'SELECT media_key, audio_key, position_ms, duration_ms, completed, updated_at FROM episode_progress WHERE media_key = ? AND audio_key = ?',
        )
        .get(key, audio) as ProgressRow | undefined) ?? null
    );
  }

  function writeCheckpoint(target: TrackedTarget, completed: boolean): void {
    const positionMs = completed
      ? target.durationMs && target.durationMs > 0
        ? target.durationMs
        : (target.positionMs ?? 0)
      : (target.positionMs ?? 0);
    target.attemptedMs = positionMs;
    db.prepare(
      `INSERT INTO episode_progress (media_key, audio_key, position_ms, duration_ms, completed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_key, audio_key) DO UPDATE SET
         position_ms = excluded.position_ms,
         duration_ms = MAX(episode_progress.duration_ms, excluded.duration_ms),
         completed = MAX(episode_progress.completed, excluded.completed),
         updated_at = excluded.updated_at`,
    ).run(
      target.mediaKey,
      target.audioKey,
      positionMs,
      target.durationMs ?? 0,
      completed ? 1 : 0,
      Date.now(),
    );
    bumpRevision();
  }

  /** Threshold write during confirmed playback; persistence issues are nonfatal. */
  function tryThresholdWrite(target: TrackedTarget): void {
    if (target.finalized || target.positionMs === null) return;
    if (Math.abs(target.positionMs - target.attemptedMs) < SAVE_THRESHOLD_MS) return;
    try {
      writeCheckpoint(target, false);
    } catch (error) {
      report(error);
    }
  }

  /** Retire/pause/quit write of the confirmed position; skips empty progress. */
  function tryFlush(target: TrackedTarget | null): void {
    if (!target || target.finalized || target.positionMs === null) return;
    try {
      writeCheckpoint(target, false);
    } catch (error) {
      report(error);
    }
  }

  function beginTracking(target: PlaybackTarget): void {
    tracked = {
      requestId: target.requestId,
      mediaKey: mediaKey(target.track),
      audioKey: audioKeyFor(target.track, target.source),
      positionMs: null,
      durationMs: null,
      attemptedMs: 0,
      finalized: false,
    };
  }

  /** Committed target changed: flush the old checkpoint, then bind the new. */
  const unsubscribePlayback = store.sub(playerPlaybackAtom, () => {
    const committed = store.get(playerPlaybackAtom);
    if (tracked && committed?.requestId !== tracked.requestId) {
      tryFlush(tracked);
      tracked = null;
    }
    if (disposed || !committed) return;
    if (committed.track.source?.kind !== 'podcast') return;
    if (tracked?.requestId === committed.requestId) return; // recovery keeps it
    beginTracking(committed);
  });

  const unsubscribePosition = store.sub(playerPositionAtom, () => {
    if (disposed || !tracked) return;
    const committed = store.get(playerPlaybackAtom);
    if (committed?.requestId !== tracked.requestId) return;
    const seconds = store.get(playerPositionAtom);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    // Every sample must come from the live seekable binding: readiness stays
    // suppressed across loads, initial seeks, EOF and disconnects, so the
    // reset zeroes those windows emit can never touch the cached checkpoint.
    if (store.get(playerSeekableRequestAtom) !== tracked.requestId) return;
    tracked.positionMs = Math.floor(seconds * 1000);
    tryThresholdWrite(tracked);
  });

  const unsubscribeDuration = store.sub(playerDurationAtom, () => {
    if (disposed || !tracked) return;
    const committed = store.get(playerPlaybackAtom);
    if (committed?.requestId !== tracked.requestId) return;
    const seconds = store.get(playerDurationAtom);
    // Zero resets (new load, reconnect) never erase a known duration.
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    tracked.durationMs = Math.floor(seconds * 1000);
  });

  const unsubscribeState = store.sub(playerStateAtom, () => {
    const state = store.get(playerStateAtom);
    // User pause only — cache pause derives to 'buffering', not 'paused'.
    if (state === 'paused' && lastState !== 'paused') tryFlush(tracked);
    lastState = state;
  });

  // Registered before the playback owner's handler so a completed episode is
  // durable before repeat/advance replaces the committed target.
  const unregisterEnd = player.onTrackEnd((target) => {
    if (disposed || target.track.source?.kind !== 'podcast') return;
    const committed = store.get(playerPlaybackAtom);
    if (committed?.requestId !== target.requestId) return;
    if (tracked?.requestId === target.requestId && tracked.finalized) return;
    const durationMs =
      tracked?.requestId === target.requestId
        ? tracked.durationMs
        : Math.floor((store.get(playerDurationAtom) || 0) * 1000) || null;
    const record: TrackedTarget =
      tracked?.requestId === target.requestId
        ? tracked
        : {
            requestId: target.requestId,
            mediaKey: mediaKey(target.track),
            audioKey: audioKeyFor(target.track, target.source),
            positionMs: null,
            durationMs,
            attemptedMs: 0,
            finalized: false,
          };
    try {
      writeCheckpoint(record, true);
      record.finalized = true;
    } catch (error) {
      report(error);
    }
  });

  const unregisterLoaded = player.onTrackLoaded((target) => {
    if (disposed) return;
    const committed = store.get(playerPlaybackAtom);
    if (committed?.requestId !== target.requestId || !pendingStartOver) return;
    // Only the matching loaded event may delete; any other committed load
    // abandons the older start-over without touching saved progress.
    const clear = pendingStartOver.requestId === target.requestId ? pendingStartOver : null;
    pendingStartOver = null;
    if (!clear) return;
    try {
      // Reset scoped to this episode and its audio variant: another source's
      // checkpoint survives a variant switch, while one the retiring target
      // flushed for this same audio between prepare and load is cleared.
      db.prepare('DELETE FROM episode_progress WHERE media_key = ? AND audio_key = ?').run(
        clear.mediaKey,
        clear.audioKey,
      );
      bumpRevision();
    } catch (error) {
      report(error);
    }
  });

  function eligibleRow(key: string, audio: string): { row: ProgressRow | null; error: unknown } {
    try {
      return { row: readRow(key, audio), error: null };
    } catch (error) {
      return { row: null, error };
    }
  }

  return {
    prepareStart(target, intent) {
      if (disposed) return undefined;
      if (target.track.source?.kind !== 'podcast') return undefined; // music passes through
      const key = mediaKey(target.track);
      const audio = audioKeyFor(target.track, target.source);
      if (!intent || intent.kind === 'resume') {
        const { row, error } = eligibleRow(key, audio);
        if (error) {
          // Ordinary playback always starts at zero; explicit resume rejects.
          if (!intent) {
            report(new Error(`Could not read saved progress: ${message(error)}`));
            return undefined;
          }
          throw new Error(`Could not read saved progress: ${message(error)}`);
        }
        const usable = row !== null && resumable(row) ? row : null;
        if (!intent) return usable ? usable.position_ms / 1000 : undefined;
        if (!usable) throw new Error('No eligible resume position for this episode.');
        return usable.position_ms / 1000;
      }
      if (intent.kind === 'start') {
        // Cleared only by this request's committed loaded event, so a failed
        // resolution or load leaves the old checkpoint intact.
        pendingStartOver = { requestId: target.requestId, mediaKey: key, audioKey: audio };
        return undefined;
      }
      // Bookmark jump: validate row, episode identity, and audio source.
      let row: BookmarkRow | null = null;
      try {
        row =
          (db
            .prepare(
              'SELECT id, media_key, audio_key, position_ms, label, created_at, updated_at FROM episode_bookmarks WHERE id = ? AND media_key = ?',
            )
            .get(intent.bookmark.id, key) as BookmarkRow | undefined) ?? null;
      } catch (error) {
        throw new Error(`Could not read bookmarks: ${message(error)}`);
      }
      if (!row) throw new Error('This bookmark no longer exists.');
      if (intent.bookmark.mediaKey !== key)
        throw new Error('This bookmark belongs to another episode.');
      if (row.audio_key !== audio || intent.bookmark.audioKey !== audio) {
        const source = row.audio_key.startsWith('youtube:') ? 'YouTube' : 'RSS';
        throw new Error(`This bookmark belongs to a different audio source. Select ${source} first.`);
      }
      return row.position_ms / 1000;
    },
    listBookmarks(track) {
      try {
        const rows = db
          .prepare(
            'SELECT id, media_key, audio_key, position_ms, label, created_at, updated_at FROM episode_bookmarks WHERE media_key = ? ORDER BY position_ms ASC, created_at ASC, id ASC',
          )
          .all(mediaKey(track)) as BookmarkRow[];
        return rows.map(rowToBookmark);
      } catch (error) {
        report(error);
        return [];
      }
    },
    addBookmark(label, expectedRequestId) {
      if (disposed) throw new Error('Episode progress is disposed.');
      const trimmed = label.trim();
      if (trimmed.length === 0) throw new Error('Bookmark label cannot be empty.');
      if (store.get(playerSeekableRequestAtom) !== expectedRequestId)
        throw new Error('Playback position is not confirmed yet; try again in a moment.');
      const committed = store.get(playerPlaybackAtom);
      if (committed?.requestId !== expectedRequestId || committed.track.source?.kind !== 'podcast')
        throw new Error('No podcast episode is playing.');
      if (tracked?.requestId !== expectedRequestId || tracked.positionMs === null)
        throw new Error('No confirmed playback position yet.');
      const now = Date.now();
      const bookmark: EpisodeBookmark = {
        id: crypto.randomUUID(),
        mediaKey: tracked.mediaKey,
        audioKey: tracked.audioKey,
        positionMs: tracked.positionMs,
        label: trimmed,
        createdAt: now,
        updatedAt: now,
      };
      try {
        db.prepare(
          'INSERT INTO episode_bookmarks (id, media_key, audio_key, position_ms, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          bookmark.id,
          bookmark.mediaKey,
          bookmark.audioKey,
          bookmark.positionMs,
          bookmark.label,
          bookmark.createdAt,
          bookmark.updatedAt,
        );
        bumpRevision();
      } catch (error) {
        report(error);
        throw error;
      }
      return bookmark;
    },
    renameBookmark(track, id, label) {
      const trimmed = label.trim();
      if (trimmed.length === 0) throw new Error('Bookmark label cannot be empty.');
      const changes = db
        .prepare(
          'UPDATE episode_bookmarks SET label = ?, updated_at = ? WHERE id = ? AND media_key = ?',
        )
        .run(trimmed, Date.now(), id, mediaKey(track)).changes;
      if (changes === 0) throw new Error('Bookmark not found for this episode.');
      bumpRevision();
    },
    deleteBookmark(track, id) {
      const changes = db
        .prepare('DELETE FROM episode_bookmarks WHERE id = ? AND media_key = ?')
        .run(id, mediaKey(track)).changes;
      if (changes === 0) throw new Error('Bookmark not found for this episode.');
      bumpRevision();
    },
    summaries(tracks) {
      const keys = [
        ...new Set(tracks.filter((track) => track.source?.kind === 'podcast').map(mediaKey)),
      ];
      if (keys.length === 0)
        return memo.result.size === 0 ? memo.result : new Map<string, string>();
      const memoKey = keys.join('\u0000');
      if (memo.revision === revision && memo.keys === memoKey) return memo.result;
      // Per key: finished dominates; otherwise the most recently updated
      // eligible checkpoint (across the episode's audio sources) supplies
      // the resume label. Ascending updated_at makes the last row win.
      const finished = new Set<string>();
      const resumes = new Map<string, string>();
      try {
        for (let offset = 0; offset < keys.length; offset += SUMMARY_CHUNK) {
          const chunk = keys.slice(offset, offset + SUMMARY_CHUNK);
          const rows = db
            .prepare(
              `SELECT media_key, audio_key, position_ms, duration_ms, completed, updated_at
               FROM episode_progress WHERE media_key IN (${chunk.map(() => '?').join(', ')})
               ORDER BY updated_at ASC`,
            )
            .all(...chunk) as ProgressRow[];
          for (const row of rows) {
            if (row.completed !== 0) {
              finished.add(row.media_key);
            } else if (resumable(row)) {
              // The tag identifies the saved audio version without implying a cross-source seek.
              resumes.set(
                row.media_key,
                `Resume at ${formatTime(row.position_ms / 1000)} ${row.audio_key.startsWith('youtube:') ? '[YT]' : '[RSS]'}`,
              );
            }
          }
        }
      } catch (error) {
        // Pure read path evaluated inside derived atoms: log only, never write.
        Logger.warn(`Episode progress summaries unavailable: ${message(error)}`);
        return new Map<string, string>();
      }
      const labels = new Map<string, string>();
      for (const key of keys) {
        const label = finished.has(key) ? 'Played' : resumes.get(key);
        if (label) labels.set(key, label);
      }
      memo.revision = revision;
      memo.keys = memoKey;
      memo.result = labels;
      return labels;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      tryFlush(tracked);
      tracked = null;
      pendingStartOver = null;
      unsubscribePlayback();
      unsubscribePosition();
      unsubscribeDuration();
      unsubscribeState();
      unregisterEnd();
      unregisterLoaded();
    },
  };
}
