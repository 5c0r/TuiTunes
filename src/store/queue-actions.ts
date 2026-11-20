import type { QueueEntry, QueueState } from './queue';

/** Fisher-Yates shuffle, returns new array of indices. */
export function shuffleIndices(length: number, random = Math.random): number[] {
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
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

export function enqueueEntry(state: QueueState, entry: QueueEntry): QueueState {
  if (state.entries.some((item) => item.entryId === entry.entryId)) return state;
  return { ...state, entries: [...state.entries, entry], order: [...state.order, entry.entryId] };
}
/**
 * Atomically append a validated batch: every row keeps its own queue identity
 * (repeated media IDs allowed), entries/order update exactly once, and the
 * cursor/repeat/shuffle state is preserved. Duplicate entry identities inside
 * the batch or against the live queue reject the whole batch before mutation.
 */
export function enqueueEntries(state: QueueState, entries: readonly QueueEntry[]): QueueState {
  if (entries.length === 0) return state;
  const ids = new Set(entries.map((entry) => entry.entryId));
  if (ids.size !== entries.length) return state;
  if (entries.some((entry) => state.entries.some((item) => item.entryId === entry.entryId)))
    return state;
  return {
    ...state,
    entries: [...state.entries, ...entries],
    order: [...state.order, ...entries.map((entry) => entry.entryId)],
  };
}
export function selectEntry(state: QueueState, entryId: string): QueueState {
  return state.entries.some((entry) => entry.entryId === entryId)
    ? { ...state, cursorId: entryId }
    : state;
}
export function removeEntry(
  state: QueueState,
  entryId: string,
): { state: QueueState; removedCurrent: boolean; successorId: string | null } {
  const index = state.order.indexOf(entryId);
  if (index < 0) return { state, removedCurrent: false, successorId: null };
  const order = state.order.filter((id) => id !== entryId);
  const removedCurrent = state.cursorId === entryId;
  const successorId = removedCurrent
    ? (order[index] ?? (state.repeat === 'all' ? order[0] : null) ?? null)
    : null;
  return {
    state: {
      ...state,
      entries: state.entries.filter((entry) => entry.entryId !== entryId),
      order,
      cursorId: removedCurrent ? successorId : state.cursorId,
    },
    removedCurrent,
    successorId,
  };
}
export function nextEntryId(state: QueueState): string | null {
  const index = state.cursorId === null ? -1 : state.order.indexOf(state.cursorId);
  if (index < 0) return null;
  const next = nextIndex(index, state.order.length, state.repeat);
  return next === null ? null : (state.order[next] ?? null);
}
export function previousEntryId(state: QueueState): string | null {
  const index = state.cursorId === null ? -1 : state.order.indexOf(state.cursorId);
  if (index < 0) return null;
  const previous = prevIndex(index, state.order.length, state.repeat);
  return previous === null ? null : (state.order[previous] ?? null);
}
export function setShuffle(state: QueueState, enabled: boolean, random = Math.random): QueueState {
  if (state.shuffle === enabled) return state;
  const ids = state.entries.map((entry) => entry.entryId);
  const rest = ids.filter((id) => id !== state.cursorId);
  return {
    ...state,
    shuffle: enabled,
    order: enabled
      ? [
          ...(state.cursorId ? [state.cursorId] : []),
          ...shuffleIndices(rest.length, random).map((index) => rest[index]),
        ]
      : ids,
  };
}
export function cycleRepeat(state: QueueState): QueueState {
  return {
    ...state,
    repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'track' : 'off',
  };
}
