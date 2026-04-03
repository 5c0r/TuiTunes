import type { Podcast, Episode } from './podcast-types';
import { parseFeed } from './rss';
import { Logger } from '../utils/logger';

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const FEED_TIMEOUT_MS = 10_000;

export class PodcastProvider {
  /** Search podcasts via iTunes API. */
  async searchPodcasts(query: string): Promise<Podcast[]> {
    const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(query)}&media=podcast&limit=25`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        Logger.error(`iTunes search failed: ${res.status} ${res.statusText}`);
        return [];
      }
      const data = await res.json() as {
        results: Array<{
          collectionId?: number;
          collectionName?: string;
          artistName?: string;
          feedUrl?: string;
          artworkUrl100?: string;
        }>;
      };
      return data.results
        .filter((r) => r.feedUrl)
        .slice(0, 25)
        .map((r) => ({
          id: String(r.collectionId),
          title: r.collectionName ?? '',
          author: r.artistName ?? '',
          feedUrl: r.feedUrl!,
          artworkUrl: r.artworkUrl100,
        }));
    } catch (err) {
      Logger.error(`iTunes search error: ${err}`);
      return [];
    }
  }

  /** Fetch and parse episodes from a podcast's RSS feed. */
  async getEpisodes(podcast: Podcast): Promise<Episode[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
      const res = await fetch(podcast.feedUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        Logger.error(`Feed fetch failed for "${podcast.title}": ${res.status}`);
        return [];
      }
      const xml = await res.text();
      return parseFeed(xml, podcast.id, podcast.title);
    } catch (err) {
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
