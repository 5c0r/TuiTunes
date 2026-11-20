import { expect, test } from 'bun:test';
import { createStore } from 'jotai';
import {
  playingFromQueueAtom,
  queueEntriesAtom,
  queueStateAtom,
  repeatAtom,
  shuffleAtom,
} from '../../src/store/queue';
import { enqueueEntry, selectEntry, setShuffle } from '../../src/store/queue-actions';

test('queue projections preserve entry identity while playback order changes', () => {
  const store = createStore();
  const entry = {
    entryId: 'a',
    track: {
      id: 'a',
      provider: 'youtube',
      source: { kind: 'youtube' as const, videoId: 'a' },
      title: 'A',
      artist: 'Artist',
      duration: 1,
    },
  };
  store.set(queueStateAtom, (state) => selectEntry(enqueueEntry(state, entry), 'a'));
  store.set(queueStateAtom, (state) => setShuffle(state, true, () => 0));
  expect(store.get(queueEntriesAtom)).toEqual([entry]);
  expect(store.get(playingFromQueueAtom)).toBe(true);
  expect(store.get(shuffleAtom)).toBe(true);
  expect(store.get(repeatAtom)).toBe('off');
  store.set(queueStateAtom, (state) => ({ ...state, cursorId: null }));
  expect(store.get(playingFromQueueAtom)).toBe(false);
});
