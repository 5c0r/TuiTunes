import type { Database } from 'bun:sqlite';
import { atom, type PrimitiveAtom } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import type { LyricLine } from '../providers/lyrics';
import { mediaKey } from '../providers/media';
import { type LyricsDocument, lyricsDocumentAtom } from '../store/lyrics';
import { playerPlaybackAtom } from '../store/player';
import { Logger } from '../utils/logger';

/** Largest magnitude a lyric delay may have, in milliseconds. */
const MAX_DELAY_MS = 10_000;

/**
 * The lyric timing currently in effect for one playback request: the exact
 * lyrics document being timed, the requestId that committed it, and the saved
 * delay (0 when no offset is stored).
 */
export interface LyricTimingContext {
  document: LyricsDocument;
  requestId: number;
  delayMs: number;
}

/**
 * Active saved timing context for the current music playback, or null while
 * timing does not apply (podcast, unsynced lyrics, or no playback).
 */
export const lyricTimingAtom: PrimitiveAtom<LyricTimingContext | null> =
  atom<LyricTimingContext | null>(null);

/** Bound a delay to the supported integer range; only NaN resets to 0. */
export function clampLyricDelay(ms: number): number {
  if (Number.isNaN(ms)) return 0;
  const bounded = Math.min(MAX_DELAY_MS, Math.max(-MAX_DELAY_MS, Math.round(ms)));
  return bounded === 0 ? 0 : bounded;
}

export function effectiveCueMs(seconds: number, delayMs: number): number {
  return Math.round(seconds * 1000) + delayMs;
}

/**
 * Index of the last cue whose effective time is at or before `position`
 * (seconds), or -1 while nothing is active yet.
 */
export function activeLyricIndex(
  lines: readonly LyricLine[],
  position: number,
  delayMs: number,
): number {
  let active = -1;
  for (let index = 0; index < lines.length; index++)
    if (effectiveCueMs(lines[index].time, delayMs) / 1000 <= position) active = index;
  return active;
}

export interface LyricTiming {
  /**
   * Persist `delayMs` for the context's document, keyed by its stable
   * media/source identity. Returns false — writing nothing — when the context
   * no longer matches the current playback request; throws when the write
   * fails; a delay of 0 removes the stored offset. The atom is updated only
   * after a successful write.
   */
  save(context: LyricTimingContext, delayMs: number): boolean;
  dispose(): void;
}

/**
 * Owns per-document lyric delay persistence. Tracks the current music
 * playback and its synced lyrics document, publishes the active timing
 * context — restoring any saved delay once per document/request change,
 * never on position ticks — and saves user offsets without touching the
 * lyrics document or the translation cache.
 */
export function createLyricTiming(store: Store, db: Database): LyricTiming {
  let active: LyricTimingContext | null = null;
  let disposed = false;

  function publish(context: LyricTimingContext | null): void {
    active = context;
    if (store.get(lyricTimingAtom) !== context) store.set(lyricTimingAtom, context);
  }

  /** Saved delay for a document, or 0; a failed read degrades to no offset. */
  function savedDelay(document: LyricsDocument): number {
    try {
      const row = db
        .prepare('SELECT delay_ms FROM lyric_timing WHERE media_key = ? AND source_key = ?')
        .get(document.mediaKey, document.sourceKey) as { delay_ms: number } | null;
      return row === null ? 0 : clampLyricDelay(row.delay_ms);
    } catch (error) {
      Logger.warn(
        `Lyric timing: failed to read the saved delay: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /** Timing applies only to the current music playback with synced lyrics. */
  function refresh(): void {
    if (disposed) return;
    const target = store.get(playerPlaybackAtom);
    const document = store.get(lyricsDocumentAtom);
    if (
      active !== null &&
      target !== null &&
      document !== null &&
      active.document === document &&
      active.requestId === target.requestId
    )
      return; // Same request and document; keeps a freshly saved context.
    const context =
      target !== null &&
      document !== null &&
      document.original.synced &&
      target.track.source?.kind !== 'podcast' &&
      document.mediaKey === mediaKey(target.track)
        ? { document, requestId: target.requestId, delayMs: savedDelay(document) }
        : null;
    publish(context);
  }

  const unsubscribers = [
    store.sub(playerPlaybackAtom, refresh),
    store.sub(lyricsDocumentAtom, refresh),
  ];
  refresh();

  return {
    save(context, delayMs) {
      const target = store.get(playerPlaybackAtom);
      const document = store.get(lyricsDocumentAtom);
      if (
        disposed ||
        active === null ||
        context !== active ||
        target === null ||
        document === null ||
        active.document !== document ||
        active.requestId !== target.requestId
      )
        return false;
      const bounded = clampLyricDelay(delayMs);
      try {
        if (bounded === 0)
          db.prepare('DELETE FROM lyric_timing WHERE media_key = ? AND source_key = ?').run(
            document.mediaKey,
            document.sourceKey,
          );
        else
          db.prepare(
            `INSERT INTO lyric_timing (media_key, source_key, delay_ms)
             VALUES (?, ?, ?)
             ON CONFLICT(media_key, source_key)
             DO UPDATE SET delay_ms = excluded.delay_ms`,
          ).run(document.mediaKey, document.sourceKey, bounded);
      } catch (error) {
        throw new Error(
          `Failed to save the lyric delay: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      publish({ document: context.document, requestId: context.requestId, delayMs: bounded });
      return true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      publish(null);
    },
  };
}
