import { atom } from 'jotai';
import type { AlbumSummary, ArtistSummary, CatalogContinuation, Track } from '../providers/types';
import type { MusicView } from './ui';

/**
 * Catalog feature 11 state: a stack of uniquely identified artist/album
 * detail frames plus the base view to restore when the root frame is popped.
 * Search keeps owning transient queries and search continuations; this module
 * owns persistent detail pages and their independent release/song cursors.
 */

/** Where to return when the catalog root frame is popped. */
export interface CatalogReturn {
  view: Exclude<MusicView, 'catalog'>;
  selectedIndex: number;
}

/** Artist detail tabs; each tab owns one independently paged collection. */
export type CatalogCollection = 'albums' | 'singles' | 'songs';

/** Provider-reported incompleteness of a collection. */
export type CatalogLimitation = { kind: 'partial' | 'unavailable'; message: string };

/**
 * One accumulated collection: loaded rows, the retained continuation cursor
 * (kept on failure for retry), provider limitation, and request generation.
 */
export interface CatalogCollectionState<T> {
  items: T[];
  continuation: CatalogContinuation<T> | null;
  limitation: CatalogLimitation | null;
  /** More rows are being fetched (initial page or continuation). */
  loading: boolean;
  /** Last continuation failure message; the cursor is retained for retry. */
  error: string | null;
  /** Bumped before every request; late results with an older value are dropped. */
  generation: number;
}

export interface CatalogArtistFrame {
  kind: 'artist';
  frameId: string;
  artistId: string;
  detail: ArtistSummary | null;
  description: string | null;
  /** Default tab is Albums. */
  activeTab: CatalogCollection;
  /** Selection retained per tab. */
  selections: Record<CatalogCollection, number>;
  albums: CatalogCollectionState<AlbumSummary>;
  singles: CatalogCollectionState<AlbumSummary>;
  songs: CatalogCollectionState<Track>;
  /** Whole-page (metadata + first pages) load in progress. */
  loading: boolean;
  /** Retryable detail-page transport failure. */
  error: string | null;
  detailGeneration: number;
}

export interface CatalogAlbumFrame {
  kind: 'album';
  frameId: string;
  albumId: string;
  detail: AlbumSummary | null;
  year: number | null;
  selectedIndex: number;
  tracks: CatalogCollectionState<Track>;
  loading: boolean;
  error: string | null;
  detailGeneration: number;
  /** A whole-album play/queue job is collecting the remaining pages. */
  actionPending: null | 'play' | 'queue';
}

export type CatalogFrame = CatalogArtistFrame | CatalogAlbumFrame;

export interface CatalogState {
  /** Root-first stack; the last frame is visible. */
  frames: CatalogFrame[];
  returnTo: CatalogReturn | null;
}

export const catalogStateAtom = atom<CatalogState>({ frames: [], returnTo: null });

/** The visible (top-of-stack) catalog frame, or null when closed. */
export const catalogFrameAtom = atom<CatalogFrame | null>((get) => {
  const frames = get(catalogStateAtom).frames;
  return frames.length > 0 ? frames[frames.length - 1] : null;
});

/** Selection index within the visible frame's active collection. */
export const catalogIndexAtom = atom<number>((get) => {
  const frame = get(catalogFrameAtom);
  if (!frame) return 0;
  return frame.kind === 'artist' ? frame.selections[frame.activeTab] : frame.selectedIndex;
});

/** Row count of the visible frame's active collection. */
export const catalogListLengthAtom = atom<number>((get) => {
  const frame = get(catalogFrameAtom);
  if (!frame) return 0;
  if (frame.kind === 'album') return frame.tracks.items.length;
  return (
    frame.activeTab === 'albums'
      ? frame.albums
      : frame.activeTab === 'singles'
        ? frame.singles
        : frame.songs
  ).items.length;
});

/**
 * The visible selected row: an album card on release tabs, an actual Track on
 * song tabs and album track lists. Album cards are a distinct selection kind,
 * never fake Tracks.
 */
export type CatalogSelection =
  | { kind: 'track'; track: Track }
  | { kind: 'album'; album: AlbumSummary };

export const catalogSelectionAtom = atom<CatalogSelection | null>((get) => {
  const frame = get(catalogFrameAtom);
  if (!frame) return null;
  if (frame.kind === 'album') {
    const track = frame.tracks.items[frame.selectedIndex];
    return track ? { kind: 'track', track } : null;
  }
  const index = frame.selections[frame.activeTab];
  if (frame.activeTab === 'songs') {
    const track = frame.songs.items[index];
    return track ? { kind: 'track', track } : null;
  }
  const item = (frame.activeTab === 'albums' ? frame.albums : frame.singles).items[index];
  return item ? { kind: 'album', album: item } : null;
});
