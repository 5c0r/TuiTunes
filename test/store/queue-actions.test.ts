import { describe, expect, test } from 'bun:test';
import type { Track } from '../../src/providers/types';
import {
  shuffleIndices,
  nextIndex,
  prevIndex,
  addToQueue,
  removeFromQueue,
} from '../../src/store/queue-actions';

const track = (id: string): Track => ({
  id,
  provider: 'test',
  title: `Track ${id}`,
  artist: `Artist ${id}`,
  duration: 180,
});

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

describe('addToQueue', () => {
  test('add to empty → [track]', () => {
    const t = track('a');
    expect(addToQueue([], t)).toEqual([t]);
  });

  test('add to [a,b] → [a,b,c]', () => {
    const a = track('a');
    const b = track('b');
    const c = track('c');
    expect(addToQueue([a, b], c)).toEqual([a, b, c]);
  });
});

describe('removeFromQueue', () => {
  test('remove index 1 from [a,b,c], current=2 → ([a,c], 1)', () => {
    const a = track('a');
    const b = track('b');
    const c = track('c');
    const [newQueue, newIndex] = removeFromQueue([a, b, c], 1, 2);
    expect(newQueue).toEqual([a, c]);
    expect(newIndex).toBe(1);
  });

  test('remove index 0 from [a,b,c], current=0 → ([b,c], 0)', () => {
    const a = track('a');
    const b = track('b');
    const c = track('c');
    const [newQueue, newIndex] = removeFromQueue([a, b, c], 0, 0);
    expect(newQueue).toEqual([b, c]);
    expect(newIndex).toBe(0);
  });

  test('remove last item from [a], current=0 → ([], 0)', () => {
    const a = track('a');
    const [newQueue, newIndex] = removeFromQueue([a], 0, 0);
    expect(newQueue).toEqual([]);
    expect(newIndex).toBe(0);
  });
});

// These tests validate the composition pattern used in app.tsx handleNext/handlePrev.
// The bug fix: queue[shuffledIndices[nextIndex(...)]] instead of queue[nextIndex(...)].
describe('shuffle + next/prev composition', () => {
  const a = track('a');
  const b = track('b');
  const c = track('c');
  const queue = [a, b, c];
  // Shuffle order: C(2), A(0), B(1) — first played is C, then A, then B
  const shuffledIndices = [2, 0, 1];

  test('next from shuffle position 0 yields second shuffle entry', () => {
    const next = nextIndex(0, queue.length, 'off');
    expect(next).toBe(1);
    const trackIdx = shuffledIndices[next!];
    expect(queue[trackIdx]).toEqual(a); // second in shuffle order is A
  });

  test('next from shuffle position 1 yields third shuffle entry', () => {
    const next = nextIndex(1, queue.length, 'off');
    expect(next).toBe(2);
    const trackIdx = shuffledIndices[next!];
    expect(queue[trackIdx]).toEqual(b); // third in shuffle order is B
  });

  test('next from last shuffle position with repeat=all wraps to first', () => {
    const next = nextIndex(2, queue.length, 'all');
    expect(next).toBe(0);
    const trackIdx = shuffledIndices[next!];
    expect(queue[trackIdx]).toEqual(c); // wraps to first in shuffle order: C
  });

  test('next from last shuffle position with repeat=off returns null', () => {
    expect(nextIndex(2, queue.length, 'off')).toBeNull();
  });

  test('repeat=track returns same shuffle entry', () => {
    const next = nextIndex(1, queue.length, 'track');
    expect(next).toBe(1);
    const trackIdx = shuffledIndices[next!];
    expect(queue[trackIdx]).toEqual(a); // repeat same: A
  });

  test('prev from shuffle position 2 yields second shuffle entry', () => {
    const prev = prevIndex(2, queue.length, 'off');
    expect(prev).toBe(1);
    const trackIdx = shuffledIndices[prev!];
    expect(queue[trackIdx]).toEqual(a);
  });

  test('prev from shuffle position 0 with repeat=all wraps to last', () => {
    const prev = prevIndex(0, queue.length, 'all');
    expect(prev).toBe(2);
    const trackIdx = shuffledIndices[prev!];
    expect(queue[trackIdx]).toEqual(b); // last in shuffle order: B
  });

  test('without shuffle, next goes sequentially through queue', () => {
    // This is the old (broken) pattern — direct index into queue
    const next = nextIndex(0, queue.length, 'off');
    expect(next).toBe(1);
    expect(queue[next!]).toEqual(b); // sequential: A→B
  });
});
