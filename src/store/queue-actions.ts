import type { Track } from '../providers/types';

/** Fisher-Yates shuffle, returns new array of indices. */
export function shuffleIndices(length: number): number[] {
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

/**
 * Compute the next queue index given current state.
 * Returns null if playback should stop (end of queue, no repeat).
 */
export function nextIndex(
  currentIndex: number,
  queueLength: number,
  repeat: 'off' | 'track' | 'all',
): number | null {
  if (queueLength === 0) return null;
  if (repeat === 'track') return currentIndex;
  const next = currentIndex + 1;
  if (next < queueLength) return next;
  if (repeat === 'all') return 0;
  return null; // end of queue, no repeat
}

/**
 * Compute the previous queue index.
 * Wraps around in 'all' repeat mode.
 */
export function prevIndex(
  currentIndex: number,
  queueLength: number,
  repeat: 'off' | 'track' | 'all',
): number | null {
  if (queueLength === 0) return null;
  if (repeat === 'track') return currentIndex;
  const prev = currentIndex - 1;
  if (prev >= 0) return prev;
  if (repeat === 'all') return queueLength - 1;
  return null; // already at start
}

/** Add a track to the queue. Returns the new queue. */
export function addToQueue(queue: Track[], track: Track): Track[] {
  return [...queue, track];
}

/** Remove a track from the queue by index. Returns [newQueue, adjustedCurrentIndex]. */
export function removeFromQueue(
  queue: Track[],
  removeIndex: number,
  currentIndex: number,
): [Track[], number] {
  const newQueue = queue.filter((_, i) => i !== removeIndex);
  let newIndex = currentIndex;
  if (removeIndex < currentIndex) {
    newIndex = currentIndex - 1;
  } else if (removeIndex === currentIndex && currentIndex >= newQueue.length) {
    newIndex = Math.max(0, newQueue.length - 1);
  }
  return [newQueue, newIndex];
}
