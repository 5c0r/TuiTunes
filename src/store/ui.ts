import { atom } from 'jotai';
import type { EpisodeBookmark } from '../application/episode-progress';
import type { SearchContinuation, SearchResult, Track } from '../providers/types';
import type { LayoutPreset } from '../ui/layouts';
import type { ThemeName } from '../ui/themes';

// -- Section: top-level mode (music vs podcast) --

export type Section = 'music' | 'podcast';
export const sectionAtom = atom<Section>('music');

// -- Music views --
export type MusicView = 'search' | 'queue' | 'library' | 'explore' | 'catalog';
export const musicViewAtom = atom<MusicView>('search');

// -- Podcast views --
export type PodcastView = 'search' | 'feeds' | 'episodes';
export const podcastViewAtom = atom<PodcastView>('feeds');

// -- Shared UI state --

/** Which panel currently has keyboard focus. */
export type FocusedPanel = 'search' | 'sidebar' | 'main';
export const focusedPanelAtom = atom<FocusedPanel>('main');

/**
 * The single active overlay, or null when none is open. Opening a new overlay
 * replaces the old one; there is no overlay stack. Lyrics visibility and search
 * suggestions are intentionally outside this union.
 */
export type Overlay =
  | { kind: 'help' }
  | { kind: 'command-palette'; filter: string; selectedIdx: number }
  | { kind: 'quit-confirm' }
  | { kind: 'seek'; value: string }
  | { kind: 'transcript-url'; value: string }
  | { kind: 'transcript-search'; query: string; selectedIdx: number }
  | { kind: 'translation-language'; value: string }
  | {
      kind: 'episode-bookmarks';
      track: Track;
      entryId: string | null;
      bookmarks: EpisodeBookmark[];
      selectedIdx: number;
      editing: 'rename' | 'delete' | null;
      value: string;
      error: string | null;
    }
  | {
      kind: 'source-picker';
      dialogId: string;
      track: Track;
      expectedRequestId: number | null;
      selectedIdx: number;
      value: string;
      editing: boolean;
      busy: boolean;
      error: string | null;
    };
export const overlayAtom = atom<Overlay | null>(null);

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
export const searchContinuationAtom = atom<SearchContinuation | null>(null);

/** Current layout preset. */
export const layoutAtom = atom<LayoutPreset>('default');

/** Current color theme. */
export const themeNameAtom = atom<ThemeName>('tokyo-night');

// -- Search suggestions --
export const searchSuggestionsAtom = atom<string[]>([]);
export const suggestionSelectedIdxAtom = atom<number>(-1);
export const suggestionsVisibleAtom = atom<boolean>(false);
