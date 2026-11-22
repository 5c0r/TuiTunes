import { atom } from 'jotai';
import type { Track } from '../providers/types';

export interface QueueEntry {
  entryId: string;
  track: Track;
}
export type RepeatMode = 'off' | 'track' | 'all';
export interface QueueState {
  entries: QueueEntry[];
  order: string[];
  cursorId: string | null;
  shuffle: boolean;
  repeat: RepeatMode;
}
export const queueStateAtom = atom<QueueState>({
  entries: [],
  order: [],
  cursorId: null,
  shuffle: false,
  repeat: 'off',
});
export const queueEntriesAtom = atom((get) => get(queueStateAtom).entries);
export const repeatAtom = atom((get) => get(queueStateAtom).repeat);
export const shuffleAtom = atom((get) => get(queueStateAtom).shuffle);
export const playingFromQueueAtom = atom((get) => get(queueStateAtom).cursorId !== null);
/** Queue-list selection identity, independent of the playback cursor. */
export const queueSelectionIdAtom = atom<string | null>(null);
/** Nonfatal queue snapshot persistence warning; null while healthy. */
export const queuePersistenceErrorAtom = atom<string | null>(null);
