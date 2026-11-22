import type { Database } from 'bun:sqlite';
import type { Store } from 'jotai/vanilla/store';
import { parseSource, serializeSource } from '../providers/media';
import type { Track } from '../providers/types';
import type { QueueEntry, QueueState, RepeatMode } from '../store/queue';
import { queuePersistenceErrorAtom, queueSelectionIdAtom, queueStateAtom } from '../store/queue';

const SNAPSHOT_VERSION = 1;
const REPEAT_MODES: readonly string[] = ['off', 'track', 'all'];

/**
 * Durable per-entry track metadata, mirroring the favorites/history columns:
 * identity plus display fields and the typed playback source. A resolved
 * source is never persisted; playback re-resolves it on demand.
 */
interface DurableTrack {
  id: string;
  provider: string;
  title: string;
  artist: string;
  album: string | null;
  artist_id: string | null;
  album_id: string | null;
  duration: number;
  source_json: string | null;
}

interface SnapshotEntry {
  entryId: string;
  track: DurableTrack;
}

/** Versioned queue snapshot; the playback cursor is intentionally excluded. */
interface QueueSnapshot {
  version: 1;
  entries: SnapshotEntry[];
  order: string[];
  shuffle: boolean;
  repeat: RepeatMode;
  selectionId: string | null;
}

export interface QueuePersistence {
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

function parseDurableTrack(value: unknown): DurableTrack | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  if (typeof value.provider !== 'string' || value.provider === '') return null;
  if (typeof value.title !== 'string' || typeof value.artist !== 'string') return null;
  if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0)
    return null;
  if (
    !nullableString(value.album) ||
    !nullableString(value.artist_id) ||
    !nullableString(value.album_id) ||
    !nullableString(value.source_json)
  )
    return null;
  return {
    id: value.id,
    provider: value.provider,
    title: value.title,
    artist: value.artist,
    album: value.album ?? null,
    artist_id: value.artist_id ?? null,
    album_id: value.album_id ?? null,
    duration: value.duration,
    source_json: value.source_json ?? null,
  };
}

/**
 * Validate the whole snapshot shape: unique entry IDs, an exact order
 * permutation, legal repeat/shuffle, a resolvable selection, and typed
 * durable track metadata. Per-entry playback sources are decoded leniently
 * afterwards: unsupported or malformed sources stay visible with source null.
 */
function parseSnapshot(payload: string): QueueSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.version !== SNAPSHOT_VERSION) return null;
  if (!Array.isArray(value.entries) || !Array.isArray(value.order)) return null;
  if (typeof value.shuffle !== 'boolean') return null;
  if (typeof value.repeat !== 'string' || !REPEAT_MODES.includes(value.repeat)) return null;
  const rawSelection = value.selectionId;
  let selectionId: string | null = null;
  if (typeof rawSelection === 'string') selectionId = rawSelection;
  else if (rawSelection !== null) return null;
  const entries: SnapshotEntry[] = [];
  const entryIds = new Set<string>();
  for (const raw of value.entries) {
    if (!isRecord(raw)) return null;
    if (typeof raw.entryId !== 'string' || raw.entryId === '') return null;
    if (entryIds.has(raw.entryId)) return null;
    const track = parseDurableTrack(raw.track);
    if (track === null) return null;
    entryIds.add(raw.entryId);
    entries.push({ entryId: raw.entryId, track });
  }
  if (value.order.length !== entries.length) return null;
  const order: string[] = [];
  for (const id of value.order) {
    if (typeof id !== 'string' || !entryIds.has(id) || order.includes(id)) return null;
    order.push(id);
  }
  if (selectionId !== null && !entryIds.has(selectionId)) return null;
  return {
    version: SNAPSHOT_VERSION,
    entries,
    order,
    shuffle: value.shuffle,
    repeat: value.repeat as RepeatMode,
    selectionId,
  };
}

function durableTrack(track: Track): DurableTrack {
  return {
    id: track.id,
    provider: track.provider,
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
    artist_id: track.artistId ?? null,
    album_id: track.albumId ?? null,
    duration: Number.isFinite(track.duration) && track.duration >= 0 ? track.duration : 0,
    source_json: serializeSource(track.source),
  };
}

function buildSnapshot(state: QueueState, selectionId: string | null): QueueSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    entries: state.entries.map((entry) => ({
      entryId: entry.entryId,
      track: durableTrack(entry.track),
    })),
    order: [...state.order],
    shuffle: state.shuffle,
    repeat: state.repeat,
    selectionId,
  };
}

function restoreTrack(durable: DurableTrack): Track {
  // Unlike older library tables, every queue snapshot explicitly stores its source.
  const source =
    durable.source_json === null
      ? null
      : parseSource(durable.source_json, durable.provider, durable.id);
  const track: Track = {
    id: durable.id,
    provider: durable.provider,
    source,
    title: durable.title,
    artist: durable.artist,
    duration: durable.duration,
  };
  if (durable.album !== null) track.album = durable.album;
  if (durable.artist_id !== null) track.artistId = durable.artist_id;
  if (durable.album_id !== null) track.albumId = durable.album_id;
  return track;
}

/**
 * Owns the queue snapshot row: hydrates the committed queue on construction,
 * persists genuine durable mutations with revision compare-and-swap, and
 * reports failures nonfatally through `queuePersistenceErrorAtom`. Cursor-only
 * changes never write; a corrupt row is never overwritten until a genuine
 * mutation repairs it.
 */
export function createQueuePersistence(store: Store, db: Database): QueuePersistence {
  /** Revision this owner believes the single snapshot row is at; null = absent. */
  let expectedRevision: number | null = null;
  /** Canonical payload of the last saved or adopted state; suppresses no-op writes. */
  let lastWritten: string | null = null;
  /** Durable projection of the last seen committed state; cursor is excluded. */
  let lastEntries: readonly QueueEntry[] | null = null;
  let lastOrder: readonly string[] | null = null;
  let lastRepeat: RepeatMode | null = null;
  let lastShuffle: boolean | null = null;
  let hydrating = true;
  let disposed = false;

  function report(text: string): void {
    store.set(queuePersistenceErrorAtom, text);
  }

  function hydrate(): void {
    let row: { revision: number; payload: string } | null = null;
    try {
      row = db.prepare('SELECT revision, payload FROM queue_snapshot WHERE id = 1').get() as {
        revision: number;
        payload: string;
      } | null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      report(`Failed to read the saved queue: ${detail}`);
    }
    if (row !== null) {
      expectedRevision = row.revision;
      const snapshot = parseSnapshot(row.payload);
      if (snapshot === null) {
        // Keep the corrupt row until a genuine queue mutation repairs it.
        report('The saved queue is corrupt; it will be replaced on the next queue change.');
      } else {
        const entries: QueueEntry[] = snapshot.entries.map((entry) => ({
          entryId: entry.entryId,
          track: restoreTrack(entry.track),
        }));
        // Restore traversal and selection intent without resuming playback.
        store.set(queueStateAtom, {
          entries,
          order: [...snapshot.order],
          cursorId: null,
          shuffle: snapshot.shuffle,
          repeat: snapshot.repeat,
        });
        store.set(queueSelectionIdAtom, snapshot.selectionId);
      }
    }
    const adopted = store.get(queueStateAtom);
    lastWritten = JSON.stringify(buildSnapshot(adopted, store.get(queueSelectionIdAtom)));
    lastEntries = adopted.entries;
    lastOrder = adopted.order;
    lastRepeat = adopted.repeat;
    lastShuffle = adopted.shuffle;
  }

  function save(): void {
    if (hydrating || disposed) return;
    const payload = JSON.stringify(
      buildSnapshot(store.get(queueStateAtom), store.get(queueSelectionIdAtom)),
    );
    if (payload === lastWritten) return;
    try {
      if (expectedRevision === null) {
        try {
          db.prepare('INSERT INTO queue_snapshot (id, revision, payload) VALUES (1, 1, ?)').run(
            payload,
          );
          expectedRevision = 1;
        } catch (error) {
          // A concurrent writer created the row; refuse to clobber it.
          if (db.prepare('SELECT 1 FROM queue_snapshot WHERE id = 1').get() === null) throw error;
          throw new Error('another session created the queue snapshot first');
        }
      } else {
        const result = db
          .prepare(
            'UPDATE queue_snapshot SET revision = revision + 1, payload = ? ' +
              'WHERE id = 1 AND revision = ?',
          )
          .run(payload, expectedRevision);
        if (Number(result.changes) !== 1)
          throw new Error('another session changed the queue snapshot');
        expectedRevision += 1;
      }
      lastWritten = payload;
      if (store.get(queuePersistenceErrorAtom) !== null) store.set(queuePersistenceErrorAtom, null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      report(`Failed to save the queue: ${detail}`);
    }
  }

  hydrate();
  hydrating = false;
  const unsubscribeQueue = store.sub(queueStateAtom, () => {
    if (hydrating || disposed) return;
    const state = store.get(queueStateAtom);
    // Cursor-only changes reuse the committed entries/order refs: skip before
    // serializing anything. The speculative cursor is deliberately excluded.
    const durableUnchanged =
      state.entries === lastEntries &&
      state.order === lastOrder &&
      state.repeat === lastRepeat &&
      state.shuffle === lastShuffle;
    lastEntries = state.entries;
    lastOrder = state.order;
    lastRepeat = state.repeat;
    lastShuffle = state.shuffle;
    if (durableUnchanged) return;
    const selection = store.get(queueSelectionIdAtom);
    if (selection !== null && !state.entries.some((entry) => entry.entryId === selection)) {
      // Removed entries cannot stay selected; the selection listener persists.
      store.set(queueSelectionIdAtom, null);
      return;
    }
    save();
  });
  const unsubscribeSelection = store.sub(queueSelectionIdAtom, () => {
    if (hydrating || disposed) return;
    save();
  });
  return {
    dispose(): void {
      disposed = true;
      unsubscribeQueue();
      unsubscribeSelection();
    },
  };
}
