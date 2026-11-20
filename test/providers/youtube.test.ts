import { afterEach, describe, expect, test } from 'bun:test';
import { Parser, YTNodes } from 'youtubei.js';
import type { Actions, Innertube } from 'youtubei.js';
import {
  alignNativeTranslation,
  configureYouTubeClientForTests,
  extractSuggestions,
  isValidArtistId,
  isValidReleaseId,
  runYouTubeOperation,
  shutdownYouTubeClient,
  transcriptLanguageName,
  YouTubeProvider,
} from '../../src/providers/youtube';
import type { LyricLine } from '../../src/providers/lyrics';
import type {
  AlbumSummary,
  CatalogContinuation,
  CatalogPage,
  Track,
} from '../../src/providers/types';

// Fixtures build real youtubei.js parser nodes, so the helpers are exercised
// against actual SDK classes rather than copies of their mapping algorithm.

function suggestionNode(text: string, variant: 'search' | 'history' = 'search') {
  const renderer = variant === 'search' ? 'searchSuggestionRenderer' : 'historySuggestionRenderer';
  return { [renderer]: { suggestion: { simpleText: text }, navigationEndpoint: {} } };
}

function suggestionSection(...contents: unknown[]) {
  return new YTNodes.SearchSuggestionsSection({ contents });
}

describe('extractSuggestions', () => {
  test('flattens sections preserving order, accepting search and history suggestions', () => {
    const sections = [
      suggestionSection(suggestionNode('unravel'), suggestionNode('unravel cover', 'history')),
      suggestionSection(suggestionNode('unravel live')),
    ];

    expect(extractSuggestions(sections)).toEqual(['unravel', 'unravel cover', 'unravel live']);
  });

  test('deduplicates identical suggestion strings', () => {
    const sections = [
      suggestionSection(suggestionNode('alpha'), suggestionNode('beta')),
      suggestionSection(
        suggestionNode('alpha'),
        suggestionNode('beta', 'history'),
        suggestionNode('gamma'),
      ),
    ];

    expect(extractSuggestions(sections)).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('drops empty suggestions and ignores non-suggestion nodes', () => {
    const sections = [
      suggestionSection(
        { messageRenderer: { text: { simpleText: 'not a suggestion' } } },
        suggestionNode(''),
        suggestionNode('real'),
      ),
    ];

    expect(extractSuggestions(sections)).toEqual(['real']);
  });

  test('joins run-based suggestion text', () => {
    const sections = [
      suggestionSection({
        searchSuggestionRenderer: {
          suggestion: { runs: [{ text: 'unravel' }, { text: ' cover' }] },
          navigationEndpoint: {},
        },
      }),
    ];

    expect(extractSuggestions(sections)).toEqual(['unravel cover']);
  });

  test('returns [] for empty sections or no sections', () => {
    expect(extractSuggestions([])).toEqual([]);
    expect(extractSuggestions([suggestionSection()])).toEqual([]);
  });
});

describe('transcriptLanguageName', () => {
  const tracklist = new YTNodes.PlayerCaptionsTracklist({
    captionTracks: [
      {
        baseUrl: 'https://example.com/captions?lang=ja',
        name: { simpleText: 'Japanese (auto-generated)' },
        vssId: 'a.ja',
        languageCode: 'ja',
        isTranslatable: true,
      },
    ],
    translationLanguages: [
      { languageCode: 'en', languageName: { simpleText: 'English' } },
      { languageCode: 'ja', languageName: { simpleText: 'Japanese' } },
    ],
  });

  test('maps an ISO code to the display name used by selectLanguage', () => {
    expect(transcriptLanguageName('en', tracklist, ['English', 'Japanese'])).toBe('English');
    expect(transcriptLanguageName('ja', tracklist, ['English', 'Japanese'])).toBe('Japanese');
  });

  test('returns null when the display name is not among the transcript languages', () => {
    expect(transcriptLanguageName('en', tracklist, ['Japanese'])).toBeNull();
  });

  test('returns null for unknown codes or missing caption metadata', () => {
    expect(transcriptLanguageName('fr', tracklist, ['English'])).toBeNull();
    expect(transcriptLanguageName('en', undefined, ['English'])).toBeNull();
  });

  test('falls back to original caption-track metadata for display names', () => {
    const originalOnly = new YTNodes.PlayerCaptionsTracklist({
      captionTracks: [
        {
          baseUrl: 'https://example.com/captions?lang=ja',
          name: { simpleText: 'Japanese (auto-generated)' },
          vssId: 'a.ja',
          languageCode: 'ja',
          isTranslatable: true,
        },
      ],
    });

    expect(transcriptLanguageName('ja', originalOnly, ['Japanese (auto-generated)'])).toBe(
      'Japanese (auto-generated)',
    );
  });

  test('prefers the first verified candidate name', () => {
    // 'English' is the translation-language name but is unavailable; the
    // caption-track name is verified instead.
    const mixed = new YTNodes.PlayerCaptionsTracklist({
      captionTracks: [
        {
          baseUrl: 'https://example.com/captions?lang=en',
          name: { simpleText: 'English (United Kingdom)' },
          vssId: 'en-GB',
          languageCode: 'en',
          isTranslatable: true,
        },
      ],
      translationLanguages: [{ languageCode: 'en', languageName: { simpleText: 'English' } }],
    });

    expect(transcriptLanguageName('en', mixed, ['English (United Kingdom)'])).toBe(
      'English (United Kingdom)',
    );
  });
});

describe('alignNativeTranslation', () => {
  const source: LyricLine[] = [
    { time: 0.33, text: '教えて 教えてよ' },
    { time: 4.18, text: 'その仕組みを' },
    { time: 29.34, text: '   ' },
    { time: 45.15, text: '息を止めて' },
  ];

  test('merges native captions by integer-millisecond timestamp', () => {
    const native: LyricLine[] = [
      { time: 0.33, text: 'Tell me, tell me' },
      { time: 4.18, text: 'How it works' },
      { time: 45.15, text: 'I hold my breath' },
    ];

    const merged = alignNativeTranslation(source, native);
    expect(merged).not.toBeNull();
    expect(merged?.map((line) => line.translatedText)).toEqual([
      'Tell me, tell me',
      'How it works',
      '',
      'I hold my breath',
    ]);
    // Timestamps and source order are preserved untouched.
    expect(merged?.map((line) => [line.time, line.text])).toEqual(
      source.map((line) => [line.time, line.text]),
    );
  });

  test('tolerates sub-millisecond rounding differences', () => {
    const merged = alignNativeTranslation(
      [{ time: 2.3001, text: 'line' }],
      [{ time: 2.3, text: 'translated' }],
    );
    expect(merged?.[0]?.translatedText).toBe('translated');
  });

  test('returns null when a nonempty source timestamp is missing', () => {
    const native: LyricLine[] = [
      { time: 0.33, text: 'Tell me, tell me' },
      { time: 4.18, text: 'How it works' },
    ];
    expect(alignNativeTranslation(source, native)).toBeNull();
  });

  test('returns null for ambiguous duplicate native timestamps', () => {
    const native: LyricLine[] = [
      { time: 0.33, text: 'Tell me, tell me' },
      { time: 0.33, text: 'Tell me again' },
      { time: 4.18, text: 'How it works' },
      { time: 45.15, text: 'I hold my breath' },
    ];
    expect(alignNativeTranslation(source, native)).toBeNull();
  });

  test('returns null for untimed sources sharing one timestamp', () => {
    const untimed: LyricLine[] = [
      { time: 0, text: 'first' },
      { time: 0, text: 'second' },
    ];
    const native: LyricLine[] = [
      { time: 0, text: 'first translated' },
      { time: 1000, text: 'second translated' },
    ];
    expect(alignNativeTranslation(untimed, native)).toBeNull();
  });

  test('extra native lines at unused timestamps do not block alignment', () => {
    const native: LyricLine[] = [
      { time: 0.0, text: 'intro caption' },
      { time: 0.33, text: 'Tell me, tell me' },
      { time: 4.18, text: 'How it works' },
      { time: 45.15, text: 'I hold my breath' },
      { time: 99.0, text: 'outro caption' },
    ];
    const merged = alignNativeTranslation(source, native);
    expect(merged?.[0]?.translatedText).toBe('Tell me, tell me');
  });

  test('blank native lines never pair and never collide', () => {
    const native: LyricLine[] = [
      { time: 0.33, text: '' },
      { time: 0.33, text: 'Tell me, tell me' },
      { time: 4.18, text: 'How it works' },
      { time: 45.15, text: 'I hold my breath' },
    ];
    const merged = alignNativeTranslation(source, native);
    expect(merged?.[0]?.translatedText).toBe('Tell me, tell me');
  });

  test('never zips unrelated captions by array index', () => {
    // Native captions in reversed order must not merge positionally.
    const native: LyricLine[] = [
      { time: 45.15, text: 'I hold my breath' },
      { time: 4.18, text: 'How it works' },
      { time: 0.33, text: 'Tell me, tell me' },
    ];
    const merged = alignNativeTranslation(source, native);
    expect(merged?.[0]?.translatedText).toBe('Tell me, tell me');
    expect(merged?.[3]?.translatedText).toBe('I hold my breath');
  });
});

// ---------------------------------------------------------------------------
// Catalog paging against real youtubei.js parser-node fixtures
// ---------------------------------------------------------------------------

interface RecordedCall {
  endpoint: string | undefined;
  args: Record<string, unknown>;
}

/** Continuation that must exist; keeps assertions free of non-null assertions. */
function cont<T>(page: { next: CatalogPage<T>['next'] }): CatalogContinuation<T> {
  if (!page.next) throw new Error('expected a continuation handle');
  return page.next;
}

/** Raw album/release card renderer (album page type, browse ID, artist run). */
function albumCard(id: string, title: string, artist = 'Daft Punk'): unknown {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: title }] },
      subtitle: {
        runs: [
          { text: '2013' },
          { text: ' • ' },
          {
            text: artist,
            navigationEndpoint: { browseEndpoint: { browseId: 'UCartist' } },
          },
        ],
      },
      navigationEndpoint: {
        browseEndpoint: {
          browseId: id,
          params: `params-${id}`,
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' },
          },
        },
      },
      thumbnailRenderer: {
        musicThumbnailRenderer: {
          thumbnail: { thumbnails: [{ url: `https://img.test/${id}.jpg` }] },
        },
      },
    },
  };
}

/** A non-release card (no album page type, 'Song' subtitle absent). */
function videoCard(title: string): unknown {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: title }] },
      subtitle: { runs: [{ text: 'Video' }] },
      navigationEndpoint: { watchEndpoint: { videoId: 'vid-x' } },
      thumbnailRenderer: {
        musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://img.test/v.jpg' }] } },
      },
    },
  };
}

function carousel(
  title: string,
  contents: unknown[],
  more?: { browseId: string },
): YTNodes.MusicCarouselShelf {
  return new YTNodes.MusicCarouselShelf({
    header: {
      musicCarouselShelfBasicHeaderRenderer: {
        title: { runs: [{ text: title }] },
        ...(more
          ? {
              moreContentButton: {
                buttonRenderer: {
                  navigationEndpoint: {
                    browseEndpoint: { browseId: more.browseId, params: 'more-params' },
                    commandMetadata: { webCommandMetadata: { apiUrl: '/youtubei/v1/browse' } },
                  },
                },
              },
            }
          : {}),
      },
    },
    contents,
    numItemsPerColumn: 4,
  });
}

function continuationItem(token: string): unknown {
  return {
    continuationItemRenderer: {
      trigger: 'CONTINUATION_TOKEN_ON_ITEM_PURPOSED',
      // The SDK parses this into ContinuationCommand: token feeds
      // buildRequest() and request pins the browse api path.
      continuationEndpoint: {
        continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' },
      },
    },
  };
}

/** Raw song row renderer; artist/album runs carry real browse endpoints. */
function songCard(
  videoId: string,
  title: string,
  extra: { artist?: string; album?: string; albumId?: string; duration?: string } = {},
): unknown {
  return {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId },
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                {
                  text: title,
                  navigationEndpoint: {
                    watchEndpoint: {
                      videoId,
                      watchEndpointMusicSupportedConfigs: {
                        watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                {
                  text: extra.artist ?? 'Daft Punk',
                  navigationEndpoint: { browseEndpoint: { browseId: 'UCsongartist' } },
                },
                { text: ' • ' },
                ...(extra.album
                  ? [
                      {
                        text: extra.album,
                        navigationEndpoint: {
                          browseEndpoint: { browseId: extra.albumId ?? 'MPRsongalbum' },
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        },
      ],
      fixedColumns: [
        {
          musicResponsiveListItemFixedColumnRenderer: {
            text: { runs: [{ text: extra.duration ?? '3:41' }] },
          },
        },
      ],
    },
  };
}

function playlistShelf(
  contents: unknown[],
  token: string | null,
  collapsedItemCount = 0,
): YTNodes.MusicPlaylistShelf {
  return new YTNodes.MusicPlaylistShelf({
    playlistId: 'PL',
    collapsedItemCount,
    contents,
    ...(token ? { continuations: [{ nextContinuationData: { continuation: token } }] } : {}),
  });
}

function trackShelf(contents: unknown[], token?: string): unknown {
  return {
    title: { runs: [{ text: 'Album' }] },
    contents,
    ...(token ? { continuations: [{ nextContinuationData: { continuation: token } }] } : {}),
  };
}

function artistFixture(sections: unknown[]): {
  header: YTNodes.MusicImmersiveHeader;
  sections: unknown[];
  getAllSongs: () => Promise<YTNodes.MusicPlaylistShelf | undefined>;
} {
  const header = new YTNodes.MusicImmersiveHeader({
    title: { runs: [{ text: 'Daft Punk' }] },
    description: { runs: [{ text: 'French electronic duo.' }] },
    thumbnail: {
      musicThumbnailRenderer: {
        thumbnail: { thumbnails: [{ url: 'https://img.test/artist.jpg' }] },
      },
    },
  });
  return {
    header,
    sections,
    getAllSongs: () => Promise.resolve(undefined),
  };
}

/** Fake Innertube whose actions.execute records and returns parsed fixtures. */
function fakeClient(respond: (call: RecordedCall) => unknown): {
  client: Innertube;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const actions = {
    execute: async (endpoint: string, args: Record<string, unknown>) => {
      const call = { endpoint, args: { ...args } };
      calls.push(call);
      return Parser.parseResponse(respond(call) as never);
    },
  } as unknown as Actions;
  const client = {
    actions,
    music: {},
  } as unknown as Innertube;
  return { client, calls };
}

describe('browse ID validation', () => {
  test('accepts only SDK artist/release prefixes', () => {
    expect(isValidArtistId('UC123')).toBe(true);
    expect(isValidArtistId('FEmusic_library_privately_owned_artist1')).toBe(true);
    expect(isValidArtistId('MPR123')).toBe(false);
    expect(isValidReleaseId('MPROS_album')).toBe(true);
    expect(isValidReleaseId('FEmusic_library_privately_owned_release9')).toBe(true);
    expect(isValidReleaseId('UC123')).toBe(false);
  });

  test('getArtist/getAlbum reject invalid browse IDs before any SDK call', async () => {
    const { client, calls } = fakeClient(() => ({}));
    const provider = new YouTubeProvider(() => Promise.resolve(client));
    await expect(provider.getArtist('MPROS_x')).rejects.toThrow('artist browse ID');
    await expect(provider.getAlbum('UC_x')).rejects.toThrow('release browse ID');
    expect(calls).toEqual([]);
  });
});

describe('YouTubeProvider.getArtist', () => {
  test('maps metadata and all supported collections from real parser nodes', async () => {
    const topSongs = playlistShelf(
      [
        songCard('t1', 'One More Time', { album: 'Discovery' }),
        songCard('t2', 'Harder, Better', { album: 'Discovery' }),
      ],
      null,
    );
    const artist = artistFixture([
      carousel('Albums', [albumCard('MPR1', 'Discovery')], { browseId: 'MPLA_albums' }),
      carousel('Singles & EPs', [albumCard('MPR2', 'Get Lucky')], { browseId: 'MPLA_singles' }),
      carousel('Videos', [videoCard('Live')]),
    ]);
    artist.getAllSongs = () => Promise.resolve(topSongs);

    const { client, calls } = fakeClient(({ args }) => {
      const browseId = (args.browseId as string) ?? '';
      if (browseId === 'MPLA_albums') {
        return {
          contents: {
            sectionListRenderer: {
              contents: [
                {
                  gridRenderer: {
                    items: [albumCard('MPR1', 'Discovery'), albumCard('MPR3', 'Homework')],
                    continuations: [{ nextContinuationData: { continuation: 'grid-2' } }],
                  },
                },
              ],
            },
          },
        };
      }
      if (browseId === 'MPLA_singles') {
        return {
          contents: {
            gridRenderer: {
              items: [albumCard('MPRS1', 'Instant Crush')],
            },
          },
        };
      }
      return {};
    });
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const detail = await provider.getArtist('UCdaft');
    expect(detail.name).toBe('Daft Punk');
    expect(detail.description).toBe('French electronic duo.');
    expect(detail.thumbnailUrl).toBe('https://img.test/artist.jpg');
    expect(detail.albums.items.map((album) => album.title)).toEqual(['Discovery', 'Homework']);
    expect(detail.albums.items[0]).toMatchObject({
      id: 'MPR1',
      artist: 'Daft Punk',
      artistId: 'UCartist',
      thumbnailUrl: 'https://img.test/MPR1.jpg',
    } satisfies Partial<AlbumSummary>);
    expect(detail.albums.next?.key).toBe('grid-2');
    expect(detail.albums.limitation).toBeNull();
    expect(detail.topTracks.items.map((track) => track.id)).toEqual(['t1', 't2']);
    expect(detail.topTracks.items[0]).toMatchObject({
      title: 'One More Time',
      artist: 'Daft Punk',
      artistId: 'UCsongartist',
      albumId: 'MPRsongalbum',
      duration: 221,
    } satisfies Partial<Track>);

    // The full release-list page is fetched through the more-content endpoint
    // with exact client arguments; the unrelated Videos carousel is not read.
    const albumCall = calls.find((call) => call.args.browseId === 'MPLA_albums');
    expect(albumCall).toMatchObject({
      // The SDK pins the api path from command metadata (prefix stripped).
      endpoint: 'browse',
      args: { client: 'YTMUSIC', parse: true, browseId: 'MPLA_albums', params: 'more-params' },
    });
    expect(calls.some((call) => call.args.browseId === 'MPLA_singles')).toBe(true);
  });

  test('missing sections and absent more-content endpoints are explicit limitations', async () => {
    const artist = artistFixture([
      carousel('Albums', [albumCard('MPR1', 'Discovery'), videoCard('not a release')]),
    ]);
    artist.getAllSongs = () =>
      Promise.reject(new Error('Could not find target shelf (Top songs).'));
    const { client } = fakeClient(() => ({}));
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const detail = await provider.getArtist('UCdaft');
    expect(detail.singles.limitation).toMatchObject({ kind: 'unavailable' });
    expect(detail.topTracks.limitation).toMatchObject({ kind: 'unavailable' });
    // Retained carousel cards, never labeled a complete discography.
    expect(detail.albums.items.map((album) => album.id)).toEqual(['MPR1']);
    expect(detail.albums.limitation).toMatchObject({ kind: 'partial' });
    expect(detail.albums.next).toBeNull();
  });

  test('a failed section does not fail the others, and cancellation rethrows', async () => {
    const artist = artistFixture([
      carousel('Albums', [], { browseId: 'MPLA_albums' }),
      carousel('Singles & EPs', [], { browseId: 'MPLA_singles' }),
    ]);
    const topSongs = playlistShelf([songCard('t1', 'Song')], null);
    artist.getAllSongs = () => Promise.resolve(topSongs);
    const { client } = fakeClient(({ args }) => {
      if (args.browseId === 'MPLA_albums') throw new Error('network down');
      return { contents: { gridRenderer: { items: [albumCard('MPR9', 'Single')] } } };
    });
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const detail = await provider.getArtist('UCdaft');
    expect(detail.albums.limitation).toMatchObject({ kind: 'unavailable' });
    expect(detail.albums.limitation?.message).toContain('network down');
    expect(detail.singles.items.map((album) => album.id)).toEqual(['MPR9']);
    expect(detail.topTracks.items).toHaveLength(1);

    const aborted = new AbortController();
    aborted.abort();
    await expect(provider.getArtist('UCdaft', aborted.signal)).rejects.toThrow();
  });

  test('follows Grid continuations, deduplicates by stable ID and detects cycles', async () => {
    const artist = artistFixture([carousel('Albums', [], { browseId: 'MPLA_albums' })]);
    artist.getAllSongs = () => Promise.resolve(playlistShelf([], null));
    const { client, calls } = fakeClient(({ args }) => {
      if (args.browseId === 'MPLA_albums') {
        return {
          contents: {
            gridRenderer: {
              items: [albumCard('MPR1', 'A')],
              continuations: [{ nextContinuationData: { continuation: 'grid-2' } }],
            },
          },
        };
      }
      if (args.continuation === 'grid-2') {
        return {
          continuationContents: {
            gridContinuation: {
              continuations: [{ nextContinuationData: { continuation: 'grid-1' } }],
              items: [albumCard('MPR2', 'B'), albumCard('MPR1', 'A again')],
            },
          },
        };
      }
      if (args.continuation === 'grid-1') {
        return {
          continuationContents: { gridContinuation: { items: [albumCard('MPR3', 'C')] } },
        };
      }
      return {};
    });
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const first = await provider.getArtist('UCdaft');
    const second = await cont(first.albums).next();
    // Exact token continuation arguments.
    expect(calls.at(-1)).toMatchObject({
      endpoint: '/browse',
      args: { client: 'YTMUSIC', continuation: 'grid-2', parse: true },
    });
    // First occurrence wins across pages.
    expect(second.items.map((album) => [album.id, album.title])).toEqual([['MPR2', 'B']]);
    // The cyclic token (grid-1 was never consumed, but grid-2 → grid-1 → grid-1?
    // Here grid-2 returns grid-1; consuming grid-1 returns no token, so no cycle.)
    expect(second.next?.key).toBe('grid-1');

    const third = await cont(second).next();
    expect(third.items.map((album) => album.id)).toEqual(['MPR3']);
    expect(third.next).toBeNull();
    expect(third.limitation).toBeNull();
  });

  test('a repeated continuation key ends paging with an incomplete-list limitation', async () => {
    const artist = artistFixture([carousel('Albums', [], { browseId: 'MPLA_albums' })]);
    artist.getAllSongs = () => Promise.resolve(playlistShelf([], null));
    const { client } = fakeClient(({ args }) => {
      if (args.browseId === 'MPLA_albums') {
        return {
          contents: {
            gridRenderer: {
              items: [albumCard('MPR1', 'A')],
              continuations: [{ nextContinuationData: { continuation: 'loop' } }],
            },
          },
        };
      }
      return {
        continuationContents: {
          gridContinuation: {
            items: [albumCard('MPR2', 'B')],
            continuations: [{ nextContinuationData: { continuation: 'loop' } }],
          },
        },
      };
    });
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const first = await provider.getArtist('UCdaft');
    const second = await cont(first.albums).next();
    expect(second.items.map((album) => album.id)).toEqual(['MPR2']);
    expect(second.next).toBeNull();
    expect(second.limitation).toMatchObject({ kind: 'partial' });
    expect(second.limitation?.message).toContain('continuation repeated');
  });

  test('a SectionList wraps exactly one release collection or is ambiguous', async () => {
    const artist = artistFixture([carousel('Albums', [], { browseId: 'MPLA_albums' })]);
    artist.getAllSongs = () => Promise.resolve(playlistShelf([], null));
    const grid = (items: unknown[]) => ({ gridRenderer: { items } });
    const { client } = fakeClient(({ args }) => {
      if (args.browseId === 'MPLA_albums') {
        return {
          contents: {
            sectionListRenderer: {
              contents: [grid([albumCard('MPR1', 'A')])],
              continuations: [{ nextContinuationData: { continuation: 'slc-1' } }],
            },
          },
        };
      }
      if (args.continuation === 'slc-1') {
        return {
          continuationContents: {
            sectionListContinuation: {
              continuations: [{ nextContinuationData: { continuation: 'slc-2' } }],
              contents: [grid([albumCard('MPR2', 'B')]), grid([albumCard('MPR3', 'C')])],
            },
          },
        };
      }
      if (args.continuation === 'slc-2') {
        return {
          continuationContents: {
            sectionListContinuation: { contents: [grid([albumCard('MPR4', 'D')])] },
          },
        };
      }
      return {};
    });
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const first = await provider.getArtist('UCdaft');
    expect(first.albums.items.map((album) => album.id)).toEqual(['MPR1']);
    expect(first.albums.next?.key).toBe('slc-1');
    const second = await cont(first.albums).next();
    // Two grids inside one SectionListContinuation are ambiguous: incomplete,
    // never an empty completed catalog.
    expect(second.items).toEqual([]);
    expect(second.next).toBeNull();
    expect(second.limitation).toMatchObject({ kind: 'partial' });
  });

  test('follows the action-based Top songs continuation without continuation_contents', async () => {
    const artist = artistFixture([]);
    const shelf = playlistShelf(
      [songCard('t1', 'Song 1'), songCard('t2', 'Song 2'), continuationItem('ep-1')],
      null,
      4,
    );
    artist.getAllSongs = () => Promise.resolve(shelf);
    const { client, calls } = fakeClient(({ args }) => {
      if (args.continuation === 'ep-1') {
        return {
          onResponseReceivedActions: [
            {
              appendContinuationItemsAction: {
                target: 'target',
                continuationItems: [
                  songCard('t3', 'Song 3'),
                  songCard('t1', 'Song 1 again'),
                  continuationItem('ep-2'),
                ],
              },
            },
          ],
        };
      }
      if (args.continuation === 'ep-2') {
        return {
          onResponseReceivedActions: [
            {
              appendContinuationItemsAction: {
                target: 'target',
                continuationItems: [songCard('t4', 'Song 4')],
              },
            },
          ],
        };
      }
      return {};
    });
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const first = await provider.getArtist('UCdaft');
    // collapsed_item_count above the mapped rows with no usable continuation
    // would mark truncation; here the ContinuationItem provides one.
    expect(first.topTracks.items.map((track) => track.id)).toEqual(['t1', 't2']);
    expect(first.topTracks.next?.key).toContain('ep-1');

    const second = await cont(first.topTracks).next();
    expect(second.items.map((track) => track.id)).toEqual(['t3']);
    expect(second.next?.key).toContain('ep-2');

    const third = await cont(second).next();
    expect(third.items.map((track) => track.id)).toEqual(['t4']);
    expect(third.next).toBeNull();
    expect(calls.some((call) => 'continuationContents' in (call.args as object))).toBe(false);
  });

  test('maps responsive album rows and marks unsupported row cards partial', async () => {
    const responsiveAlbumRow = (id: string | null, title: string): unknown => ({
      musicResponsiveListItemRenderer: {
        flexColumns: [
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
          {
            musicResponsiveListItemFlexColumnRenderer: {
              text: {
                runs: [
                  {
                    text: 'Daft Punk',
                    navigationEndpoint: { browseEndpoint: { browseId: 'UCdaft' } },
                  },
                  { text: ' • ' },
                  { text: '2013' },
                ],
              },
            },
          },
        ],
        // A null browseId leaves a typed album row without a stable ID.
        ...(id === null
          ? {}
          : {
              navigationEndpoint: {
                browseEndpoint: {
                  browseId: id,
                  browseEndpointContextSupportedConfigs: {
                    browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' },
                  },
                },
              },
            }),
      },
    });
    const artist = artistFixture([carousel('Albums', [], { browseId: 'MPLA_albums' })]);
    artist.getAllSongs = () => Promise.resolve(playlistShelf([], null));
    const { client } = fakeClient(({ args }) => {
      if (args.browseId === 'MPLA_albums') {
        return {
          contents: {
            musicShelfRenderer: {
              title: { runs: [{ text: 'Albums' }] },
              contents: [
                responsiveAlbumRow('MPR10', 'Alive 2007'),
                responsiveAlbumRow(null, 'ID-less entry'),
              ],
            },
          },
        };
      }
      return {};
    });
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const detail = await provider.getArtist('UCdaft');
    expect(detail.albums.items).toHaveLength(1);
    expect(detail.albums.items[0]).toMatchObject({
      id: 'MPR10',
      title: 'Alive 2007',
      artist: 'Daft Punk',
      artistId: 'UCdaft',
    } satisfies Partial<AlbumSummary>);
    expect(detail.albums.limitation).toMatchObject({ kind: 'partial' });
    expect(detail.albums.limitation?.message).toContain('unsupported');
  });

  test('a sole-child SectionList keeps the validated wrapper continuation', async () => {
    const artist = artistFixture([carousel('Albums', [], { browseId: 'MPLA_albums' })]);
    artist.getAllSongs = () => Promise.resolve(playlistShelf([], null));
    const { client, calls } = fakeClient(({ args }) => {
      if (args.browseId === 'MPLA_albums') {
        return {
          contents: {
            sectionListRenderer: {
              // The grid itself carries no token; only the wrapper does.
              contents: [{ gridRenderer: { items: [albumCard('MPR1', 'A')] } }],
              continuations: [{ nextContinuationData: { continuation: 'wrap-1' } }],
            },
          },
        };
      }
      if (args.continuation === 'wrap-1') {
        return { continuationContents: { gridContinuation: { items: [albumCard('MPR2', 'B')] } } };
      }
      return {};
    });
    const music = { ...client, music: { getArtist: async () => artist } } as unknown as Innertube;
    const provider = new YouTubeProvider(() => Promise.resolve(music));

    const first = await provider.getArtist('UCdaft');
    expect(first.albums.next?.key).toBe('wrap-1');
    const second = await cont(first.albums).next();
    expect(calls.at(-1)).toMatchObject({
      endpoint: '/browse',
      args: { client: 'YTMUSIC', continuation: 'wrap-1', parse: true },
    });
    expect(second.items.map((album) => album.id)).toEqual(['MPR2']);
    expect(second.next).toBeNull();
  });
});

describe('YouTubeProvider.getAlbum', () => {
  function albumClient(
    respond: (call: RecordedCall) => unknown,
    albumRaw: unknown,
  ): {
    provider: YouTubeProvider;
    calls: RecordedCall[];
  } {
    const { client, calls } = fakeClient(respond);
    const parsed = Parser.parseResponse(albumRaw as never);
    const album = {
      header: parsed.header?.item(),
      contents: parsed.contents_memo?.getType(YTNodes.MusicShelf)?.[0]?.contents ?? [],
      page: parsed,
    };
    const music = { ...client, music: { getAlbum: async () => album } } as unknown as Innertube;
    return { provider: new YouTubeProvider(() => Promise.resolve(music)), calls };
  }

  test('maps MusicDetailHeader metadata and preserves repeated video IDs', async () => {
    const { provider } = albumClient(() => ({}), {
      header: {
        musicDetailHeaderRenderer: {
          title: { runs: [{ text: 'Random Access Memories' }] },
          description: { runs: [{ text: 'Studio album.' }] },
          subtitle: {
            runs: [
              { text: 'Album' },
              { text: ' • ' },
              { text: 'Daft Punk', navigationEndpoint: { browseEndpoint: { browseId: 'UCdaft' } } },
              { text: ' • ' },
              { text: '2013' },
            ],
          },
          secondSubtitle: { runs: [{ text: '13 songs' }, { text: ' • ' }, { text: '1:15:51' }] },
          thumbnail: {
            croppedSquareThumbnailRenderer: {
              thumbnail: { thumbnails: [{ url: 'https://img.test/ram.jpg' }] },
            },
          },
          menu: { menuRenderer: {} },
        },
      },
      contents: {
        sectionListRenderer: {
          contents: [
            {
              musicShelfRenderer: trackShelf([
                songCard('v1', 'Give Life Back to Music', {
                  artist: 'Daft Punk',
                  album: 'Random Access Memories',
                  albumId: 'MPRram',
                }),
                songCard('v1', 'Give Life Back to Music (reprised)', {
                  album: 'Random Access Memories',
                  albumId: 'MPRram',
                }),
                songCard('v2', 'Giorgio by Moroder'),
              ]),
            },
          ],
        },
      },
    });

    const detail = await provider.getAlbum('MPRram');
    expect(detail.title).toBe('Random Access Memories');
    expect(detail.artist).toBe('Daft Punk');
    expect(detail.artistId).toBe('UCdaft');
    expect(detail.year).toBe(2013);
    expect(detail.thumbnailUrl).toBe('https://img.test/ram.jpg');
    // Header artist is summary context only; per-track artists come from rows
    // and repeated video IDs stay separate ordered rows.
    expect(detail.tracks.items.map((track) => [track.id, track.title, track.artistId])).toEqual([
      ['v1', 'Give Life Back to Music', 'UCsongartist'],
      ['v1', 'Give Life Back to Music (reprised)', 'UCsongartist'],
      ['v2', 'Giorgio by Moroder', 'UCsongartist'],
    ]);
    // The row without album metadata gets the fetched album as missing-field
    // context; explicit per-row fields are never overwritten.
    expect(detail.tracks.items[2]).toMatchObject({
      albumId: 'MPRram',
      album: 'Random Access Memories',
    } satisfies Partial<Track>);
    expect(detail.tracks.limitation).toBeNull();
    expect(detail.tracks.next).toBeNull();
  });

  test('maps MusicResponsiveHeader, follows the shelf token through MusicShelfContinuation', async () => {
    const { provider, calls } = albumClient(
      ({ args }) => {
        if (args.continuation === 'shelf-2') {
          return {
            continuationContents: {
              musicShelfContinuation: {
                continuations: [{ nextContinuationData: { continuation: 'shelf-3' } }],
                contents: [songCard('v3', 'Contact')],
              },
            },
          };
        }
        return {};
      },
      {
        header: {
          musicResponsiveHeaderRenderer: {
            title: { runs: [{ text: 'Discovery' }] },
            subtitle: { runs: [{ text: 'Album' }] },
            straplineTextOne: {
              runs: [
                {
                  text: 'Daft Punk',
                  navigationEndpoint: { browseEndpoint: { browseId: 'UCdaft' } },
                },
              ],
            },
            secondSubtitle: { runs: [{ text: '2001' }] },
            thumbnail: {
              musicThumbnailRenderer: {
                thumbnail: { thumbnails: [{ url: 'https://img.test/disc.jpg' }] },
              },
            },
          },
        },
        contents: {
          sectionListRenderer: {
            contents: [
              { musicShelfRenderer: trackShelf([songCard('v1', 'One More Time')], 'shelf-2') },
            ],
          },
        },
      },
    );

    const detail = await provider.getAlbum('MPRdisc');
    expect(detail.title).toBe('Discovery');
    expect(detail.artist).toBe('Daft Punk');
    expect(detail.artistId).toBe('UCdaft');
    expect(detail.year).toBe(2001);
    expect(detail.tracks.items.map((track) => track.title)).toEqual(['One More Time']);
    expect(detail.tracks.next?.key).toBe('shelf-2');

    const page = await cont(detail.tracks).next();
    expect(calls.at(-1)).toMatchObject({
      endpoint: '/browse',
      args: { client: 'YTMUSIC', continuation: 'shelf-2', parse: true },
    });
    expect(page.items.map((track) => track.title)).toEqual(['Contact']);
  });

  test('rows without a stable ID make the album explicitly partial', async () => {
    const noId = songCard('v1', 'Has ID');
    const rowless = {
      musicResponsiveListItemRenderer: {
        playlistItemData: {},
        flexColumns: [
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'No ID' }] } } },
        ],
      },
    };
    const { provider } = albumClient(() => ({}), {
      contents: {
        sectionListRenderer: {
          contents: [{ musicShelfRenderer: trackShelf([noId, rowless]) }],
        },
      },
    });

    const detail = await provider.getAlbum('MPRx');
    expect(detail.tracks.items.map((track) => track.title)).toEqual(['Has ID']);
    expect(detail.tracks.limitation).toMatchObject({ kind: 'partial' });
    expect(detail.tracks.limitation?.message).toContain('ID-less');
  });

  test('an album page without a tracklist shelf is unavailable, and a failed cursor is retained for retry', async () => {
    let shelfFailures = 0;
    const { provider } = albumClient(
      ({ args }) => {
        if (args.continuation === 'shelf-flaky') {
          shelfFailures += 1;
          if (shelfFailures === 1) throw new Error('socket hang up');
          return {
            continuationContents: {
              musicShelfContinuation: { contents: [songCard('v9', 'Late Track')] },
            },
          };
        }
        return {};
      },
      {
        contents: {
          sectionListRenderer: {
            contents: [{ musicCarouselShelfRenderer: { header: {}, contents: [] } }],
          },
        },
      },
    );

    const empty = await provider.getAlbum('MPRempty');
    expect(empty.tracks.items).toEqual([]);
    expect(empty.tracks.limitation).toMatchObject({ kind: 'unavailable' });

    const flaky = albumClient(
      ({ args }) => {
        if (args.continuation === 'shelf-flaky') {
          shelfFailures += 1;
          if (shelfFailures % 2 === 1) throw new Error('socket hang up');
          return {
            continuationContents: {
              musicShelfContinuation: { contents: [songCard('v9', 'Late Track')] },
            },
          };
        }
        return {};
      },
      {
        contents: {
          sectionListRenderer: {
            contents: [
              { musicShelfRenderer: trackShelf([songCard('v1', 'First')], 'shelf-flaky') },
            ],
          },
        },
      },
    );
    const withShelf = await flaky.provider.getAlbum('MPRflaky');

    const continuation = cont(withShelf.tracks);
    await expect(continuation.next()).rejects.toThrow('socket hang up');
    // The same handle retries the same token and succeeds.
    const retried: CatalogPage<Track> = await continuation.next();
    expect(retried.items.map((track) => track.title)).toEqual(['Late Track']);
    expect(flaky.calls.filter((call) => call.args.continuation === 'shelf-flaky')).toHaveLength(2);
  });

  test('successful pages replay verbatim after a later failure, without poisoning dedupe', async () => {
    let page2Fetches = 0;
    let page3Attempts = 0;
    const { provider } = albumClient(
      ({ args }) => {
        if (args.continuation === 'a2') {
          page2Fetches += 1;
          return {
            continuationContents: {
              musicShelfContinuation: {
                contents: [songCard('v2', 'Second')],
                continuations: [{ nextContinuationData: { continuation: 'a3' } }],
              },
            },
          };
        }
        if (args.continuation === 'a3') {
          page3Attempts += 1;
          if (page3Attempts === 1) throw new Error('flaky page 3');
          return {
            continuationContents: {
              musicShelfContinuation: { contents: [songCard('v3', 'Third')] },
            },
          };
        }
        return {};
      },
      {
        contents: {
          sectionListRenderer: {
            contents: [
              {
                musicShelfRenderer: trackShelf(
                  [songCard('v1', 'First'), songCard('v1', 'First (reprise)')],
                  'a2',
                ),
              },
            ],
          },
        },
      },
    );

    const detail = await provider.getAlbum('MPRreplay');
    const page2Handle = cont(detail.tracks);
    const page2 = await page2Handle.next();
    expect(page2.items.map((track) => track.title)).toEqual(['Second']);

    const page3Handle = cont(page2);
    await expect(page3Handle.next()).rejects.toThrow('flaky page 3');

    // A repeated traversal from the same frame cursor replays the successful
    // page verbatim (no refetch, no duplicate-drop poisoning) and retries only
    // the failed one.
    const replayed = await page2Handle.next();
    expect(replayed).toBe(page2);
    expect(cont(replayed)).toBe(page3Handle);
    expect(page2Fetches).toBe(1);

    const page3 = await page3Handle.next();
    expect(page3.items.map((track) => track.title)).toEqual(['Third']);
    expect(page3.next).toBeNull();
    expect(page3.limitation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Operation scope: shared initialization, abort, deadline and shutdown
/** The runtime fetch input shape (Bun libs name no RequestInfo). */
type FetchInput = Parameters<typeof fetch>[0];

/** Request URL of any fetch input shape. */
function requestUrl(input: FetchInput): string {
  return input instanceof Request ? input.url : String(input);
}

/** True when the request targets the InnerTube /browse endpoint path. */
function isBrowseRequest(input: FetchInput): boolean {
  try {
    return new URL(requestUrl(input)).pathname.endsWith('/browse');
  } catch {
    return false;
  }
}

interface CapturedFetch {
  url: string;
  signal: AbortSignal | undefined;
}

function hangForever(signal: AbortSignal | undefined): Promise<Response> {
  const { promise, reject } = Promise.withResolvers<Response>();
  // Already-aborted signals reject immediately; listeners never fire
  // retroactively.
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  return promise;
}

describe('runYouTubeOperation', () => {
  const originalFetch = globalThis.fetch;
  const captured: CapturedFetch[] = [];

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    configureYouTubeClientForTests(null);
    await shutdownYouTubeClient();
  });

  test('shares one offline initialization across concurrent operations and isolates aborts', async () => {
    configureYouTubeClientForTests({
      generate_session_locally: true,
      retrieve_player: false,
      retrieve_innertube_config: false,
    });
    captured.length = 0;
    const bothStarted = Promise.withResolvers<void>();
    // Initialization traffic resolves deterministically; only the /browse
    // requests under test hang until aborted.
    globalThis.fetch = ((input: FetchInput, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!isBrowseRequest(input)) return Promise.resolve(new Response('{}'));
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      captured.push({ url, signal });
      if (captured.length === 2) bothStarted.resolve();
      return hangForever(signal);
    }) as typeof fetch;

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const operationA = runYouTubeOperation(controllerA.signal, (client) =>
      client.actions.execute('/browse', { client: 'YTMUSIC', parse: true }),
    );
    const operationB = runYouTubeOperation(controllerB.signal, (client) =>
      client.actions.execute('/browse', { client: 'YTMUSIC', parse: true }),
    );

    await bothStarted.promise;
    // Aborting A aborts only A's captured request, never B's.
    controllerA.abort();
    await expect(operationA).rejects.toThrow();
    expect(captured[0]?.signal?.aborted).toBe(true);
    expect(captured[1]?.signal?.aborted).toBe(false);

    controllerB.abort();
    await expect(operationB).rejects.toThrow();
    expect(captured[1]?.signal?.aborted).toBe(true);
  });

  test('aborts during response-body read and marks the captured request aborted', async () => {
    configureYouTubeClientForTests({
      generate_session_locally: true,
      retrieve_player: false,
      retrieve_innertube_config: false,
    });
    captured.length = 0;
    const streamStarted = Promise.withResolvers<void>();
    globalThis.fetch = ((input: FetchInput, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!isBrowseRequest(input)) return Promise.resolve(new Response('{}'));
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      captured.push({ url, signal });
      let errorStream: ((reason: unknown) => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"contents":{"sectionList'));
          errorStream = (reason: unknown) => controller.error(reason);
          streamStarted.resolve();
        },
      });
      signal?.addEventListener(
        'abort',
        () => {
          errorStream?.(signal.reason);
        },
        { once: true },
      );
      return Promise.resolve(
        new Response(stream, { headers: { 'content-type': 'application/json' } }),
      );
    }) as typeof fetch;

    const controller = new AbortController();
    const operation = runYouTubeOperation(controller.signal, (client) =>
      client.actions.execute('/browse', { client: 'YTMUSIC', parse: true }),
    );
    await streamStarted.promise;
    controller.abort();
    await expect(operation).rejects.toThrow();
    expect(captured[0]?.signal?.aborted).toBe(true);
  });

  test('expires requests past the configured deadline', async () => {
    configureYouTubeClientForTests(
      { generate_session_locally: true, retrieve_player: false, retrieve_innertube_config: false },
      40,
    );
    globalThis.fetch = ((_input: FetchInput, init?: RequestInit) => {
      if (!isBrowseRequest(_input)) {
        return Promise.resolve(new Response('{}'));
      }
      return hangForever(init?.signal ?? (_input instanceof Request ? _input.signal : undefined));
    }) as typeof fetch;

    await expect(
      runYouTubeOperation(undefined, (client) =>
        client.actions.execute('/browse', { client: 'YTMUSIC', parse: true }),
      ),
    ).rejects.toThrow();
  });

  test('shutdown aborts in-flight work, drains, and a later operation recreates the client', async () => {
    configureYouTubeClientForTests({
      generate_session_locally: true,
      retrieve_player: false,
      retrieve_innertube_config: false,
    });
    let requests = 0;
    let browseHangs = true;
    const requestStarted = Promise.withResolvers<void>();
    globalThis.fetch = ((input: FetchInput, init?: RequestInit) => {
      requests += 1;
      // The first generation's browse request is really in flight before
      // shutdown; initialization traffic resolves without touching the network.
      if (isBrowseRequest(input) && browseHangs) {
        requestStarted.resolve();
        return hangForever(init?.signal ?? (input instanceof Request ? input.signal : undefined));
      }
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;

    const first = runYouTubeOperation(undefined, (client) =>
      client.actions.execute('/browse', { client: 'YTMUSIC', parse: true }),
    );
    await requestStarted.promise;
    const drain = shutdownYouTubeClient();
    await expect(first).rejects.toThrow();
    // The drain itself resolves only after verified drainage of init,
    // operations and request/body lifetimes.
    await expect(drain).resolves.toBeUndefined();

    browseHangs = false;
    const second = await runYouTubeOperation(undefined, (client) =>
      client.actions.execute('/browse', { client: 'YTMUSIC', parse: true }),
    );
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(second).toBeDefined();
  });

  test('the request deadline aborts a stalled body read, not just headers', async () => {
    configureYouTubeClientForTests(
      { generate_session_locally: true, retrieve_player: false, retrieve_innertube_config: false },
      40,
    );
    globalThis.fetch = ((input: FetchInput, init?: RequestInit) => {
      if (!isBrowseRequest(input)) {
        return Promise.resolve(new Response('{}'));
      }
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      let errorStream: ((reason: unknown) => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"contents":'));
          errorStream = (reason: unknown) => controller.error(reason);
        },
      });
      signal?.addEventListener(
        'abort',
        () => {
          errorStream?.(signal.reason);
        },
        { once: true },
      );
      return Promise.resolve(
        new Response(stream, { headers: { 'content-type': 'application/json' } }),
      );
    }) as typeof fetch;

    await expect(
      runYouTubeOperation(undefined, (client) =>
        client.actions.execute('/browse', { client: 'YTMUSIC', parse: true }),
      ),
    ).rejects.toThrow();
  });
});
