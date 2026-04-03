import { TextAttributes, type KeyEvent, type ScrollBoxRenderable } from '@opentui/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Provider, useAtomValue, useSetAtom } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { useKeyboard } from '@opentui/react';
import { PlayerController } from './player/controller';
import { playerTrackAtom } from './store/player';
import {
  searchResultsAtom,
  searchLoadingAtom,
  focusedPanelAtom,
  sectionAtom,
  musicViewAtom,
  podcastViewAtom as podcastViewAtomUI,
  layoutAtom,
  themeNameAtom,
  searchPageAtom,
  searchHasMoreAtom,
  searchContinuationAtom,
  type Section,
  type MusicView,
  type PodcastView,
} from './store/ui';
import { nextLayout } from './ui/layouts';
import { queueAtom, queueIndexAtom, repeatAtom, shuffleAtom, shuffledIndicesAtom, playingFromQueueAtom } from './store/queue';
import type { Track } from './providers/types';
import { getActiveProvider } from './providers/registry';
import { nextIndex, prevIndex, shuffleIndices, removeFromQueue } from './store/queue-actions';
import { Header } from './ui/Header';
import { TrackList } from './ui/TrackList';
import { Sidebar } from './ui/Sidebar';
import { NowPlaying } from './ui/NowPlaying';
import { HelpOverlay } from './ui/HelpOverlay';
import { QuitConfirm } from './ui/QuitConfirm';
import { CommandPalette } from './ui/CommandPalette';
import { useTheme } from './ui/useTheme';
import { nextTheme } from './ui/themes';
import { LAYOUT_LABELS } from './ui/layouts';
import { filterCommands } from './commands';
import { Lyrics } from './ui/Lyrics';
import { Transcript } from './ui/Transcript';
import { SeekInput, parseTimeInput } from './ui/SeekInput';
import { TranscriptUrlInput } from './ui/TranscriptUrlInput';
import { lyricsVisibleAtom, lyricsDataAtom, lyricsLoadingAtom, transcriptSourceAtom } from './store/lyrics';
import { fetchLyrics } from './providers/lyrics';
import { podcastProvider } from './providers/podcast';
import { fetchTranscript } from './providers/transcript';
import { findYouTubeVideoId, youtubeUrl, extractYouTubeSrt } from './providers/podcast-youtube';
import { parseSrt, parseVtt } from './providers/subtitle-parser';
import {
  podcastSearchResultsAtom, podcastSearchLoadingAtom,
  selectedPodcastAtom, podcastEpisodesAtom, episodesLoadingAtom,
  subscribedFeedsAtom,
} from './store/podcast';
import { subscribeFeed, unsubscribeFeed, getSubscribedFeeds, isSubscribed } from './db/queries';
import { Logger } from './utils/logger';
import { getDb } from './db/index';
import { addFavorite, removeFavorite, getFavorites, getHistory } from './db/queries';
import { favoritesSetAtom, favoritesAtom, historyAtom } from './store/library';

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

function AppInner({ controller, onQuit }: { controller: PlayerController; onQuit: () => void }): React.ReactNode {
  // UI state
  const focusedPanel = useAtomValue(focusedPanelAtom);
  const setFocusedPanel = useSetAtom(focusedPanelAtom);
  const section = useAtomValue(sectionAtom);
  const setSection = useSetAtom(sectionAtom);
  const musicView = useAtomValue(musicViewAtom);
  const setMusicView = useSetAtom(musicViewAtom);
  const layout = useAtomValue(layoutAtom);
  const setLayout = useSetAtom(layoutAtom);
  const themeName = useAtomValue(themeNameAtom);
  const setThemeName = useSetAtom(themeNameAtom);

  // Player state (for playing indicator)
  const playerTrack = useAtomValue(playerTrackAtom);

  // Lyrics state
  const lyricsVisible = useAtomValue(lyricsVisibleAtom);
  const setLyricsVisible = useSetAtom(lyricsVisibleAtom);
  const setLyricsData = useSetAtom(lyricsDataAtom);
  const setLyricsLoading = useSetAtom(lyricsLoadingAtom);

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

  // Auto-fetch lyrics when track changes
  useEffect(() => {
    if (!playerTrack) {
      setLyricsData(null);
      return;
    }
    let cancelled = false;
    setLyricsLoading(true);
    fetchLyrics(playerTrack).then((result) => {
      if (!cancelled) {
        setLyricsData(result);
        setLyricsLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setLyricsData(null);
        setLyricsLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [playerTrack, setLyricsData, setLyricsLoading]);


  // -- Handlers --

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setFocusedPanel('main');
    setSelectedIndex(0);

    // Podcast search when in podcast view
    if (section === 'podcast') {
      setPodcastSearchLoading(true);
      try {
        const podcasts = await podcastProvider.searchPodcasts(query);
        setPodcastSearchResults(podcasts);
        setPodcastView('search');
        Logger.info(`Podcast search '${query}': ${podcasts.length} results`);
      } catch (err) {
        Logger.error(`Podcast search failed: ${err}`);
      } finally {
        setPodcastSearchLoading(false);
      }
      return;
    }

    // Music search (YouTube)
    setSearchLoading(true);
    setMusicView('search');
    setSearchPage(1);
    try {
      const provider = getActiveProvider();
      const results = await provider.search(query);
      setSearchResults(results);
      setSearchHasMore(results.hasMore);
      setSearchContinuation(results.continuation ?? null);
      Logger.info(`Search '${query}': ${results.tracks.length} results`);
    } catch (err) {
      Logger.error(`Search failed: ${err}`);
    } finally {
      setSearchLoading(false);
    }
  }, [section, setSearchResults, setSearchLoading, setFocusedPanel, setMusicView,
      setSearchPage, setSearchHasMore, setSearchContinuation,
      setPodcastSearchResults, setPodcastSearchLoading, setPodcastView]);

  const handleLoadMore = useCallback(async () => {
    if (!searchHasMore || searchPage >= 2 || !searchContinuation) return;
    setSearchLoading(true);
    try {
      const provider = getActiveProvider();
      const results = await provider.search('', { continuation: searchContinuation });
      const existing = searchResults?.tracks ?? [];
      setSearchResults({ ...results, tracks: [...existing, ...results.tracks] });
      setSearchHasMore(results.hasMore && searchPage + 1 < 2);
      setSearchContinuation(results.continuation ?? null);
      setSearchPage(searchPage + 1);
      Logger.info(`Loaded page ${searchPage + 1}: ${results.tracks.length} more results`);
    } catch (err) {
      Logger.error(`Load more failed: ${err}`);
    } finally {
      setSearchLoading(false);
    }
  }, [searchHasMore, searchPage, searchContinuation, searchResults,
      setSearchResults, setSearchLoading, setSearchPage, setSearchHasMore, setSearchContinuation]);

  const playTrack = useCallback(async (track: Track) => {
    try {
      const provider = getActiveProvider();
      const url = await provider.getStreamUrl(track);
      await controller.play(track, url);
    } catch (err) {
      Logger.error(`Play failed: ${err}`);
    }
  }, [controller]);

  // Play a track immediately (one-off, does NOT touch the queue)
  const handlePlayDirect = useCallback(async (track: Track) => {
    setPlayingFromQueue(false);
    await playTrack(track);
  }, [playTrack, setPlayingFromQueue]);

  // Play a track from the queue (sets index, marks queue-playback mode)
  const handlePlayFromQueue = useCallback(async (track: Track) => {
    const idx = queue.findIndex((t) => t.id === track.id);
    if (idx >= 0) setQueueIndex(idx);
    setPlayingFromQueue(true);
    await playTrack(track);
  }, [queue, setQueueIndex, playTrack, setPlayingFromQueue]);

  // Next/prev only operate when playing from the queue
  const handleNext = useCallback(async () => {
    if (!playingFromQueue || queue.length === 0) return;
    const next = nextIndex(queueIndex, queue.length, repeat);
    if (next === null) return;
    setQueueIndex(next);
    const track = queue[next];
    if (track) await playTrack(track);
  }, [playingFromQueue, queueIndex, queue, repeat, setQueueIndex, playTrack]);

  // Auto-advance queue when track ends
  useEffect(() => {
    controller.onTrackEnd(() => void handleNext());
  }, [controller, handleNext]);

  const handlePrev = useCallback(async () => {
    if (!playingFromQueue || queue.length === 0) return;
    const prev = prevIndex(queueIndex, queue.length, repeat);
    if (prev === null) return;
    setQueueIndex(prev);
    const track = queue[prev];
    if (track) await playTrack(track);
  }, [playingFromQueue, queueIndex, queue, repeat, setQueueIndex, playTrack]);

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

  const mainTracks = section === 'podcast'
    ? (podcastView === 'episodes' ? episodesAsTracks : [])
    : musicView === 'queue' ? queue
    : musicView === 'library' ? favorites
    : musicView === 'explore' ? history
    : (searchResults?.tracks ?? []);

  // Play handler: podcast episodes play their audio URL directly via mpv
  const handlePlayEpisode = useCallback(async (track: Track) => {
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
          setLyricsData({ lines: transcript.lines, synced: true, source: transcript.source, sourceUrl: transcript.sourceUrl });
        } else {
          setLyricsData(null);
        }
      } catch {
        setLyricsData(null);
      } finally {
        setLyricsLoading(false);
      }
    }
  }, [podcastEpisodes, controller, setLyricsLoading, setLyricsData]);

  const mainOnPlay = section === 'podcast' ? handlePlayEpisode
    : musicView === 'queue' ? handlePlayFromQueue
    : handlePlayDirect;

  // Items visible in the main panel — unified for navigation
  const podcastListItems = section === 'podcast' && podcastView !== 'episodes'
    ? (podcastView === 'search' ? podcastSearchResults : subscribedFeeds)
    : [];
  const visibleListLength = podcastListItems.length > 0 ? podcastListItems.length : mainTracks.length;

  // Page-based scroll for podcast list
  useEffect(() => {
    const sb = podcastScrollRef.current;
    if (!sb || podcastListItems.length === 0) return;
    const child = sb.content.findDescendantById(`podcast-row-${selectedIndex}`);
    if (!child) return;
    const viewTop = sb.scrollTop;
    const viewBottom = viewTop + sb.viewport.height;
    if (child.y + child.height > viewBottom) sb.scrollTop = child.y;
    else if (child.y < viewTop) sb.scrollTop = child.y;
  }, [selectedIndex, podcastListItems.length]);

  // Refresh DB-backed views when switching to them
  const refreshLibraryView = useCallback((view: string) => {
    try {
      const db = getDb();
      if (view === 'library') setFavorites(getFavorites(db));
      if (view === 'explore') setHistory(getHistory(db));
    } catch (err) {
      Logger.error(`Failed to refresh ${view}: ${err}`);
    }
  }, [setFavorites, setHistory]);

  // Command palette executor
  const executeCommand = useCallback((id: string) => {
    setPaletteVisible(false);
    switch (id) {
      case 'play-pause': void controller.togglePause(); break;
      case 'next': void handleNext(); break;
      case 'prev': void handlePrev(); break;
      case 'seek-forward': void controller.seekRelative(10); break;
      case 'seek-backward': void controller.seekRelative(-10); break;
      case 'seek-to': setSeekInputVisible(true); setSeekInputValue(''); break;
      case 'volume-up': void controller.addVolume(5); break;
      case 'volume-down': void controller.addVolume(-5); break;
      case 'mute': void controller.toggleMute(); break;
      case 'speed-up': void controller.cycleSpeedUp(); break;
      case 'speed-down': void controller.cycleSpeedDown(); break;
      case 'speed-reset': void controller.setSpeed(1.0); break;
      case 'speed-1.5': void controller.setSpeed(1.5); break;
      case 'speed-2': void controller.setSpeed(2.0); break;
      case 'shuffle': handleToggleShuffle(); break;
      case 'repeat': handleCycleRepeat(); break;
      case 'search': setFocusedPanel('search'); break;
      case 'view-search': setSection('music'); setMusicView('search'); setSelectedIndex(0); break;
      case 'view-queue': setSection('music'); setMusicView('queue'); setSelectedIndex(0); break;
      case 'view-favorites': refreshLibraryView('library'); setSection('music'); setMusicView('library'); setSelectedIndex(0); break;
      case 'view-history': refreshLibraryView('explore'); setSection('music'); setMusicView('explore'); setSelectedIndex(0); break;
      case 'lyrics': setLyricsVisible((v: boolean) => !v); break;
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
      case 'help': setHelpVisible((v) => !v); break;
      case 'quit': setQuitConfirmVisible(true); break;
      case 'layout-default': setLayout('default'); break;
      case 'layout-compact': setLayout('compact'); break;
      case 'layout-minimal': setLayout('minimal'); break;
      case 'layout-split': setLayout('split'); break;
      case 'layout-wide': setLayout('wide'); break;
      case 'layout-focus': setLayout('focus'); break;
    }
  }, [controller, handleNext, handlePrev, handleToggleShuffle, handleCycleRepeat,
      setFocusedPanel, setSection, setMusicView, setPodcastView, refreshLibraryView, onQuit, setLayout, setThemeName, setQuitConfirmVisible]);

  // -- Global keybindings --
  useKeyboard((key: KeyEvent) => {
    // Command palette
    if (key.ctrl && key.name === 'p') {
      setPaletteVisible((v) => {
        if (!v) { setPaletteFilter(''); setPaletteSelectedIdx(0); }
        return !v;
      });
      return;
    }
    // Layout cycling
    if (key.ctrl && key.name === 'l') {
      setLayout((prev) => nextLayout(prev));
      return;
    }
    // Theme cycling
    if (key.ctrl && key.name === 't') {
      setThemeName((prev) => nextTheme(prev));
      return;
    }
    // Section switching
    if (key.ctrl && key.name === '1') { setSection('music'); return; }
    if (key.ctrl && key.name === '2') { setSection('podcast'); return; }
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
              setLyricsData({ lines, synced: lines.length > 0 && lines[0].time > 0, source: 'custom', sourceUrl: url });
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

    // When search input is focused, only allow Tab, Escape, and Ctrl combos.
    // Everything else is the user typing a query.
    if (focusedPanel === 'search') {
      if (key.name === 'tab') {
        setFocusedPanel('main');
      } else if (key.name === 'escape') {
        setFocusedPanel('main');
      }
      // Ctrl combos already handled above (Ctrl+P, Ctrl+L, Ctrl+T)
      // Quit handled below — but also Ctrl-gated so it's fine
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
            podcastProvider.getEpisodes(podcast).then((eps) => {
              setPodcastEpisodes(eps);
              setEpisodesLoading(false);
            }).catch(() => setEpisodesLoading(false));
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
          setFavoritesSet((prev: Set<string>) => { const next = new Set(prev); next.delete(trackKey); return next; });
        } else {
          addFavorite(db, track);
          setFavoritesSet((prev: Set<string>) => new Set(prev).add(trackKey));
        }
        setFavorites(getFavorites(db));
        Logger.info(`Favorite toggled: ${track.title}`);
      }
      return;
    }

    // Lyrics toggle
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

    // Load more search results (max 2 pages)
    if (key.name === 'L') {
      if (section === 'music' && musicView === 'search' && searchHasMore) {
        void handleLoadMore();
        return;
      }
      if (section === 'podcast' && podcastView === 'episodes' && hasMoreEpisodes) {
        setEpisodePageSize((prev) => prev + 50);
        return;
      }
    }

    // Sidebar navigation — when sidebar focused
    if (focusedPanel === 'sidebar') {
      if (section === 'music') {
        const views: MusicView[] = ['search', 'queue', 'library', 'explore'];
        const idx = views.indexOf(musicView);
        if (key.name === 'j' || key.name === 'down') {
          const newView = views[Math.min(idx + 1, views.length - 1)];
          if (newView) { setMusicView(newView); setSelectedIndex(0); refreshLibraryView(newView); }
          return;
        }
        if (key.name === 'k' || key.name === 'up') {
          const newView = views[Math.max(idx - 1, 0)];
          if (newView) { setMusicView(newView); setSelectedIndex(0); refreshLibraryView(newView); }
          return;
        }
      } else {
        const views: PodcastView[] = ['search', 'feeds', 'episodes'];
        const idx = views.indexOf(podcastView);
        if (key.name === 'j' || key.name === 'down') {
          const newView = views[Math.min(idx + 1, views.length - 1)];
          if (newView) { setPodcastView(newView); setSelectedIndex(0); }
          return;
        }
        if (key.name === 'k' || key.name === 'up') {
          const newView = views[Math.max(idx - 1, 0)];
          if (newView) { setPodcastView(newView); setSelectedIndex(0); }
          return;
        }
      }
      if (key.name === 'return' || key.name === 'enter') {
        setFocusedPanel('main');
        return;
      }
    }

    // Playback controls (search gate above ensures these never fire while typing)
    if (key.name === 'space') void controller.togglePause();
    else if (key.name === 'n') void handleNext();
    else if (key.name === 'p') void handlePrev();
    else if (key.name === '>') void controller.seekRelative(10);
    else if (key.name === '<') void controller.seekRelative(-10);
    else if (key.name === '=' || key.name === '+') void controller.addVolume(5);
    else if (key.name === '-') void controller.addVolume(-5);
    else if (key.name === 'm') void controller.toggleMute();
    else if (key.name === 's') handleToggleShuffle();
    else if (key.name === 'r') handleCycleRepeat();
    else if (key.name === ']') void controller.cycleSpeedUp();
    else if (key.name === '[') void controller.cycleSpeedDown();

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
    if (key.name === 'x' && focusedPanel === 'main' && section === 'music' && musicView === 'queue' && queue.length > 0) {
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
  const pageInfo = section === 'music' && musicView === 'search' && resultCount > 0
    ? ` (${resultCount}${searchHasMore ? ' • Shift+L for more' : ''})` : '';
  const viewTitle = section === 'podcast'
    ? (podcastView === 'episodes' && selectedPodcast ? selectedPodcast.title : 'Podcasts')
    : (musicView === 'queue' ? 'Queue'
      : musicView === 'library' ? 'Favorites'
      : musicView === 'explore' ? 'History'
      : 'Results') + pageInfo;

  const emptyMessage = section === 'podcast' ? 'Use Ctrl+P > "podcast" to search, or subscribe to feeds.'
    : musicView === 'queue' ? 'Queue is empty. Press q on a track to add it.'
    : musicView === 'library' ? 'No favorites yet. Press f on a track to save it.'
    : musicView === 'explore' ? 'No history yet. Play a track to start.'
    : 'Press / to search YouTube Music';

  const podcastListJsx = podcastListItems.length > 0 ? (
    <scrollbox ref={podcastScrollRef}>
      {podcastListItems.map((podcast, i) => {
        const selected = i === selectedIndex;
        return (
          <box key={podcast.id} id={`podcast-row-${i}`} flexDirection="column" backgroundColor={selected ? t.selection : undefined} paddingLeft={1} paddingRight={1}>
            <box flexDirection="row">
              <text fg={selected ? t.accent : t.dim} attributes={selected ? TextAttributes.BOLD : 0}>
                {String(i + 1).padStart(2, ' ')}  {selected ? '\u25b8 ' : '  '}
              </text>
              <text fg={selected ? t.accent : t.fg} attributes={selected ? TextAttributes.BOLD : 0} truncate flexGrow={1}>
                {podcast.title}
              </text>
              {isSubscribed(getDb(), podcast.feedUrl) && <text fg={t.green}> \u2713</text>}
            </box>
            <box flexDirection="row">
              <text fg={selected ? t.dim : t.dim}>
                {'      '}{podcast.author}
              </text>
            </box>
          </box>
        );
      })}
    </scrollbox>
  ) : null;

  const trackListJsx = mainTracks.length > 0 ? (
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
      <text fg={DIM}>[?] help  [ctrl+p] commands  [ctrl+l] layout  [ctrl+t] theme</text>
    </box>
  );

  const mainPanel = (
    <box flexGrow={1} flexDirection="row">
      {/* Track list: shrinks when lyrics/transcript panel is open */}
      <box
        flexGrow={lyricsVisible ? 0 : 1}
        width={lyricsVisible ? '35%' : undefined}
        flexDirection="column"
        border borderStyle="rounded"
        borderColor={focusedPanel === 'main' ? ACCENT : DIM}
        title={viewTitle}
      >
        {searchLoading ? (
          <box paddingLeft={1} paddingTop={1}>
            <text fg={DIM}>Searching...</text>
          </box>
        ) : section === 'podcast' && podcastListJsx ? podcastListJsx : trackListJsx}
      </box>
      {/* Lyrics/Transcript: takes remaining ~65% */}
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
    <Header focused={focusedPanel === 'search'} section={section} onSearch={handleSearch} onSectionChange={setSection} />
  );

  // -- Layout rendering --
  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Focus layout: centered now-playing only */}
      {layout === 'focus' ? (
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          <NowPlaying />
          <text fg={DIM}>
            [space] pause  [n/p] next/prev  [ctrl+l] layout  [ctrl+t] theme  [ctrl+q] quit
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
              <box flexGrow={1} flexDirection="column" border borderStyle="rounded"
                borderColor={focusedPanel === 'sidebar' ? ACCENT : DIM} title="Queue">
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
        onFilterChange={(v) => { setPaletteFilter(v); setPaletteSelectedIdx(0); }}
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
    </box>
  );
}
