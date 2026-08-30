import { expect, test } from 'bun:test';
import type { MockInput, TestRenderer } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { act } from 'react';
import { App } from '../../src/app';
import type { PlayerController } from '../../src/player/controller';
import { podcastProvider } from '../../src/providers/podcast';
import type { Podcast } from '../../src/providers/podcast-types';
import { getProvider, registerProvider } from '../../src/providers/registry';
import type { IProvider, SearchOptions, SearchResult, Track } from '../../src/providers/types';
import { YouTubeProvider } from '../../src/providers/youtube';
import { lyricsDataAtom, lyricsVisibleAtom } from '../../src/store/lyrics';
import {
  playerDurationAtom,
  playerPositionAtom,
  playerSpeedAtom,
  playerTrackAtom,
  playerVolumeAtom,
} from '../../src/store/player';
import { podcastSearchLoadingAtom, podcastSearchResultsAtom } from '../../src/store/podcast';
import {
  focusedPanelAtom,
  searchHasMoreAtom,
  searchLoadingAtom,
  searchResultsAtom,
  sectionAtom,
} from '../../src/store/ui';

const oldTrack: Track = {
  id: 'old',
  provider: 'app-search-test',
  title: 'Old result',
  artist: 'Test artist',
  duration: 0,
};
const newTrack: Track = {
  id: 'new',
  provider: 'app-search-test',
  title: 'New result',
  artist: 'Test artist',
  duration: 0,
};
const baseTrack: Track = {
  id: 'base',
  provider: 'app-search-test',
  title: 'Base result',
  artist: 'Test artist',
  duration: 0,
};
const pageTrack: Track = {
  id: 'page',
  provider: 'app-search-test',
  title: 'Page result',
  artist: 'Test artist',
  duration: 0,
};
const oldResult: SearchResult = { tracks: [oldTrack], hasMore: false };
const newResult: SearchResult = { tracks: [newTrack], hasMore: false };
const pendingSearches: Array<{
  query: string;
  options: SearchOptions | undefined;
  resolve: (result: SearchResult) => void;
  reject: (reason?: unknown) => void;
}> = [];

const provider: IProvider = {
  id: 'app-search-test',
  name: 'App search test',
  icon: '',
  search: (query, options) => {
    const { promise, resolve, reject } = Promise.withResolvers<SearchResult>();
    pendingSearches.push({ query, options, resolve, reject });
    return promise;
  },
  getTrack: async () => newTrack,
  getStreamUrl: async () => '',
};

const defaultController = { onTrackEnd: () => {} } as unknown as PlayerController;

async function flushPendingSearches(renderOnce?: () => Promise<void>): Promise<void> {
  await act(async () => {
    for (const { resolve } of pendingSearches) resolve({ tracks: [], hasMore: false });
    await Bun.sleep(0);
    if (renderOnce) await renderOnce();
  });
}

async function cleanupTestApp(
  renderer: TestRenderer | undefined,
  renderOnce: (() => Promise<void>) | undefined,
  originalProvider: IProvider | undefined,
): Promise<void> {
  try {
    await flushPendingSearches(renderOnce);
  } finally {
    try {
      if (renderer) {
        await act(async () => {
          renderer.destroy();
        });
      }
    } finally {
      if (originalProvider) registerProvider(originalProvider);
    }
  }
}

async function renderTestApp(store: Store, controller = defaultController) {
  let originalProvider: IProvider | undefined;
  let renderer: TestRenderer | undefined;
  let renderOnce: (() => Promise<void>) | undefined;
  try {
    originalProvider = getProvider('youtube');
    if (!originalProvider) {
      originalProvider = new YouTubeProvider();
      registerProvider(originalProvider);
    }
    registerProvider({ ...provider, id: originalProvider.id });
    const setup = await testRender(
      <App store={store} controller={controller} onQuit={() => {}} />,
      { width: 100, height: 30 },
    );
    renderer = setup.renderer;
    renderOnce = setup.renderOnce;
    return {
      ...setup,
      cleanup: async () => cleanupTestApp(renderer, renderOnce, originalProvider),
    };
  } catch (error) {
    await cleanupTestApp(renderer, renderOnce, originalProvider);
    throw error;
  }
}

async function submit(mockInput: MockInput): Promise<void> {
  await act(async () => {
    mockInput.pressEnter();
    await Promise.resolve();
  });
}

async function typeAndSubmit(
  mockInput: MockInput,
  renderOnce: () => Promise<void>,
  query: string,
): Promise<void> {
  await act(async () => {
    await mockInput.typeText(query);
  });
  await renderOnce();
  await submit(mockInput);
}

async function refocusAndReplace(
  store: Store,
  mockInput: MockInput,
  renderOnce: () => Promise<void>,
  oldQuery: string,
  newQuery: string,
): Promise<void> {
  await act(async () => {
    store.set(focusedPanelAtom, 'search');
  });
  await renderOnce();
  await act(async () => {
    for (let index = 0; index < oldQuery.length; index++) mockInput.pressBackspace();
    await mockInput.typeText(newQuery);
  });
  await renderOnce();
}

async function settle(
  resolve: (result: SearchResult) => void,
  result: SearchResult,
  renderOnce: () => Promise<void>,
): Promise<void> {
  await act(async () => {
    resolve(result);
    await Bun.sleep(0);
    await renderOnce();
  });
}

test('ignores an old music result while a newer search remains pending', async () => {
  pendingSearches.length = 0;
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await typeAndSubmit(mockInput, renderOnce, 'old');
    expect(pendingSearches.map(({ query }) => query)).toEqual(['old']);
    await refocusAndReplace(store, mockInput, renderOnce, 'old', 'new');
    expect(captureCharFrame()).toContain('new');
    await submit(mockInput);

    expect(pendingSearches.map(({ query }) => query)).toEqual(['old', 'new']);
    const oldSearch = pendingSearches[0];
    const newSearch = pendingSearches[1];
    if (!oldSearch || !newSearch) throw new Error('Expected both music searches');

    await settle(oldSearch.resolve, oldResult, renderOnce);
    expect(store.get(searchResultsAtom)).toBeNull();
    expect(store.get(searchLoadingAtom)).toBe(true);

    await settle(newSearch.resolve, newResult, renderOnce);
    expect(store.get(searchResultsAtom)?.tracks).toEqual([newTrack]);
    expect(store.get(searchLoadingAtom)).toBe(false);
  } finally {
    await cleanup();
  }
});

test('ignores an old podcast result while a newer search remains pending', async () => {
  const oldPodcast: Podcast = {
    id: 'old-podcast',
    title: 'Old podcast',
    author: 'Test author',
    feedUrl: 'https://example.test/old.xml',
  };
  const newPodcast: Podcast = {
    id: 'new-podcast',
    title: 'New podcast',
    author: 'Test author',
    feedUrl: 'https://example.test/new.xml',
  };
  const pendingPodcasts: Array<{ query: string; resolve: (podcasts: Podcast[]) => void }> = [];
  const originalSearchPodcasts = podcastProvider.searchPodcasts;
  const store = createStore();
  store.set(sectionAtom, 'podcast');
  store.set(focusedPanelAtom, 'search');
  let renderOnce: (() => Promise<void>) | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  try {
    podcastProvider.searchPodcasts = (query) =>
      new Promise((resolve) => {
        pendingPodcasts.push({ query, resolve });
      });
    const setup = await renderTestApp(store);
    const { mockInput, renderOnce: activeRenderOnce } = setup;
    renderOnce = activeRenderOnce;
    cleanup = setup.cleanup;

    await typeAndSubmit(mockInput, activeRenderOnce, 'old');
    expect(pendingPodcasts.map(({ query }) => query)).toEqual(['old']);
    await refocusAndReplace(store, mockInput, activeRenderOnce, 'old', 'new');
    await submit(mockInput);

    expect(pendingPodcasts.map(({ query }) => query)).toEqual(['old', 'new']);
    const oldSearch = pendingPodcasts[0];
    const newSearch = pendingPodcasts[1];
    if (!oldSearch || !newSearch) throw new Error('Expected both podcast searches');

    await act(async () => {
      oldSearch.resolve([oldPodcast]);
      await Bun.sleep(0);
      await activeRenderOnce();
    });
    expect(store.get(podcastSearchResultsAtom)).toEqual([]);
    expect(store.get(podcastSearchLoadingAtom)).toBe(true);

    await act(async () => {
      newSearch.resolve([newPodcast]);
      await Bun.sleep(0);
      await activeRenderOnce();
    });
    expect(store.get(podcastSearchResultsAtom)).toEqual([newPodcast]);
    expect(store.get(podcastSearchLoadingAtom)).toBe(false);
  } finally {
    try {
      await act(async () => {
        for (const { resolve } of pendingPodcasts) resolve([]);
        await Bun.sleep(0);
        if (renderOnce) await renderOnce();
      });
    } finally {
      try {
        podcastProvider.searchPodcasts = originalSearchPodcasts;
      } finally {
        if (cleanup) await cleanup();
      }
    }
  }
});

test('ignores a stale continuation while a fresh music search remains pending', async () => {
  const continuation = {};
  const baseResult: SearchResult = {
    tracks: [baseTrack],
    hasMore: true,
    continuation,
  };
  const pageResult: SearchResult = { tracks: [pageTrack], hasMore: false };
  pendingSearches.length = 0;
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const { mockInput, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await typeAndSubmit(mockInput, renderOnce, 'base');
    const baseSearch = pendingSearches[0];
    if (!baseSearch) throw new Error('Expected base search');
    await settle(baseSearch.resolve, baseResult, renderOnce);
    expect(store.get(searchHasMoreAtom)).toBe(true);

    await act(async () => {
      mockInput.pressKey('l', { shift: true });
      await Promise.resolve();
    });
    expect(pendingSearches.map(({ query }) => query)).toEqual(['base', '']);
    const pageSearch = pendingSearches[1];
    if (!pageSearch) throw new Error('Expected continuation search');
    expect(pageSearch.options).toEqual({ continuation });

    await refocusAndReplace(store, mockInput, renderOnce, 'base', 'fresh');
    await submit(mockInput);
    expect(pendingSearches.map(({ query }) => query)).toEqual(['base', '', 'fresh']);
    const freshSearch = pendingSearches[2];
    if (!freshSearch) throw new Error('Expected fresh search');

    await settle(pageSearch.resolve, pageResult, renderOnce);
    expect(store.get(searchResultsAtom)?.tracks).toEqual([baseTrack]);
    expect(store.get(searchLoadingAtom)).toBe(true);

    await settle(freshSearch.resolve, newResult, renderOnce);
    expect(store.get(searchResultsAtom)?.tracks).toEqual([newTrack]);
    expect(store.get(searchLoadingAtom)).toBe(false);
  } finally {
    await cleanup();
  }
});

test('starts only one continuation for rapid Shift+L presses', async () => {
  const continuation = {};
  const baseResult: SearchResult = {
    tracks: [baseTrack],
    hasMore: true,
    continuation,
  };
  pendingSearches.length = 0;
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const { mockInput, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await typeAndSubmit(mockInput, renderOnce, 'base');
    const baseSearch = pendingSearches[0];
    if (!baseSearch) throw new Error('Expected base search');
    await settle(baseSearch.resolve, baseResult, renderOnce);

    await act(async () => {
      mockInput.pressKey('l', { shift: true });
      mockInput.pressKey('l', { shift: true });
      await Promise.resolve();
    });

    expect(pendingSearches.map(({ query }) => query)).toEqual(['base', '']);
  } finally {
    await cleanup();
  }
});

test('does not load a continuation while a fresh search is pending', async () => {
  const continuation = {};
  const baseResult: SearchResult = {
    tracks: [baseTrack],
    hasMore: true,
    continuation,
  };
  pendingSearches.length = 0;
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const { mockInput, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await typeAndSubmit(mockInput, renderOnce, 'base');
    const baseSearch = pendingSearches[0];
    if (!baseSearch) throw new Error('Expected base search');
    await settle(baseSearch.resolve, baseResult, renderOnce);

    await refocusAndReplace(store, mockInput, renderOnce, 'base', 'fresh');
    await submit(mockInput);
    expect(pendingSearches.map(({ query }) => query)).toEqual(['base', 'fresh']);

    await act(async () => {
      mockInput.pressKey('l', { shift: true });
      await Promise.resolve();
    });

    expect(pendingSearches.map(({ query }) => query)).toEqual(['base', 'fresh']);
  } finally {
    await cleanup();
  }
});

test('keeps fresh continuation ownership when an older page is pending', async () => {
  const oldContinuation = {};
  const freshContinuation = {};
  const baseResult: SearchResult = {
    tracks: [baseTrack],
    hasMore: true,
    continuation: oldContinuation,
  };
  const freshResult: SearchResult = {
    tracks: [newTrack],
    hasMore: true,
    continuation: freshContinuation,
  };
  const freshPageTrack: Track = {
    id: 'fresh-page',
    provider: 'app-search-test',
    title: 'Fresh page result',
    artist: 'Test artist',
    duration: 0,
  };
  const freshPageResult: SearchResult = { tracks: [freshPageTrack], hasMore: false };
  pendingSearches.length = 0;
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const { mockInput, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await typeAndSubmit(mockInput, renderOnce, 'base');
    const baseSearch = pendingSearches[0];
    if (!baseSearch) throw new Error('Expected base search');
    await settle(baseSearch.resolve, baseResult, renderOnce);

    await act(async () => {
      mockInput.pressKey('l', { shift: true });
      await Promise.resolve();
    });
    const oldPageSearch = pendingSearches[1];
    if (!oldPageSearch) throw new Error('Expected old continuation');

    await refocusAndReplace(store, mockInput, renderOnce, 'base', 'fresh');
    await submit(mockInput);
    const freshSearch = pendingSearches[2];
    if (!freshSearch) throw new Error('Expected fresh search');
    await settle(freshSearch.resolve, freshResult, renderOnce);

    await act(async () => {
      mockInput.pressKey('l', { shift: true });
      await Promise.resolve();
    });
    expect(pendingSearches.map(({ query }) => query)).toEqual(['base', '', 'fresh', '']);
    const freshPageSearch = pendingSearches[3];
    if (!freshPageSearch) throw new Error('Expected fresh continuation');

    await settle(oldPageSearch.resolve, { tracks: [pageTrack], hasMore: false }, renderOnce);
    expect(store.get(searchLoadingAtom)).toBe(true);
    await act(async () => {
      mockInput.pressKey('l', { shift: true });
      await Promise.resolve();
    });
    expect(pendingSearches.map(({ query }) => query)).toEqual(['base', '', 'fresh', '']);

    await settle(freshPageSearch.resolve, freshPageResult, renderOnce);
    expect(store.get(searchResultsAtom)?.tracks).toEqual([newTrack, freshPageTrack]);
    expect(store.get(searchLoadingAtom)).toBe(false);
  } finally {
    await cleanup();
  }
});

test('keeps retained music results pageable after a fresh search rejects', async () => {
  const continuation = {};
  const baseResult: SearchResult = {
    tracks: [baseTrack],
    hasMore: true,
    continuation,
  };
  pendingSearches.length = 0;
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await typeAndSubmit(mockInput, renderOnce, 'base');
    const baseSearch = pendingSearches[0];
    if (!baseSearch) throw new Error('Expected base search');
    await settle(baseSearch.resolve, baseResult, renderOnce);

    await refocusAndReplace(store, mockInput, renderOnce, 'base', 'fresh');
    await submit(mockInput);
    const freshSearch = pendingSearches[1];
    if (!freshSearch) throw new Error('Expected fresh search');
    await act(async () => {
      freshSearch.reject(new Error('Search failed'));
      await Promise.resolve();
      await Bun.sleep(0);
    });
    await renderOnce();

    expect(captureCharFrame()).toContain('Base result');
    expect(store.get(searchHasMoreAtom)).toBe(true);
    expect(store.get(searchLoadingAtom)).toBe(false);

    await act(async () => {
      mockInput.pressKey('l', { shift: true });
      await Promise.resolve();
    });
    expect(pendingSearches.map(({ query }) => query)).toEqual(['base', 'fresh', '']);
    const pageSearch = pendingSearches[2];
    if (!pageSearch) throw new Error('Expected continuation after rejected fresh search');
    expect(pageSearch.options?.continuation).toBe(continuation);
  } finally {
    await cleanup();
  }
});

test('does not invoke mute while typing in focused search input', async () => {
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  let toggleMuteCalls = 0;
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp(store, {
    onTrackEnd: () => {},
    toggleMute: async () => {
      toggleMuteCalls++;
    },
  } as unknown as PlayerController);

  try {
    await act(async () => {
      await mockInput.typeText('m99');
    });
    await renderOnce();

    expect(captureCharFrame()).toContain('m99');
    expect(toggleMuteCalls).toBe(0);
  } finally {
    await cleanup();
  }
});

test('palette transcript search reopens lyrics closed after callback creation', async () => {
  const store = createStore();
  store.set(sectionAtom, 'podcast');
  store.set(playerTrackAtom, newTrack);
  store.set(lyricsDataAtom, {
    lines: [{ time: 0, text: 'Needle lyric' }],
    synced: false,
    source: 'test',
  });
  store.set(lyricsVisibleAtom, true);
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await act(async () => {
      store.set(lyricsVisibleAtom, false);
      await renderOnce();
    });
    await act(async () => {
      mockInput.pressKey('p', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();

    expect(captureCharFrame()).toContain('Command Palette');
    await act(async () => {
      await mockInput.typeText('find');
    });
    await renderOnce();

    expect(captureCharFrame()).toContain('Transcript');
    await act(async () => {
      mockInput.pressArrow('down');
      await Promise.resolve();
    });
    await renderOnce();
    await submit(mockInput);
    await renderOnce();

    expect(captureCharFrame()).toContain('Find:');
    expect(store.get(lyricsVisibleAtom)).toBe(true);
  } finally {
    await cleanup();
  }
});

test('renders two spaces between NowPlaying speed and time', async () => {
  const store = createStore();
  store.set(playerVolumeAtom, 75);
  store.set(playerSpeedAtom, 1.5);
  store.set(playerPositionAtom, 65);
  store.set(playerDurationAtom, 130);
  const { captureCharFrame, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await renderOnce();
    expect(captureCharFrame()).toContain('🔊75% 1.5x  1:05 / 2:10');
  } finally {
    await cleanup();
  }
});

test('renders two spaces between transcript URL actions', async () => {
  const store = createStore();
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp(store);

  try {
    await act(async () => {
      mockInput.pressKey('p', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Command Palette');
    await act(async () => {
      await mockInput.typeText('custom');
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Custom URL');
    await submit(mockInput);
    await renderOnce();

    expect(captureCharFrame()).toContain('[Enter] load  [Escape] cancel');
  } finally {
    await cleanup();
  }
});
