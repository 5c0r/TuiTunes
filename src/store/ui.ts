import { atom } from 'jotai';
import type { SearchResult } from '../providers/types';
import type { LayoutPreset } from '../ui/layouts';
import type { ThemeName } from '../ui/themes';

// -- Section: top-level mode (music vs podcast) --

export type Section = 'music' | 'podcast';
export const sectionAtom = atom<Section>('music');

// -- Music views --
export type MusicView = 'search' | 'queue' | 'library' | 'explore';
export const musicViewAtom = atom<MusicView>('search');

// -- Podcast views --
export type PodcastView = 'search' | 'feeds' | 'episodes';
export const podcastViewAtom = atom<PodcastView>('feeds');

// -- Shared UI state --

/** Which panel currently has keyboard focus. */
export const focusedPanelAtom = atom<'search' | 'sidebar' | 'main'>('main');

/** Current search input text. */
export const searchQueryAtom = atom('');

/** Results from the most recent music search, or null if none. */
export const searchResultsAtom = atom<SearchResult | null>(null);

/** Whether a search request is in flight. */
export const searchLoadingAtom = atom(false);

/** Current search page (1-based). */
export const searchPageAtom = atom(1);

/** Whether more results can be loaded. */
export const searchHasMoreAtom = atom(false);

/** Opaque continuation token for next page. */
export const searchContinuationAtom = atom<unknown>(null);

/** Current layout preset. */
export const layoutAtom = atom<LayoutPreset>('default');

/** Current color theme. */
export const themeNameAtom = atom<ThemeName>('tokyo-night');

// -- Search suggestions --
export const searchSuggestionsAtom = atom<string[]>([]);
export const suggestionSelectedIdxAtom = atom<number>(-1);
export const suggestionsVisibleAtom = atom<boolean>(false);