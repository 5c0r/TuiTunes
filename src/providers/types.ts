export interface Track {
  id: string;
  provider: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  thumbnailUrl?: string;
}

export interface SearchResult {
  tracks: Track[];
  albums?: AlbumSummary[];
  artists?: ArtistSummary[];
  playlists?: PlaylistSummary[];
  hasMore: boolean;
  continuation?: unknown;
}

export interface SearchOptions {
  type?: 'all' | 'song' | 'album' | 'artist' | 'playlist';
  continuation?: unknown;
}

export interface AlbumSummary {
  id: string;
  title: string;
  artist: string;
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
  getArtist?(id: string): Promise<ArtistDetail>;
  getAlbum?(id: string): Promise<AlbumDetail>;
  getSearchSuggestions?(query: string): Promise<string[]>;
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
  topTracks: Track[];
}

export interface AlbumDetail extends AlbumSummary {
  tracks: Track[];
  year?: number;
}
