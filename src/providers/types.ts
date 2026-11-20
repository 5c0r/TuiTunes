import type { Episode } from './podcast-types';

export type TrackSource =
  | { kind: 'youtube'; videoId: string }
  | { kind: 'podcast'; episode: Episode };
/**
 * Per-episode playback-source policy. `auto` is the default (no stored row);
 * the other modes record an explicit user choice for future playback.
 */
export type PlaybackSourcePreference =
  | { mode: 'auto' }
  | { mode: 'rss' }
  | { mode: 'youtube-match' }
  | { mode: 'youtube-video'; videoId: string };
/** How a resolved source was chosen; part of the cached resolution, not its identity. */
export type PlaybackSourceSelection = PlaybackSourcePreference['mode'];
export type ResolvedPlaybackSource =
  | { kind: 'youtube'; url: string; videoId: string; selection: PlaybackSourceSelection }
  | { kind: 'rss'; url: string; transcriptUrl?: string; selection: PlaybackSourceSelection };
export interface PlaybackTarget {
  track: Track;
  source: ResolvedPlaybackSource;
  requestId: number;
  origin: { kind: 'direct' } | { kind: 'queue'; entryId: string };
}

export interface Track {
  id: string;
  provider: string;
  source: TrackSource | null;
  resolvedSource?: ResolvedPlaybackSource;
  title: string;
  artist: string;
  album?: string;
  /** Provider browse ID of the primary artist, when the provider supplies one. */
  artistId?: string;
  /** Provider browse ID of the release, when the provider supplies one. */
  albumId?: string;
  duration: number;
  thumbnailUrl?: string;
}

/** Cursor for paged catalog collections; opaque, never persisted. */
export interface CatalogContinuation<T> {
  readonly key: string;
  next(signal?: AbortSignal): Promise<CatalogPage<T>>;
}
export interface CatalogPage<T> {
  items: T[];
  next: CatalogContinuation<T> | null;
  limitation: null | { kind: 'partial' | 'unavailable'; message: string };
}

export interface SearchContinuation {
  next(signal?: AbortSignal): Promise<SearchResult>;
}

export interface SearchResult {
  tracks: Track[];
  albums?: AlbumSummary[];
  artists?: ArtistSummary[];
  playlists?: PlaylistSummary[];
  hasMore: boolean;
  continuation?: SearchContinuation;
}

export interface SearchOptions {
  type?: 'all' | 'song' | 'album' | 'artist' | 'playlist';
  continuation?: SearchContinuation;
  signal?: AbortSignal;
}

export interface AlbumSummary {
  id: string;
  title: string;
  artist: string;
  /** Browse ID of the album's primary artist, when the provider supplies one. */
  artistId?: string;
  thumbnailUrl?: string;
}

export interface ArtistSummary {
  id: string;
  name: string;
  thumbnailUrl?: string;
}

export interface PlaylistSummary {
  id: string;
  title: string;
  trackCount?: number;
  thumbnailUrl?: string;
}

export interface IProvider {
  readonly id: string;
  readonly name: string;
  readonly icon: string;

  search(query: string, opts?: SearchOptions): Promise<SearchResult>;
  getTrack(id: string): Promise<Track>;
  getStreamUrl(track: Track): Promise<string>;

  getTrending?(): Promise<Track[]>;
  getPlaylists?(): Promise<Playlist[]>;
  getPlaylist?(id: string): Promise<PlaylistDetail>;
  getArtist?(id: string, signal?: AbortSignal): Promise<ArtistDetail>;
  getAlbum?(id: string, signal?: AbortSignal): Promise<AlbumDetail>;
  getSearchSuggestions?(query: string, signal?: AbortSignal): Promise<string[]>;
}

export interface Playlist {
  id: string;
  title: string;
  trackCount?: number;
}

export interface PlaylistDetail extends Playlist {
  tracks: Track[];
  description?: string;
}

export interface ArtistDetail extends ArtistSummary {
  description?: string;
  albums: CatalogPage<AlbumSummary>;
  singles: CatalogPage<AlbumSummary>;
  topTracks: CatalogPage<Track>;
}

export interface AlbumDetail extends AlbumSummary {
  year?: number;
  tracks: CatalogPage<Track>;
}
