import { expect, test } from 'bun:test';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { createCatalogController, type CatalogController } from '../../src/application/catalog';
import type {
  AlbumDetail,
  AlbumSummary,
  ArtistDetail,
  CatalogContinuation,
  CatalogPage,
  IProvider,
  Track,
} from '../../src/providers/types';
import {
  catalogFrameAtom,
  catalogIndexAtom,
  catalogListLengthAtom,
  catalogSelectionAtom,
  catalogStateAtom,
} from '../../src/store/catalog';
import { musicViewAtom } from '../../src/store/ui';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const album = (id: string, title = id): AlbumSummary => ({
  id,
  title,
  artist: 'Daft Punk',
  artistId: 'UCdaft',
});

const track = (id: string, title = id): Track => ({
  id,
  provider: 'youtube',
  source: { kind: 'youtube', videoId: id },
  title,
  artist: 'Daft Punk',
  duration: 200,
});

const emptyPage = <T>(): CatalogPage<T> => ({ items: [], next: null, limitation: null });

interface ContinuationLog {
  key: string;
  signal: AbortSignal | undefined;
}

/**
 * A scripted continuation: each call records its signal and consumes the next
 * scripted response (a CatalogPage, or a thrown Error).
 */
function scripted<T>(
  key: string,
  script: Array<CatalogPage<T> | Error>,
): { continuation: CatalogContinuation<T>; log: ContinuationLog[] } {
  const log: ContinuationLog[] = [];
  const continuation: CatalogContinuation<T> = {
    key,
    next(signal) {
      log.push({ key, signal });
      const step = script.shift();
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step ?? emptyPage<T>());
    },
  };
  return { continuation, log };
}

function artistDetail(
  overrides: Partial<Pick<ArtistDetail, 'albums' | 'singles' | 'topTracks'>> = {},
): ArtistDetail {
  return {
    id: 'UCdaft',
    name: 'Daft Punk',
    thumbnailUrl: 'https://img.test/a.jpg',
    description: 'French electronic duo.',
    albums: {
      items: [album('MPR1', 'Discovery'), album('MPR2', 'Homework')],
      next: null,
      limitation: null,
    },
    singles: { items: [album('MPR3', 'Get Lucky')], next: null, limitation: null },
    topTracks: {
      items: [track('t1', 'One More Time'), track('t2', 'Harder')],
      next: null,
      limitation: null,
    },
    ...overrides,
  };
}

function albumDetail(overrides: Partial<Pick<AlbumDetail, 'tracks' | 'year'>> = {}): AlbumDetail {
  return {
    id: 'MPRram',
    title: 'Random Access Memories',
    artist: 'Daft Punk',
    artistId: 'UCdaft',
    year: 2013,
    tracks: {
      items: [track('v1', 'Give Life Back to Music'), track('v2', 'Giorgio')],
      next: null,
      limitation: null,
    },
    ...overrides,
  };
}

interface Harness {
  store: Store;
  controller: CatalogController;
  playback: {
    played: Track[][];
    enqueued: Track[][];
    playAlbum(loadTracks: (signal: AbortSignal) => Promise<readonly Track[]>): Promise<void>;
    enqueueMany(tracks: readonly Track[]): string[];
  };
  artistRequests: { id: string; signal: AbortSignal | undefined }[];
  albumRequests: { id: string; signal: AbortSignal | undefined }[];
}

type ArtistResponder = () => ArtistDetail | Error | Promise<ArtistDetail | Error>;
type AlbumResponder = () => AlbumDetail | Error | Promise<AlbumDetail | Error>;

function harness(
  artistRespond: ArtistResponder = () => artistDetail(),
  albumRespond: AlbumResponder = () => albumDetail(),
): Harness {
  const artistRequests: Harness['artistRequests'] = [];
  const albumRequests: Harness['albumRequests'] = [];
  const played: Track[][] = [];
  const enqueued: Track[][] = [];
  const music: IProvider = {
    id: 'youtube',
    name: 'YouTube Music',
    icon: '',
    search: async () => ({ tracks: [], hasMore: false }),
    getTrack: async (id) => track(id),
    getStreamUrl: async () => '',
    getArtist: (id, signal) => {
      artistRequests.push({ id, signal });
      return Promise.resolve(artistRespond()).then((detail) => {
        if (detail instanceof Error) throw detail;
        return detail;
      });
    },
    getAlbum: (id, signal) => {
      albumRequests.push({ id, signal });
      return Promise.resolve(albumRespond()).then((detail) => {
        if (detail instanceof Error) throw detail;
        return detail;
      });
    },
  };
  const playback = {
    played,
    enqueued,
    playAlbum(loadTracks: (signal: AbortSignal) => Promise<readonly Track[]>): Promise<void> {
      return loadTracks(new AbortController().signal).then((tracks) => {
        played.push([...tracks]);
      });
    },
    enqueueMany(tracks: readonly Track[]): string[] {
      enqueued.push([...tracks]);
      return tracks.map((_, index) => `entry-${enqueued.length}-${index}`);
    },
  };
  const store = createStore();
  const controller = createCatalogController(store, { music, playback });
  return { store, controller, playback, artistRequests, albumRequests };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('openArtist maps detail, collections and selectors from the provider page', async () => {
  const { store, controller } = harness();
  store.set(musicViewAtom, 'search');

  await controller.openArtist('UCdaft', { view: 'search', selectedIndex: 3 });

  expect(store.get(musicViewAtom)).toBe('catalog');
  const frame = store.get(catalogFrameAtom);

  expect(frame?.kind).toBe('artist');
  if (frame?.kind !== 'artist') return;
  expect(frame.detail?.name).toBe('Daft Punk');
  expect(frame.description).toBe('French electronic duo.');
  expect(frame.activeTab).toBe('albums');
  expect(frame.albums.items.map((entry) => entry.title)).toEqual(['Discovery', 'Homework']);
  expect(frame.singles.items.map((entry) => entry.title)).toEqual(['Get Lucky']);
  expect(frame.songs.items.map((entry) => entry.title)).toEqual(['One More Time', 'Harder']);
  expect(frame.error).toBeNull();

  expect(store.get(catalogListLengthAtom)).toBe(2);
  expect(store.get(catalogIndexAtom)).toBe(0);
  expect(store.get(catalogSelectionAtom)).toEqual({
    kind: 'album',
    album: album('MPR1', 'Discovery'),
  });

  controller.navigate('down');
  expect(store.get(catalogSelectionAtom)).toEqual({
    kind: 'album',
    album: album('MPR2', 'Homework'),
  });
  controller.changeTab('next');
  expect(store.get(catalogListLengthAtom)).toBe(1);
  expect(store.get(catalogSelectionAtom)).toEqual({
    kind: 'album',
    album: album('MPR3', 'Get Lucky'),
  });
  controller.changeTab('next');
  expect(store.get(catalogSelectionAtom)).toEqual({
    kind: 'track',
    track: track('t1', 'One More Time'),
  });
  controller.changeTab('previous');
  controller.changeTab('previous');
  // The albums selection made earlier (1) survives the tab round-trip.
  expect(store.get(catalogIndexAtom)).toBe(1);
});

test('providers without catalog support show an unavailable message, not a method error', async () => {
  const store = createStore();
  const music: IProvider = {
    id: 'stub',
    name: 'Stub',
    icon: '',
    search: async () => ({ tracks: [], hasMore: false }),
    getTrack: async (id) => track(id),
    getStreamUrl: async () => '',
  };
  const controller = createCatalogController(store, {
    music,
    playback: {
      playAlbum: async () => {},
      enqueueMany: () => [],
    },
  });

  await controller.openArtist('UCx');
  let frame = store.get(catalogFrameAtom);
  expect(frame?.kind).toBe('artist');
  if (frame?.kind === 'artist') {
    expect(frame.error).toBe('Stub does not support artist browsing.');
    expect(frame.albums.items).toEqual([]);
  }

  await controller.openAlbum('MPRx');
  frame = store.get(catalogFrameAtom);
  expect(frame?.kind).toBe('album');
  if (frame?.kind === 'album') expect(frame.error).toBe('Stub does not support album browsing.');
});

test('an initial transport failure is a retryable detail error', async () => {
  let fail = true;
  const { store, controller, artistRequests } = harness(() =>
    fail ? new Error('network down') : artistDetail(),
  );

  await controller.openArtist('UCdaft');
  let frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'artist') throw new Error('expected artist frame');
  expect(frame.error).toBe('network down');
  expect(frame.loading).toBe(false);

  fail = false;
  await controller.retry();
  expect(artistRequests).toHaveLength(2);
  frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'artist') throw new Error('expected artist frame');
  expect(frame.error).toBeNull();
  expect(frame.albums.items).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// Paging, cursors and failures
// ---------------------------------------------------------------------------

test('loadMore appends pages, replaces the cursor and retains it on failure', async () => {
  const failing = new Error('socket hang up');
  let attempts = 0;
  const { continuation, log } = scripted<AlbumSummary>('albums-page-2', []);
  const good = artistDetail({
    albums: { items: [album('MPR1')], next: continuation, limitation: null },
  });
  const pages = {
    failThen: null as CatalogPage<AlbumSummary> | null,
  };
  const { store, controller } = harness(() => good);
  // Re-script the continuation with stateful behavior via the shared handle.
  continuation.next = (signal) => {
    log.push({ key: 'albums-page-2', signal });
    attempts += 1;
    if (attempts === 1) return Promise.reject(failing);
    return Promise.resolve(
      pages.failThen ?? { items: [album('MPR9')], next: null, limitation: null },
    );
  };

  await controller.openArtist('UCdaft');
  if (store.get(catalogFrameAtom)?.kind !== 'artist') throw new Error('expected artist frame');

  await controller.loadMore();
  let frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'artist') throw new Error('expected artist frame');
  // Failure preserves loaded rows and the failed cursor, with a retry hint.
  expect(frame.albums.items.map((entry) => entry.id)).toEqual(['MPR1']);
  expect(frame.albums.error).toBe('socket hang up');
  expect(frame.albums.continuation).toBe(continuation);
  expect(frame.albums.loading).toBe(false);

  await controller.retry();
  frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'artist') throw new Error('expected artist frame');
  expect(attempts).toBe(2);
  expect(frame.albums.items.map((entry) => entry.id)).toEqual(['MPR1', 'MPR9']);
  expect(frame.albums.error).toBeNull();
  expect(frame.albums.continuation).toBeNull();
});

test('loadMore forwards the frame signal and late stale pages cannot write', async () => {
  const page2 = Promise.withResolvers<CatalogPage<AlbumSummary>>();
  const { continuation, log } = scripted<AlbumSummary>('cursor', []);
  continuation.next = (signal) => {
    log.push({ key: 'cursor', signal });
    return page2.promise;
  };
  const { store, controller } = harness(() =>
    artistDetail({ albums: { items: [album('MPR1')], next: continuation, limitation: null } }),
  );
  await controller.openArtist('UCdaft');

  const more = controller.loadMore();
  expect(log[0]?.signal).toBeDefined();

  // A pop aborts the frame's view work; the late page cannot write anywhere.
  controller.back();
  page2.resolve({ items: [album('MPR9')], next: null, limitation: null });
  await more;
  expect(store.get(catalogStateAtom).frames).toEqual([]);
});

test('unavailable sections are explicit limitations and survive without breaking others', async () => {
  const detail = artistDetail({
    singles: {
      items: [],
      next: null,
      limitation: {
        kind: 'unavailable',
        message: 'Singles & EPs are not available for this artist.',
      },
    },
  });
  const { store, controller } = harness(() => detail);
  await controller.openArtist('UCdaft');

  controller.changeTab('next');
  const frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'artist') throw new Error('expected artist frame');
  expect(frame.singles.limitation).toMatchObject({ kind: 'unavailable' });
  expect(frame.songs.items).toHaveLength(2);
});

test('limitations are sticky across successful appends', async () => {
  const { continuation } = scripted<AlbumSummary>('k', []);
  continuation.next = async () => ({
    items: [album('MPR9')],
    next: null,
    limitation: null,
  });
  const { store, controller } = harness(() =>
    artistDetail({
      albums: {
        items: [album('MPR1')],
        next: continuation,
        limitation: { kind: 'partial', message: 'Incomplete list: rows skipped.' },
      },
    }),
  );
  await controller.openArtist('UCdaft');
  await controller.loadMore();

  const frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'artist') throw new Error('expected artist frame');
  expect(frame.albums.items).toHaveLength(2);
  expect(frame.albums.limitation).toMatchObject({ kind: 'partial' });
});

// ---------------------------------------------------------------------------
// Back stack and ownership
// ---------------------------------------------------------------------------

test('drill-down keeps cached parents; back restores selection and tab without refetch', async () => {
  const { store, controller, artistRequests, albumRequests } = harness();
  await controller.openArtist('UCdaft', { view: 'library', selectedIndex: 5 });
  controller.navigate('down'); // albums selection → 1
  controller.changeTab('next'); // singles tab
  controller.navigate('down'); // singles selection → 1

  await controller.openAlbum('MPRram');

  expect(store.get(catalogStateAtom).frames).toHaveLength(2);
  expect(store.get(catalogStateAtom).returnTo).toEqual({ view: 'library', selectedIndex: 5 });
  const albumFrame = store.get(catalogFrameAtom);
  if (albumFrame?.kind !== 'album') throw new Error('expected album frame');
  expect(albumFrame.detail?.title).toBe('Random Access Memories');
  expect(albumFrame.year).toBe(2013);
  expect(store.get(catalogSelectionAtom)).toEqual({
    kind: 'track',
    track: track('v1', 'Give Life Back to Music'),
  });

  expect(controller.back()).toBeNull();
  const parent = store.get(catalogFrameAtom);
  if (parent?.kind !== 'artist') throw new Error('expected artist frame');
  expect(parent.activeTab).toBe('singles');
  // The singles list has one row, so the earlier move clamps to index 0.
  expect(parent.selections.singles).toBe(0);
  expect(parent.albums.items).toHaveLength(2);
  expect(store.get(catalogIndexAtom)).toBe(0);

  // No refetch happened while navigating back and forth.
  expect(artistRequests).toHaveLength(1);
  expect(albumRequests).toHaveLength(1);

  // Root pop hands the base view/index back and clears the stack.
  expect(controller.back()).toEqual({ view: 'library', selectedIndex: 5 });
  expect(store.get(catalogStateAtom).frames).toEqual([]);
  expect(controller.back()).toBeNull();
});

test('opening with a returnTo replaces the stack and aborts obsolete view work', async () => {
  const first = Promise.withResolvers<ArtistDetail>();
  let calls = 0;
  const { store, controller, artistRequests } = harness(() => {
    calls += 1;
    return calls === 1 ? first.promise : Promise.resolve(artistDetail());
  });
  const opening = controller.openArtist('UCa', { view: 'search', selectedIndex: 0 });
  void opening.catch(() => {});

  await controller.openArtist('UCb', { view: 'library', selectedIndex: 2 });
  expect(store.get(catalogStateAtom).frames).toHaveLength(1);
  if (store.get(catalogFrameAtom)?.kind !== 'artist') throw new Error('expected artist frame');

  // The aborted first load rejects (its provider call was aborted) and its
  // late data never lands.
  first.resolve(artistDetail());
  await settle();
  const frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'artist') throw new Error('expected artist frame');
  expect(frame.artistId).toBe('UCb');
  expect(artistRequests.map((request) => request.id)).toEqual(['UCa', 'UCb']);
  expect(artistRequests[0]?.signal?.aborted).toBe(true);
});

test('close clears the stack without touching the base view owner', async () => {
  const { store, controller } = harness();
  await controller.openArtist('UCdaft', { view: 'search', selectedIndex: 1 });
  controller.close();
  expect(store.get(catalogStateAtom)).toEqual({ frames: [], returnTo: null });
  expect(store.get(catalogFrameAtom)).toBeNull();
  expect(store.get(catalogSelectionAtom)).toBeNull();
});

test('navigate clamps to the loaded rows of the active collection', async () => {
  const { store, controller } = harness();
  await controller.openArtist('UCdaft');
  controller.navigate('up');
  expect(store.get(catalogIndexAtom)).toBe(0);
  controller.navigate('last');
  expect(store.get(catalogIndexAtom)).toBe(1);
  controller.navigate('down');
  expect(store.get(catalogIndexAtom)).toBe(1);
  controller.navigate('first');
  expect(store.get(catalogIndexAtom)).toBe(0);
});

// ---------------------------------------------------------------------------
// Whole-album actions
// ---------------------------------------------------------------------------

test('playAlbum collects every remaining page before playback mutation', async () => {
  const { continuation } = scripted<Track>('tracks-page-2', []);
  continuation.next = async () => ({
    items: [track('v3', 'Lose Yourself to Dance')],
    next: null,
    limitation: null,
  });
  const { store, controller, playback } = harness(
    () => artistDetail(),
    () =>
      albumDetail({
        tracks: { items: [track('v1'), track('v2')], next: continuation, limitation: null },
      }),
  );
  await controller.openAlbum('MPRram');

  await controller.playAlbum();
  expect(playback.played).toEqual([
    [track('v1'), track('v2'), track('v3', 'Lose Yourself to Dance')],
  ]);
  expect(playback.enqueued).toEqual([]);
  const frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'album') throw new Error('expected album frame');
  expect(frame.actionPending).toBeNull();
});

test('queueAlbum collects all pages and appends exactly one batch', async () => {
  const { continuation } = scripted<Track>('more', []);
  continuation.next = async () => ({ items: [track('v3')], next: null, limitation: null });
  const { store, controller, playback } = harness(
    () => artistDetail(),
    () =>
      albumDetail({
        tracks: { items: [track('v1'), track('v2')], next: continuation, limitation: null },
      }),
  );
  await controller.openAlbum('MPRram');

  await controller.queueAlbum();
  expect(playback.played).toEqual([]);
  expect(playback.enqueued).toEqual([[track('v1'), track('v2'), track('v3')]]);
  const frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'album') throw new Error('expected album frame');
  expect(frame.actionPending).toBeNull();
});

test('incomplete album data disables whole-album actions', async () => {
  const { controller, playback } = harness(
    () => artistDetail(),
    () =>
      albumDetail({
        tracks: {
          items: [track('v1')],
          next: null,
          limitation: {
            kind: 'partial',
            message: 'Incomplete list: rows without a stable ID were skipped.',
          },
        },
      }),
  );
  await controller.openAlbum('MPRram');

  await controller.playAlbum();
  await controller.queueAlbum();
  expect(playback.played).toEqual([]);
  expect(playback.enqueued).toEqual([]);
});

test('duplicate submissions are suppressed while the same album action is pending', async () => {
  const gate = Promise.withResolvers<CatalogPage<Track>>();
  const { continuation } = scripted<Track>('slow', []);
  continuation.next = () => gate.promise;
  const { store, controller, playback } = harness(
    () => artistDetail(),
    () => albumDetail({ tracks: { items: [track('v1')], next: continuation, limitation: null } }),
  );
  await controller.openAlbum('MPRram');

  const playing = controller.playAlbum();
  const frameDuring = store.get(catalogFrameAtom);
  if (frameDuring?.kind !== 'album') throw new Error('expected album frame');
  expect(frameDuring.actionPending).toBe('play');

  await controller.queueAlbum();
  await controller.playAlbum();
  expect(playback.played).toEqual([]);
  expect(playback.enqueued).toEqual([]);

  gate.resolve({ items: [track('v2')], next: null, limitation: null });
  await playing;
  expect(playback.played).toEqual([[track('v1'), track('v2')]]);

  // A later explicit repeat is allowed.
  await controller.queueAlbum();
  expect(playback.enqueued).toEqual([[track('v1'), track('v2')]]);
});

test('an incomplete page during collection leaves playback untouched', async () => {
  const { continuation } = scripted<Track>('partial', []);
  continuation.next = async () => ({
    items: [track('v2')],
    next: null,
    limitation: { kind: 'partial', message: 'Incomplete list: the continuation repeated.' },
  });
  const { controller, playback } = harness(
    () => artistDetail(),
    () => albumDetail({ tracks: { items: [track('v1')], next: continuation, limitation: null } }),
  );
  await controller.openAlbum('MPRram');

  await expect(controller.playAlbum()).rejects.toThrow('incomplete');
  expect(playback.played).toEqual([]);
  expect(playback.enqueued).toEqual([]);
});

test('navigation cannot redirect an explicit album action to another album', async () => {
  const gate = Promise.withResolvers<CatalogPage<Track>>();
  const { continuation } = scripted<Track>('slow', []);
  continuation.next = () => gate.promise;
  const { store, controller, playback } = harness(
    () => artistDetail(),
    () => albumDetail({ tracks: { items: [track('v1')], next: continuation, limitation: null } }),
  );
  await controller.openArtist('UCdaft', { view: 'search', selectedIndex: 0 });
  await controller.openAlbum('MPRram');

  const playing = controller.playAlbum();
  controller.back(); // pop to the artist frame while collecting
  expect(store.get(catalogFrameAtom)?.kind).toBe('artist');

  gate.resolve({ items: [track('v2')], next: null, limitation: null });
  await playing;
  // The captured album's pages are what plays, not the newly visible artist.
  expect(playback.played).toEqual([[track('v1'), track('v2')]]);
});

test('loadMore is refused while an album action is collecting pages', async () => {
  const gate = Promise.withResolvers<CatalogPage<Track>>();
  const moreLog: unknown[] = [];
  const { continuation } = scripted<Track>('slow', []);
  continuation.next = () => {
    moreLog.push('called');
    return gate.promise;
  };
  const { store, controller } = harness(
    () => artistDetail(),
    () => albumDetail({ tracks: { items: [track('v1')], next: continuation, limitation: null } }),
  );
  await controller.openAlbum('MPRram');

  const playing = controller.playAlbum();
  // The collector's own first page fetch starts immediately.
  expect(moreLog).toEqual(['called']);
  await controller.loadMore();
  // loadMore must not add a second concurrent collection from the same cursor.
  expect(moreLog).toEqual(['called']);

  gate.resolve({ items: [track('v2')], next: null, limitation: null });
  await playing;
  const frame = store.get(catalogFrameAtom);
  if (frame?.kind !== 'album') throw new Error('expected album frame');
  expect(frame.tracks.items).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

test('dispose aborts in-flight view work, clears state and drains jobs', async () => {
  const pending = Promise.withResolvers<ArtistDetail>();
  const signals: (AbortSignal | undefined)[] = [];
  const store = createStore();
  const music: IProvider = {
    id: 'youtube',
    name: 'YouTube Music',
    icon: '',
    search: async () => ({ tracks: [], hasMore: false }),
    getTrack: async (id) => track(id),
    getStreamUrl: async () => '',
    getArtist: (_id, signal) => {
      signals.push(signal);
      const { promise, reject } = Promise.withResolvers<ArtistDetail>();
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      return promise;
    },
  };
  const controller = createCatalogController(store, {
    music,
    playback: { playAlbum: async () => {}, enqueueMany: () => [] },
  });
  const opening = controller.openArtist('UCdaft', { view: 'search', selectedIndex: 0 });
  void opening.catch(() => {});

  await controller.dispose();
  expect(signals[0]?.aborted).toBe(true);
  expect(store.get(catalogStateAtom)).toEqual({ frames: [], returnTo: null });

  pending.resolve(artistDetail());
  await settle();
  // Late data never repopulates a disposed controller.
  expect(store.get(catalogStateAtom).frames).toEqual([]);
});

test('dispose aborts and drains a pending whole-album action without mutating the queue', async () => {
  const gate = Promise.withResolvers<CatalogPage<Track>>();
  const { continuation } = scripted<Track>('slow', []);
  continuation.next = (signal) => {
    const { promise, reject } = Promise.withResolvers<CatalogPage<Track>>();
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    void gate.promise.then(
      () => reject(new Error('unexpected completion')),
      () => reject(new Error('gate failed')),
    );
    return promise;
  };
  const { store, controller, playback } = harness(
    () => artistDetail(),
    () => albumDetail({ tracks: { items: [track('v1')], next: continuation, limitation: null } }),
  );
  await controller.openAlbum('MPRram');

  const queueing = controller.queueAlbum();
  void queueing.catch(() => {});
  await controller.dispose();

  // Disposal intentionally cancels the collection; only the no-mutation
  // contract is asserted, not the abort reason's wording.
  await expect(queueing).rejects.toThrow();
  expect(playback.enqueued).toEqual([]);
  expect(store.get(catalogStateAtom)).toEqual({ frames: [], returnTo: null });
});
