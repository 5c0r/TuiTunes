import { atom } from 'jotai';
import type { LyricsResult } from '../providers/lyrics';

/** Whether lyrics panel is visible. */
export const lyricsVisibleAtom = atom(false);

/** Current lyrics data, or null if not loaded/unavailable. */
export const lyricsDataAtom = atom<LyricsResult | null>(null);

/** Loading state for lyrics fetch. */
export const lyricsLoadingAtom = atom(false);

/** Transcript source preference: 'auto' (default), or a custom SRT/VTT URL. */
export const transcriptSourceAtom = atom<'auto' | string>('auto');

/** Whether lyrics translation is enabled. */
export const translationEnabledAtom = atom(false);

/** Loading state for translation fetch. */
export const translationLoadingAtom = atom(false);
