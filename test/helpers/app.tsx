import { Database } from 'bun:sqlite';
import type { MockInput, MockMouse, TestRenderer } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { act } from 'react';
import { App } from '../../src/app';
import type { RuntimeDependencies } from '../../src/application/runtime';
import { type AppRuntime, createAppRuntime } from '../../src/application/runtime';
import { runMigrations } from '../../src/db/index';
import type { PlayerPort } from '../../src/player/controller';
import { resolvePlaybackSource } from '../../src/providers/media';
import { PodcastProvider } from '../../src/providers/podcast';
import type { Podcast } from '../../src/providers/podcast-types';
import type { TranslationProvider } from '../../src/providers/translate';
import type { IProvider, SearchResult, Track } from '../../src/providers/types';
import type { SpectrumCapturePort } from '../../src/spectrum/types';
import { createTestPlayer, type TestPlayer } from './player';

export function createTestDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

export function makeTrack(id: string, title = id): Track {
  return {
    id,
    provider: 'test-music',
    source: { kind: 'youtube', videoId: id },
    title,
    artist: 'Test artist',
    duration: 0,
  };
}

export const testMusicProvider: IProvider = {
  id: 'test-music',
  name: 'Test music',
  icon: '',
  search: async (): Promise<SearchResult> => ({ tracks: [], hasMore: false }),
  getTrack: async (id: string): Promise<Track> => makeTrack(id),
  getStreamUrl: async () => '',
};

/** A PodcastProvider whose fetcher records each request as a deferred Response. */
export interface DeferredFetchRequest {
  url: string;
  respond: (body: string) => void;
}

export function createDeferredPodcasts(): {
  provider: PodcastProvider;
  requests: DeferredFetchRequest[];
} {
  const requests: DeferredFetchRequest[] = [];
  const provider = new PodcastProvider((input): Promise<Response> => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    requests.push({ url: String(input), respond: (body) => resolve(new Response(body)) });
    return promise;
  });
  return { provider, requests };
}

/** iTunes search JSON for the given podcasts, as the real adapter expects. */
export function itunesSearchBody(podcasts: Podcast[]): string {
  return JSON.stringify({
    results: podcasts.map((podcast) => ({
      collectionId: Number(podcast.id),
      collectionName: podcast.title,
      artistName: podcast.author,
      feedUrl: podcast.feedUrl,
    })),
  });
}

export const testPodcasts: PodcastProvider = new PodcastProvider(
  async () => new Response('{"results":[]}'),
);

const testTranslationProvider: TranslationProvider = {
  id: 'test',
  name: 'Test translator',
  translate: async (text) => text,
  translateBatch: async (texts) => texts.map(() => ''),
};

export interface TestAppHandle {
  renderer: TestRenderer;
  renderOnce: () => Promise<void>;
  captureCharFrame: () => string;
  mockInput: MockInput;
  mockMouse: MockMouse;
  resize(width: number, height: number): void;
  store: Store;
  db: Database;
  runtime: AppRuntime;
  player: TestPlayer;
  cleanup: () => Promise<void>;
}

export interface RenderTestAppOptions {
  store?: Store;
  db?: Database;
  music?: IProvider;
  podcasts?: PodcastProvider;
  player?: PlayerPort;
  resolve?: typeof resolvePlaybackSource;
  capture?: SpectrumCapturePort;
  fetchMusicLyrics?: RuntimeDependencies['fetchMusicLyrics'];
  onQuit?: () => void;
}

/**
 * Renders the real App around a fresh runtime: an in-memory migrated DB, the
 * shared test player, offline lyric/translation boundaries, and the real
 * resolvePlaybackSource (synchronous for YouTube-source tracks). Cleanup
 * destroys the renderer, disposes the runtime, and closes the DB.
 */
export async function renderTestApp(options: RenderTestAppOptions = {}): Promise<TestAppHandle> {
  const store = options.store ?? createStore();
  const db = options.db ?? createTestDb();
  const testPlayer = createTestPlayer(store);
  const player = options.player ?? testPlayer.player;
  const runtime = createAppRuntime(store, {
    db,
    player,
    music: options.music ?? testMusicProvider,
    podcasts: options.podcasts ?? testPodcasts,
    resolve: options.resolve ?? resolvePlaybackSource,
    capture: options.capture ?? {
      async run(_target, signal) {
        signal.throwIfAborted();
        throw new Error('OS audio capture is disabled in the offline App harness.');
      },
    },
    fetchMusicLyrics: options.fetchMusicLyrics ?? (async () => null),
    fetchUrl: async () => [],
    fetchYouTubeCaptions: async () => null,
    fetchNativeTranslation: async () => null,
    translationProvider: () => testTranslationProvider,
  } satisfies RuntimeDependencies);
  const setup = await testRender(
    <App store={store} runtime={runtime} onQuit={options.onQuit ?? (() => {})} />,
    { width: 100, height: 30 },
  );
  const cleanup = async (): Promise<void> => {
    try {
      // Cover the renderer's destroy-event unmount too; keep disposal outside
      // this synchronous act because the pinned renderer resets its flag.
      try {
        act(() => setup.renderer.destroy());
      } finally {
        await runtime.dispose();
      }
    } finally {
      db.close();
    }
  };
  return {
    renderer: setup.renderer,
    renderOnce: async () => {
      await act(async () => setup.renderOnce());
    },
    captureCharFrame: () => setup.captureCharFrame(),
    mockInput: setup.mockInput,
    mockMouse: setup.mockMouse,
    resize: setup.resize,
    store,
    db,
    runtime,
    player: testPlayer,
    cleanup,
  };
}
