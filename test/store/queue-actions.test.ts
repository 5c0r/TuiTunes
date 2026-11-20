import { describe, expect, test } from 'bun:test';
import type { QueueState } from '../../src/store/queue';
import {
  cycleRepeat,
  enqueueEntries,
  enqueueEntry,
  nextEntryId,
  nextIndex,
  prevIndex,
  previousEntryId,
  removeEntry,
  selectEntry,
  setShuffle,
  shuffleIndices,
} from '../../src/store/queue-actions';

const empty: QueueState = { entries: [], order: [], cursorId: null, shuffle: false, repeat: 'off' };
const entry = (entryId: string) => ({
  entryId,
  track: {
    id: 'duplicate',
    provider: 'youtube',
    source: { kind: 'youtube' as const, videoId: 'duplicate' },
    title: entryId,
    artist: 'Artist',
    duration: 1,
  },
});
const populated = () =>
  ['a', 'b', 'c'].reduce((state, id) => enqueueEntry(state, entry(id)), empty);

describe('shuffleIndices', () => {
  test('returns array of length N', () => {
    expect(shuffleIndices(5)).toHaveLength(5);
  });

  test('contains all indices 0..N-1 (no duplicates)', () => {
    const result = shuffleIndices(10);
    expect(result.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  test('length 0 returns []', () => {
    expect(shuffleIndices(0)).toEqual([]);
  });

  test('length 1 returns [0]', () => {
    expect(shuffleIndices(1)).toEqual([0]);
  });
});

describe('nextIndex', () => {
  test('(0, 3, off) → 1', () => {
    expect(nextIndex(0, 3, 'off')).toBe(1);
  });

  test('(2, 3, off) → null (end)', () => {
    expect(nextIndex(2, 3, 'off')).toBeNull();
  });

  test('(2, 3, all) → 0 (wrap)', () => {
    expect(nextIndex(2, 3, 'all')).toBe(0);
  });

  test('(1, 3, track) → 1 (same)', () => {
    expect(nextIndex(1, 3, 'track')).toBe(1);
  });

  test('(0, 0, off) → null (empty)', () => {
    expect(nextIndex(0, 0, 'off')).toBeNull();
  });
});

describe('prevIndex', () => {
  test('(1, 3, off) → 0', () => {
    expect(prevIndex(1, 3, 'off')).toBe(0);
  });

  test('(0, 3, off) → null (start)', () => {
    expect(prevIndex(0, 3, 'off')).toBeNull();
  });

  test('(0, 3, all) → 2 (wrap)', () => {
    expect(prevIndex(0, 3, 'all')).toBe(2);
  });

  test('(1, 3, track) → 1 (same)', () => {
    expect(prevIndex(1, 3, 'track')).toBe(1);
  });

  test('(0, 0, off) → null (empty)', () => {
    expect(prevIndex(0, 0, 'off')).toBeNull();
  });
});

test('selection uses entry identity under shuffled order', () => {
  const state = selectEntry({ ...populated(), shuffle: true, order: ['c', 'a', 'b'] }, 'a');
  expect(nextEntryId(state)).toBe('b');
  expect(previousEntryId(state)).toBe('c');
  expect(nextEntryId({ ...state, cursorId: null })).toBeNull();
});
test('duplicates stay independently selectable and removal preserves live order', () => {
  let state = selectEntry(populated(), 'b');
  const removed = removeEntry(state, 'a');
  expect(removed.state.cursorId).toBe('b');
  expect(removed.state.order).toEqual(['b', 'c']);
  state = setShuffle(removed.state, true, () => 0);
  expect(state.entries.map((item) => item.entryId)).toEqual(['b', 'c']);
  expect(state.order[0]).toBe('b');
  expect(setShuffle(state, false).cursorId).toBe('b');
});
test('current removals advance, wrap only repeat-all, and always stop when empty', () => {
  for (const repeat of ['off', 'track', 'all'] as const) {
    const state = { ...populated(), repeat };
    expect(removeEntry(selectEntry(state, 'b'), 'b').successorId).toBe('c');
    expect(removeEntry(selectEntry(state, 'c'), 'c').successorId).toBe(
      repeat === 'all' ? 'a' : null,
    );
    const single = selectEntry(enqueueEntry({ ...empty, repeat }, entry('a')), 'a');
    expect(removeEntry(single, 'a').state.cursorId).toBeNull();
  }
  expect(cycleRepeat(cycleRepeat(cycleRepeat(empty))).repeat).toBe('off');
});

describe('enqueueEntries', () => {
  test('appends the whole batch once with fresh identities, preserving cursor/repeat/shuffle', () => {
    const base = selectEntry(setShuffle(populated(), true), 'b');
    // Repeated media rows stay separate queue identities.
    const albumRow = entry('w');
    const repeatedMedia = { entryId: 'w-again', track: albumRow.track };
    const next = enqueueEntries(base, [albumRow, repeatedMedia]);
    expect(next.order).toEqual([...base.order, albumRow.entryId, repeatedMedia.entryId]);
    expect(next.entries).toEqual([...base.entries, albumRow, repeatedMedia]);
    expect(next.cursorId).toBe(base.cursorId);
    expect(next.shuffle).toBe(base.shuffle);
    expect(next.repeat).toBe(base.repeat);
  });

  test('empty batch is a no-op returning the same state reference', () => {
    const state = populated();
    expect(enqueueEntries(state, [])).toBe(state);
  });

  test('duplicate identities inside the batch reject it before any mutation', () => {
    const state = populated();
    const duplicate = entry('dup');
    expect(enqueueEntries(state, [duplicate, entry('ok'), { ...duplicate }])).toBe(state);
  });

  test('an identity already in the queue rejects the whole batch', () => {
    const state = populated();
    expect(enqueueEntries(state, [entry('fresh'), entry('b')])).toBe(state);
  });
});
