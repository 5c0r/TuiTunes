import { atom } from 'jotai';
import type { EpisodeBookmark } from '../application/episode-progress';
import type { LyricTimingContext } from '../application/lyric-timing';
import type { SearchContinuation, SearchResult, Track } from '../providers/types';
import type { LayoutPreset } from '../ui/layouts';
import type { ThemeName } from '../ui/themes';
import type { TuiTunesConfig } from '../utils/config';

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

/** Translation backend ids, mirroring TuiTunesConfig.translationProvider. */
export type TranslationProviderId = TuiTunesConfig['translationProvider'];

/** Selectable rows of the translation settings overlay, in display order. */
export type TranslationSettingsField =
  | 'provider'
  | 'target'
  | 'source'
  | 'endpoint'
  | 'key'
  | 'test'
  | 'save'
  | 'cancel';

/** Display/selection order shared by the keyboard dispatcher and the renderer. */
export const TRANSLATION_SETTINGS_FIELDS: readonly TranslationSettingsField[] = [
  'provider',
  'target',
  'source',
  'endpoint',
  'key',
  'test',
  'save',
  'cancel',
];

/** Left/right cycling order for the provider row. */
export const TRANSLATION_PROVIDER_ORDER: readonly TranslationProviderId[] = [
  'none',
  'libretranslate',
  'lingva',
  'mymemory',
  'deepl',
];

/** Manual connection-test outcome shown inside the overlay. */
export type TranslationTestStatus =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; message: string }
  | { state: 'error'; message: string };

/**
 * The single active overlay, or null when none is open. Opening a new overlay
 * replaces the old one; there is no overlay stack. Lyrics visibility and search
 * suggestions are intentionally outside this union.
 */
export type Overlay =
  | { kind: 'help' }
  | { kind: 'command-palette'; filter: string; selectedIdx: number }
  | { kind: 'lyric-timing'; context: LyricTimingContext; delayMs: number; error: string | null }
  | { kind: 'quit-confirm' }
  | { kind: 'seek'; value: string }
  | { kind: 'transcript-url'; value: string }
  | { kind: 'transcript-search'; query: string; selectedIdx: number }
  | {
      kind: 'translation-settings';
      provider: TranslationProviderId;
      targetLanguage: string;
      sourceLanguage: string;
      endpoint: string;
      apiKey: string;
      /** Whether a DeepL key is already stored; the secret itself is never re-displayed. */
      keySet: boolean;
      field: TranslationSettingsField;
      editing: boolean;
      test: TranslationTestStatus;
      error: string | null;
    }
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
