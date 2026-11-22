import type { Database } from 'bun:sqlite';
import type { Store } from 'jotai/vanilla/store';
import {
  addToHistory,
  getPlaybackSourcePreference,
  setPlaybackSourcePreference,
} from '../db/queries';
import type { PlayerPort } from '../player/controller';
import type { resolvePlaybackSource } from '../providers/media';
import type { PodcastProvider } from '../providers/podcast';
import type { IProvider } from '../providers/types';
import type { SpectrumCapturePort } from '../spectrum/types';
import { queueSelectionIdAtom, queueStateAtom } from '../store/queue';
import { type CatalogController, createCatalogController } from './catalog';
import { createEpisodeProgress, type EpisodeProgress } from './episode-progress';
import type { LyricsDependencies, LyricsSession } from './lyrics';
import { createLyricsSession } from './lyrics';
import type { PlaybackSession } from './playback';
import { createPlaybackSession } from './playback';
import { createQueuePersistence } from './queue-persistence';
import type { SearchController } from './search';
import { createSearchController } from './search';
import { createSpectrumSession, type SpectrumSession } from './spectrum';

export type RuntimeDependencies = Omit<LyricsDependencies, 'db'> & {
  db: Database;
  player: PlayerPort;
  music: IProvider;
  podcasts: PodcastProvider;
  /** Signature of resolvePlaybackSource from providers/media. */
  resolve: typeof resolvePlaybackSource;
  capture: SpectrumCapturePort;
};

export interface AppRuntime {
  readonly db: Database;
  readonly player: PlayerPort;
  readonly playback: PlaybackSession;
  readonly lyrics: LyricsSession;
  readonly search: SearchController;
  readonly catalog: CatalogController;
  readonly spectrum: SpectrumSession;
  readonly episodeProgress: EpisodeProgress;
  readonly musicProviderId: string;
  dispose(): Promise<void>;
}

/**
 * Assembly point for the application owners. Bootstrap constructs it with the
 * real DB, player, and providers; tests construct a fresh runtime around an
 * in-memory DB and explicit boundary implementations. The runtime does not own
 * the injected DB or player — bootstrap destroys them.
 */
export function createAppRuntime(store: Store, deps: RuntimeDependencies): AppRuntime {
  const queuePersistence = createQueuePersistence(store, deps.db);
  // Register EOF progress before playback's repeat/advance handler can replace the target.
  const episodeProgress = createEpisodeProgress(store, deps.db, deps.player);
  const playback = createPlaybackSession(store, deps.player, {
    resolve: deps.resolve,
    episodeProgress,
    getSourcePreference: (key) => getPlaybackSourcePreference(deps.db, key),
    saveSourcePreference: (key, preference) =>
      setPlaybackSourcePreference(deps.db, key, preference),
    onLoaded: (target) => {
      // The playback session deduplicates by requestId; write history once per
      // successful load with the enriched track (resolvedSource included).
      addToHistory(deps.db, target.track);
      if (
        target.origin.kind === 'queue' &&
        store.get(queueStateAtom).cursorId === target.origin.entryId
      )
        store.set(queueSelectionIdAtom, target.origin.entryId);
    },
  });
  const lyrics = createLyricsSession(store, {
    db: deps.db,
    fetchMusicLyrics: deps.fetchMusicLyrics,
    fetchUrl: deps.fetchUrl,
    fetchYouTubeCaptions: deps.fetchYouTubeCaptions,
    fetchNativeTranslation: deps.fetchNativeTranslation,
    translationProvider: deps.translationProvider,
  });
  const search = createSearchController(store, {
    music: deps.music,
    podcasts: deps.podcasts,
  });
  const catalog = createCatalogController(store, { music: deps.music, playback });
  const spectrum = createSpectrumSession(store, { capture: deps.capture });
  return {
    db: deps.db,
    player: deps.player,
    playback,
    lyrics,
    search,
    catalog,
    spectrum,
    episodeProgress,
    musicProviderId: deps.music.id,
    async dispose(): Promise<void> {
      // Save the last confirmed checkpoint before playback is torn down or SQLite closes.
      episodeProgress.dispose();
      queuePersistence.dispose();
      const results = await Promise.allSettled([
        spectrum.dispose(),
        catalog.dispose(),
        search.dispose(),
        playback.dispose(),
        lyrics.dispose(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) throw new AggregateError(failures, 'Application cleanup failed');
    },
  };
}
