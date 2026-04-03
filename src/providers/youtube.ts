import { Innertube, Platform } from 'youtubei.js';
import { Logger } from '../utils/logger';
import type { IProvider, Track, SearchResult, SearchOptions } from './types';

// youtubei.js v17 requires a custom JS evaluator for URL deciphering.
// We don't actually need it — mpv + yt-dlp handles playback — but
// set it up anyway so getInfo() doesn't throw if called.
Platform.shim.eval = async (code, env) => {
  const keys = Object.keys(env);
  const values = Object.values(env);
  const fn = new Function(...keys, code.output);
  return fn(...values);
};

let innertube: Innertube | null = null;

async function getClient(): Promise<Innertube> {
  if (!innertube) {
    innertube = await Innertube.create({ lang: 'en', location: 'US' });
    Logger.info('youtubei.js client initialized');
  }
  return innertube;
}

/**
 * Extract tracks from a MusicShelf's MusicResponsiveListItem entries.
 * The search response nests items inside ItemSection/MusicShelf containers.
 */
function trackFromItem(item: unknown): Track | null {
  const it = item as Record<string, unknown>;
  if (it.type !== 'MusicResponsiveListItem') return null;
  if (!it.id || typeof it.id !== 'string') return null;

  const artists = it.artists as Array<{ name: string }> | undefined;
  const duration = it.duration as { seconds: number } | undefined;
  const album = it.album as { name: string } | undefined;
  const thumbnails = it.thumbnails as Array<{ url: string }> | undefined;

  return {
    id: it.id,
    provider: 'youtube',
    title: (it.title as string) ?? 'Unknown',
    artist: artists?.[0]?.name ?? 'Unknown Artist',
    album: album?.name,
    duration: duration?.seconds ?? 0,
    thumbnailUrl: thumbnails?.[0]?.url,
  };
}

/** Extract tracks from search contents (wrapped in MusicShelf sections). */
function extractTracks(contents: unknown[]): Track[] {
  const tracks: Track[] = [];
  for (const section of contents) {
    const s = section as Record<string, unknown>;
    if (s.type === 'MusicShelf' && Array.isArray(s.contents)) {
      for (const item of s.contents) {
        const t = trackFromItem(item);
        if (t) tracks.push(t);
      }
    }
  }
  return tracks;
}

/** Extract tracks from a flat items array (continuation pages). */
function extractTracksFromItems(items: unknown[]): Track[] {
  const tracks: Track[] = [];
  for (const item of items) {
    const t = trackFromItem(item);
    if (t) tracks.push(t);
  }
  return tracks;
}

export class YouTubeProvider implements IProvider {
  readonly id = 'youtube';
  readonly name = 'YouTube Music';
  readonly icon = '▶';

  async search(query: string, opts?: SearchOptions): Promise<SearchResult> {
    const yt = await getClient();

    // Page 2+: use continuation from previous result
    if (opts?.continuation) {
      const prevResult = opts.continuation as { getContinuation: () => Promise<unknown> };
      const page = await prevResult.getContinuation() as {
        contents: { contents?: unknown[] };
        has_continuation?: boolean;
      };
      const items = page.contents?.contents ?? [];
      const tracks = extractTracksFromItems(items);
      Logger.info(`YouTube search '${query}' (page 2+): ${tracks.length} results`);
      return {
        tracks,
        hasMore: page.has_continuation ?? false,
        continuation: page.has_continuation ? page : undefined,
      };
    }

    // Page 1: fresh search
    const results = await yt.music.search(query, { type: 'song' });
    const tracks = extractTracks(results.contents ?? []);
    Logger.info(`YouTube search '${query}': ${tracks.length} results`);

    return {
      tracks,
      hasMore: results.has_continuation ?? false,
      continuation: results.has_continuation ? results : undefined,
    };
  }

  async getTrack(id: string): Promise<Track> {
    const yt = await getClient();
    const info = await yt.music.getInfo(id);

    const meta = info.basic_info;
    return {
      id,
      provider: 'youtube',
      title: meta.title ?? 'Unknown',
      artist: meta.author ?? 'Unknown Artist',
      duration: meta.duration ?? 0,
      thumbnailUrl: meta.thumbnail?.[0]?.url,
    };
  }

  /**
   * Return a YouTube Music URL that mpv + yt-dlp can play directly.
   * No URL deciphering needed — yt-dlp handles it.
   */
  async getStreamUrl(track: Track): Promise<string> {
    return `https://music.youtube.com/watch?v=${track.id}`;
  }

  async getSearchSuggestions(query: string): Promise<string[]> {
    try {
      const yt = await getClient();
      const suggestions = await yt.music.getSearchSuggestions(query);
      // suggestions is an array of suggestion objects with a `text` field
      return suggestions
        .map((s: unknown) => {
          const entry = s as Record<string, unknown>;
          // Each suggestion may be a SearchSuggestion with query text
          if (typeof entry.text === 'string') return entry.text;
          return null;
        })
        .filter((s): s is string => s !== null);
    } catch {
      return [];
    }
  }
}
