import { atom } from 'jotai';
import type { Track } from '../providers/types';

/**
 * Set of favorite track keys ('provider:id') for O(1) lookup.
 * Loaded from SQLite on startup, updated on toggle.
 */
export const favoritesSetAtom = atom<Set<string>>(new Set<string>());

/** Full favorite tracks list, loaded from DB. */
export const favoritesAtom = atom<Track[]>([]);

/** Recent play history, loaded from DB. */
export const historyAtom = atom<Track[]>([]);
