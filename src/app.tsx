import {
  type InputRenderable,
  type KeyEvent,
  type ScrollBoxRenderable,
  TextAttributes,
} from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { atom, Provider, useAtomValue, useSetAtom } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  episodeProgressRevisionAtom,
  type EpisodePlayIntent,
} from './application/episode-progress';
import { dispatchKey } from './application/keyboard';
import { effectiveCueMs, lyricTimingAtom } from './application/lyric-timing';
import type { AppRuntime } from './application/runtime';
import type { CommandId } from './commands';
import { filterCommands } from './commands';
import {
  addFavorite,
  getFavorites,
  getHistory,
  getSubscribedFeeds,
  removeFavorite,
  subscribeFeed,
  unsubscribeFeed,
} from './db/queries';
import { episodeToTrack, mediaKey, parseYouTubeVideoId } from './providers/media';
import type { PlaybackSourcePreference, Track } from './providers/types';
import type { Podcast } from './providers/podcast-types';
import {
  catalogFrameAtom,
  catalogIndexAtom,
  catalogListLengthAtom,
  catalogSelectionAtom,
  catalogStateAtom,
} from './store/catalog';
import { configAtom, lyricFollowModeAtom } from './store/config';
import { favoritesAtom, favoritesSetAtom, historyAtom } from './store/library';
import { lyricsDataAtom, lyricsVisibleAtom, translationEnabledAtom } from './store/lyrics';
import {
  playerErrorAtom,
  playerNoticeAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerStateAtom,
  playerSeekableRequestAtom,
  playerDurationAtom,
} from './store/player';
import {
  podcastEpisodesAtom,
  podcastSearchResultsAtom,
  selectedPodcastAtom,
  subscribedFeedsAtom,
} from './store/podcast';
import { queueEntriesAtom, queueSelectionIdAtom } from './store/queue';
import {
  focusedPanelAtom,
  layoutAtom,
  type MusicView,
  musicViewAtom,
  type Overlay,
  overlayAtom,
  type PodcastView,
  podcastViewAtom,
  searchHasMoreAtom,
  searchLoadingAtom,
  searchQueryAtom,
  searchResultsAtom,
  searchSuggestionsAtom,
  sectionAtom,
  suggestionSelectedIdxAtom,
  suggestionsVisibleAtom,
  themeNameAtom,
} from './store/ui';
import { CatalogView } from './ui/CatalogView';
import { CommandPalette } from './ui/CommandPalette';
import { EpisodeBookmarks } from './ui/EpisodeBookmarks';
import { Header } from './ui/Header';
import { HelpOverlay } from './ui/HelpOverlay';
import { Lyrics, lyricFollowSuspendedAtom } from './ui/Lyrics';
import { LyricTiming } from './ui/LyricTiming';
import { nextLayout } from './ui/layouts';
import { NowPlaying } from './ui/NowPlaying';
import { QuitConfirm } from './ui/QuitConfirm';
import { parseTimeInput, SeekInput } from './ui/SeekInput';
import { Sidebar, type View } from './ui/Sidebar';
import { usePointerClicks } from './ui/usePointerClicks';
import { SourcePicker } from './ui/SourcePicker';
import { TrackList } from './ui/TrackList';
import { Transcript } from './ui/Transcript';
import { TranscriptUrlInput } from './ui/TranscriptUrlInput';
import { TranslationLanguageInput } from './ui/TranslationLanguageInput';
import { nextTheme } from './ui/themes';
import { useTheme } from './ui/useTheme';
import { usePresentation } from './ui/usePresentation';
import { type IconStyle, saveConfig } from './utils/config';
import { formatTime } from './utils/format';
import { Logger } from './utils/logger';
import { searchTranscript } from './utils/transcript-search';

const QUEUE_PREVIEW_SIZE = 5;

interface AppProps {
  store: Store;
  runtime: AppRuntime;
  onQuit: () => void;
}

export function App({ store, runtime, onQuit }: AppProps): React.ReactNode {
  return (
    <Provider store={store}>
      <AppInner store={store} runtime={runtime} onQuit={onQuit} />
    </Provider>
  );
}

function AppInner({ store, runtime, onQuit }: AppProps): React.ReactNode {
  const { playback, player, search, lyrics, lyricTiming, catalog, db, episodeProgress } = runtime;
  const podcastScrollRef = useRef<ScrollBoxRenderable>(null);
  const searchInputRef = useRef<InputRenderable>(null);
  const p = usePresentation(podcastScrollRef);

  // UI state
  const focusedPanel = useAtomValue(focusedPanelAtom);
  const setFocusedPanel = useSetAtom(focusedPanelAtom);
  const section = useAtomValue(sectionAtom);
  const setSection = useSetAtom(sectionAtom);
  const musicView = useAtomValue(musicViewAtom);
  const setMusicView = useSetAtom(musicViewAtom);
  const layout = useAtomValue(layoutAtom);
  const setLayout = useSetAtom(layoutAtom);
  const setThemeName = useSetAtom(themeNameAtom);
  const overlay = useAtomValue(overlayAtom);
  const setOverlay = useSetAtom(overlayAtom);
  const catalogState = useAtomValue(catalogStateAtom);
  const catalogIndex = useAtomValue(catalogIndexAtom);
  const catalogLength = useAtomValue(catalogListLengthAtom);
  const isCatalog = section === 'music' && musicView === 'catalog';
  const mainListVisible = layout !== 'focus' && layout !== 'wide';

  // Playback state (for playing indicator and favorite enrichment)
  const playbackTarget = useAtomValue(playerPlaybackAtom);
  const setPlayerError = useSetAtom(playerErrorAtom);

  // Lyrics state (rendered by Lyrics/Transcript; the lyrics session owns writes)
  const lyricsVisible = useAtomValue(lyricsVisibleAtom);
  const setLyricsVisible = useSetAtom(lyricsVisibleAtom);
  const lyricsData = useAtomValue(lyricsDataAtom);
  const timing = useAtomValue(lyricTimingAtom);
  const lyricFollowMode = useAtomValue(lyricFollowModeAtom);
  const timingDelay =
    overlay?.kind === 'lyric-timing' && timing === overlay.context
      ? overlay.delayMs
      : (timing?.delayMs ?? 0);
  useEffect(() => {
    const dismissStale = () => {
      const current = store.get(overlayAtom);
      if (current?.kind === 'lyric-timing' && current.context !== store.get(lyricTimingAtom)) {
        store.set(overlayAtom, null);
      }
    };
    dismissStale();
    return store.sub(lyricTimingAtom, dismissStale);
  }, [store]);
  const translationEnabled = useAtomValue(translationEnabledAtom);
  const setTranslationEnabled = useSetAtom(translationEnabledAtom);

  // Config (translation language submission)
  const config = useAtomValue(configAtom);
  const setConfig = useSetAtom(configAtom);

  // Search state
  const searchResults = useAtomValue(searchResultsAtom);
  const searchLoading = useAtomValue(searchLoadingAtom);
  const searchHasMore = useAtomValue(searchHasMoreAtom);
  const searchQuery = useAtomValue(searchQueryAtom);
  const setSearchQuery = useSetAtom(searchQueryAtom);
  const suggestions = useAtomValue(searchSuggestionsAtom);
  const suggestionIdx = useAtomValue(suggestionSelectedIdxAtom);
  const setSuggestionIdx = useSetAtom(suggestionSelectedIdxAtom);
  const suggestionsVisible = useAtomValue(suggestionsVisibleAtom);

  // Queue state
  const queueEntries = useAtomValue(queueEntriesAtom);
  const queueSelectionId = useAtomValue(queueSelectionIdAtom);
  const queueIndex = Math.max(
    0,
    queueEntries.findIndex((entry) => entry.entryId === queueSelectionId),
  );
  const queueTracks = useMemo(() => queueEntries.map((entry) => entry.track), [queueEntries]);
  const queueRowIds = useMemo(() => queueEntries.map((entry) => entry.entryId), [queueEntries]);
  const previewTracks = useMemo(() => queueTracks.slice(0, QUEUE_PREVIEW_SIZE), [queueTracks]);
  const hasQueuePane = layout === 'split' || layout === 'wide';
  const queuePaneFocused = hasQueuePane && focusedPanel === 'sidebar';
  const isQueue = section === 'music' && musicView === 'queue';

  // Library state
  const favoritesSet = useAtomValue(favoritesSetAtom);
  const favorites = useAtomValue(favoritesAtom);
  const history = useAtomValue(historyAtom);
  const setFavoritesSet = useSetAtom(favoritesSetAtom);
  const setFavorites = useSetAtom(favoritesAtom);
  const setHistory = useSetAtom(historyAtom);

  // Podcast state
  const podcastSearchResults = useAtomValue(podcastSearchResultsAtom);
  const selectedPodcast = useAtomValue(selectedPodcastAtom);
  const podcastEpisodes = useAtomValue(podcastEpisodesAtom);
  const setSubscribedFeeds = useSetAtom(subscribedFeedsAtom);
  const subscribedFeeds = useAtomValue(subscribedFeedsAtom);
  const podcastView = useAtomValue(podcastViewAtom);
  const setPodcastView = useSetAtom(podcastViewAtom);

  // Combined view for rendering convenience
  const activeView =
    section === 'podcast'
      ? podcastView
      : musicView === 'catalog'
        ? (catalogState.returnTo?.view ?? 'search')
        : musicView;

  // Local UI state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const visibleSelectedIndex = isCatalog ? catalogIndex : isQueue ? queueIndex : selectedIndex;
  const [episodePageSize, setEpisodePageSize] = useState(50);
  const clickScope = `${layout}:${section}:${section === 'music' ? musicView : podcastView}`;
  const focusTransitionRef = useRef(false);
  useEffect(() => {
    focusTransitionRef.current = store.get(focusedPanelAtom) !== focusedPanel;
  }, [focusedPanel, store]);

  // Load favorites + history + subscribed feeds from DB on mount
  useEffect(() => {
    try {
      const favTracks = getFavorites(db);
      setFavorites(favTracks);
      setFavoritesSet(new Set(favTracks.map(mediaKey)));
      setHistory(getHistory(db));
      setSubscribedFeeds(getSubscribedFeeds(db));
    } catch (err) {
      Logger.error(`Failed to load library: ${err}`);
    }
  }, [db, setFavorites, setFavoritesSet, setHistory, setSubscribedFeeds]);

  // -- Derived list state --

  const episodesAsTracks = useMemo(
    () => podcastEpisodes.slice(0, episodePageSize).map(episodeToTrack),
    [podcastEpisodes, episodePageSize],
  );
  const hasMoreEpisodes = podcastEpisodes.length > episodePageSize;

  const searchTracks = searchResults?.tracks;
  const mainTracks: Track[] = useMemo(() => {
    if (section === 'podcast') {
      return podcastView === 'episodes' ? episodesAsTracks : [];
    }
    if (musicView === 'queue') return queueTracks;
    if (musicView === 'library') return favorites;
    if (musicView === 'explore') return history;
    if (musicView === 'catalog') return [];
    return searchTracks ?? [];
  }, [
    section,
    podcastView,
    episodesAsTracks,
    musicView,
    queueTracks,
    favorites,
    history,
    searchTracks,
  ]);
  const trackNotesAtom = useMemo(
    () =>
      atom((get) => {
        get(episodeProgressRevisionAtom);
        const summaries = episodeProgress.summaries(mainTracks);
        return summaries.size === 0
          ? undefined
          : mainTracks.map((track) => summaries.get(mediaKey(track)));
      }),
    [episodeProgress, mainTracks],
  );
  const trackNotes = useAtomValue(trackNotesAtom);

  // Items visible in the main panel — unified for navigation
  const podcastListItems =
    section === 'podcast' && podcastView !== 'episodes'
      ? podcastView === 'search'
        ? podcastSearchResults
        : subscribedFeeds
      : [];
  const podcastClicks = usePointerClicks(clickScope, {
    context: podcastListItems.length ? podcastListItems : null,
    active: focusedPanel === 'main',
    scrollRef: podcastScrollRef,
  });
  const visibleListLength = !mainListVisible
    ? 0
    : isCatalog
      ? catalogLength
      : podcastListItems.length > 0
        ? podcastListItems.length
        : mainTracks.length;

  useEffect(() => {
    if (!isCatalog && !isQueue && mainListVisible) {
      setSelectedIndex((index) => Math.min(index, Math.max(0, visibleListLength - 1)));
    }
  }, [isCatalog, isQueue, mainListVisible, visibleListLength]);

  const subscribedFeedUrls = useMemo(
    () => new Set(subscribedFeeds.map((feed) => feed.feedUrl)),
    [subscribedFeeds],
  );

  const playingEntryId =
    playbackTarget?.origin.kind === 'queue' ? playbackTarget.origin.entryId : null;
  const playingMediaKey = playbackTarget ? mediaKey(playbackTarget.track) : null;
  const queuePlayingIndex = playingEntryId
    ? queueEntries.findIndex((entry) => entry.entryId === playingEntryId)
    : -1;
  const listPlayingIndex = mainTracks.findIndex(
    (track) => playingMediaKey !== null && mediaKey(track) === playingMediaKey,
  );

  const transcriptQuery = overlay?.kind === 'transcript-search' ? overlay.query : '';
  const transcriptMatches = useMemo(() => {
    if (overlay?.kind !== 'transcript-search') return [];
    const matches = searchTranscript(lyricsData?.lines ?? [], overlay.query);
    if (!timing?.delayMs) return matches;
    return matches.map((match) => ({
      ...match,
      time: Math.max(0, effectiveCueMs(match.time, timing.delayMs) / 1000),
    }));
  }, [overlay, lyricsData, timing]);
  const hasTranscript = (lyricsData?.lines.length ?? 0) > 0;

  // Let OpenTUI handle podcast list scroll (same as TrackList).
  useEffect(() => {
    const sb = podcastScrollRef.current;
    if (!sb || podcastListItems.length === 0) return;
    sb.scrollChildIntoView(`podcast-row-${selectedIndex}`);
  }, [selectedIndex, podcastListItems.length]);

  // Refresh DB-backed views when switching to them
  const refreshLibraryView = (view: string) => {
    try {
      if (view === 'library') setFavorites(getFavorites(db));
      if (view === 'explore') setHistory(getHistory(db));
    } catch (err) {
      Logger.error(`Failed to refresh ${view}: ${err}`);
    }
  };

  // -- Shared keyboard and pointer actions --

  const hasFocusedQueuePane = () => {
    const currentLayout = store.get(layoutAtom);
    return (
      (currentLayout === 'split' || currentLayout === 'wide') &&
      store.get(focusedPanelAtom) === 'sidebar'
    );
  };

  const selectedQueueEntry = () => {
    const entries = store.get(queueEntriesAtom);
    const entryId = store.get(queueSelectionIdAtom);
    const index = entries.findIndex((entry) => entry.entryId === entryId);
    return entries[
      index >= 0 &&
      (!hasFocusedQueuePane() || store.get(layoutAtom) !== 'wide' || index < QUEUE_PREVIEW_SIZE)
        ? index
        : 0
    ];
  };

  const selectedTrack = (): Track | null => {
    if (hasFocusedQueuePane()) return selectedQueueEntry()?.track ?? null;
    if (!mainListVisible || store.get(focusedPanelAtom) !== 'main') return null;
    if (
      store.get(sectionAtom) !== section ||
      (section === 'music' && store.get(musicViewAtom) !== musicView) ||
      (section === 'podcast' && store.get(podcastViewAtom) !== podcastView)
    )
      return null;
    if (isCatalog) {
      const selection = store.get(catalogSelectionAtom);
      return selection?.kind === 'track' ? selection.track : null;
    }
    if (isQueue) return selectedQueueEntry()?.track ?? null;
    return mainTracks[visibleSelectedIndex] ?? null;
  };

  const episodeSelection = (): { track: Track; entryId: string | null } | null => {
    const selected = selectedTrack();
    if (selected?.source?.kind === 'podcast') {
      return {
        track: selected,
        entryId: isQueue || hasFocusedQueuePane() ? (selectedQueueEntry()?.entryId ?? null) : null,
      };
    }
    const target = store.get(playerPlaybackAtom);
    if (target?.track.source?.kind !== 'podcast') return null;
    return {
      track: target.track,
      entryId: target.origin.kind === 'queue' ? target.origin.entryId : null,
    };
  };

  const playEpisode = (
    selection: { track: Track; entryId: string | null },
    intent: EpisodePlayIntent,
  ): Promise<void> =>
    selection.entryId === null
      ? playback.playDirect(selection.track, intent)
      : playback.playQueueEntry(selection.entryId, intent);

  const catalogReturnTo = () => {
    if (musicView === 'catalog') return undefined;
    return { view: musicView, selectedIndex };
  };

  const openSourcePicker = (track: Track, expectedRequestId: number | null): void => {
    if (track.source?.kind !== 'podcast') return;
    const preference = playback.getSourcePreference(track);
    const modes = ['auto', 'rss', 'youtube-match', 'youtube-video'] as const;
    setOverlay({
      kind: 'source-picker',
      dialogId: crypto.randomUUID(),
      track,
      expectedRequestId,
      selectedIdx: modes.indexOf(preference.mode),
      value: preference.mode === 'youtube-video' ? preference.videoId : '',
      editing: false,
      busy: false,
      error: null,
    });
  };

  const toggleDisplay = (key: 'ascii' | 'reducedMotion' | 'spectrumEnabled'): void => {
    const current = store.get(configAtom);
    const next = { ...current, [key]: !current[key] };
    saveConfig(next);
    setConfig(next);
  };
  const reportCommandError = (err: unknown): void => {
    if (err instanceof Error && err.name === 'AbortError') return;
    setPlayerError(err instanceof Error ? err.message : String(err));
  };

  const setFocus = (panel: 'search' | 'sidebar' | 'main') => {
    focusTransitionRef.current = store.get(focusedPanelAtom) !== panel;
    if (panel === 'search') searchInputRef.current?.focus();
    else searchInputRef.current?.blur();
    setFocusedPanel(panel);
  };

  const submitSearch = (query: string) => {
    const section = store.get(sectionAtom);
    if (section === 'music') catalog.close();
    setSearchQuery(query);
    setFocus('main');
    setSelectedIndex(0);
    void search.search(query, section);
  };

  const selectSidebarView = (view: View) => {
    if (store.get(sectionAtom) === 'music') {
      if (view === 'catalog' || view === 'episodes' || view === 'feeds') return;
      if (view === store.get(musicViewAtom)) return;
      catalog.close();
      setMusicView(view);
      refreshLibraryView(view);
    } else {
      if (view !== 'search' && view !== 'episodes' && view !== 'feeds') return;
      if (view === store.get(podcastViewAtom)) return;
      setPodcastView(view);
    }
    setSelectedIndex(0);
  };

  const navigateQueue = (direction: 'up' | 'down' | 'first' | 'last') => {
    const entries = store.get(queueEntriesAtom);
    const length =
      hasFocusedQueuePane() && store.get(layoutAtom) === 'wide'
        ? Math.min(QUEUE_PREVIEW_SIZE, entries.length)
        : entries.length;
    if (length === 0) return;
    const entryId = selectedQueueEntry()?.entryId;
    const index = entries.findIndex((entry) => entry.entryId === entryId);
    const next =
      direction === 'down'
        ? Math.min(index + 1, length - 1)
        : direction === 'up'
          ? Math.max(index - 1, 0)
          : direction === 'first'
            ? 0
            : length - 1;
    store.set(queueSelectionIdAtom, entries[next].entryId);
  };
  const navigate = (direction: 'up' | 'down' | 'first' | 'last') => {
    if (hasFocusedQueuePane()) {
      navigateQueue(direction);
      return;
    }
    if (store.get(focusedPanelAtom) === 'sidebar') {
      if (section === 'music') {
        const views: MusicView[] = ['search', 'queue', 'library', 'explore'];
        const view =
          musicView === 'catalog' ? (catalogState.returnTo?.view ?? 'search') : musicView;
        const idx = views.indexOf(view);
        const next =
          direction === 'down'
            ? views[Math.min(idx + 1, views.length - 1)]
            : direction === 'up'
              ? views[Math.max(idx - 1, 0)]
              : direction === 'first'
                ? views[0]
                : views[views.length - 1];
        selectSidebarView(next);
        return;
      }
      const views: PodcastView[] = ['search', 'feeds', 'episodes'];
      const idx = views.indexOf(podcastView);
      const next =
        direction === 'down'
          ? views[Math.min(idx + 1, views.length - 1)]
          : direction === 'up'
            ? views[Math.max(idx - 1, 0)]
            : direction === 'first'
              ? views[0]
              : views[views.length - 1];
      selectSidebarView(next);
      return;
    }
    if (isCatalog && mainListVisible) {
      catalog.navigate(direction);
      return;
    }
    if (visibleListLength === 0) return;
    if (isQueue) {
      navigateQueue(direction);
      return;
    }
    setSelectedIndex((i) => {
      if (direction === 'down') return Math.min(i + 1, visibleListLength - 1);
      if (direction === 'up') return Math.max(i - 1, 0);
      if (direction === 'first') return 0;
      return visibleListLength - 1;
    });
  };

  const openPodcast = (podcast: Podcast) => {
    setSelectedIndex(0);
    setEpisodePageSize(50);
    runCommand(() => search.openPodcast(podcast));
  };

  const activateQueueEntry = (entryId: string) =>
    runCommand(() => playback.playQueueEntry(entryId));

  const activateSelection = () => {
    if (hasFocusedQueuePane() || (mainListVisible && isQueue)) {
      const entry = selectedQueueEntry();
      if (entry) activateQueueEntry(entry.entryId);
      return;
    }
    if (!mainListVisible) return;
    if (isCatalog) {
      const selection = store.get(catalogSelectionAtom);
      if (selection?.kind === 'album') runCommand(() => catalog.openAlbum(selection.album.id));
      else if (selection?.kind === 'track') runCommand(() => playback.playDirect(selection.track));
      return;
    }
    // Podcast: enter on a podcast item loads its episodes
    if (section === 'podcast' && podcastView !== 'episodes' && podcastListItems.length > 0) {
      const podcast = podcastListItems[selectedIndex];
      if (podcast) openPodcast(podcast);
      return;
    }
    const track = selectedTrack();
    if (track) runCommand(() => playback.playDirect(track));
  };

  const submitOverlay = (submitted: Overlay) => {
    switch (submitted.kind) {
      case 'command-palette': {
        const cmd = filterCommands(submitted.filter)[submitted.selectedIdx];
        if (cmd) {
          // Close first so a command opening another overlay is not re-closed.
          setOverlay(null);
          executeCommand(cmd.id);
        }
        break;
      }
      case 'episode-bookmarks': {
        const bookmark = submitted.bookmarks[submitted.selectedIdx];
        if (!bookmark) return;
        try {
          if (submitted.editing === 'rename') {
            episodeProgress.renameBookmark(submitted.track, bookmark.id, submitted.value);
          } else if (submitted.editing === 'delete') {
            episodeProgress.deleteBookmark(submitted.track, bookmark.id);
          } else {
            if (
              submitted.entryId &&
              !store.get(queueEntriesAtom).some((entry) => entry.entryId === submitted.entryId)
            )
              throw new Error('This episode is no longer in the queue.');
            setOverlay(null);
            void playEpisode(submitted, { kind: 'bookmark', bookmark }).catch(reportCommandError);
            return;
          }
          const bookmarks = episodeProgress.listBookmarks(submitted.track);
          const same = bookmarks.findIndex((item) => item.id === bookmark.id);
          setOverlay({
            ...submitted,
            bookmarks,
            selectedIdx:
              same >= 0 ? same : Math.max(0, Math.min(submitted.selectedIdx, bookmarks.length - 1)),
            editing: null,
            value: '',
            error: null,
          });
        } catch (error) {
          setOverlay({
            ...submitted,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case 'lyric-timing': {
        try {
          lyricTiming.save(submitted.context, submitted.delayMs);
          setOverlay(null);
        } catch (error) {
          setOverlay({
            ...submitted,
            delayMs: submitted.context.delayMs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case 'seek': {
        const seconds = parseTimeInput(submitted.value);
        if (seconds === null || seconds < 0) return; // invalid — stay open
        seekTo(seconds);
        setOverlay(null);
        break;
      }
      case 'transcript-url': {
        const url = submitted.value.trim();
        setOverlay(null);
        void lyrics.setTranscriptSource(url ? { kind: 'custom', url } : { kind: 'auto' });
        break;
      }
      case 'transcript-search': {
        const match = transcriptMatches[submitted.selectedIdx];
        if (match) {
          const duration = store.get(playerDurationAtom);
          seekTo(
            store.get(lyricTimingAtom) && duration > 0
              ? Math.min(match.time, duration)
              : match.time,
          );
        }
        setOverlay(null);
        break;
      }
      case 'translation-language': {
        const lang = submitted.value.trim().toLowerCase();
        if (lang.length >= 2) {
          // Save synchronously before updating the atom.
          const next = { ...store.get(configAtom), translationLanguage: lang };
          saveConfig(next);
          setConfig(next);
          Logger.info(`Translation language set to: ${lang}`);
        }
        setOverlay(null);
        break;
      }
      case 'source-picker': {
        const current = store.get(overlayAtom);
        if (
          current?.kind !== 'source-picker' ||
          current.dialogId !== submitted.dialogId ||
          current.busy
        )
          return;
        let preference: PlaybackSourcePreference;
        if (current.selectedIdx === 3) {
          const videoId = parseYouTubeVideoId(current.value);
          if (!videoId) {
            setOverlay({
              ...current,
              error: 'Enter a valid YouTube video URL or 11-character ID.',
            });
            return;
          }
          preference = { mode: 'youtube-video', videoId };
        } else {
          const mode = (['auto', 'rss', 'youtube-match'] as const)[current.selectedIdx];
          if (!mode) return;
          preference = { mode };
        }
        setOverlay({ ...current, busy: true, error: null });
        void playback
          .setSourcePreference(current.track, preference, current.expectedRequestId)
          .then((result) => {
            setOverlay((active) => {
              if (active?.kind !== 'source-picker' || active.dialogId !== current.dialogId)
                return active;
              return result.status === 'failed'
                ? { ...active, busy: false, error: result.message }
                : null;
            });
          })
          .catch((error: unknown) => {
            setOverlay((active) => {
              if (active?.kind !== 'source-picker' || active.dialogId !== current.dialogId)
                return active;
              if (error instanceof Error && error.name === 'AbortError') return null;
              return {
                ...active,
                busy: false,
                error: error instanceof Error ? error.message : String(error),
              };
            });
          });
        break;
      }
      default:
        break;
    }
  };

  const toggleFavorite = () => {
    const track = selectedTrack();
    if (!track) return;
    const key = mediaKey(track);
    // Favoriting the playing item saves its enriched track (resolvedSource).
    const toSave =
      playbackTarget && mediaKey(playbackTarget.track) === key ? playbackTarget.track : track;
    if (favoritesSet.has(key)) {
      removeFavorite(db, toSave);
      setFavoritesSet((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    } else {
      addFavorite(db, toSave);
      setFavoritesSet((prev) => new Set(prev).add(key));
    }
    setFavorites(getFavorites(db));
    Logger.info(`Favorite toggled: ${track.title}`);
  };

  // Exhaustive command handlers. Inapplicable selection commands no-op rather
  // than act on a hidden stale selection.
  const commandHandlers: Record<CommandId, () => void | Promise<void>> = {
    'play-pause': () => player.togglePause(),
    next: () => playback.next(),
    prev: () => playback.previous(),
    'seek-forward': () => player.seekRelative(10),
    'seek-backward': () => player.seekRelative(-10),
    'seek-to': () => setOverlay({ kind: 'seek', value: '' }),
    'volume-up': () => player.addVolume(5),
    'volume-down': () => player.addVolume(-5),
    mute: () => player.toggleMute(),
    'speed-up': () => player.cycleSpeedUp(),
    'speed-down': () => player.cycleSpeedDown(),
    'speed-reset': () => player.setSpeed(1.0),
    'speed-1.5': () => player.setSpeed(1.5),
    'speed-2': () => player.setSpeed(2.0),
    shuffle: () => playback.toggleShuffle(),
    repeat: () => playback.cycleRepeat(),
    search: () => setFocus('search'),
    'view-search': () => {
      catalog.close();
      setSection('music');
      setMusicView('search');
      setSelectedIndex(0);
    },
    'view-queue': () => {
      catalog.close();
      setSection('music');
      setMusicView('queue');
      setSelectedIndex(0);
    },
    'view-favorites': () => {
      catalog.close();
      refreshLibraryView('library');
      setSection('music');
      setMusicView('library');
      setSelectedIndex(0);
    },
    'view-history': () => {
      catalog.close();
      refreshLibraryView('explore');
      setSection('music');
      setMusicView('explore');
      setSelectedIndex(0);
    },
    lyrics: () => setLyricsVisible((v) => !v),
    'load-more': () => {
      if (isCatalog && mainListVisible) return catalog.loadMore();
      if (section === 'music' && musicView === 'search' && searchHasMore) {
        return search.loadMore();
      }
      if (section === 'podcast' && podcastView === 'episodes' && hasMoreEpisodes) {
        setEpisodePageSize((prev) => prev + 50);
      }
      return undefined;
    },
    favorite: () => {
      if (!hasFocusedQueuePane() && (focusedPanel !== 'main' || visibleListLength === 0)) return;
      toggleFavorite();
    },
    'queue-add': () => {
      if (!hasFocusedQueuePane() && (focusedPanel !== 'main' || visibleListLength === 0)) return;
      const track = selectedTrack();
      if (track) {
        playback.enqueue(track);
        Logger.info(`Queued: ${track.title}`);
      }
    },
    'queue-remove': () => {
      if (!hasFocusedQueuePane() && (focusedPanel !== 'main' || !isQueue || !mainListVisible))
        return;
      const entry = selectedQueueEntry();
      if (!entry) return;
      return playback.remove(entry.entryId);
    },
    'podcast-search': () => {
      setSection('podcast');
      setPodcastView('search');
      setFocus('search');
      setSelectedIndex(0);
    },
    'podcast-feeds': () => {
      setSection('podcast');
      setPodcastView('feeds');
      setSelectedIndex(0);
    },
    'podcast-subscribe': () => {
      if (selectedPodcast) {
        subscribeFeed(db, selectedPodcast);
        setSubscribedFeeds(getSubscribedFeeds(db));
        Logger.info(`Subscribed: ${selectedPodcast.title}`);
      }
    },
    'podcast-unsubscribe': () => {
      if (selectedPodcast) {
        unsubscribeFeed(db, selectedPodcast.feedUrl);
        setSubscribedFeeds(getSubscribedFeeds(db));
        Logger.info(`Unsubscribed: ${selectedPodcast.title}`);
      }
    },
    'transcript-url': () => setOverlay({ kind: 'transcript-url', value: '' }),
    'transcript-auto': () => {
      void lyrics.setTranscriptSource({ kind: 'auto' });
      Logger.info('Transcript source reset to auto');
    },
    'transcript-reload': () => lyrics.reload(),
    'transcript-search': () => {
      if (!hasTranscript) return;
      if (!lyricsVisible) setLyricsVisible(true);
      setOverlay({ kind: 'transcript-search', query: '', selectedIdx: 0 });
    },
    'layout-default': () => setLayout('default'),
    'layout-compact': () => setLayout('compact'),
    'layout-minimal': () => setLayout('minimal'),
    'layout-split': () => setLayout('split'),
    'layout-wide': () => setLayout('wide'),
    'layout-focus': () => setLayout('focus'),
    'layout-vertical': () => setLayout('vertical'),
    'layout-cycle': () => setLayout((prev) => nextLayout(prev)),
    'theme-cycle': () => setThemeName((prev) => nextTheme(prev)),
    'section-music': () => setSection('music'),
    'section-podcast': () => setSection('podcast'),
    'toggle-translation': () => {
      const enabling = !translationEnabled;
      setTranslationEnabled(enabling);
      if (enabling) setLyricsVisible(true);
    },
    'adjust-lyric-timing': () => {
      const context = store.get(lyricTimingAtom);
      if (!context) {
        setPlayerError('Start a track with synced music lyrics to adjust lyric timing.');
        return;
      }
      setSection('music');
      setLyricsVisible(true);
      if (layout === 'focus' || layout === 'wide' || layout === 'minimal') setLayout('default');
      setOverlay({ kind: 'lyric-timing', context, delayMs: context.delayMs, error: null });
    },
    'cycle-lyric-follow': () => {
      const current = store.get(configAtom);
      const next: typeof current = {
        ...current,
        lyricFollowMode:
          current.lyricFollowMode === 'keep-visible' ? 'upper-third' : 'keep-visible',
      };
      saveConfig(next);
      setConfig(next);
      store.set(
        playerNoticeAtom,
        next.lyricFollowMode === 'upper-third'
          ? 'Lyric follow: Upper third'
          : 'Lyric follow: Keep visible',
      );
    },
    'follow-lyrics': () => store.set(lyricFollowSuspendedAtom, null),
    'episode-resume': () => {
      const selection = episodeSelection();
      if (selection) return playEpisode(selection, { kind: 'resume' });
    },
    'episode-start': () => {
      const selection = episodeSelection();
      if (selection) return playEpisode(selection, { kind: 'start' });
    },
    'episode-bookmark-add': () => {
      const target = store.get(playerPlaybackAtom);
      if (target?.track.source?.kind !== 'podcast') return;
      const label = `Bookmark at ${formatTime(store.get(playerPositionAtom))}`;
      const saved = episodeProgress.addBookmark(label, target.requestId);
      store.set(playerNoticeAtom, `Bookmark saved at ${formatTime(saved.positionMs / 1000)}`);
    },
    'episode-bookmarks': () => {
      const selection = episodeSelection();
      if (!selection) return;
      setOverlay({
        kind: 'episode-bookmarks',
        ...selection,
        bookmarks: episodeProgress.listBookmarks(selection.track),
        selectedIdx: 0,
        editing: null,
        value: '',
        error: null,
      });
    },
    'source-selected': () => {
      const track = selectedTrack();
      if (track) openSourcePicker(track, null);
    },
    'source-current': () => {
      const target = store.get(playerPlaybackAtom);
      if (target && store.get(playerStateAtom) !== 'stopped')
        openSourcePicker(target.track, target.requestId);
    },
    'browse-artist': () => {
      const track = selectedTrack();
      if (
        track?.source?.kind === 'youtube' &&
        track.provider === runtime.musicProviderId &&
        track.artistId
      ) {
        return catalog.openArtist(track.artistId, catalogReturnTo());
      }
    },
    'browse-album': () => {
      if (!mainListVisible || focusedPanel !== 'main') return;
      const selection = isCatalog ? store.get(catalogSelectionAtom) : null;
      if (selection?.kind === 'album') return catalog.openAlbum(selection.album.id);
      const track = selectedTrack();
      if (
        track?.source?.kind === 'youtube' &&
        track.provider === runtime.musicProviderId &&
        track.albumId
      ) {
        return catalog.openAlbum(track.albumId, catalogReturnTo());
      }
    },
    'catalog-back': () => {
      if (!isCatalog || !mainListVisible) return;
      const destination = catalog.back();
      if (destination) {
        setMusicView(destination.view);
        setSelectedIndex(destination.selectedIndex);
      }
    },
    'catalog-tab': () => {
      if (isCatalog && mainListVisible) catalog.changeTab('next');
    },
    'catalog-retry': () => {
      if (isCatalog && mainListVisible) return catalog.retry();
    },
    'album-play': () => {
      if (isCatalog && mainListVisible && focusedPanel === 'main') return catalog.playAlbum();
    },
    'album-queue': () => {
      if (isCatalog && mainListVisible && focusedPanel === 'main') return catalog.queueAlbum();
    },
    'toggle-ascii': () => toggleDisplay('ascii'),
    'toggle-icon-style': () => {
      const current = store.get(configAtom);
      const iconStyle: IconStyle = current.iconStyle === 'nerd-font' ? 'unicode' : 'nerd-font';
      const next = { ...current, iconStyle };
      saveConfig(next);
      setConfig(next);
    },
    'toggle-reduced-motion': () => toggleDisplay('reducedMotion'),
    'toggle-spectrum': () => toggleDisplay('spectrumEnabled'),
    'set-translation-language': () => setOverlay({ kind: 'translation-language', value: '' }),
    help: () => setOverlay((prev) => (prev?.kind === 'help' ? null : { kind: 'help' })),
    quit: () => {
      if (store.get(overlayAtom)?.kind === 'quit-confirm') onQuit();
      else setOverlay({ kind: 'quit-confirm' });
    },
  };

  const runCommand = (action: () => void | Promise<void>): void => {
    try {
      const result = action();
      if (result instanceof Promise) result.catch(reportCommandError);
    } catch (err) {
      reportCommandError(err);
    }
  };
  const executeCommand = (id: CommandId): void => runCommand(commandHandlers[id]);

  const seekTo = (seconds: number, requestId?: number): void => {
    if (requestId !== undefined) {
      if (store.get(overlayAtom)) return;
      if (store.get(playerPlaybackAtom)?.requestId !== requestId) return;
      if (store.get(playerSeekableRequestAtom) !== requestId) return;
      const duration = store.get(playerDurationAtom);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds)) return;
      seconds = Math.min(duration, Math.max(0, seconds));
    }
    runCommand(() => player.seekAbsolute(seconds));
  };

  // -- Global keybindings: the sole registration, forwarding the dispatcher --
  useKeyboard((key: KeyEvent) => {
    if (
      focusTransitionRef.current &&
      store.get(focusedPanelAtom) !== 'search' &&
      !store.get(overlayAtom) &&
      !key.ctrl &&
      !key.meta &&
      !key.option
    ) {
      key.preventDefault();
      return;
    }
    const handled = dispatchKey(
      key,
      {
        overlay: store.get(overlayAtom),
        focusedPanel: store.get(focusedPanelAtom),
        queuePane: hasFocusedQueuePane(),
        section: store.get(sectionAtom),
        musicView: store.get(musicViewAtom),
        podcastView: store.get(podcastViewAtom),
        catalogKind:
          mainListVisible && isCatalog ? (store.get(catalogFrameAtom)?.kind ?? null) : null,
        hasSelection: hasFocusedQueuePane()
          ? store.get(queueEntriesAtom).length > 0
          : visibleListLength > 0,
        hasTranscript,
        transcriptMatchCount: transcriptMatches.length,
        suggestions: suggestionsVisible ? suggestions : [],
        suggestionIndex: suggestionIdx,
        searchQuery: store.get(searchQueryAtom),
        searchInputFocused: searchInputRef.current?.focused ?? false,
      },
      {
        command: executeCommand,
        setOverlay,
        setFocus,
        navigate,
        activateSelection,
        changeCatalogTab: (direction) => catalog.changeTab(direction),
        setSuggestionIndex: setSuggestionIdx,
        clearSuggestions: search.dismissSuggestions,
        submitSearch,
        submitOverlay,
      },
    );
    if (handled) key.preventDefault();
    if (store.get(overlayAtom)) searchInputRef.current?.blur();
  });

  const t = useTheme();
  const ACCENT = t.accent;
  const DIM = t.dim;
  const TEXT_FG = t.fg;

  const canClick = () => !store.get(overlayAtom) && store.get(layoutAtom) === layout;
  const canClickMain = () =>
    canClick() &&
    mainListVisible &&
    store.get(sectionAtom) === section &&
    (section === 'music'
      ? store.get(musicViewAtom) === musicView
      : store.get(podcastViewAtom) === podcastView) &&
    (isCatalog || !store.get(searchLoadingAtom));

  const clickQueueRow = (index: number, activate: boolean, auxiliary: boolean) => {
    if (auxiliary ? !canClick() : !canClickMain()) return;
    const entry = queueEntries[index];
    // The row owns its rendered entry ID. Never play the new occupant of
    // a position whose old hit target was just removed.
    if (!entry || store.get(queueEntriesAtom) !== queueEntries) return;
    setFocus(auxiliary ? 'sidebar' : 'main');
    store.set(queueSelectionIdAtom, entry.entryId);
    if (activate) activateQueueEntry(entry.entryId);
  };

  const clickTrackRow = (index: number, activate: boolean) => {
    if (isQueue) {
      clickQueueRow(index, activate, false);
      return;
    }
    if (!canClickMain()) return;
    const track = mainTracks[index];
    const stale =
      section === 'podcast'
        ? store.get(podcastEpisodesAtom) !== podcastEpisodes
        : musicView === 'library'
          ? store.get(favoritesAtom) !== favorites
          : musicView === 'explore'
            ? store.get(historyAtom) !== history
            : store.get(searchResultsAtom)?.tracks !== searchTracks;
    if (!track || stale) return;
    setFocus('main');
    setSelectedIndex(index);
    if (activate) runCommand(() => playback.playDirect(track));
  };

  const nowPlaying = (
    <NowPlaying
      onCommand={(id) => {
        if (canClick()) executeCommand(id);
      }}
      onSeek={seekTo}
    />
  );

  // -- Reusable JSX fragments --
  const resultCount = mainTracks.length;
  const pageInfo =
    section === 'music' && musicView === 'search' && resultCount > 0
      ? p.text(` (${resultCount}${searchHasMore ? ' • Shift+L for more' : ''})`)
      : '';
  const viewTitle =
    section === 'podcast'
      ? podcastView === 'episodes' && selectedPodcast
        ? selectedPodcast.title
        : 'Podcasts'
      : (isCatalog
          ? 'Browse music'
          : musicView === 'queue'
            ? 'Queue'
            : musicView === 'library'
              ? 'Favorites'
              : musicView === 'explore'
                ? 'History'
                : 'Results') + pageInfo;

  const emptyMessage =
    section === 'podcast'
      ? 'Use Ctrl+P > "podcast" to search, or subscribe to feeds.'
      : musicView === 'queue'
        ? 'Queue is empty. Press q on a track to add it.'
        : musicView === 'library'
          ? 'No favorites yet. Press f on a track to save it.'
          : musicView === 'explore'
            ? 'No history yet. Play a track to start.'
            : 'Press / to search YouTube Music';

  const podcastListJsx =
    podcastListItems.length > 0 ? (
      <scrollbox ref={podcastScrollRef} onMouseScroll={podcastClicks.clear} {...p.scrollbarProps}>
        {podcastListItems.map((podcast, i) => {
          const selected = i === selectedIndex;
          return (
            <box
              key={podcast.feedUrl}
              id={`podcast-row-${i}`}
              flexDirection="column"
              backgroundColor={selected ? t.selection : undefined}
              paddingLeft={1}
              paddingRight={1}
              onMouse={podcastClicks.bind(
                podcast.feedUrl,
                (activate) => {
                  if (!canClickMain()) return;
                  const current =
                    podcastView === 'search'
                      ? store.get(podcastSearchResultsAtom)
                      : store.get(subscribedFeedsAtom);
                  if (current !== podcastListItems) return;
                  setFocus('main');
                  setSelectedIndex(i);
                  if (activate) openPodcast(podcast);
                },
                true,
              )}
            >
              <box flexDirection="row">
                <text
                  fg={selected ? t.accent : t.dim}
                  attributes={selected ? TextAttributes.BOLD : 0}
                >
                  {String(i + 1).padStart(2, ' ')} {selected ? `${p.icon('selected')} ` : '  '}
                </text>
                <text
                  fg={selected ? t.accent : t.fg}
                  attributes={selected ? TextAttributes.BOLD : 0}
                  truncate
                  flexGrow={1}
                >
                  {podcast.title}
                </text>
                {subscribedFeedUrls.has(podcast.feedUrl) && (
                  <text fg={t.green}> {p.icon('check')}</text>
                )}
              </box>
              <box flexDirection="row">
                <text fg={t.dim}>
                  {'      '}
                  {podcast.author}
                </text>
              </box>
            </box>
          );
        })}
      </scrollbox>
    ) : null;

  const trackListJsx = isCatalog ? (
    <CatalogView
      key={clickScope}
      focused={focusedPanel === 'main'}
      playingTrackId={playbackTarget?.track.id}
      favoritesSet={favoritesSet}
      onTabClick={(frameId, tab) => {
        if (!canClickMain() || store.get(catalogFrameAtom)?.frameId !== frameId) return;
        setFocus('main');
        catalog.changeTab(tab);
      }}
      onRowClick={(frameId, items, index, activate) => {
        const frame = store.get(catalogFrameAtom);
        if (!canClickMain() || !frame || frame.frameId !== frameId) return;
        const current = frame.kind === 'album' ? frame.tracks.items : frame[frame.activeTab].items;
        if (current !== items || !items[index]) return;
        setFocus('main');
        catalog.navigate(index);
        if (activate) activateSelection();
      }}
    />
  ) : mainTracks.length > 0 ? (
    <TrackList
      key={clickScope}
      rowIds={isQueue ? queueRowIds : undefined}
      onRowClick={clickTrackRow}
      tracks={mainTracks}
      focused={focusedPanel === 'main'}
      selectedIndex={visibleSelectedIndex}
      playingIndex={isQueue ? queuePlayingIndex : listPlayingIndex}
      showRemoveHint={isQueue}
      rowNotes={trackNotes}
    />
  ) : (
    <box paddingLeft={1} paddingTop={1} flexDirection="column" gap={1}>
      <text fg={TEXT_FG}>{emptyMessage}</text>
      <text fg={DIM}>[?] help [ctrl+p] commands [ctrl+l] layout [ctrl+t] theme</text>
    </box>
  );

  const listContent =
    searchLoading && !isCatalog ? (
      <box paddingLeft={1} paddingTop={1}>
        <text fg={DIM}>Searching...</text>
      </box>
    ) : (
      (podcastListJsx ?? trackListJsx)
    );
  const isVertical = layout === 'vertical';
  const mainPanel = (
    <box flexGrow={1} flexDirection={isVertical ? 'column' : 'row'}>
      {/* Track list: shrinks when lyrics/transcript panel is open */}
      <box
        flexGrow={lyricsVisible ? 0 : 1}
        width={lyricsVisible && !isVertical ? '35%' : undefined}
        height={lyricsVisible && isVertical ? '50%' : undefined}
        flexDirection="column"
        border
        borderStyle="rounded"
        {...p.borderProps}
        borderColor={focusedPanel === 'main' ? ACCENT : DIM}
        title={viewTitle}
      >
        {listContent}
      </box>
      {/* Lyrics/Transcript: remaining space */}
      {lyricsVisible &&
        (section === 'podcast' ? (
          <Transcript />
        ) : (
          <Lyrics delayMs={timingDelay} followMode={lyricFollowMode} />
        ))}
    </box>
  );

  const sidebarJsx = (
    <Sidebar
      focused={focusedPanel === 'sidebar'}
      section={section}
      activeView={activeView}
      onViewClick={(view) => {
        if (!canClick() || store.get(sectionAtom) !== section) return;
        search.dismissSuggestions();
        setFocus('sidebar');
        selectSidebarView(view);
      }}
    />
  );

  const headerJsx = (
    <Header
      focused={focusedPanel === 'search' && overlay === null}
      inputRef={searchInputRef}
      section={section}
      query={searchQuery}
      onInput={(value) => {
        // OpenTUI also emits input when React writes the submitted query.
        if (value === store.get(searchQueryAtom)) return;
        setSearchQuery(value);
        search.suggest(value);
      }}
      onFocusedChange={(focused) => {
        if (!focused) return;
        if (store.get(overlayAtom)) {
          searchInputRef.current?.blur();
          return;
        }
        setFocusedPanel('search');
      }}
      suggestions={suggestions}
      suggestionIdx={suggestionIdx}
      suggestionsVisible={suggestionsVisible}
      onSectionClick={(next) => {
        if (!canClick()) return;
        search.dismissSuggestions();
        setFocus('main');
        executeCommand(next === 'music' ? 'section-music' : 'section-podcast');
      }}
      onSuggestionClick={(query) => {
        if (
          canClick() &&
          store.get(sectionAtom) === section &&
          store.get(suggestionsVisibleAtom) &&
          store.get(searchSuggestionsAtom) === suggestions &&
          suggestions.includes(query)
        )
          submitSearch(query);
      }}
    />
  );

  // -- Layout rendering --
  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Focus layout: centered now-playing only */}
      {layout === 'focus' ? (
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          {nowPlaying}
          <text fg={DIM}>
            [space] pause [n/p] next/prev [ctrl+l] layout [ctrl+t] theme [ctrl+q] quit
          </text>
        </box>
      ) : (
        /* All other layouts */
        <>
          {/* Header — all except focus */}
          {headerJsx}

          {/* Body — varies by layout */}
          {layout === 'wide' ? (
            /* Wide: large now playing + queue preview below */
            <box flexGrow={1} flexDirection="column">
              <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
                {nowPlaying}
              </box>
              <box
                border
                borderStyle="rounded"
                {...p.borderProps}
                borderColor={queuePaneFocused ? ACCENT : DIM}
                title="Up Next"
                height={8}
              >
                <TrackList
                  tracks={previewTracks}
                  rowIds={queueRowIds}
                  onRowClick={(index, activate) => clickQueueRow(index, activate, true)}
                  focused={queuePaneFocused}
                  selectedIndex={queueIndex < previewTracks.length ? queueIndex : 0}
                  playingIndex={queuePlayingIndex < previewTracks.length ? queuePlayingIndex : -1}
                />
              </box>
            </box>
          ) : layout === 'split' ? (
            /* Split: queue left, results right */
            <box flexDirection="row" flexGrow={1}>
              <box
                flexGrow={1}
                flexDirection="column"
                border
                borderStyle="rounded"
                {...p.borderProps}
                borderColor={focusedPanel === 'sidebar' ? ACCENT : DIM}
                title="Queue"
              >
                <TrackList
                  tracks={queueTracks}
                  rowIds={queueRowIds}
                  onRowClick={(index, activate) => clickQueueRow(index, activate, true)}
                  focused={queuePaneFocused}
                  selectedIndex={queueIndex}
                  playingIndex={queuePlayingIndex}
                  showRemoveHint={true}
                />
              </box>
              {mainPanel}
            </box>
          ) : layout === 'minimal' ? (
            /* Minimal: track list only */
            <box flexGrow={1} flexDirection="column">
              {listContent}
            </box>
          ) : layout === 'vertical' ? (
            /* Vertical: header + full-width main + footer, no sidebar */
            <box flexGrow={1} flexDirection="column">
              {mainPanel}
            </box>
          ) : (
            /* Default / Compact */
            <box flexDirection="row" flexGrow={1}>
              {layout === 'default' && sidebarJsx}
              {mainPanel}
            </box>
          )}

          {/* Now Playing footer — all except focus and wide */}
          {layout !== 'wide' && nowPlaying}
        </>
      )}

      {/* Overlays — at most one is active */}
      {overlay && (
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          zIndex={10}
          onMouse={(event) => event.stopPropagation()}
        >
          {overlay?.kind === 'help' && <HelpOverlay />}
          {overlay?.kind === 'command-palette' && (
            <CommandPalette
              filter={overlay.filter}
              selectedIdx={overlay.selectedIdx}
              onFilterChange={(value) =>
                setOverlay({ kind: 'command-palette', filter: value, selectedIdx: 0 })
              }
            />
          )}
          <QuitConfirm visible={overlay?.kind === 'quit-confirm'} />
          {overlay?.kind === 'source-picker' && (
            <SourcePicker overlay={overlay} onChange={setOverlay} />
          )}
          {overlay?.kind === 'episode-bookmarks' && (
            <EpisodeBookmarks
              overlay={overlay}
              onInput={(value) => {
                const current = store.get(overlayAtom);
                if (current?.kind === 'episode-bookmarks' && current.editing === 'rename')
                  setOverlay({ ...current, value, error: null });
              }}
            />
          )}
          {overlay?.kind === 'lyric-timing' && <LyricTiming overlay={overlay} />}
          {overlay?.kind === 'seek' && (
            <SeekInput
              value={overlay.value}
              onInput={(value) => setOverlay({ kind: 'seek', value })}
            />
          )}
          {overlay?.kind === 'transcript-url' && (
            <TranscriptUrlInput
              value={overlay.value}
              onInput={(value) => setOverlay({ kind: 'transcript-url', value })}
            />
          )}
          {overlay?.kind === 'translation-language' && (
            <TranslationLanguageInput
              value={overlay.value}
              currentLang={config.translationLanguage}
              onInput={(value) => setOverlay({ kind: 'translation-language', value })}
            />
          )}
          {overlay?.kind === 'transcript-search' && (
            <box
              position="absolute"
              bottom={3}
              left={1}
              right={1}
              height={Math.min(3 + Math.min(transcriptMatches.length, 5), 8)}
              border
              borderStyle="rounded"
              {...p.borderProps}
              borderColor={t.accent}
              backgroundColor={t.bg}
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
            >
              <box flexDirection="row">
                <text fg={t.accent} attributes={TextAttributes.BOLD}>
                  Find:{' '}
                </text>
                <input
                  focused
                  value={transcriptQuery}
                  onInput={
                    ((value: string) => {
                      setOverlay({ kind: 'transcript-search', query: value, selectedIdx: 0 });
                    }) as never
                  }
                />
                {transcriptMatches.length > 0 && (
                  <text fg={t.dim}>
                    {' '}
                    ({overlay.selectedIdx + 1}/{transcriptMatches.length})
                  </text>
                )}
              </box>
              {transcriptMatches.slice(0, 5).map((match, i) => (
                <text
                  key={match.idx}
                  fg={i === overlay.selectedIdx ? t.accent : t.dim}
                  attributes={i === overlay.selectedIdx ? TextAttributes.BOLD : 0}
                  truncate
                >
                  {i === overlay.selectedIdx ? ` ${p.icon('selected')} ` : '   '}[
                  {formatTime(match.time)}] {match.text}
                </text>
              ))}
              {transcriptMatches.length === 0 && transcriptQuery.trim() && (
                <text fg={t.dim}> No matches</text>
              )}
            </box>
          )}
        </box>
      )}
    </box>
  );
}
