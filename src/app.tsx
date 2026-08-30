import { type KeyEvent, type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { Provider, useAtomValue, useSetAtom } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterCommands } from './commands';
import { getDb } from './db/index';
import {
  addFavorite,
  getFavorites,
  getHistory,
  getSubscribedFeeds,
  getTranslation,
  isSubscribed,
  removeFavorite,
  saveTranslation,
  subscribeFeed,
  unsubscribeFeed,
} from './db/queries';
import type { PlayerController } from './player/controller';
import { fetchLyrics, type LyricsResult } from './providers/lyrics';
import { podcastProvider } from './providers/podcast';
import { extractYouTubeSrt, findYouTubeVideoId, youtubeUrl } from './providers/podcast-youtube';
import { getActiveProvider } from './providers/registry';
import { parseSrt, parseVtt } from './providers/subtitle-parser';
import { fetchTranscript } from './providers/transcript';
import { getTranslationProvider } from './providers/translate';
import type { Track } from './providers/types';
import { getTranslatedTranscript } from './providers/youtube';
import { favoritesAtom, favoritesSetAtom, historyAtom } from './store/library';
import {
  lyricsDataAtom,
  lyricsLoadingAtom,
  lyricsVisibleAtom,
  transcriptSourceAtom,
  translationEnabledAtom,
  translationLoadingAtom,
} from './store/lyrics';
import { playerTrackAtom } from './store/player';
import {
  episodesLoadingAtom,
  podcastEpisodesAtom,
  podcastSearchLoadingAtom,
  podcastSearchResultsAtom,
  selectedPodcastAtom,
  subscribedFeedsAtom,
} from './store/podcast';
import {
  playingFromQueueAtom,
  queueAtom,
  queueIndexAtom,
  repeatAtom,
  shuffleAtom,
  shuffledIndicesAtom,
} from './store/queue';
import { nextIndex, prevIndex, removeFromQueue, shuffleIndices } from './store/queue-actions';
import {
  focusedPanelAtom,
  layoutAtom,
  type MusicView,
  musicViewAtom,
  type PodcastView,
  podcastViewAtom as podcastViewAtomUI,
  searchContinuationAtom,
  searchHasMoreAtom,
  searchLoadingAtom,
  searchPageAtom,
  searchResultsAtom,
  searchSuggestionsAtom,
  sectionAtom,
  suggestionSelectedIdxAtom,
  suggestionsVisibleAtom,
  themeNameAtom,
} from './store/ui';
import { CommandPalette } from './ui/CommandPalette';
import { Header } from './ui/Header';
import { HelpOverlay } from './ui/HelpOverlay';
import { Lyrics } from './ui/Lyrics';
import { nextLayout } from './ui/layouts';
import { NowPlaying } from './ui/NowPlaying';
import { QuitConfirm } from './ui/QuitConfirm';
import { parseTimeInput, SeekInput } from './ui/SeekInput';
import { Sidebar } from './ui/Sidebar';
import { TrackList } from './ui/TrackList';
import { Transcript } from './ui/Transcript';
import { TranscriptUrlInput } from './ui/TranscriptUrlInput';
import { TranslationLanguageInput } from './ui/TranslationLanguageInput';
import { nextTheme } from './ui/themes';
import { useTheme } from './ui/useTheme';
import { loadConfig, saveConfig } from './utils/config';
import { formatTime } from './utils/format';
import { Logger } from './utils/logger';
import { searchTranscript } from './utils/transcript-search';

interface AppProps {
  store: Store;
  controller: PlayerController;
  onQuit: () => void;
}

export function App({ store, controller, onQuit }: AppProps): React.ReactNode {
  return (
    <Provider store={store}>
      <AppInner controller={controller} onQuit={onQuit} />
    </Provider>
  );
}

function AppInner({
  controller,
  onQuit,
}: {
  controller: PlayerController;
  onQuit: () => void;
}): React.ReactNode {
  // UI state
  const focusedPanel = useAtomValue(focusedPanelAtom);
  const setFocusedPanel = useSetAtom(focusedPanelAtom);
  const section = useAtomValue(sectionAtom);
  const setSection = useSetAtom(sectionAtom);
  const musicView = useAtomValue(musicViewAtom);
  const setMusicView = useSetAtom(musicViewAtom);
  const layout = useAtomValue(layoutAtom);
  const setLayout = useSetAtom(layoutAtom);
  const _themeName = useAtomValue(themeNameAtom);
  const setThemeName = useSetAtom(themeNameAtom);

  // Player state (for playing indicator)
  const playerTrack = useAtomValue(playerTrackAtom);

  // Lyrics state
  const lyricsVisible = useAtomValue(lyricsVisibleAtom);
  const setLyricsVisible = useSetAtom(lyricsVisibleAtom);
  const setLyricsData = useSetAtom(lyricsDataAtom);
  const lyricsData = useAtomValue(lyricsDataAtom);
  const setLyricsLoading = useSetAtom(lyricsLoadingAtom);

  // Translation state
  const translationEnabled = useAtomValue(translationEnabledAtom);
  const setTranslationEnabled = useSetAtom(translationEnabledAtom);
  const setTranslationLoading = useSetAtom(translationLoadingAtom);

  // Search state
  const searchResults = useAtomValue(searchResultsAtom);
  const searchLoading = useAtomValue(searchLoadingAtom);
  const setSearchResults = useSetAtom(searchResultsAtom);
  const setSearchLoading = useSetAtom(searchLoadingAtom);
  const searchPage = useAtomValue(searchPageAtom);
  const setSearchPage = useSetAtom(searchPageAtom);
  const searchHasMore = useAtomValue(searchHasMoreAtom);
  const setSearchHasMore = useSetAtom(searchHasMoreAtom);
  const searchContinuation = useAtomValue(searchContinuationAtom);
  const setSearchContinuation = useSetAtom(searchContinuationAtom);

  // Search suggestions
  const suggestions = useAtomValue(searchSuggestionsAtom);
  const setSuggestions = useSetAtom(searchSuggestionsAtom);
  const suggestionIdx = useAtomValue(suggestionSelectedIdxAtom);
  const setSuggestionIdx = useSetAtom(suggestionSelectedIdxAtom);
  const suggestionsVisible = useAtomValue(suggestionsVisibleAtom);
  const setSuggestionsVisible = useSetAtom(suggestionsVisibleAtom);

  // Queue state
  const queue = useAtomValue(queueAtom);
  const queueIndex = useAtomValue(queueIndexAtom);
  const repeat = useAtomValue(repeatAtom);
  const shuffle = useAtomValue(shuffleAtom);
  const setQueue = useSetAtom(queueAtom);
  const setQueueIndex = useSetAtom(queueIndexAtom);
  const setRepeat = useSetAtom(repeatAtom);
  const setShuffle = useSetAtom(shuffleAtom);
  const setShuffledIndices = useSetAtom(shuffledIndicesAtom);
  const shuffledIndices = useAtomValue(shuffledIndicesAtom);
  const playingFromQueue = useAtomValue(playingFromQueueAtom);
  const setPlayingFromQueue = useSetAtom(playingFromQueueAtom);

  // Library state
  const favoritesSet = useAtomValue(favoritesSetAtom);
  const favorites = useAtomValue(favoritesAtom);
  const history = useAtomValue(historyAtom);
  const setFavoritesSet = useSetAtom(favoritesSetAtom);
  const setFavorites = useSetAtom(favoritesAtom);
  const setHistory = useSetAtom(historyAtom);

  // Podcast state
  const podcastSearchResults = useAtomValue(podcastSearchResultsAtom);
  const setPodcastSearchResults = useSetAtom(podcastSearchResultsAtom);
  const setPodcastSearchLoading = useSetAtom(podcastSearchLoadingAtom);
  const selectedPodcast = useAtomValue(selectedPodcastAtom);
  const setSelectedPodcast = useSetAtom(selectedPodcastAtom);
  const podcastEpisodes = useAtomValue(podcastEpisodesAtom);
  const setPodcastEpisodes = useSetAtom(podcastEpisodesAtom);
  const setEpisodesLoading = useSetAtom(episodesLoadingAtom);
  const subscribedFeeds = useAtomValue(subscribedFeedsAtom);
  const setSubscribedFeeds = useSetAtom(subscribedFeedsAtom);
  const podcastView = useAtomValue(podcastViewAtomUI);
  const setPodcastView = useSetAtom(podcastViewAtomUI);

  // Combined view for rendering convenience
  const activeView = section === 'podcast' ? podcastView : musicView;

  // Local UI state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [episodePageSize, setEpisodePageSize] = useState(50);
  const [helpVisible, setHelpVisible] = useState(false);
  const [paletteVisible, setPaletteVisible] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [paletteSelectedIdx, setPaletteSelectedIdx] = useState(0);
  const [quitConfirmVisible, setQuitConfirmVisible] = useState(false);
  const [seekInputVisible, setSeekInputVisible] = useState(false);
  const [seekInputValue, setSeekInputValue] = useState('');
  const [transcriptUrlVisible, setTranscriptUrlVisible] = useState(false);
  const [transcriptUrlValue, setTranscriptUrlValue] = useState('');
  const [transcriptSearchVisible, setTranscriptSearchVisible] = useState(false);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState('');
  const [transcriptSearchIdx, setTranscriptSearchIdx] = useState(0);
  const [translationLangVisible, setTranslationLangVisible] = useState(false);
  const [translationLangValue, setTranslationLangValue] = useState('');

  const transcriptMatches = useMemo(
    () =>
      transcriptSearchVisible
        ? searchTranscript(lyricsData?.lines ?? [], transcriptSearchQuery)
        : [],
    [transcriptSearchVisible, transcriptSearchQuery, lyricsData],
  );
  const setTranscriptSource = useSetAtom(transcriptSourceAtom);
  const podcastScrollRef = useRef<ScrollBoxRenderable>(null);

  // Load favorites + history + subscribed feeds from DB on mount
  useEffect(() => {
    try {
      const db = getDb();
      const favTracks = getFavorites(db);
      setFavorites(favTracks);
      setFavoritesSet(new Set(favTracks.map((t) => `${t.provider}:${t.id}`)));
      setHistory(getHistory(db));
      setSubscribedFeeds(getSubscribedFeeds(db));
    } catch (err) {
      Logger.error(`Failed to load library: ${err}`);
    }
  }, [setFavorites, setFavoritesSet, setHistory, setSubscribedFeeds]);

  // Auto-fetch lyrics when track changes (music only).
  // Podcast transcripts are loaded by handlePlayEpisode — do NOT overwrite
  // them here, otherwise fetchLyrics returns null and clears the transcript.
  useEffect(() => {
    if (!playerTrack) {
      setLyricsData(null);
      return;
    }
    // Skip for podcast tracks — transcript is handled separately
    if (section === 'podcast') return;

    let cancelled = false;
    setLyricsLoading(true);
    fetchLyrics(playerTrack)
      .then((result) => {
        if (!cancelled) {
          setLyricsData(result);
          setLyricsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLyricsData(null);
          setLyricsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [playerTrack, section, setLyricsData, setLyricsLoading]);

  // Ref to hold latest lyricsData for the translation effect — avoids stale closures
  // and lets the effect depend only on stable trigger values (translationEnabled, playerTrack).
  const lyricsDataRef = useRef(lyricsData);
  lyricsDataRef.current = lyricsData;

  // Auto-translate lyrics when translation is enabled.
  // The effect body reads from lyricsDataRef.current, but still needs to re-fire when
  // lyricsData?.translatedTo is cleared (toggle re-enable) or source changes (new track).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-trigger via ref pattern
  useEffect(() => {
    if (!translationEnabled) {
      Logger.debug('Translation effect: skipped (translation disabled)');
      return;
    }
    const data = lyricsDataRef.current;
    if (!data || data.lines.length === 0) {
      Logger.debug(`Translation effect: skipped (no lyrics data loaded)`);
      return;
    }
    // Already translated — nothing to do
    if (data.translatedTo) {
      Logger.debug(`Translation effect: skipped (already translated to ${data.translatedTo})`);
      return;
    }

    const config = loadConfig();
    // Auto-set language to 'en' on first enable if not configured
    let targetLang = config.translationLanguage;
    if (!targetLang) {
      targetLang = 'en';
      saveConfig({ ...config, translationLanguage: targetLang });
      Logger.info(`Translation: auto-set language to 'en' (was null)`);
    }

    const trackName = playerTrack ? `${playerTrack.artist} - ${playerTrack.title}` : 'unknown';
    Logger.info(
      `Translation: starting for "${trackName}" (${data.lines.length} lines, source=${data.source}, target=${targetLang}, provider=${config.translationProvider})`,
    );

    let cancelled = false;
    setTranslationLoading(true);

    const doTranslation = async (): Promise<LyricsResult | null> => {
      const trackId = playerTrack?.id ?? 'unknown';
      const source = data.source;

      // Check DB cache first
      const cached = getTranslation(getDb(), trackId, source, targetLang);
      if (cached && cached.length === data.lines.length) {
        Logger.info(
          `Translation: cache HIT for ${trackId} (${source}→${targetLang}, ${cached.length} lines)`,
        );
        return {
          ...data,
          lines: data.lines.map((line, i) => ({
            ...line,
            translatedText: cached[i] ?? '',
          })),
          translatedTo: targetLang,
        };
      }
      Logger.info(`Translation: cache MISS for ${trackId} (${source}→${targetLang})`);

      // For YouTube tracks, try native transcript translation first
      if (playerTrack?.provider === 'youtube' && source === 'youtube') {
        Logger.info(`Translation: trying YouTube native transcript for ${trackId}→${targetLang}`);
        const ytTranslated = await getTranslatedTranscript(playerTrack.id, targetLang);
        if (ytTranslated && ytTranslated.length > 0) {
          Logger.info(`Translation: YouTube native OK — ${ytTranslated.length} translated lines`);
          const mergedLines = data.lines.map((line, i) => ({
            ...line,
            translatedText: ytTranslated[i]?.text ?? '',
          }));
          const translatedTexts = mergedLines.map((l) => l.translatedText ?? '');
          saveTranslation(getDb(), trackId, source, targetLang, 'youtube', translatedTexts);
          return { ...data, lines: mergedLines, translatedTo: targetLang };
        }
        Logger.info('Translation: YouTube native unavailable, falling back to external provider');
      }

      // External provider translation (batch)
      const provider = getTranslationProvider(config.translationProvider, {
        deeplApiKey: config.deeplApiKey ?? undefined,
        lingvaInstance: config.lingvaInstance ?? undefined,
      });
      const textsToTranslate = data.lines.map((l) => l.text).filter((t) => t.trim().length > 0);
      if (textsToTranslate.length === 0) {
        Logger.info('Translation: no non-empty lines to translate');
        return null;
      }

      Logger.info(
        `Translation: calling ${provider.name} (${provider.id}) with ${textsToTranslate.length} lines`,
      );
      const translatedTexts = await provider.translateBatch(textsToTranslate, targetLang);
      Logger.info(
        `Translation: ${provider.id} returned ${translatedTexts.length} translated lines`,
      );

      // Map back to full lines (including empty ones)
      let translatedIdx = 0;
      const mergedLines = data.lines.map((line) => {
        if (line.text.trim().length === 0) {
          return { ...line, translatedText: '' };
        }
        const translated = translatedTexts[translatedIdx] ?? '';
        translatedIdx++;
        return { ...line, translatedText: translated };
      });

      const allTranslated = mergedLines.map((l) => l.translatedText ?? '');
      saveTranslation(getDb(), trackId, source, targetLang, provider.id, allTranslated);
      Logger.info(
        `Translation: merged and cached ${mergedLines.length} lines (${provider.id}→${targetLang})`,
      );
      return { ...data, lines: mergedLines, translatedTo: targetLang };
    };

    doTranslation()
      .then((result) => {
        if (!cancelled && result) {
          const translatedCount = result.lines.filter(
            (l) => l.translatedText && l.translatedText.length > 0,
          ).length;
          Logger.info(
            `Translation: complete — ${translatedCount}/${result.lines.length} lines translated, lang=${result.translatedTo}`,
          );
          setLyricsData(result);
        }
      })
      .catch((err) => Logger.error(`Translation: failed for "${trackName}": ${err}`))
      .finally(() => {
        if (!cancelled) setTranslationLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    translationEnabled,
    playerTrack,
    lyricsData?.translatedTo,
    lyricsData?.source,
    setLyricsData,
    setTranslationLoading,
  ]);

  // -- Handlers --

  const suggestionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const musicSearchRequestIdRef = useRef(0);
  const podcastSearchRequestIdRef = useRef(0);
  const musicSearchInFlightRef = useRef(false);
  const loadMoreInFlightRef = useRef<number | null>(null);

  const fetchSuggestions = useCallback(
    async (query: string) => {
      if (!query.trim() || query.length < 2 || section === 'podcast') {
        setSuggestions([]);
        setSuggestionsVisible(false);
        return;
      }
      try {
        const provider = getActiveProvider();
        if (provider.getSearchSuggestions) {
          const results = await provider.getSearchSuggestions(query);
          setSuggestions(results.slice(0, 8));
          setSuggestionIdx(-1);
          setSuggestionsVisible(results.length > 0);
        }
      } catch {
        // Suggestions are non-critical
      }
    },
    [section, setSuggestions, setSuggestionIdx, setSuggestionsVisible],
  );

  const handleSearchInput = useCallback(
    (value: string) => {
      if (suggestionsTimerRef.current) clearTimeout(suggestionsTimerRef.current);
      suggestionsTimerRef.current = setTimeout(() => void fetchSuggestions(value), 300);
    },
    [fetchSuggestions],
  );

  const handleSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) return;

      setSuggestions([]);
      setSuggestionsVisible(false);
      setFocusedPanel('main');
      setSelectedIndex(0);

      // Podcast search when in podcast view
      if (section === 'podcast') {
        const requestId = ++podcastSearchRequestIdRef.current;
        setPodcastSearchLoading(true);
        try {
          const podcasts = await podcastProvider.searchPodcasts(query);
          if (requestId !== podcastSearchRequestIdRef.current) return;

          setPodcastSearchResults(podcasts);
          setPodcastView('search');
          Logger.info(`Podcast search '${query}': ${podcasts.length} results`);
        } catch (err) {
          Logger.error(`Podcast search failed: ${err}`);
        } finally {
          if (requestId === podcastSearchRequestIdRef.current) setPodcastSearchLoading(false);
        }
        return;
      }

      // Music search (YouTube)
      const requestId = ++musicSearchRequestIdRef.current;
      musicSearchInFlightRef.current = true;
      setSearchHasMore(false);
      setSearchContinuation(null);

      setSearchLoading(true);
      setMusicView('search');
      setSearchPage(1);
      try {
        const provider = getActiveProvider();
        const results = await provider.search(query);
        if (requestId !== musicSearchRequestIdRef.current) return;

        setSearchResults(results);
        setSearchHasMore(results.hasMore);
        setSearchContinuation(results.continuation ?? null);
        Logger.info(`Search '${query}': ${results.tracks.length} results`);
      } catch (err) {
        Logger.error(`Search failed: ${err}`);
      } finally {
        if (requestId === musicSearchRequestIdRef.current) {
          musicSearchInFlightRef.current = false;
          setSearchLoading(false);
        }
      }
    },
    [
      section,
      setSearchResults,
      setSearchLoading,
      setFocusedPanel,
      setMusicView,
      setSearchPage,
      setSearchHasMore,
      setSearchContinuation,
      setPodcastSearchResults,
      setPodcastSearchLoading,
      setPodcastView,
    ],
  );

  const handleLoadMore = useCallback(async () => {
    if (
      !searchHasMore ||
      !searchContinuation ||
      musicSearchInFlightRef.current ||
      loadMoreInFlightRef.current === musicSearchRequestIdRef.current
    ) {
      return;
    }
    const requestId = musicSearchRequestIdRef.current;
    loadMoreInFlightRef.current = requestId;

    setSearchLoading(true);
    try {
      const provider = getActiveProvider();
      const results = await provider.search('', { continuation: searchContinuation });
      if (requestId !== musicSearchRequestIdRef.current) return;

      const existing = searchResults?.tracks ?? [];
      setSearchResults({ ...results, tracks: [...existing, ...results.tracks] });
      setSearchHasMore(results.hasMore);
      setSearchContinuation(results.continuation ?? null);
      setSearchPage(searchPage + 1);
      Logger.info(`Loaded page ${searchPage + 1}: ${results.tracks.length} more results`);
    } catch (err) {
      Logger.error(`Load more failed: ${err}`);
    } finally {
      if (loadMoreInFlightRef.current === requestId) loadMoreInFlightRef.current = null;
      if (requestId === musicSearchRequestIdRef.current) setSearchLoading(false);
    }
  }, [
    searchHasMore,
    searchPage,
    searchContinuation,
    searchResults,
    setSearchResults,
    setSearchLoading,
    setSearchPage,
    setSearchHasMore,
    setSearchContinuation,
  ]);

  const playTrack = useCallback(
    async (track: Track) => {
      try {
        const provider = getActiveProvider();
        const url = await provider.getStreamUrl(track);
        await controller.play(track, url);
      } catch (err) {
        Logger.error(`Play failed: ${err}`);
      }
    },
    [controller],
  );

  // Play a track immediately (one-off, does NOT touch the queue)
  const handlePlayDirect = useCallback(
    async (track: Track) => {
      setPlayingFromQueue(false);
      await playTrack(track);
    },
    [playTrack, setPlayingFromQueue],
  );

  // Play a track from the queue (sets index, marks queue-playback mode)
  const handlePlayFromQueue = useCallback(
    async (track: Track) => {
      const idx = queue.findIndex((t) => t.id === track.id);
      if (idx >= 0) setQueueIndex(idx);
      setPlayingFromQueue(true);
      await playTrack(track);
    },
    [queue, setQueueIndex, playTrack, setPlayingFromQueue],
  );

  // Next/prev only operate when playing from the queue
  const handleNext = useCallback(async () => {
    if (!playingFromQueue || queue.length === 0) return;
    const next = nextIndex(queueIndex, queue.length, repeat);
    if (next === null) return;
    setQueueIndex(next);
    const trackIdx = shuffle ? shuffledIndices[next] : next;
    const track = queue[trackIdx];
    if (track) await playTrack(track);
  }, [
    playingFromQueue,
    queueIndex,
    queue,
    repeat,
    shuffle,
    shuffledIndices,
    setQueueIndex,
    playTrack,
  ]);

  // Auto-advance queue when track ends
  useEffect(() => {
    controller.onTrackEnd(() => {
      // Repeat-one: replay current track regardless of queue state
      if (repeat === 'track' && playerTrack) {
        void playTrack(playerTrack);
        return;
      }
      void handleNext();
    });
  }, [controller, handleNext, repeat, playerTrack, playTrack]);

  const handlePrev = useCallback(async () => {
    if (!playingFromQueue || queue.length === 0) return;
    const prev = prevIndex(queueIndex, queue.length, repeat);
    if (prev === null) return;
    setQueueIndex(prev);
    const trackIdx = shuffle ? shuffledIndices[prev] : prev;
    const track = queue[trackIdx];
    if (track) await playTrack(track);
  }, [
    playingFromQueue,
    queueIndex,
    queue,
    repeat,
    shuffle,
    shuffledIndices,
    setQueueIndex,
    playTrack,
  ]);

  const handleToggleShuffle = useCallback(() => {
    setShuffle((prev) => {
      const next = !prev;
      if (next) {
        setShuffledIndices(shuffleIndices(queue.length));
      } else {
        setShuffledIndices([]);
      }
      return next;
    });
  }, [queue.length, setShuffle, setShuffledIndices]);

  const handleCycleRepeat = useCallback(() => {
    setRepeat((prev) => {
      if (prev === 'off') return 'all';
      if (prev === 'all') return 'track';
      return 'off';
    });
  }, [setRepeat]);

  // -- Determine main content tracks (before keybindings so handler can reference them) --
  // Convert podcast episodes to Track-like objects for TrackList
  const episodesAsTracks: Track[] = podcastEpisodes.slice(0, episodePageSize).map((ep) => ({
    id: ep.id,
    provider: 'podcast',
    title: ep.title,
    artist: ep.podcastTitle,
    duration: ep.duration,
  }));
  const hasMoreEpisodes = podcastEpisodes.length > episodePageSize;

  const mainTracks =
    section === 'podcast'
      ? podcastView === 'episodes'
        ? episodesAsTracks
        : []
      : musicView === 'queue'
        ? queue
        : musicView === 'library'
          ? favorites
          : musicView === 'explore'
            ? history
            : (searchResults?.tracks ?? []);

  // Play handler: podcast episodes play their audio URL directly via mpv
  const handlePlayEpisode = useCallback(
    async (track: Track) => {
      const episode = podcastEpisodes.find((ep) => ep.id === track.id);
      if (!episode) return;

      // Try YouTube first: same source for audio + transcript = perfect sync
      setLyricsLoading(true);
      const videoId = await findYouTubeVideoId(episode);

      if (videoId) {
        // Play YouTube version (audio only via yt-dlp)
        const ytUrl = youtubeUrl(videoId);
        await controller.play(track, ytUrl);

        // Extract captions from the same video
        const result = await extractYouTubeSrt(videoId);
        if (result) {
          const lines = parseSrt(result.srt);
          setLyricsData({ lines, synced: true, source: 'youtube', sourceUrl: result.videoUrl });
        } else {
          setLyricsData(null);
        }
        setLyricsLoading(false);
      } else {
        // Fallback: play RSS audio, try to find transcript separately
        const url = podcastProvider.getStreamUrl(episode);
        await controller.play(track, url);

        try {
          const transcript = await fetchTranscript(episode);
          if (transcript) {
            setLyricsData({
              lines: transcript.lines,
              synced: true,
              source: transcript.source,
              sourceUrl: transcript.sourceUrl,
            });
          } else {
            setLyricsData(null);
          }
        } catch {
          setLyricsData(null);
        } finally {
          setLyricsLoading(false);
        }
      }
    },
    [podcastEpisodes, controller, setLyricsLoading, setLyricsData],
  );

  const mainOnPlay =
    section === 'podcast'
      ? handlePlayEpisode
      : musicView === 'queue'
        ? handlePlayFromQueue
        : handlePlayDirect;

  // Items visible in the main panel — unified for navigation
  const podcastListItems =
    section === 'podcast' && podcastView !== 'episodes'
      ? podcastView === 'search'
        ? podcastSearchResults
        : subscribedFeeds
      : [];
  const visibleListLength =
    podcastListItems.length > 0 ? podcastListItems.length : mainTracks.length;

  // Let OpenTUI handle podcast list scroll (same as TrackList).
  useEffect(() => {
    const sb = podcastScrollRef.current;
    if (!sb || podcastListItems.length === 0) return;
    sb.scrollChildIntoView(`podcast-row-${selectedIndex}`);
  }, [selectedIndex, podcastListItems.length]);

  // Refresh DB-backed views when switching to them
  const refreshLibraryView = useCallback(
    (view: string) => {
      try {
        const db = getDb();
        if (view === 'library') setFavorites(getFavorites(db));
        if (view === 'explore') setHistory(getHistory(db));
      } catch (err) {
        Logger.error(`Failed to refresh ${view}: ${err}`);
      }
    },
    [setFavorites, setHistory],
  );

  // Command palette executor
  const executeCommand = useCallback(
    (id: string) => {
      setPaletteVisible(false);
      switch (id) {
        case 'play-pause':
          void controller.togglePause();
          break;
        case 'next':
          void handleNext();
          break;
        case 'prev':
          void handlePrev();
          break;
        case 'seek-forward':
          void controller.seekRelative(10);
          break;
        case 'seek-backward':
          void controller.seekRelative(-10);
          break;
        case 'seek-to':
          setSeekInputVisible(true);
          setSeekInputValue('');
          break;
        case 'volume-up':
          void controller.addVolume(5);
          break;
        case 'volume-down':
          void controller.addVolume(-5);
          break;
        case 'mute':
          void controller.toggleMute();
          break;
        case 'speed-up':
          void controller.cycleSpeedUp();
          break;
        case 'speed-down':
          void controller.cycleSpeedDown();
          break;
        case 'speed-reset':
          void controller.setSpeed(1.0);
          break;
        case 'speed-1.5':
          void controller.setSpeed(1.5);
          break;
        case 'speed-2':
          void controller.setSpeed(2.0);
          break;
        case 'shuffle':
          handleToggleShuffle();
          break;
        case 'repeat':
          handleCycleRepeat();
          break;
        case 'search':
          setFocusedPanel('search');
          break;
        case 'view-search':
          setSection('music');
          setMusicView('search');
          setSelectedIndex(0);
          break;
        case 'view-queue':
          setSection('music');
          setMusicView('queue');
          setSelectedIndex(0);
          break;
        case 'view-favorites':
          refreshLibraryView('library');
          setSection('music');
          setMusicView('library');
          setSelectedIndex(0);
          break;
        case 'view-history':
          refreshLibraryView('explore');
          setSection('music');
          setMusicView('explore');
          setSelectedIndex(0);
          break;
        case 'lyrics':
          setLyricsVisible((v: boolean) => !v);
          break;
        case 'toggle-translation': {
          const nowEnabled = !translationEnabled;
          Logger.info(
            `Translation: toggled ${nowEnabled ? 'ON' : 'OFF'} (lyricsData=${lyricsData ? `${lyricsData.lines.length} lines, source=${lyricsData.source}` : 'null'}, translatedTo=${lyricsData?.translatedTo ?? 'none'})`,
          );
          setTranslationEnabled(nowEnabled);
          if (nowEnabled) {
            // Show lyrics panel and strip translatedTo to re-trigger the effect
            setLyricsVisible(true);
            if (lyricsData?.translatedTo) {
              setLyricsData({ ...lyricsData, translatedTo: undefined });
            }
          } else if (lyricsData?.translatedTo) {
            // Remove translations from display
            setLyricsData({
              ...lyricsData,
              lines: lyricsData.lines.map((line) => ({ ...line, translatedText: undefined })),
              translatedTo: undefined,
            });
          }
          break;
        }
        case 'set-translation-language':
          setTranslationLangVisible(true);
          setTranslationLangValue('');
          break;
        case 'podcast-feeds':
          setSection('podcast');
          setPodcastView('feeds');
          setSelectedIndex(0);
          break;
        case 'podcast-subscribe':
          if (selectedPodcast) {
            subscribeFeed(getDb(), selectedPodcast);
            setSubscribedFeeds(getSubscribedFeeds(getDb()));
            Logger.info(`Subscribed: ${selectedPodcast.title}`);
          }
          break;
        case 'podcast-unsubscribe':
          if (selectedPodcast) {
            unsubscribeFeed(getDb(), selectedPodcast.feedUrl);
            setSubscribedFeeds(getSubscribedFeeds(getDb()));
            Logger.info(`Unsubscribed: ${selectedPodcast.title}`);
          }
          break;
        case 'transcript-url':
          setTranscriptUrlVisible(true);
          setTranscriptUrlValue('');
          break;
        case 'transcript-auto':
          setTranscriptSource('auto');
          Logger.info('Transcript source reset to auto');
          break;
        case 'transcript-reload':
          // Re-trigger the lyrics/transcript auto-fetch by clearing and re-setting
          setLyricsData(null);
          setLyricsLoading(true);
          break;
        case 'transcript-search':
          if (lyricsData?.lines && lyricsData.lines.length > 0) {
            if (!lyricsVisible) setLyricsVisible(true);
            setTranscriptSearchVisible(true);
            setTranscriptSearchQuery('');
            setTranscriptSearchIdx(0);
          }
          break;
        case 'help':
          setHelpVisible((v) => !v);
          break;
        case 'quit':
          setQuitConfirmVisible(true);
          break;
        case 'layout-default':
          setLayout('default');
          break;
        case 'layout-compact':
          setLayout('compact');
          break;
        case 'layout-minimal':
          setLayout('minimal');
          break;
        case 'layout-split':
          setLayout('split');
          break;
        case 'layout-wide':
          setLayout('wide');
          break;
        case 'layout-focus':
          setLayout('focus');
          break;
        case 'layout-vertical':
          setLayout('vertical');
          break;
        case 'layout-cycle':
          setLayout((prev) => nextLayout(prev));
          break;
        case 'theme-cycle':
          setThemeName((prev) => nextTheme(prev));
          break;
        case 'section-music':
          setSection('music');
          break;
        case 'section-podcast':
          setSection('podcast');
          break;
      }
    },
    [
      controller,
      handleNext,
      handlePrev,
      handleToggleShuffle,
      handleCycleRepeat,
      setFocusedPanel,
      setSection,
      setMusicView,
      setPodcastView,
      refreshLibraryView,
      setLayout,
      setLyricsVisible,
      setTranscriptSource,
      setLyricsLoading,
      selectedPodcast,
      setSubscribedFeeds,
      setLyricsData,
      setTranslationEnabled,
      translationEnabled,
      lyricsData,
    ],
  );

  // -- Global keybindings --
  useKeyboard((key: KeyEvent) => {
    // Command palette
    if (key.ctrl && key.name === 'p') {
      setPaletteVisible((v) => {
        if (!v) {
          setPaletteFilter('');
          setPaletteSelectedIdx(0);
        }
        return !v;
      });
      return;
    }
    // Layout cycling — skip when an input is active
    if (
      key.ctrl &&
      key.name === 'l' &&
      focusedPanel !== 'search' &&
      !paletteVisible &&
      !seekInputVisible &&
      !transcriptUrlVisible &&
      !transcriptSearchVisible &&
      !translationLangVisible
    ) {
      setLayout((prev) => nextLayout(prev));
      return;
    }
    // Theme cycling — skip when an input is active
    if (
      key.ctrl &&
      key.name === 't' &&
      focusedPanel !== 'search' &&
      !paletteVisible &&
      !seekInputVisible &&
      !transcriptUrlVisible &&
      !transcriptSearchVisible &&
      !translationLangVisible
    ) {
      setThemeName((prev) => nextTheme(prev));
      return;
    }
    // Section switching — skip when search input is active
    if (key.ctrl && key.name === '1' && focusedPanel !== 'search') {
      setSection('music');
      return;
    }
    if (key.ctrl && key.name === '2' && focusedPanel !== 'search') {
      setSection('podcast');
      return;
    }
    // Quit confirmation dialog — handle y/n/escape, block everything else
    if (quitConfirmVisible) {
      if (key.name === 'y' || key.name === 'return' || key.name === 'enter') {
        onQuit();
      } else if (key.name === 'n' || key.name === 'escape') {
        setQuitConfirmVisible(false);
      }
      return;
    }

    // Command palette — handle j/k/enter/escape, block everything else
    if (paletteVisible) {
      const cmds = filterCommands(paletteFilter);
      const maxIdx = Math.min(cmds.length, 15) - 1;
      if (key.name === 'escape') {
        setPaletteVisible(false);
        setPaletteFilter('');
        setPaletteSelectedIdx(0);
      } else if (key.name === 'down') {
        setPaletteSelectedIdx((i) => Math.min(i + 1, maxIdx));
      } else if (key.name === 'up') {
        setPaletteSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (key.name === 'return' || key.name === 'enter') {
        const cmd = cmds[paletteSelectedIdx];
        if (cmd) {
          executeCommand(cmd.id);
          setPaletteVisible(false);
          setPaletteFilter('');
          setPaletteSelectedIdx(0);
        }
      }
      // All other keys are for the palette's <input> — don't leak
      return;
    }

    // Seek input — handle enter/escape, block everything else
    if (seekInputVisible) {
      if (key.name === 'escape') {
        setSeekInputVisible(false);
        setSeekInputValue('');
      } else if (key.name === 'return' || key.name === 'enter') {
        const seconds = parseTimeInput(seekInputValue);
        if (seconds === null || seconds < 0) {
          // Invalid input — stay open, don't seek
          return;
        }
        void controller.seekAbsolute(seconds);
        setSeekInputVisible(false);
        setSeekInputValue('');
      }
      return;
    }

    // Transcript URL input — handle enter/escape, block everything else
    if (transcriptUrlVisible) {
      if (key.name === 'escape') {
        setTranscriptUrlVisible(false);
        setTranscriptUrlValue('');
      } else if (key.name === 'return' || key.name === 'enter') {
        const url = transcriptUrlValue.trim();
        if (url) {
          // Load custom transcript from URL
          setTranscriptSource(url);
          setLyricsLoading(true);
          fetch(url, { signal: AbortSignal.timeout(10_000) })
            .then((r) => r.text())
            .then((text) => {
              const lines = text.trimStart().startsWith('WEBVTT') ? parseVtt(text) : parseSrt(text);
              setLyricsData({
                lines,
                synced: lines.length > 0 && lines[0].time > 0,
                source: 'custom',
                sourceUrl: url,
              });
            })
            .catch(() => setLyricsData(null))
            .finally(() => setLyricsLoading(false));
        } else {
          // Empty = reset to auto
          setTranscriptSource('auto');
        }
        setTranscriptUrlVisible(false);
        setTranscriptUrlValue('');
      }
      return;
    }

    // Transcript text search — filter and jump to timestamp
    if (transcriptSearchVisible) {
      if (key.name === 'escape') {
        setTranscriptSearchVisible(false);
        setTranscriptSearchQuery('');
        setTranscriptSearchIdx(0);
      } else if (key.name === 'return' || key.name === 'enter') {
        const match = transcriptMatches[transcriptSearchIdx];
        if (match) {
          void controller.seekAbsolute(match.time);
        }
        setTranscriptSearchVisible(false);
        setTranscriptSearchQuery('');
        setTranscriptSearchIdx(0);
      } else if (key.name === 'down') {
        setTranscriptSearchIdx((i) => Math.min(i + 1, Math.max(0, transcriptMatches.length - 1)));
      } else if (key.name === 'up') {
        setTranscriptSearchIdx((i) => Math.max(i - 1, 0));
      }
      return;
    }

    // Translation language input — handle enter/escape, block everything else
    if (translationLangVisible) {
      if (key.name === 'escape') {
        setTranslationLangVisible(false);
        setTranslationLangValue('');
      } else if (key.name === 'return' || key.name === 'enter') {
        const lang = translationLangValue.trim().toLowerCase();
        if (lang.length >= 2) {
          const config = loadConfig();
          saveConfig({ ...config, translationLanguage: lang });
          Logger.info(`Translation language set to: ${lang}`);
          // Re-trigger translation if enabled
          if (translationEnabled && lyricsData) {
            setLyricsData({ ...lyricsData, translatedTo: undefined });
          }
        }
        setTranslationLangVisible(false);
        setTranslationLangValue('');
      }
      return;
    }

    // When search input is focused, only allow Tab, Escape, and Ctrl combos.
    // Everything else is the user typing a query.
    if (focusedPanel === 'search') {
      // Suggestion navigation
      if (suggestionsVisible && suggestions.length > 0) {
        if (key.name === 'down') {
          setSuggestionIdx((i) => Math.min(i + 1, suggestions.length - 1));
          return;
        }
        if (key.name === 'up') {
          setSuggestionIdx((i) => Math.max(i - 1, -1));
          return;
        }
        if ((key.name === 'return' || key.name === 'enter') && suggestionIdx >= 0) {
          const selected = suggestions[suggestionIdx];
          if (selected) {
            setSuggestions([]);
            setSuggestionsVisible(false);
            void handleSearch(selected);
          }
          return;
        }
      }
      if (key.name === 'escape') {
        if (suggestionsVisible) {
          setSuggestions([]);
          setSuggestionsVisible(false);
        } else {
          setFocusedPanel('main');
        }
        return;
      }
      if (key.name === 'tab') {
        setSuggestions([]);
        setSuggestionsVisible(false);
        setFocusedPanel('main');
        return;
      }
      if (key.ctrl && (key.name === 'q' || key.name === 'c')) {
        setQuitConfirmVisible(true);
      }
      return;
    }
    // Help overlay
    if (key.name === '?') {
      setHelpVisible((v) => !v);
      return;
    }
    if (helpVisible && key.name === 'escape') {
      setHelpVisible(false);
      return;
    }

    // List navigation — only when main panel is focused
    if (focusedPanel === 'main' && visibleListLength > 0) {
      if (key.name === 'j' || key.name === 'down') {
        setSelectedIndex((i) => Math.min(i + 1, visibleListLength - 1));
        return;
      }
      if (key.name === 'k' || key.name === 'up') {
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (key.name === 'g') {
        setSelectedIndex(0);
        return;
      }
      if (key.name === 'G') {
        setSelectedIndex(visibleListLength - 1);
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        // Podcast: enter on a podcast item loads its episodes
        if (section === 'podcast' && podcastView !== 'episodes' && podcastListItems.length > 0) {
          const podcast = podcastListItems[selectedIndex];
          if (podcast) {
            setSelectedPodcast(podcast);
            setPodcastView('episodes');
            setEpisodesLoading(true);
            setSelectedIndex(0);
            setEpisodePageSize(50);
            podcastProvider
              .getEpisodes(podcast)
              .then((eps) => {
                setPodcastEpisodes(eps);
                setEpisodesLoading(false);
              })
              .catch(() => setEpisodesLoading(false));
          }
          return;
        }
        // Normal: play the selected track
        const track = mainTracks[selectedIndex];
        if (track) void mainOnPlay(track);
        return;
      }
    }

    // Favorites toggle — when main panel focused
    if (key.name === 'f' && focusedPanel === 'main' && mainTracks.length > 0) {
      const track = mainTracks[selectedIndex];
      if (track) {
        const trackKey = `${track.provider}:${track.id}`;
        const db = getDb();
        if (favoritesSet.has(trackKey)) {
          removeFavorite(db, track);
          setFavoritesSet((prev: Set<string>) => {
            const next = new Set(prev);
            next.delete(trackKey);
            return next;
          });
        } else {
          addFavorite(db, track);
          setFavoritesSet((prev: Set<string>) => new Set(prev).add(trackKey));
        }
        setFavorites(getFavorites(db));
        Logger.info(`Favorite toggled: ${track.title}`);
      }
      return;
    }

    // Load more — Shift+L. Must be checked before lowercase 'l' (lyrics)
    // because Kitty protocol reports key.name='l' + key.shift=true for Shift+L.
    if (key.name === 'L' || (key.name === 'l' && key.shift)) {
      if (section === 'music' && musicView === 'search' && searchHasMore) {
        void handleLoadMore();
      } else if (section === 'podcast' && podcastView === 'episodes' && hasMoreEpisodes) {
        setEpisodePageSize((prev) => prev + 50);
      }
      return;
    }

    // Lyrics toggle — plain 'l' without shift
    if (key.name === 'l') {
      setLyricsVisible((v: boolean) => !v);
      return;
    }

    // Jump to time
    if (key.name === 't') {
      setSeekInputVisible(true);
      setSeekInputValue('');
      return;
    }

    // Find in lyrics/transcript — Ctrl+F when lyrics data is available
    if (key.ctrl && key.name === 'f' && lyricsData?.lines && lyricsData.lines.length > 0) {
      if (!lyricsVisible) setLyricsVisible(true);
      setTranscriptSearchVisible(true);
      setTranscriptSearchQuery('');
      setTranscriptSearchIdx(0);
      return;
    }

    // Sidebar navigation — when sidebar focused
    if (focusedPanel === 'sidebar') {
      if (section === 'music') {
        const views: MusicView[] = ['search', 'queue', 'library', 'explore'];
        const idx = views.indexOf(musicView);
        if (key.name === 'j' || key.name === 'down') {
          const newView = views[Math.min(idx + 1, views.length - 1)];
          if (newView) {
            setMusicView(newView);
            setSelectedIndex(0);
            refreshLibraryView(newView);
          }
          return;
        }
        if (key.name === 'k' || key.name === 'up') {
          const newView = views[Math.max(idx - 1, 0)];
          if (newView) {
            setMusicView(newView);
            setSelectedIndex(0);
            refreshLibraryView(newView);
          }
          return;
        }
      } else {
        const views: PodcastView[] = ['search', 'feeds', 'episodes'];
        const idx = views.indexOf(podcastView);
        if (key.name === 'j' || key.name === 'down') {
          const newView = views[Math.min(idx + 1, views.length - 1)];
          if (newView) {
            setPodcastView(newView);
            setSelectedIndex(0);
          }
          return;
        }
        if (key.name === 'k' || key.name === 'up') {
          const newView = views[Math.max(idx - 1, 0)];
          if (newView) {
            setPodcastView(newView);
            setSelectedIndex(0);
          }
          return;
        }
      }
      if (key.name === 'return' || key.name === 'enter') {
        setFocusedPanel('main');
        return;
      }
    }

    // Playback controls — only when not in search input
    if (key.name === 'space') {
      void controller.togglePause();
      return;
    }
    if (key.name === 'n') {
      void handleNext();
      return;
    }
    if (key.name === 'p') {
      void handlePrev();
      return;
    }
    if (key.name === '>') {
      void controller.seekRelative(10);
      return;
    }
    if (key.name === '<') {
      void controller.seekRelative(-10);
      return;
    }
    if (key.name === '=' || key.name === '+') {
      void controller.addVolume(5);
      return;
    }
    if (key.name === '-') {
      void controller.addVolume(-5);
      return;
    }
    if (key.name === 'm') {
      void controller.toggleMute();
      return;
    }
    if (key.name === 's') {
      handleToggleShuffle();
      return;
    }
    if (key.name === 'r') {
      handleCycleRepeat();
      return;
    }
    if (key.name === ']') {
      void controller.cycleSpeedUp();
      return;
    }
    if (key.name === '[') {
      void controller.cycleSpeedDown();
      return;
    }

    // Focus management
    if (key.name === 'tab') {
      setFocusedPanel((prev) => {
        if (prev === 'main') return 'sidebar';
        if (prev === 'sidebar') return 'search';
        return 'main';
      });
    } else if (key.name === '/') {
      setFocusedPanel('search');
    } else if (key.name === 'escape') {
      setFocusedPanel('main');
    }

    // Add to queue
    if (key.name === 'q' && focusedPanel === 'main' && mainTracks.length > 0) {
      const track = mainTracks[selectedIndex];
      if (track) {
        setQueue((prev) => [...prev, track]);
        Logger.info(`Queued: ${track.title}`);
      }
      return;
    }

    // Remove from queue
    if (
      key.name === 'x' &&
      focusedPanel === 'main' &&
      section === 'music' &&
      musicView === 'queue' &&
      queue.length > 0
    ) {
      const [newQueue, newIdx] = removeFromQueue(queue, selectedIndex, queueIndex);
      setQueue(newQueue);
      setQueueIndex(newIdx);
      setSelectedIndex(Math.min(selectedIndex, Math.max(0, newQueue.length - 1)));
      Logger.info(`Removed from queue at index ${selectedIndex}`);
      return;
    }

    // Quit
    if (key.ctrl && (key.name === 'q' || key.name === 'c')) {
      setQuitConfirmVisible(true);
    }
  });
  const t = useTheme();
  const ACCENT = t.accent;
  const DIM = t.dim;
  const TEXT_FG = t.fg;

  // -- Reusable JSX fragments --
  const resultCount = mainTracks.length;
  const pageInfo =
    section === 'music' && musicView === 'search' && resultCount > 0
      ? ` (${resultCount}${searchHasMore ? ' • Shift+L for more' : ''})`
      : '';
  const viewTitle =
    section === 'podcast'
      ? podcastView === 'episodes' && selectedPodcast
        ? selectedPodcast.title
        : 'Podcasts'
      : (musicView === 'queue'
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
      <scrollbox ref={podcastScrollRef}>
        {podcastListItems.map((podcast, i) => {
          const selected = i === selectedIndex;
          return (
            <box
              key={podcast.id}
              id={`podcast-row-${i}`}
              flexDirection="column"
              backgroundColor={selected ? t.selection : undefined}
              paddingLeft={1}
              paddingRight={1}
            >
              <box flexDirection="row">
                <text
                  fg={selected ? t.accent : t.dim}
                  attributes={selected ? TextAttributes.BOLD : 0}
                >
                  {String(i + 1).padStart(2, ' ')} {selected ? '\u25b8 ' : '  '}
                </text>
                <text
                  fg={selected ? t.accent : t.fg}
                  attributes={selected ? TextAttributes.BOLD : 0}
                  truncate
                  flexGrow={1}
                >
                  {podcast.title}
                </text>
                {isSubscribed(getDb(), podcast.feedUrl) && <text fg={t.green}> \u2713</text>}
              </box>
              <box flexDirection="row">
                <text fg={selected ? t.dim : t.dim}>
                  {'      '}
                  {podcast.author}
                </text>
              </box>
            </box>
          );
        })}
      </scrollbox>
    ) : null;

  const trackListJsx =
    mainTracks.length > 0 ? (
      <TrackList
        tracks={mainTracks}
        focused={focusedPanel === 'main'}
        selectedIndex={selectedIndex}
        onSelect={setSelectedIndex}
        onPlay={mainOnPlay}
        playingTrackId={playerTrack?.id}
        showRemoveHint={section === 'music' && musicView === 'queue'}
      />
    ) : (
      <box paddingLeft={1} paddingTop={1} flexDirection="column" gap={1}>
        <text fg={TEXT_FG}>{emptyMessage}</text>
        <text fg={DIM}>[?] help [ctrl+p] commands [ctrl+l] layout [ctrl+t] theme</text>
      </box>
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
        borderColor={focusedPanel === 'main' ? ACCENT : DIM}
        title={viewTitle}
      >
        {searchLoading ? (
          <box paddingLeft={1} paddingTop={1}>
            <text fg={DIM}>Searching...</text>
          </box>
        ) : section === 'podcast' && podcastListJsx ? (
          podcastListJsx
        ) : (
          trackListJsx
        )}
      </box>
      {/* Lyrics/Transcript: remaining space */}
      {lyricsVisible && (section === 'podcast' ? <Transcript /> : <Lyrics />)}
    </box>
  );

  const sidebarJsx = (
    <Sidebar
      focused={focusedPanel === 'sidebar'}
      section={section}
      activeView={activeView}
      onViewChange={(v) => {
        if (section === 'podcast') setPodcastView(v as PodcastView);
        else setMusicView(v as MusicView);
      }}
    />
  );

  const headerJsx = (
    <Header
      focused={focusedPanel === 'search'}
      section={section}
      onSearch={handleSearch}
      onSectionChange={setSection}
      onInput={handleSearchInput}
      suggestions={suggestions}
      suggestionIdx={suggestionIdx}
      suggestionsVisible={suggestionsVisible}
    />
  );

  // -- Layout rendering --
  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Focus layout: centered now-playing only */}
      {layout === 'focus' ? (
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          <NowPlaying />
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
                <NowPlaying />
              </box>
              <box border borderStyle="rounded" borderColor={DIM} title="Up Next" height={8}>
                <TrackList
                  tracks={queue.slice(0, 5)}
                  focused={false}
                  selectedIndex={-1}
                  onSelect={() => {}}
                  onPlay={handlePlayFromQueue}
                  playingTrackId={playerTrack?.id}
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
                borderColor={focusedPanel === 'sidebar' ? ACCENT : DIM}
                title="Queue"
              >
                <TrackList
                  tracks={queue}
                  focused={focusedPanel === 'sidebar'}
                  selectedIndex={activeView === 'queue' ? selectedIndex : -1}
                  onSelect={setSelectedIndex}
                  onPlay={handlePlayFromQueue}
                  playingTrackId={playerTrack?.id}
                  showRemoveHint={true}
                />
              </box>
              {mainPanel}
            </box>
          ) : layout === 'minimal' ? (
            /* Minimal: track list only */
            <box flexGrow={1} flexDirection="column">
              {trackListJsx}
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
          {layout !== 'wide' && <NowPlaying />}
        </>
      )}

      {/* Overlays */}
      <HelpOverlay visible={helpVisible} />
      <CommandPalette
        visible={paletteVisible}
        filter={paletteFilter}
        selectedIdx={paletteSelectedIdx}
        onFilterChange={(v) => {
          setPaletteFilter(v);
          setPaletteSelectedIdx(0);
        }}
        onSubmit={() => {
          const cmds = filterCommands(paletteFilter);
          const cmd = cmds[paletteSelectedIdx];
          if (cmd) {
            executeCommand(cmd.id);
            setPaletteVisible(false);
            setPaletteFilter('');
            setPaletteSelectedIdx(0);
          }
        }}
      />
      <QuitConfirm visible={quitConfirmVisible} />
      <SeekInput
        visible={seekInputVisible}
        value={seekInputValue}
        onInput={setSeekInputValue}
        onSubmit={() => {
          const seconds = parseTimeInput(seekInputValue);
          if (seconds === null || seconds < 0) return;
          void controller.seekAbsolute(seconds);
          setSeekInputVisible(false);
          setSeekInputValue('');
        }}
      />
      <TranscriptUrlInput
        visible={transcriptUrlVisible}
        value={transcriptUrlValue}
        onInput={setTranscriptUrlValue}
      />
      <TranslationLanguageInput
        visible={translationLangVisible}
        value={translationLangValue}
        currentLang={loadConfig().translationLanguage}
        onInput={setTranslationLangValue}
      />
      {transcriptSearchVisible && (
        <box
          position="absolute"
          bottom={3}
          left={1}
          right={1}
          height={Math.min(3 + Math.min(transcriptMatches.length, 5), 8)}
          border
          borderStyle="rounded"
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
              onInput={
                ((v: string) => {
                  setTranscriptSearchQuery(v);
                  setTranscriptSearchIdx(0);
                }) as never
              }
            />
            {transcriptMatches.length > 0 && (
              <text fg={t.dim}>
                {' '}
                ({transcriptSearchIdx + 1}/{transcriptMatches.length})
              </text>
            )}
          </box>
          {transcriptMatches.slice(0, 5).map((match, i) => (
            <text
              key={match.idx}
              fg={i === transcriptSearchIdx ? t.accent : t.dim}
              attributes={i === transcriptSearchIdx ? TextAttributes.BOLD : 0}
              truncate
            >
              {i === transcriptSearchIdx ? ' \u25b8 ' : '   '}[{formatTime(match.time)}]{' '}
              {match.text}
            </text>
          ))}
          {transcriptMatches.length === 0 && transcriptSearchQuery.trim() && (
            <text fg={t.dim}> No matches</text>
          )}
        </box>
      )}
    </box>
  );
}
