import { describe, expect, test } from 'bun:test';
import type { Podcast } from '../../src/providers/podcast-types';
import { PodcastProvider, type PodcastFetcher } from '../../src/providers/podcast';

const FEED_XML =
  '<?xml version="1.0"?><rss><channel><item><title>Episode One</title>' +
  '<guid>g-1</guid><enclosure url="https://e.example/1.mp3" type="audio/mpeg"/></item></channel></rss>';

const PODCAST: Podcast = {
  id: 'p1',
  title: 'Feed',
  author: 'Author',
  feedUrl: 'https://f.example/rss',
};

const SEARCH_PAYLOAD = {
  results: [
    {
      collectionId: 11,
      collectionName: 'Cast A',
      artistName: 'Author A',
      feedUrl: 'https://a.example/feed',
      artworkUrl100: 'https://a.example/art.jpg',
    },
    { collectionId: 12, collectionName: 'Missing feedUrl', artistName: 'X' },
    { collectionName: 'Missing collectionId', feedUrl: 'https://b.example/feed' },
    { collectionId: '13', collectionName: 'String collectionId', feedUrl: 'https://c.example/feed' },
    'junk-entry',
    null,
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PodcastProvider.searchPodcasts', () => {
  test('maps valid entries and drops entries missing required fields', async () => {
    const provider = new PodcastProvider(async () => jsonResponse(SEARCH_PAYLOAD));
    const results = await provider.searchPodcasts('cast');
    expect(results).toEqual([
      {
        id: '11',
        title: 'Cast A',
        author: 'Author A',
        feedUrl: 'https://a.example/feed',
        artworkUrl: 'https://a.example/art.jpg',
      },
    ]);
  });

  test('returns [] on HTTP failure', async () => {
    const provider = new PodcastProvider(async () => jsonResponse('boom', 500));
    expect(await provider.searchPodcasts('cast')).toEqual([]);
  });

  test('returns [] on malformed JSON', async () => {
    const provider = new PodcastProvider(async () => jsonResponse('not json'));
    expect(await provider.searchPodcasts('cast')).toEqual([]);
  });

  test('returns [] when results are absent', async () => {
    const provider = new PodcastProvider(async () => jsonResponse({ kind: 'other' }));
    expect(await provider.searchPodcasts('cast')).toEqual([]);
  });

  test('propagates caller cancellation instead of reporting no results', async () => {
    const fetcher: PodcastFetcher = (_input, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      const bail = () => reject(new Error('caller aborted'));
      if (init?.signal?.aborted) bail();
      else init?.signal?.addEventListener('abort', bail);
      return promise;
    };
    const provider = new PodcastProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.searchPodcasts('cast', controller.signal)).rejects.toThrow(
      'caller aborted',
    );
  });
});

describe('PodcastProvider.getEpisodes', () => {
  test('fetches and parses the feed into episodes', async () => {
    const provider = new PodcastProvider(
      async () => new Response(FEED_XML, { headers: { 'content-type': 'application/rss+xml' } }),
    );
    const episodes = await provider.getEpisodes(PODCAST);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      id: 'g-1',
      podcastId: 'p1',
      podcastTitle: 'Feed',
      audioUrl: 'https://e.example/1.mp3',
    });
  });

  test('returns [] on HTTP failure', async () => {
    const provider = new PodcastProvider(async () => new Response('forbidden', { status: 403 }));
    expect(await provider.getEpisodes(PODCAST)).toEqual([]);
  });

  test('returns [] on a body with no items', async () => {
    const provider = new PodcastProvider(async () => new Response('not xml at all'));
    expect(await provider.getEpisodes(PODCAST)).toEqual([]);
  });

  test('propagates caller cancellation instead of reporting failure', async () => {
    const fetcher: PodcastFetcher = (_input, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      const bail = () => reject(new Error('caller aborted'));
      if (init?.signal?.aborted) bail();
      else init?.signal?.addEventListener('abort', bail);
      return promise;
    };
    const provider = new PodcastProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.getEpisodes(PODCAST, controller.signal)).rejects.toThrow(
      'caller aborted',
    );
  });
});
