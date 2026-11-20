import { Logger } from '../utils/logger';
import type { Episode, Podcast } from './podcast-types';
import { parseFeed } from './rss';

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 25;

/** Raw iTunes search entry: every used field is validated, never trusted. */
interface ItunesResult {
  collectionId?: unknown;
  collectionName?: unknown;
  artistName?: unknown;
  feedUrl?: unknown;
  artworkUrl100?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Minimal fetch port; tests inject a stubbed implementation. */
export type PodcastFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** One deadline covering connection, headers, and the full body read. */
function deadlineSignal(callerSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

/** Validate iTunes search JSON at the boundary before constructing Podcasts. */
function parseSearchResults(data: unknown): Podcast[] {
  if (typeof data !== 'object' || data === null || !('results' in data)) return [];
  const results: unknown = data.results;
  if (!Array.isArray(results)) return [];
  const podcasts: Podcast[] = [];
  for (const raw of results) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as ItunesResult;
    const feedUrl = optionalString(entry.feedUrl);
    const collectionId = entry.collectionId;
    if (!feedUrl || feedUrl.length === 0) continue;
    if (typeof collectionId !== 'number' || !Number.isFinite(collectionId)) continue;
    podcasts.push({
      id: String(collectionId),
      title: optionalString(entry.collectionName) ?? '',
      author: optionalString(entry.artistName) ?? '',
      feedUrl,
      artworkUrl: optionalString(entry.artworkUrl100),
    });
  }
  return podcasts;
}

export class PodcastProvider {
  constructor(private readonly fetcher: PodcastFetcher = fetch) {}

  /**
   * Search podcasts via the iTunes API. Ordinary failures return [] so they
   * stay distinguishable from caller cancellation, which propagates.
   */
  async searchPodcasts(query: string, signal?: AbortSignal): Promise<Podcast[]> {
    const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(query)}&media=podcast&limit=25`;
    try {
      const res = await this.fetcher(url, { signal: deadlineSignal(signal) });
      if (!res.ok) {
        Logger.error(`iTunes search failed: ${res.status} ${res.statusText}`);
        return [];
      }
      return parseSearchResults(await res.json()).slice(0, MAX_RESULTS);
    } catch (err) {
      if (signal?.aborted) throw err;
      Logger.error(`iTunes search error: ${err}`);
      return [];
    }
  }

  /**
   * Fetch and parse episodes from a podcast's RSS feed. Ordinary failures
   * return []; caller cancellation propagates.
   */
  async getEpisodes(podcast: Podcast, signal?: AbortSignal): Promise<Episode[]> {
    try {
      const res = await this.fetcher(podcast.feedUrl, { signal: deadlineSignal(signal) });
      if (!res.ok) {
        Logger.error(`Feed fetch failed for "${podcast.title}": ${res.status}`);
        return [];
      }
      const xml = await res.text();
      return parseFeed(xml, podcast.id, podcast.title);
    } catch (err) {
      if (signal?.aborted) throw err;
      Logger.error(`Feed fetch error for "${podcast.title}": ${err}`);
      return [];
    }
  }

  /** Stream URL is the enclosure URL — mpv plays it directly. */
  getStreamUrl(episode: Episode): string {
    return episode.audioUrl;
  }
}

export const podcastProvider = new PodcastProvider();
