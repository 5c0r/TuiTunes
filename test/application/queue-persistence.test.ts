import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { createQueuePersistence } from '../../src/application/queue-persistence';
import { runMigrations } from '../../src/db/index';
import { mediaKey } from '../../src/providers/media';
import type { Episode } from '../../src/providers/podcast-types';
import type { ResolvedPlaybackSource, Track } from '../../src/providers/types';
import {
  queuePersistenceErrorAtom,
  queueSelectionIdAtom,
  queueStateAtom,
  type QueueState,
} from '../../src/store/queue';
import {
  cycleRepeat,
  enqueueEntries,
  removeEntry,
  selectEntry,
  setShuffle,
} from '../../src/store/queue-actions';

const track = (id: string): Track => ({
  id,
  provider: 'youtube',
  source: { kind: 'youtube', videoId: id },
  title: `Title ${id}`,
  artist: 'Artist',
  duration: 123,
});

const RESOLVED: ResolvedPlaybackSource = {
  kind: 'youtube',
  videoId: 'aaaaaaaaaaa',
  url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  selection: 'auto',
};
const resolvedTrack = (): Track => ({ ...track('aaaaaaaaaaa'), resolvedSource: RESOLVED });

const episode = (id: string): Episode => ({
  id,
  podcastId: 'feed-1',
  podcastTitle: 'The Feed',
  title: `Episode ${id}`,
  audioUrl: `https://audio.test/${id}.mp3`,
  transcriptUrl: `https://transcript.test/${id}.vtt`,
  duration: 1800,
  publishDate: '2026-01-01',
});
const episodeTrack = (id: string): Track => ({
  id,
  provider: 'podcast',
  source: { kind: 'podcast', episode: episode(id) },
  title: `Episode ${id}`,
  artist: 'The Feed',
  duration: 1800,
});

function openDb(path = ':memory:'): Database {
  const db = new Database(path);
  runMigrations(db);
  return db;
}

interface SnapshotRow {
  revision: number;
  payload: string;
}

function readRow(db: Database): SnapshotRow | null {
  return db
    .prepare('SELECT revision, payload FROM queue_snapshot WHERE id = 1')
    .get() as SnapshotRow | null;
}

function enqueue(store: Store, tracks: readonly Track[]): string[] {
  const entries = tracks.map((t) => ({ entryId: crypto.randomUUID(), track: t }));
  store.set(queueStateAtom, enqueueEntries(store.get(queueStateAtom), entries));
  return entries.map((entry) => entry.entryId);
}

function apply(store: Store, transition: (state: QueueState) => QueueState): void {
  store.set(queueStateAtom, transition(store.get(queueStateAtom)));
}

test('restores a shuffled queue with duplicate media across a temp-file restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-persistence-'));
  try {
    const dbPath = join(dir, 'queue.db');
    const db = openDb(dbPath);
    const store = createStore();
    const owner = createQueuePersistence(store, db);
    const originals = [resolvedTrack(), episodeTrack('ep1'), track('aaaaaaaaaaa')];
    const ids = enqueue(store, originals);
    apply(store, (state) => setShuffle(state, true, () => 0.25));
    apply(store, (state) => cycleRepeat(cycleRepeat(state)));
    apply(store, (state) => selectEntry(state, ids[1])); // cursor-only: no write
    store.set(queueSelectionIdAtom, ids[2]);
    const saved = readRow(db);
    expect(saved).not.toBeNull();
    const savedPayload = JSON.parse(saved!.payload);
    expect(savedPayload.entries).toHaveLength(3);
    expect(savedPayload.order).toHaveLength(ids.length);
    for (const id of ids) expect(savedPayload.order).toContain(id);
    expect(saved!.payload).not.toContain('resolvedSource');
    owner.dispose();
    db.close();

    const reopened = openDb(dbPath);
    const restoredStore = createStore();
    const restoredOwner = createQueuePersistence(restoredStore, reopened);
    const state = restoredStore.get(queueStateAtom);
    expect(state.entries.map((entry) => entry.entryId)).toEqual(ids);
    expect(state.entries.map((entry) => mediaKey(entry.track))).toEqual(originals.map(mediaKey));
    // Duplicate media stays individually addressable queue entries.
    expect(state.entries.filter((entry) => entry.track.id === 'aaaaaaaaaaa')).toHaveLength(2);
    expect(state.order).toEqual(savedPayload.order);
    expect(state.shuffle).toBe(true);
    expect(state.repeat).toBe('track');
    expect(state.cursorId).toBeNull();
    expect(state.entries[1].track.source).toEqual({ kind: 'podcast', episode: episode('ep1') });
    expect(state.entries[0].track.resolvedSource).toBeUndefined();
    expect(restoredStore.get(queueSelectionIdAtom)).toBe(ids[2]);
    expect(restoredStore.get(queuePersistenceErrorAtom)).toBeNull();
    restoredOwner.dispose();
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps unsupported persisted sources visible and never persists resolved sources', () => {
  const db = openDb();
  const unsupported = (entryId: string, id: string, provider: string, sourceJson: string) => ({
    entryId,
    track: {
      id,
      provider,
      title: `Old ${id}`,
      artist: 'Legacy',
      album: null,
      artist_id: null,
      album_id: null,
      duration: 60,
      source_json: sourceJson,
    },
  });
  db.prepare('INSERT INTO queue_snapshot (id, revision, payload) VALUES (1, 3, ?)').run(
    JSON.stringify({
      version: 1,
      entries: [
        unsupported('legacy-local', 'legacy1', 'podcast', '{"kind":"local","path":"/tmp/a.mp3"}'),
        unsupported('legacy-junk', 'legacy2', 'youtube', 'not json'),
      ],
      order: ['legacy-local', 'legacy-junk'],
      shuffle: false,
      repeat: 'all',
      selectionId: 'legacy-junk',
    }),
  );
  const store = createStore();
  const owner = createQueuePersistence(store, db);
  const state = store.get(queueStateAtom);
  expect(state.entries.map((entry) => entry.track.source)).toEqual([null, null]);
  expect(state.entries.map((entry) => entry.track.title)).toEqual(['Old legacy1', 'Old legacy2']);
  expect(state.repeat).toBe('all');
  expect(store.get(queueSelectionIdAtom)).toBe('legacy-junk');
  expect(store.get(queuePersistenceErrorAtom)).toBeNull();
  // A genuine mutation persists the sanitized view without resolvedSource.
  const [fresh] = enqueue(store, [resolvedTrack()]);
  const row = readRow(db)!;
  expect(row.revision).toBe(4);
  expect(row.payload).not.toContain('resolvedSource');
  const sources = JSON.parse(row.payload).entries.map(
    (entry: { track: { source_json: string | null } }) => entry.track.source_json,
  );
  expect(sources).toEqual([
    null,
    null,
    JSON.stringify({ kind: 'youtube', videoId: 'aaaaaaaaaaa' }),
  ]);
  owner.dispose();
  const secondStore = createStore();
  const secondOwner = createQueuePersistence(secondStore, db);
  expect(
    secondStore.get(queueStateAtom).entries.map((entry) => [entry.entryId, entry.track.source]),
  ).toEqual([
    ['legacy-local', null],
    ['legacy-junk', null],
    [fresh, { kind: 'youtube', videoId: 'aaaaaaaaaaa' }],
  ]);
  secondOwner.dispose();
  db.close();
});

test('ignores cursor-only changes but persists real mutations', () => {
  const db = openDb();
  const store = createStore();
  const owner = createQueuePersistence(store, db);
  const ids = enqueue(store, [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')]);
  const before = readRow(db);
  expect(before).not.toBeNull();
  apply(store, (state) => selectEntry(state, ids[0]));
  apply(store, (state) => ({ ...state, cursorId: ids[1] }));
  expect(readRow(db)).toEqual(before);
  apply(store, cycleRepeat);
  const after = readRow(db)!;
  expect(after.revision).toBe(before!.revision + 1);
  expect(JSON.parse(after.payload).repeat).toBe('all');
  owner.dispose();
  db.close();
});

test('reports corrupt snapshots and repairs them only on genuine mutation', () => {
  const db = openDb();
  db.prepare('INSERT INTO queue_snapshot (id, revision, payload) VALUES (1, 7, ?)').run(
    '{"version":1,',
  );
  const store = createStore();
  const seeded = enqueue(store, [track('aaaaaaaaaaa')]);
  store.set(queueSelectionIdAtom, seeded[0]);
  const owner = createQueuePersistence(store, db);
  expect(store.get(queuePersistenceErrorAtom)).toContain('corrupt');
  expect(store.get(queueStateAtom).entries.map((entry) => entry.entryId)).toEqual(seeded);
  expect(store.get(queueSelectionIdAtom)).toBe(seeded[0]);
  expect(readRow(db)).toEqual({ revision: 7, payload: '{"version":1,' });
  apply(store, cycleRepeat);
  const repaired = readRow(db)!;
  expect(repaired.revision).toBe(8);
  expect(JSON.parse(repaired.payload).repeat).toBe('all');
  expect(JSON.parse(repaired.payload).selectionId).toBe(seeded[0]);
  expect(store.get(queuePersistenceErrorAtom)).toBeNull();
  owner.dispose();
  db.close();
});

{
  const durable = (id: string): Record<string, unknown> => ({
    id,
    provider: 'youtube',
    title: `Title ${id}`,
    artist: 'Artist',
    album: null,
    artist_id: null,
    album_id: null,
    duration: 60,
    source_json: JSON.stringify({ kind: 'youtube', videoId: id }),
  });
  const entry = (entryId: string, id: string) => ({ entryId, track: durable(id) });
  const payload = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      version: 1,
      entries: [entry('e1', 'aaaaaaaaaaa'), entry('e2', 'bbbbbbbbbbb')],
      order: ['e1', 'e2'],
      shuffle: false,
      repeat: 'off',
      selectionId: null,
      ...overrides,
    });
  const cases: [string, string][] = [
    ['invalid JSON', 'nonsense{'],
    ['unknown version', payload({ version: 2 })],
    [
      'duplicate entry IDs',
      payload({
        entries: [entry('e1', 'aaaaaaaaaaa'), entry('e1', 'bbbbbbbbbbb')],
        order: ['e1', 'e1'],
      }),
    ],
    ['order missing an entry', payload({ order: ['e1'] })],
    ['order with an unknown entry', payload({ order: ['e1', 'ghost'] })],
    ['order with a duplicate entry', payload({ order: ['e1', 'e1'] })],
    ['illegal repeat mode', payload({ repeat: 'sometimes' })],
    ['non-boolean shuffle', payload({ shuffle: 'yes' })],
    ['dangling selection', payload({ selectionId: 'ghost' })],
    [
      'untyped track metadata',
      payload({
        entries: [
          entry('e1', 'aaaaaaaaaaa'),
          { entryId: 'e2', track: { ...durable('bbbbbbbbbbb'), duration: '60' } },
        ],
        order: ['e1', 'e2'],
      }),
    ],
  ];
  for (const [label, corrupt] of cases) {
    test(`rejects a corrupt snapshot: ${label}`, () => {
      const db = openDb();
      db.prepare('INSERT INTO queue_snapshot (id, revision, payload) VALUES (1, 2, ?)').run(
        corrupt,
      );
      const store = createStore();
      const owner = createQueuePersistence(store, db);
      expect(store.get(queuePersistenceErrorAtom)).not.toBeNull();
      expect(store.get(queueStateAtom).entries).toEqual([]);
      expect(readRow(db)).toEqual({ revision: 2, payload: corrupt });
      owner.dispose();
      db.close();
    });
  }
}

test('refuses to clobber a snapshot written by a competing owner', () => {
  const db = openDb();
  // Both owners start from an absent row; the first insert wins.
  const storeA = createStore();
  const storeB = createStore();
  const a = createQueuePersistence(storeA, db);
  const b = createQueuePersistence(storeB, db);
  enqueue(storeA, [track('aaaaaaaaaaa')]);
  const first = readRow(db)!;
  expect(first.revision).toBe(1);
  enqueue(storeB, [track('bbbbbbbbbbb')]);
  expect(readRow(db)).toEqual(first);
  expect(storeB.get(queuePersistenceErrorAtom)).toContain('another session');
  expect(storeA.get(queuePersistenceErrorAtom)).toBeNull();
  a.dispose();
  b.dispose();

  // Both hydrated revision 1; the second writer's compare-and-swap must fail.
  const storeC = createStore();
  const storeD = createStore();
  const c = createQueuePersistence(storeC, db);
  const d = createQueuePersistence(storeD, db);
  apply(storeC, cycleRepeat);
  const second = readRow(db)!;
  expect(second.revision).toBe(2);
  apply(storeD, (state) => setShuffle(state, true));
  expect(readRow(db)).toEqual(second);
  expect(storeD.get(queuePersistenceErrorAtom)).toContain('another session');
  c.dispose();
  d.dispose();
  db.close();
});

test('persists exactly one revision for an atomic batch append', () => {
  const db = openDb();
  const store = createStore();
  const owner = createQueuePersistence(store, db);
  const seeded = enqueue(store, [track('aaaaaaaaaaa')]);
  const baseline = readRow(db)!.revision;
  const batch = [track('bbbbbbbbbbb'), episodeTrack('ep9'), track('aaaaaaaaaaa')].map((t) => ({
    entryId: crypto.randomUUID(),
    track: t,
  }));
  store.set(queueStateAtom, enqueueEntries(store.get(queueStateAtom), batch));
  const row = readRow(db)!;
  expect(row.revision).toBe(baseline + 1);
  const parsed = JSON.parse(row.payload);
  expect(parsed.entries).toHaveLength(4);
  expect(parsed.order).toEqual([...seeded, ...batch.map((entry) => entry.entryId)]);
  owner.dispose();
  db.close();
});

test('an absent snapshot row leaves the current store intact and unwritten', () => {
  const db = openDb();
  const store = createStore();
  const seeded = enqueue(store, [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')]);
  store.set(queueSelectionIdAtom, seeded[0]);
  const before = store.get(queueStateAtom);
  const owner = createQueuePersistence(store, db);
  expect(store.get(queueStateAtom)).toBe(before);
  expect(store.get(queueSelectionIdAtom)).toBe(seeded[0]);
  expect(store.get(queuePersistenceErrorAtom)).toBeNull();
  expect(readRow(db)).toBeNull();
  owner.dispose();
  db.close();
});

test('writes nothing for an untouched empty queue', () => {
  const db = openDb();
  const store = createStore();
  const owner = createQueuePersistence(store, db);
  expect(readRow(db)).toBeNull();
  expect(store.get(queuePersistenceErrorAtom)).toBeNull();
  owner.dispose();
  db.close();
});

test('drops a selection whose entry was removed', () => {
  const db = openDb();
  const store = createStore();
  const owner = createQueuePersistence(store, db);
  const [first, second] = enqueue(store, [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')]);
  store.set(queueSelectionIdAtom, first);
  expect(JSON.parse(readRow(db)!.payload).selectionId).toBe(first);
  apply(store, (state) => removeEntry(state, first).state);
  expect(store.get(queueSelectionIdAtom)).toBeNull();
  expect(store.get(queueStateAtom).entries.map((entry) => entry.entryId)).toEqual([second]);
  expect(JSON.parse(readRow(db)!.payload).selectionId).toBeNull();
  owner.dispose();
  db.close();
});
