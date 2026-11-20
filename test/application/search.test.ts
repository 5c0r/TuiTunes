import { expect, test, vi } from 'bun:test';
import { createStore } from 'jotai';
import { createSearchController } from '../../src/application/search';
import { PodcastProvider } from '../../src/providers/podcast';
import type { Podcast } from '../../src/providers/podcast-types';
import type {
  IProvider,
  SearchContinuation,
  SearchOptions,
  SearchResult,
  Track,
} from '../../src/providers/types';
import {
  episodesLoadingAtom,
  podcastEpisodesAtom,
  podcastSearchLoadingAtom,
  podcastSearchResultsAtom,
} from '../../src/store/podcast';
import {
  searchHasMoreAtom,
  searchLoadingAtom,
  searchResultsAtom,
  searchSuggestionsAtom,
  sectionAtom,
  suggestionsVisibleAtom,
} from '../../src/store/ui';
import { createDeferredPodcasts, itunesSearchBody } from '../helpers/app';

function track(id: string): Track {
  return {
    id,
    provider: 'search-test',
    source: { kind: 'youtube', videoId: id },
    title: id,
    artist: 'Test artist',
    duration: 0,
  };
}

interface PendingMusic {
  query: string;
  options: SearchOptions | undefined;
  resolve: (result: SearchResult) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Mirrors the real provider: fresh searches return deferred promises that
 * reject when their abort signal fires, and continuation requests are
 * forwarded to the continuation handle with the same signal.
 */
function pendingMusicProvider(): { provider: IProvider; pending: PendingMusic[] } {
  const pending: PendingMusic[] = [];
  const provider: IProvider = {
    id: 'search-test',
    name: 'Search test',
    icon: '',
    search: (query, options) => {
      if (options?.continuation) return options.continuation.next(options.signal);
      const { promise, resolve, reject } = Promise.withResolvers<SearchResult>();
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
      pending.push({ query, options, resolve, reject });
      return promise;
    },
    getTrack: async (id) => track(id),
    getStreamUrl: async () => '',
  };
  return { provider, pending };
}

interface PendingContinuation {
  signal: AbortSignal | undefined;
  resolve: (result: SearchResult) => void;
  reject: (reason?: unknown) => void;
}

/** Deferred continuation handle that rejects when its request signal aborts. */
function deferredContinuation(): {
  token: SearchContinuation;
  requests: PendingContinuation[];
} {
  const requests: PendingContinuation[] = [];
  const token: SearchContinuation = {
    next: (signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<SearchResult>();
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      requests.push({ signal, resolve, reject });
      return promise;
    },
  };
  return { token, requests };
}

async function settleMicrotasks(): Promise<void> {
  await Bun.sleep(0);
}

test('ignores an old music result while a newer search remains pending', async () => {
  const { provider, pending } = pendingMusicProvider();
  const store = createStore();
  const controller = createSearchController(store, { music: provider, podcasts: stubPodcasts() });

  const first = controller.search('old', 'music');
  const second = controller.search('new', 'music');
  pending[0]?.resolve({ tracks: [track('old')], hasMore: false });
  await settleMicrotasks();
  expect(store.get(searchResultsAtom)).toBeNull();
  expect(store.get(searchLoadingAtom)).toBe(true);

  pending[1]?.resolve({ tracks: [track('new')], hasMore: false });
  await Promise.all([first, second]);

  expect(store.get(searchResultsAtom)?.tracks.map((t) => t.id)).toEqual(['new']);
  expect(store.get(searchLoadingAtom)).toBe(false);
});

test('retains music results and continuation after a replacement search rejects', async () => {
  const { provider, pending } = pendingMusicProvider();
  const store = createStore();
  const controller = createSearchController(store, { music: provider, podcasts: stubPodcasts() });
  const { token, requests } = deferredContinuation();

  const initial = controller.search('base', 'music');
  pending[0]?.resolve({ tracks: [track('base')], hasMore: true, continuation: token });
  await initial;
  expect(store.get(searchHasMoreAtom)).toBe(true);

  const replacement = controller.search('fresh', 'music');
  pending[1]?.reject(new Error('Search failed'));
  await replacement;
  expect(store.get(searchResultsAtom)?.tracks.map((t) => t.id)).toEqual(['base']);
  expect(store.get(searchLoadingAtom)).toBe(false);
  expect(store.get(searchHasMoreAtom)).toBe(true);

  const loadMore = controller.loadMore();
  expect(requests).toHaveLength(1);
  requests[0]?.resolve({ tracks: [track('page')], hasMore: false });
  await loadMore;
  expect(store.get(searchResultsAtom)?.tracks.map((t) => t.id)).toEqual(['base', 'page']);
});

test('ignores a stale continuation while a fresh music search is pending', async () => {
  const { provider, pending } = pendingMusicProvider();
  const store = createStore();
  const controller = createSearchController(store, { music: provider, podcasts: stubPodcasts() });
  const { token, requests } = deferredContinuation();

  const initial = controller.search('base', 'music');
  pending[0]?.resolve({ tracks: [track('base')], hasMore: true, continuation: token });
  await initial;

  const page = controller.loadMore();
  const fresh = controller.search('fresh', 'music');
  expect(requests).toHaveLength(1);
  // The superseding search aborts the continuation request on the wire; its
  // late resolution can never overwrite the pending fresh search.
  expect(requests[0]?.signal?.aborted).toBe(true);
  requests[0]?.resolve({ tracks: [track('page')], hasMore: false });
  await settleMicrotasks();
  expect(store.get(searchResultsAtom)?.tracks.map((t) => t.id)).toEqual(['base']);
  expect(store.get(searchLoadingAtom)).toBe(true);

  pending[1]?.resolve({ tracks: [track('fresh')], hasMore: false });
  await Promise.all([page, fresh]);
  expect(store.get(searchResultsAtom)?.tracks.map((t) => t.id)).toEqual(['fresh']);
});

test('starts only one continuation for rapid loadMore calls', async () => {
  const { provider, pending } = pendingMusicProvider();
  const store = createStore();
  const controller = createSearchController(store, { music: provider, podcasts: stubPodcasts() });
  const { token, requests } = deferredContinuation();

  const initial = controller.search('base', 'music');
  pending[0]?.resolve({ tracks: [track('base')], hasMore: true, continuation: token });
  await initial;

  const first = controller.loadMore();
  const second = controller.loadMore();
  expect(requests).toHaveLength(1);
  requests[0]?.resolve({ tracks: [track('page')], hasMore: false });
  await Promise.all([first, second]);
});

test('keeps fresh continuation ownership when an older page is pending', async () => {
  const { provider, pending } = pendingMusicProvider();
  const store = createStore();
  const controller = createSearchController(store, { music: provider, podcasts: stubPodcasts() });
  const oldPages = deferredContinuation();
  const freshPages = deferredContinuation();

  const initial = controller.search('base', 'music');
  pending[0]?.resolve({ tracks: [track('base')], hasMore: true, continuation: oldPages.token });
  await initial;

  const oldPage = controller.loadMore();
  const fresh = controller.search('fresh', 'music');
  pending[1]?.resolve({ tracks: [track('fresh')], hasMore: true, continuation: freshPages.token });
  await fresh;
  await settleMicrotasks();

  const freshPage = controller.loadMore();
  expect(freshPages.requests).toHaveLength(1);
  oldPages.requests[0]?.resolve({ tracks: [track('stale')], hasMore: false });
  await settleMicrotasks();
  expect(store.get(searchResultsAtom)?.tracks.map((t) => t.id)).toEqual(['fresh']);

  freshPages.requests[0]?.resolve({ tracks: [track('fresh-page')], hasMore: false });
  await Promise.all([oldPage, freshPage]);
  expect(store.get(searchResultsAtom)?.tracks.map((t) => t.id)).toEqual(['fresh', 'fresh-page']);
});

test('ignores an old podcast result while a newer search remains pending', async () => {
  const { provider: podcasts, requests } = createDeferredPodcasts();
  const store = createStore();
  store.set(sectionAtom, 'podcast');
  const controller = createSearchController(store, { music: stubMusic(), podcasts });

  const first = controller.search('old', 'podcast');
  const second = controller.search('new', 'podcast');
  requests[0]?.respond(itunesSearchBody([podcast('101')]));
  await settleMicrotasks();
  expect(store.get(podcastSearchResultsAtom)).toEqual([]);
  expect(store.get(podcastSearchLoadingAtom)).toBe(true);

  requests[1]?.respond(itunesSearchBody([podcast('202')]));
  await Promise.all([first, second]);
  expect(store.get(podcastSearchResultsAtom).map((p) => p.id)).toEqual(['202']);
  expect(store.get(podcastSearchLoadingAtom)).toBe(false);
});

test('a response for podcast A cannot populate the episodes of podcast B', async () => {
  const { provider: podcasts, requests } = createDeferredPodcasts();
  const store = createStore();
  const controller = createSearchController(store, { music: stubMusic(), podcasts });

  const first = controller.openPodcast(podcast('101'));
  const second = controller.openPodcast(podcast('202'));
  requests[0]?.respond(emptyFeed());
  await settleMicrotasks();
  expect(store.get(podcastEpisodesAtom)).toEqual([]);
  expect(store.get(episodesLoadingAtom)).toBe(true);

  requests[1]?.respond(emptyFeed());
  await Promise.all([first, second]);
  expect(store.get(episodesLoadingAtom)).toBe(false);
});

test('suggest debounces and keeps only the latest generation', async () => {
  const queries: string[] = [];
  const music: IProvider = {
    id: 'suggest-test',
    name: 'Suggest test',
    icon: '',
    search: async () => ({ tracks: [], hasMore: false }),
    getTrack: async (id) => track(id),
    getStreamUrl: async () => '',
    getSearchSuggestions: async (query) => {
      queries.push(query);
      return [query];
    },
  };
  const store = createStore();
  const controller = createSearchController(store, { music, podcasts: stubPodcasts() });

  vi.useFakeTimers();
  try {
    controller.suggest('a');
    controller.suggest('al');
    controller.suggest('alph');
    vi.advanceTimersByTime(260);
    await Promise.resolve();
    await Promise.resolve();

    expect(queries).toEqual(['alph']);
    expect(store.get(searchSuggestionsAtom)).toEqual(['alph']);
    expect(store.get(suggestionsVisibleAtom)).toBe(true);
  } finally {
    vi.useRealTimers();
    await controller.dispose();
  }
});

test('suggest clears suggestions for short queries and podcast section', async () => {
  const store = createStore();
  const controller = createSearchController(store, {
    music: stubMusic(),
    podcasts: stubPodcasts(),
  });
  store.set(searchSuggestionsAtom, ['stale']);
  store.set(suggestionsVisibleAtom, true);

  vi.useFakeTimers();
  try {
    controller.suggest('a');
    expect(store.get(searchSuggestionsAtom)).toEqual([]);
    expect(store.get(suggestionsVisibleAtom)).toBe(false);

    store.set(sectionAtom, 'podcast');
    controller.suggest('podcast query');
    vi.advanceTimersByTime(260);
    expect(store.get(searchSuggestionsAtom)).toEqual([]);
  } finally {
    vi.useRealTimers();
    await controller.dispose();
  }
});

test('dispose cancels scheduled suggestions and discards late results', async () => {
  const queries: string[] = [];
  const music: IProvider = {
    id: 'dispose-test',
    name: 'Dispose test',
    icon: '',
    search: (query, options) => {
      const { promise, resolve, reject } = Promise.withResolvers<SearchResult>();
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
      if (query === 'dispose-late') {
        setTimeout(() => resolve({ tracks: [track('late')], hasMore: false }), 5);
      }
      return promise;
    },
    getTrack: async (id) => track(id),
    getStreamUrl: async () => '',
    getSearchSuggestions: async (query) => {
      queries.push(query);
      return [query];
    },
  };
  const store = createStore();
  const controller = createSearchController(store, { music, podcasts: stubPodcasts() });

  vi.useFakeTimers();
  try {
    const late = controller.search('dispose-late', 'music');
    controller.suggest('dispose');
    controller.dispose();
    vi.advanceTimersByTime(20);
    await late;

    expect(queries).toEqual([]);
    expect(store.get(searchResultsAtom)).toBeNull();
    expect(store.get(searchLoadingAtom)).toBe(true); // disposed controller never clears
  } finally {
    vi.useRealTimers();
  }
});

// ---------------------------------------------------------------------------
// Real cancellation forwarding: superseded requests are aborted on the wire
// ---------------------------------------------------------------------------

test('a superseded music search aborts the in-flight request signal', async () => {
  const { provider, pending } = pendingMusicProvider();
  const store = createStore();
  const controller = createSearchController(store, { music: provider, podcasts: stubPodcasts() });

  const first = controller.search('old', 'music');
  const second = controller.search('new', 'music');

  expect(pending[0]?.options?.signal?.aborted).toBe(true);
  expect(pending[1]?.options?.signal?.aborted).toBe(false);
  pending[1]?.resolve({ tracks: [track('new')], hasMore: false });
  await Promise.all([first, second]);
  await controller.dispose();
});

test('a newer search aborts an in-flight continuation signal', async () => {
  const { provider, pending } = pendingMusicProvider();
  const store = createStore();
  const controller = createSearchController(store, { music: provider, podcasts: stubPodcasts() });
  const { token, requests } = deferredContinuation();

  const initial = controller.search('base', 'music');
  pending[0]?.resolve({ tracks: [track('base')], hasMore: true, continuation: token });
  await initial;

  const page = controller.loadMore();
  const fresh = controller.search('fresh', 'music');
  expect(requests[0]?.signal?.aborted).toBe(true);
  pending[1]?.resolve({ tracks: [track('fresh')], hasMore: false });
  await Promise.all([page, fresh]);
  await controller.dispose();
});

test('superseded suggestions abort their in-flight signal', async () => {
  const captured: (AbortSignal | undefined)[] = [];
  const music: IProvider = {
    id: 'suggest-abort',
    name: 'Suggest abort',
    icon: '',
    search: async () => ({ tracks: [], hasMore: false }),
    getTrack: async (id) => track(id),
    getStreamUrl: async () => '',
    getSearchSuggestions: (_query, signal) => {
      captured.push(signal);
      return Promise.withResolvers<string[]>().promise;
    },
  };
  const store = createStore();
  const controller = createSearchController(store, { music, podcasts: stubPodcasts() });

  vi.useFakeTimers();
  try {
    controller.suggest('al');
    vi.advanceTimersByTime(260);
    controller.suggest('alph');
    vi.advanceTimersByTime(260);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.aborted).toBe(true);
    expect(captured[1]?.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
    await controller.dispose();
  }
});

test('dispose aborts in-flight music search and suggestion signals', async () => {
  const { provider, pending } = pendingMusicProvider();
  const suggestionSignals: (AbortSignal | undefined)[] = [];
  const music: IProvider = {
    ...provider,
    getSearchSuggestions: (_query, signal) => {
      suggestionSignals.push(signal);
      return Promise.withResolvers<string[]>().promise;
    },
  };
  const store = createStore();
  const controller = createSearchController(store, { music, podcasts: stubPodcasts() });

  vi.useFakeTimers();
  try {
    const search = controller.search('dispose-me', 'music');
    controller.suggest('dispose-me');
    vi.advanceTimersByTime(260);
    await controller.dispose();
    await search;
    expect(pending[0]?.options?.signal?.aborted).toBe(true);
    expect(suggestionSignals[0]?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

function podcast(id: string): Podcast {
  return { id, title: id, author: 'Test author', feedUrl: `https://example.test/${id}.xml` };
}

function stubMusic(): IProvider {
  return {
    id: 'stub',
    name: 'Stub',
    icon: '',
    search: async () => ({ tracks: [], hasMore: false }),
    getTrack: async (id) => track(id),
    getStreamUrl: async () => '',
  };
}

function stubPodcasts(): PodcastProvider {
  return new PodcastProvider(async () => new Response('{"results":[]}'));
}

function emptyFeed(): string {
  return '<rss version="2.0"><channel></channel></rss>';
}
