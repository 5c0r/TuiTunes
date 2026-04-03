import { atom } from 'jotai';
import type { Track } from '../providers/types';

/** Ordered list of tracks in the playback queue. */
export const queueAtom = atom<Track[]>([]);

/** Index into the queue (or shuffledIndices when shuffle is on). */
export const queueIndexAtom = atom(0);

/** Repeat mode: off, single track, or whole queue. */
export const repeatAtom = atom<'off' | 'track' | 'all'>('off');

/** Whether shuffle mode is active. */
export const shuffleAtom = atom(false);

/** Fisher-Yates shuffled index mapping; empty when shuffle is off. */
export const shuffledIndicesAtom = atom<number[]>([]);

/** Whether the current playback originated from the queue (vs a one-off play). */
export const playingFromQueueAtom = atom(false);

/** The track currently selected by queue index (+ shuffle indirection). Null if queue is empty or index is out of bounds. */
export const currentTrackAtom = atom<Track | null>((get) => {
  const queue = get(queueAtom);
  if (queue.length === 0) return null;

  const index = get(queueIndexAtom);
  const shuffle = get(shuffleAtom);

  let trackIndex: number;
  if (shuffle) {
    const shuffled = get(shuffledIndicesAtom);
    if (index < 0 || index >= shuffled.length) return null;
    trackIndex = shuffled[index];
  } else {
    trackIndex = index;
  }

  if (trackIndex < 0 || trackIndex >= queue.length) return null;
  return queue[trackIndex];
});
