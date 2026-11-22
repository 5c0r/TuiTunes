import type { Store } from 'jotai/vanilla/store';
import type { PodcastProvider } from '../providers/podcast';
import type { Podcast } from '../providers/podcast-types';
import type { IProvider } from '../providers/types';
import {
  episodesLoadingAtom,
  podcastEpisodesAtom,
  podcastSearchLoadingAtom,
  podcastSearchResultsAtom,
  selectedPodcastAtom,
} from '../store/podcast';
import type { Section } from '../store/ui';
import {
  musicViewAtom,
  podcastViewAtom,
  searchContinuationAtom,
  searchHasMoreAtom,
  searchLoadingAtom,
  searchPageAtom,
  searchResultsAtom,
  searchSuggestionsAtom,
  sectionAtom,
  suggestionSelectedIdxAtom,
  suggestionsVisibleAtom,
} from '../store/ui';
import { Logger } from '../utils/logger';

const SUGGEST_DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 8;

export interface SearchController {
  search(query: string, section: Section): Promise<void>;
  loadMore(): Promise<void>;
  suggest(query: string): void;
  dismissSuggestions(): void;
  openPodcast(podcast: Podcast): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Owns every search/episode request: music search generations, podcast search
 * generations, continuation-in-flight guards, suggestion debounce, and episode
 * loading. A response for podcast A can never populate B's list or clear B's
 * loading flag, and a stale continuation can never overwrite a newer search.
 */
export function createSearchController(
  store: Store,
  deps: { music: IProvider; podcasts: PodcastProvider },
): SearchController {
  let disposed = false;
  let musicRequestId = 0;
  let podcastRequestId = 0;
  let episodesRequestId = 0;
  let suggestRequestId = 0;
  let musicInFlight = false;
  let loadMoreInFlight: number | null = null;
  let suggestTimer: ReturnType<typeof setTimeout> | undefined;
  let episodesController: AbortController | null = null;
  let musicRequestController: AbortController | null = null;
  let suggestController: AbortController | null = null;

  async function searchMusic(query: string): Promise<void> {
    const requestId = ++musicRequestId;
    musicInFlight = true;
    // Superseded searches abort their in-flight HTTP work, not just their
    // stale UI writes.
    musicRequestController?.abort();
    const controller = new AbortController();
    musicRequestController = controller;
    store.set(searchLoadingAtom, true);
    store.set(musicViewAtom, 'search');
    store.set(searchPageAtom, 1);
    try {
      const results = await deps.music.search(query, { signal: controller.signal });
      if (disposed || requestId !== musicRequestId) return;
      store.set(searchResultsAtom, results);
      store.set(searchHasMoreAtom, results.hasMore);
      store.set(searchContinuationAtom, results.continuation ?? null);
      Logger.info(`Search '${query}': ${results.tracks.length} results`);
    } catch (err) {
      Logger.error(`Search failed: ${err}`);
    } finally {
      if (!disposed && requestId === musicRequestId) {
        musicInFlight = false;
        store.set(searchLoadingAtom, false);
      }
    }
  }

  async function searchPodcasts(query: string): Promise<void> {
    const requestId = ++podcastRequestId;
    store.set(podcastSearchLoadingAtom, true);
    try {
      const podcasts = await deps.podcasts.searchPodcasts(query);
      if (disposed || requestId !== podcastRequestId) return;
      store.set(podcastSearchResultsAtom, podcasts);
      store.set(podcastViewAtom, 'search');
      Logger.info(`Podcast search '${query}': ${podcasts.length} results`);
    } catch (err) {
      Logger.error(`Podcast search failed: ${err}`);
    } finally {
      if (!disposed && requestId === podcastRequestId) {
        store.set(podcastSearchLoadingAtom, false);
      }
    }
  }

  async function loadMore(): Promise<void> {
    const hasMore = store.get(searchHasMoreAtom);
    const continuation = store.get(searchContinuationAtom);
    if (!hasMore || !continuation || musicInFlight || loadMoreInFlight === musicRequestId) {
      return;
    }
    const requestId = musicRequestId;
    loadMoreInFlight = requestId;
    const page = store.get(searchPageAtom);
    const existing = store.get(searchResultsAtom)?.tracks ?? [];
    // The continuation request owns the music abort scope until it settles;
    // a newer search aborts it through musicRequestController.
    musicRequestController = new AbortController();
    const controller = musicRequestController;

    store.set(searchLoadingAtom, true);
    try {
      const results = await deps.music.search('', { continuation, signal: controller.signal });
      if (disposed || requestId !== musicRequestId) return;
      store.set(searchResultsAtom, { ...results, tracks: [...existing, ...results.tracks] });
      store.set(searchHasMoreAtom, results.hasMore);
      store.set(searchContinuationAtom, results.continuation ?? null);
      store.set(searchPageAtom, page + 1);
      Logger.info(`Loaded page ${page + 1}: ${results.tracks.length} more results`);
    } catch (err) {
      Logger.error(`Load more failed: ${err}`);
    } finally {
      if (loadMoreInFlight === requestId) loadMoreInFlight = null;
      if (!disposed && requestId === musicRequestId) store.set(searchLoadingAtom, false);
    }
  }

  function cancelSuggestionRequest(): void {
    ++suggestRequestId;
    clearTimeout(suggestTimer);
    suggestTimer = undefined;
    suggestController?.abort();
    suggestController = null;
  }

  function dismissSuggestions(): void {
    cancelSuggestionRequest();
    store.set(searchSuggestionsAtom, []);
    store.set(suggestionsVisibleAtom, false);
    store.set(suggestionSelectedIdxAtom, -1);
  }

  function suggest(query: string): void {
    if (!query.trim() || query.length < 2 || store.get(sectionAtom) === 'podcast') {
      dismissSuggestions();
      return;
    }
    cancelSuggestionRequest();
    const requestId = suggestRequestId;
    const queryAtSchedule = query;
    const controller = new AbortController();
    suggestController = controller;
    suggestTimer = setTimeout(() => {
      suggestTimer = undefined;
      const fetchSuggestions = deps.music.getSearchSuggestions;
      if (!fetchSuggestions || controller.signal.aborted) return;
      fetchSuggestions
        .call(deps.music, queryAtSchedule, controller.signal)
        .then((results) => {
          if (disposed || requestId !== suggestRequestId) return;
          store.set(searchSuggestionsAtom, results.slice(0, MAX_SUGGESTIONS));
          store.set(suggestionSelectedIdxAtom, -1);
          store.set(suggestionsVisibleAtom, results.length > 0);
        })
        .catch(() => {
          // Suggestions are non-critical; aborted ones never surface.
        });
    }, SUGGEST_DEBOUNCE_MS);
  }

  async function openPodcast(podcast: Podcast): Promise<void> {
    const requestId = ++episodesRequestId;
    episodesController?.abort();
    const controller = new AbortController();
    episodesController = controller;
    store.set(selectedPodcastAtom, podcast);
    store.set(podcastViewAtom, 'episodes');
    store.set(episodesLoadingAtom, true);
    try {
      const episodes = await deps.podcasts.getEpisodes(podcast, controller.signal);
      if (disposed || controller.signal.aborted || requestId !== episodesRequestId) return;
      store.set(podcastEpisodesAtom, episodes);
    } catch (err) {
      Logger.error(`Failed to load episodes for "${podcast.title}": ${err}`);
    } finally {
      if (!disposed && requestId === episodesRequestId) {
        store.set(episodesLoadingAtom, false);
      }
    }
  }

  return {
    async search(query: string, section: Section): Promise<void> {
      if (!query.trim()) return;
      dismissSuggestions();
      if (section === 'podcast') return searchPodcasts(query);
      return searchMusic(query);
    },
    loadMore,
    suggest,
    dismissSuggestions,
    openPodcast,
    async dispose(): Promise<void> {
      disposed = true;
      ++musicRequestId;
      ++podcastRequestId;
      ++episodesRequestId;
      episodesController?.abort();
      episodesController = null;
      musicRequestController?.abort();
      musicRequestController = null;
      cancelSuggestionRequest();
    },
  };
}
