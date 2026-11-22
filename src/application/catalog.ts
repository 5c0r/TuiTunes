import type { Store } from 'jotai/vanilla/store';
import type { PlaybackSession } from './playback';
import type { AlbumSummary, CatalogPage, IProvider, Track } from '../providers/types';
import {
  catalogStateAtom,
  type CatalogAlbumFrame,
  type CatalogArtistFrame,
  type CatalogCollection,
  type CatalogCollectionState,
  type CatalogFrame,
  type CatalogReturn,
} from '../store/catalog';
import { musicViewAtom, type MusicView } from '../store/ui';
import { Logger } from '../utils/logger';

export type { CatalogReturn } from '../store/catalog';

/**
 * Narrow playback surface the catalog needs: batch enqueue and the album
 * playback intent that reserves ownership before collecting pages.
 */
export type CatalogPlayback = Pick<PlaybackSession, 'enqueueMany' | 'playAlbum'>;

export interface CatalogController {
  openArtist(id: string, returnTo?: CatalogReturn): Promise<void>;
  openAlbum(id: string, returnTo?: CatalogReturn): Promise<void>;
  navigate(direction: 'up' | 'down' | 'first' | 'last' | number): void;
  changeTab(direction: 'next' | 'previous' | CatalogCollection): void;
  loadMore(): Promise<void>;
  retry(): Promise<void>;
  /** Returns the base view/index when the root frame is popped, else null. */
  back(): CatalogReturn | null;
  /** Clears the stack and its view jobs; the caller owns the view switch. */
  close(): void;
  playAlbum(): Promise<void>;
  queueAlbum(): Promise<void>;
  dispose(): Promise<void>;
}

/** Collection slots on either frame kind. */
type CollectionSlot = 'albums' | 'singles' | 'songs' | 'tracks';

const ARTIST_TAB_ORDER: readonly CatalogCollection[] = ['albums', 'singles', 'songs'];

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function emptyCollection<T>(): CatalogCollectionState<T> {
  return {
    items: [],
    continuation: null,
    limitation: null,
    loading: false,
    error: null,
    generation: 0,
  };
}

/**
 * Owns catalog detail frames and their view jobs. Every request is bound to
 * frame ID and generation; push/pop/close abort obsolete work and late results
 * can never replace a newer frame or clear another frame's loading state.
 * Explicit album play/add captures the album at action time and is never
 * redirected to another album by navigation.
 */
export function createCatalogController(
  store: Store,
  deps: { music: IProvider; playback: CatalogPlayback },
): CatalogController {
  let disposed = false;
  let frameSeq = 0;
  const jobs = new Set<Promise<void>>();
  const viewControllers = new Map<string, AbortController>();
  const actionControllers = new Set<AbortController>();
  let albumActionInFlight = false;

  // -- frame plumbing -------------------------------------------------------

  function topFrame(): CatalogFrame | null {
    const frames = store.get(catalogStateAtom).frames;
    return frames.length > 0 ? frames[frames.length - 1] : null;
  }

  function findFrame(frameId: string): CatalogFrame | null {
    return store.get(catalogStateAtom).frames.find((frame) => frame.frameId === frameId) ?? null;
  }

  function updateFrame(frameId: string, update: (frame: CatalogFrame) => CatalogFrame): void {
    store.set(catalogStateAtom, (state) =>
      state.frames.some((frame) => frame.frameId === frameId)
        ? {
            ...state,
            frames: state.frames.map((frame) =>
              frame.frameId === frameId ? update(frame) : frame,
            ),
          }
        : state,
    );
  }

  function abortFrame(frameId: string): void {
    viewControllers.get(frameId)?.abort();
    viewControllers.delete(frameId);
  }

  function abortAllFrames(): void {
    for (const controller of viewControllers.values()) controller.abort();
    viewControllers.clear();
  }

  /** One abort scope per frame; recreated after retry so a new load can run. */
  function frameController(frameId: string): AbortController {
    let controller = viewControllers.get(frameId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      viewControllers.set(frameId, controller);
    }
    return controller;
  }

  function trackJob(job: Promise<void>): void {
    jobs.add(job);
    // Release on either outcome without leaving a rejected finally-chain.
    const release = () => {
      jobs.delete(job);
    };
    void job.then(release, release);
  }

  function defaultReturnTo(): CatalogReturn {
    const view: MusicView = store.get(musicViewAtom);
    return { view: view === 'catalog' ? 'search' : view, selectedIndex: 0 };
  }

  function pushFrame(frame: CatalogFrame, returnTo: CatalogReturn | undefined): void {
    if (returnTo) {
      // Opening from a base list replaces the stack; obsolete view work aborts.
      abortAllFrames();
      store.set(catalogStateAtom, { frames: [frame], returnTo });
      return;
    }
    // Drilling down keeps cached loaded parent frames and the base return.
    store.set(catalogStateAtom, (state) => ({
      frames: [...state.frames, frame],
      returnTo: state.returnTo ?? defaultReturnTo(),
    }));
  }

  // -- collection plumbing --------------------------------------------------

  function collectionSlot(frame: CatalogFrame): CollectionSlot {
    if (frame.kind === 'album') return 'tracks';
    return frame.activeTab;
  }

  function collectionState(
    frame: CatalogFrame,
    slot: CollectionSlot,
  ): CatalogCollectionState<AlbumSummary | Track> | null {
    switch (slot) {
      case 'albums':
        return frame.kind === 'artist' ? frame.albums : null;
      case 'singles':
        return frame.kind === 'artist' ? frame.singles : null;
      case 'songs':
        return frame.kind === 'artist' ? frame.songs : null;
      case 'tracks':
        return frame.kind === 'album' ? frame.tracks : null;
    }
  }

  /** Field-only patch shared by every collection element type. */
  function patchCollectionFlags(
    frame: CatalogFrame,
    slot: CollectionSlot,
    flags: { loading?: boolean; error?: string | null; generation?: number },
  ): CatalogFrame {
    switch (slot) {
      case 'albums':
        return frame.kind === 'artist'
          ? { ...frame, albums: { ...frame.albums, ...flags } }
          : frame;
      case 'singles':
        return frame.kind === 'artist'
          ? { ...frame, singles: { ...frame.singles, ...flags } }
          : frame;
      case 'songs':
        return frame.kind === 'artist' ? { ...frame, songs: { ...frame.songs, ...flags } } : frame;
      case 'tracks':
        return frame.kind === 'album' ? { ...frame, tracks: { ...frame.tracks, ...flags } } : frame;
    }
  }

  function mergePage<T>(
    state: CatalogCollectionState<T>,
    page: CatalogPage<T>,
    generation: number,
  ): CatalogCollectionState<T> {
    return {
      ...state,
      items: [...state.items, ...page.items],
      continuation: page.next,
      // Limitations are sticky: rows that could not be mapped never come back.
      limitation: state.limitation ?? page.limitation,
      loading: false,
      error: null,
      generation,
    };
  }

  /** Apply a fetched page only while the slot and generation still match. */
  function applyPage(
    frame: CatalogFrame,
    slot: CollectionSlot,
    page: CatalogPage<AlbumSummary | Track>,
    generation: number,
  ): CatalogFrame {
    const state = collectionState(frame, slot);
    if (!state || state.generation !== generation) return frame;
    switch (slot) {
      case 'albums':
        return frame.kind === 'artist'
          ? {
              ...frame,
              albums: mergePage(frame.albums, page as CatalogPage<AlbumSummary>, generation),
            }
          : frame;
      case 'singles':
        return frame.kind === 'artist'
          ? {
              ...frame,
              singles: mergePage(frame.singles, page as CatalogPage<AlbumSummary>, generation),
            }
          : frame;
      case 'songs':
        return frame.kind === 'artist'
          ? { ...frame, songs: mergePage(frame.songs, page as CatalogPage<Track>, generation) }
          : frame;
      case 'tracks':
        return frame.kind === 'album'
          ? { ...frame, tracks: mergePage(frame.tracks, page as CatalogPage<Track>, generation) }
          : frame;
    }
  }

  function pageToCollection<T>(
    page: CatalogPage<T>,
    generation: number,
  ): CatalogCollectionState<T> {
    return {
      items: page.items,
      continuation: page.next,
      limitation: page.limitation,
      loading: false,
      error: null,
      generation,
    };
  }

  /** Keep already loaded collections on detail retry; refresh empty ones. */
  function mergeCollection<T>(
    existing: CatalogCollectionState<T>,
    fresh: CatalogPage<T>,
  ): CatalogCollectionState<T> {
    if (existing.items.length > 0 || existing.continuation) {
      return { ...existing, loading: false, error: null };
    }
    return pageToCollection(fresh, existing.generation);
  }

  // -- detail loading -------------------------------------------------------

  async function loadArtistDetail(frameId: string, artistId: string): Promise<void> {
    const current = findFrame(frameId);
    if (!current || current.kind !== 'artist') return;
    const controller = frameController(frameId);
    const generation = current.detailGeneration + 1;
    updateFrame(frameId, (frame) =>
      frame.kind === 'artist'
        ? { ...frame, loading: true, error: null, detailGeneration: generation }
        : frame,
    );
    const fetchArtist = deps.music.getArtist;
    if (!fetchArtist) {
      updateFrame(frameId, (frame) =>
        frame.kind === 'artist' &&
        frame.detailGeneration === generation &&
        !controller.signal.aborted
          ? {
              ...frame,
              loading: false,
              error: `${deps.music.name} does not support artist browsing.`,
            }
          : frame,
      );
      return;
    }
    try {
      const detail = await fetchArtist.call(deps.music, artistId, controller.signal);
      updateFrame(frameId, (frame) => {
        if (
          frame.kind !== 'artist' ||
          frame.detailGeneration !== generation ||
          controller.signal.aborted
        ) {
          return frame;
        }
        return {
          ...frame,
          loading: false,
          error: null,
          detail: { id: detail.id, name: detail.name, thumbnailUrl: detail.thumbnailUrl },
          description: detail.description ?? null,
          albums: mergeCollection(frame.albums, detail.albums),
          singles: mergeCollection(frame.singles, detail.singles),
          songs: mergeCollection(frame.songs, detail.topTracks),
        };
      });
    } catch (value) {
      if (controller.signal.aborted) return;
      updateFrame(frameId, (frame) =>
        frame.kind === 'artist' && frame.detailGeneration === generation
          ? { ...frame, loading: false, error: errorMessage(value) }
          : frame,
      );
    }
  }

  async function loadAlbumDetail(frameId: string, albumId: string): Promise<void> {
    const current = findFrame(frameId);
    if (!current || current.kind !== 'album') return;
    const controller = frameController(frameId);
    const generation = current.detailGeneration + 1;
    updateFrame(frameId, (frame) =>
      frame.kind === 'album'
        ? { ...frame, loading: true, error: null, detailGeneration: generation }
        : frame,
    );
    const fetchAlbum = deps.music.getAlbum;
    if (!fetchAlbum) {
      updateFrame(frameId, (frame) =>
        frame.kind === 'album' &&
        frame.detailGeneration === generation &&
        !controller.signal.aborted
          ? {
              ...frame,
              loading: false,
              error: `${deps.music.name} does not support album browsing.`,
            }
          : frame,
      );
      return;
    }
    try {
      const detail = await fetchAlbum.call(deps.music, albumId, controller.signal);
      updateFrame(frameId, (frame) => {
        if (
          frame.kind !== 'album' ||
          frame.detailGeneration !== generation ||
          controller.signal.aborted
        ) {
          return frame;
        }
        return {
          ...frame,
          loading: false,
          error: null,
          detail: {
            id: detail.id,
            title: detail.title,
            artist: detail.artist,
            artistId: detail.artistId,
            thumbnailUrl: detail.thumbnailUrl,
          },
          year: detail.year ?? null,
          tracks: mergeCollection(frame.tracks, detail.tracks),
        };
      });
    } catch (value) {
      if (controller.signal.aborted) return;
      updateFrame(frameId, (frame) =>
        frame.kind === 'album' && frame.detailGeneration === generation
          ? { ...frame, loading: false, error: errorMessage(value) }
          : frame,
      );
    }
  }

  // -- continuation loading -------------------------------------------------

  async function continueInto(
    frameId: string,
    slot: CollectionSlot,
    continuation: NonNullable<CatalogCollectionState<AlbumSummary | Track>['continuation']>,
    generation: number,
  ): Promise<void> {
    const controller = frameController(frameId);
    updateFrame(frameId, (frame) =>
      patchCollectionFlags(frame, slot, { generation, loading: true, error: null }),
    );
    try {
      // The provider retains the cursor for retry when this rejects.
      const page = await continuation.next(controller.signal);
      if (controller.signal.aborted) return;
      updateFrame(frameId, (frame) => applyPage(frame, slot, page, generation));
    } catch (value) {
      if (controller.signal.aborted) return;
      updateFrame(frameId, (frame) =>
        patchCollectionFlags(frame, slot, {
          generation,
          loading: false,
          error: errorMessage(value),
        }),
      );
    }
  }

  // -- whole-album actions --------------------------------------------------

  /**
   * Collect every remaining page of the captured album before any queue
   * mutation. A failed, cancelled, incomplete or cyclic collection throws and
   * leaves the queue untouched; playback.playAlbum owns the intent reservation
   * and aborts this collector when a newer playback intent arrives.
   */
  async function runAlbumAction(action: 'play' | 'queue'): Promise<void> {
    if (disposed || albumActionInFlight) return;
    const frame = topFrame();
    if (!frame || frame.kind !== 'album' || frame.actionPending !== null) return;
    const tracks = frame.tracks;
    if (tracks.loading || tracks.limitation !== null || tracks.items.length === 0) {
      Logger.warn(
        tracks.limitation
          ? `Album action unavailable: ${tracks.limitation.message}`
          : 'Album action unavailable: track list is not loaded.',
      );
      return;
    }
    albumActionInFlight = true;
    updateFrame(frame.frameId, (current) =>
      current.kind === 'album' ? { ...current, actionPending: action } : current,
    );
    const actionController = new AbortController();
    actionControllers.add(actionController);
    const firstPage: readonly Track[] = tracks.items;
    const remaining = tracks.continuation;
    const load = async (signal: AbortSignal): Promise<readonly Track[]> => {
      // The play collector also observes the controller's abort scope, so
      // disposal cancels it even while playback owns the intent signal.
      const effective = AbortSignal.any([signal, actionController.signal]);
      const collected: Track[] = [...firstPage];
      let cursor = remaining;
      while (cursor !== null) {
        const page = await cursor.next(effective);
        if (page.limitation !== null) {
          throw new Error(`Album data is incomplete: ${page.limitation.message}`);
        }
        collected.push(...page.items);
        cursor = page.next;
      }
      if (collected.length === 0) throw new Error('Album has no playable tracks.');
      return collected;
    };
    try {
      if (action === 'play') {
        await deps.playback.playAlbum(load);
      } else {
        const collected = await load(actionController.signal);
        if (disposed || actionController.signal.aborted) return;
        deps.playback.enqueueMany(collected);
      }
    } finally {
      actionControllers.delete(actionController);
      actionController.abort();
      albumActionInFlight = false;
      updateFrame(frame.frameId, (current) =>
        current.kind === 'album' && current.actionPending === action
          ? { ...current, actionPending: null }
          : current,
      );
    }
  }

  // -- controller surface ---------------------------------------------------

  function openFrame(
    frame: CatalogFrame,
    returnTo: CatalogReturn | undefined,
    load: () => Promise<void>,
  ): Promise<void> {
    if (disposed) return Promise.resolve();
    pushFrame(frame, returnTo);
    store.set(musicViewAtom, 'catalog');
    const job = load();
    trackJob(job);
    return job;
  }

  return {
    openArtist(id, returnTo) {
      const frameId = `catalog-artist-${++frameSeq}`;
      const frame: CatalogArtistFrame = {
        kind: 'artist',
        frameId,
        artistId: id,
        detail: null,
        description: null,
        activeTab: 'albums',
        selections: { albums: 0, singles: 0, songs: 0 },
        albums: emptyCollection(),
        singles: emptyCollection(),
        songs: emptyCollection(),
        loading: true,
        error: null,
        detailGeneration: 0,
      };
      return openFrame(frame, returnTo, () => loadArtistDetail(frameId, id));
    },

    openAlbum(id, returnTo) {
      const frameId = `catalog-album-${++frameSeq}`;
      const frame: CatalogAlbumFrame = {
        kind: 'album',
        frameId,
        albumId: id,
        detail: null,
        year: null,
        selectedIndex: 0,
        tracks: emptyCollection(),
        loading: true,
        error: null,
        detailGeneration: 0,
        actionPending: null,
      };
      return openFrame(frame, returnTo, () => loadAlbumDetail(frameId, id));
    },

    navigate(direction) {
      if (disposed) return;
      const frame = topFrame();
      if (!frame) return;
      updateFrame(frame.frameId, (current) => {
        const length = collectionState(current, collectionSlot(current))?.items.length ?? 0;
        const position =
          current.kind === 'artist' ? current.selections[current.activeTab] : current.selectedIndex;
        const moved =
          typeof direction === 'number'
            ? direction
            : direction === 'first'
              ? 0
              : direction === 'last'
                ? length - 1
                : position + (direction === 'down' ? 1 : -1);
        const clamped = Math.max(0, Math.min(moved, Math.max(0, length - 1)));
        if (current.kind === 'album') return { ...current, selectedIndex: clamped };
        return { ...current, selections: { ...current.selections, [current.activeTab]: clamped } };
      });
    },

    changeTab(direction) {
      if (disposed) return;
      const frame = topFrame();
      if (!frame || frame.kind !== 'artist') return;
      const index = ARTIST_TAB_ORDER.indexOf(frame.activeTab);
      const offset = direction === 'next' ? 1 : -1;
      const next =
        direction === 'next' || direction === 'previous'
          ? ARTIST_TAB_ORDER[(index + offset + ARTIST_TAB_ORDER.length) % ARTIST_TAB_ORDER.length]
          : direction;
      if (next === frame.activeTab) return;
      updateFrame(frame.frameId, (current) =>
        current.kind === 'artist' ? { ...current, activeTab: next } : current,
      );
    },

    loadMore() {
      if (disposed) return Promise.resolve();
      const frame = topFrame();
      if (!frame) return Promise.resolve();
      const slot = collectionSlot(frame);
      const current = frame && collectionState(frame, slot);
      if (!current || current.loading || !current.continuation) return Promise.resolve();
      if (frame.kind === 'album' && frame.actionPending !== null) return Promise.resolve();
      const job = continueInto(frame.frameId, slot, current.continuation, current.generation + 1);
      trackJob(job);
      return job;
    },

    retry() {
      if (disposed) return Promise.resolve();
      const frame = topFrame();
      if (!frame) return Promise.resolve();
      if (frame.error !== null) {
        const reload =
          frame.kind === 'artist'
            ? loadArtistDetail(frame.frameId, frame.artistId)
            : loadAlbumDetail(frame.frameId, frame.albumId);
        trackJob(reload);
        return reload;
      }
      const state = collectionState(frame, collectionSlot(frame));
      if (state && state.error !== null) return this.loadMore();
      if (state && state.items.length === 0 && state.limitation !== null && !state.loading) {
        const reload =
          frame.kind === 'artist'
            ? loadArtistDetail(frame.frameId, frame.artistId)
            : loadAlbumDetail(frame.frameId, frame.albumId);
        trackJob(reload);
        return reload;
      }
      return this.loadMore();
    },

    back() {
      const state = store.get(catalogStateAtom);
      if (state.frames.length === 0) return null;
      abortFrame(state.frames[state.frames.length - 1].frameId);
      const frames = state.frames.slice(0, -1);
      // The root pop hands the base view/index back; drilling pops return null.
      const returnTo = frames.length === 0 ? state.returnTo : null;
      store.set(catalogStateAtom, {
        frames,
        returnTo: frames.length === 0 ? null : state.returnTo,
      });
      return returnTo;
    },

    close() {
      abortAllFrames();
      store.set(catalogStateAtom, { frames: [], returnTo: null });
    },

    playAlbum() {
      const job = runAlbumAction('play');
      trackJob(job);
      return job;
    },

    queueAlbum() {
      const job = runAlbumAction('queue');
      trackJob(job);
      return job;
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      abortAllFrames();
      for (const controller of actionControllers) controller.abort();
      store.set(catalogStateAtom, { frames: [], returnTo: null });
      await Promise.allSettled([...jobs]);
      jobs.clear();
    },
  };
}
