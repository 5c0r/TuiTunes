import { expect, test } from 'bun:test';
import { ScrollBoxRenderable } from '@opentui/core';
import { createStore } from 'jotai';
import { act } from 'react';
import { PodcastProvider } from '../../src/providers/podcast';
import type { AlbumDetail, ArtistDetail } from '../../src/providers/types';
import { catalogFrameAtom, catalogIndexAtom } from '../../src/store/catalog';
import { configAtom } from '../../src/store/config';
import { playerMuteAtom, playerStateAtom } from '../../src/store/player';
import { queueSelectionIdAtom, queueStateAtom } from '../../src/store/queue';
import {
  focusedPanelAtom,
  layoutAtom,
  musicViewAtom,
  overlayAtom,
  podcastViewAtom,
  searchQueryAtom,
  searchResultsAtom,
  searchSuggestionsAtom,
  sectionAtom,
  suggestionsVisibleAtom,
} from '../../src/store/ui';
import { DEFAULT_CONFIG } from '../../src/utils/config';
import {
  itunesSearchBody,
  makeTrack,
  renderTestApp,
  type TestAppHandle,
  testMusicProvider,
} from '../helpers/app';
import { createTestPlayer } from '../helpers/player';

function mouseStore() {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  return store;
}

/** Coordinate of rendered ASCII fixture text, not a layout-tree assumption. */
function point(app: TestAppHandle, text: string, occurrence = 0): [number, number] {
  const frame = app.captureCharFrame();
  const lines = frame.split('\n');
  for (let y = 0; y < lines.length; y += 1) {
    const x = lines[y].indexOf(text);
    if (x >= 0 && occurrence-- === 0) return [x, y];
  }
  throw new Error(`Missing mouse fixture ${text} in:\n${frame}`);
}

async function click(app: TestAppHandle, text: string, occurrence = 0): Promise<void> {
  await act(async () => app.mockMouse.click(...point(app, text, occurrence)));
  await app.renderOnce();
}

async function doubleClick(app: TestAppHandle, text: string, occurrence = 0): Promise<void> {
  await act(async () => app.mockMouse.doubleClick(...point(app, text, occurrence)));
  await app.renderOnce();
}

async function enter(app: TestAppHandle): Promise<void> {
  await act(async () => app.mockInput.pressEnter());
  await app.renderOnce();
}

test('mouse focuses the real search input and a suggestion submits exactly one search', async () => {
  const store = mouseStore();
  const queries: string[] = [];
  const app = await renderTestApp({
    store,
    music: {
      ...testMusicProvider,
      async search(query) {
        queries.push(query);
        return { tracks: [makeTrack('chosen', 'Chosen result')], hasMore: false };
      },
    },
  });
  try {
    await app.renderOnce();
    await click(app, 'Search music...');
    await act(async () => app.mockInput.typeText('mqf'));
    expect(store.get(searchQueryAtom)).toBe('mqf');
    expect(store.get(queueStateAtom).entries).toEqual([]);
    expect(app.player.played).toEqual([]);

    await act(async () => {
      store.set(searchSuggestionsAtom, ['mouse suggestion', 'another suggestion']);
      store.set(suggestionsVisibleAtom, true);
    });
    await app.renderOnce();
    await click(app, 'mouse suggestion');
    expect(queries).toEqual(['mouse suggestion']);
    expect(store.get(focusedPanelAtom)).toBe('main');
    expect(store.get(searchQueryAtom)).toBe('mouse suggestion');
    expect(app.captureCharFrame()).not.toContain('another suggestion');
    expect(app.captureCharFrame()).toContain('Chosen result');
  } finally {
    await app.cleanup();
  }
});

test('different rows and drags do not activate; a repeated click plays the rendered row', async () => {
  const store = mouseStore();
  const tracks = [makeTrack('one', 'First result'), makeTrack('two', 'Second result')];
  store.set(searchResultsAtom, { tracks, hasMore: false });
  const app = await renderTestApp({ store });
  try {
    await app.renderOnce();
    await click(app, 'First result');
    await click(app, 'Second result');
    expect(app.player.played).toEqual([]);

    const [x, y] = point(app, 'Second result');
    await act(async () => app.mockMouse.drag(x, y, x + 5, y));
    await click(app, 'Second result');
    expect(app.player.played).toEqual([]);
    await enter(app);
    expect(app.player.played.map((target) => target.track.id)).toEqual(['two']);

    await doubleClick(app, 'First result');
    expect(app.player.played.map((target) => target.track.id)).toEqual(['two', 'one']);

    const replacement = makeTrack('replacement', 'Replacement row');
    await act(async () => app.mockMouse.pressDown(...point(app, 'First result')));
    await act(async () => store.set(searchResultsAtom, { tracks: [replacement], hasMore: false }));
    await app.renderOnce();
    await act(async () => app.mockMouse.release(...point(app, 'Replacement row')));
    await click(app, 'Replacement row');
    expect(app.player.played.map((target) => target.track.id)).toEqual(['two', 'one']);
  } finally {
    await app.cleanup();
  }
});

test('visible split and wide queue panes select duplicates by entry ID without stealing the results view', async () => {
  const store = mouseStore();
  const twin = makeTrack('twinned', 'Queue twin');
  const result = makeTrack('right', 'Right result');
  const app = await renderTestApp({ store });
  try {
    await act(async () => {
      app.runtime.playback.enqueue(twin);
      app.runtime.playback.enqueue(twin);
      store.set(searchResultsAtom, { tracks: [result], hasMore: false });
      store.set(layoutAtom, 'split');
    });
    await app.renderOnce();
    const [first, second] = store.get(queueStateAtom).entries;
    await click(app, 'Queue twin', 1);
    expect(store.get(queueSelectionIdAtom)).toBe(second.entryId);
    expect(store.get(musicViewAtom)).toBe('search');
    expect(app.player.played).toEqual([]);
    await enter(app);
    expect(app.player.played[0]?.origin).toEqual({ kind: 'queue', entryId: second.entryId });
    await doubleClick(app, 'Right result');
    expect(app.player.played[1]?.origin).toEqual({ kind: 'direct' });
    expect(app.player.played[1]?.track.id).toBe(result.id);

    await act(async () => store.set(layoutAtom, 'wide'));
    await app.renderOnce();
    await doubleClick(app, 'Queue twin');
    expect(app.player.played[2]?.origin).toEqual({ kind: 'queue', entryId: first.entryId });
  } finally {
    await app.cleanup();
  }
});

test('visible playback buttons run the same App commands as the keyboard', async () => {
  const store = mouseStore();
  const base = createTestPlayer(store);
  const seeks: number[] = [];
  const app = await renderTestApp({
    store,
    player: {
      ...base.player,
      async toggleMute() {
        store.set(playerMuteAtom, (muted) => !muted);
      },
      async seekAbsolute(seconds) {
        seeks.push(seconds);
        throw new Error('Fixture seek could not complete');
      },
    },
  });
  try {
    const first = makeTrack('queue-a', 'Queue audio A');
    const second = makeTrack('queue-b', 'Queue audio B');
    await act(async () => {
      app.runtime.playback.enqueue(first);
      app.runtime.playback.enqueue(second);
      await app.runtime.playback.playQueueEntry(store.get(queueStateAtom).entries[0].entryId);
      base.emitLoaded(base.played[0]);
      base.emitPosition(20, { duration: 80 });
    });
    await app.renderOnce();
    await click(app, '======');
    expect(seeks).toEqual([0]);
    expect(app.captureCharFrame()).toContain('Fixture seek could not complete');
    await click(app, 'Pause');
    expect(store.get(playerStateAtom)).toBe('paused');
    await click(app, 'Mute');
    expect(store.get(playerMuteAtom)).toBe(true);
    await click(app, 'Next');
    expect(base.played.map((target) => target.track.id)).toEqual(['queue-a', 'queue-b']);

    await act(async () => app.mockInput.pressKey('p'));
    expect(base.played.map((target) => target.track.id)).toEqual(['queue-a', 'queue-b', 'queue-a']);
    await act(async () => app.runtime.playback.playDirect(makeTrack('direct', 'Direct audio')));
    await app.renderOnce();
    await click(app, 'Next');
    expect(base.played.map((target) => target.track.id)).toEqual([
      'queue-a',
      'queue-b',
      'queue-a',
      'direct',
    ]);
    expect(store.get(queueStateAtom).cursorId).toBeNull();
  } finally {
    await app.cleanup();
  }
});

test('tabs, sidebar and podcast results open the same feed as Enter', async () => {
  const store = mouseStore();
  const pod = {
    id: '17',
    title: 'Mouse podcast',
    author: 'Host',
    feedUrl: 'https://feed.test/mouse',
  };
  const requests: string[] = [];
  const app = await renderTestApp({
    store,
    podcasts: new PodcastProvider(async (input) => {
      const url = String(input);
      requests.push(url);
      return new Response(
        url === pod.feedUrl
          ? '<rss><channel><title>Mouse podcast</title><item><guid>ep</guid><title>Mouse episode</title><enclosure url="https://feed.test/episode.mp3" type="audio/mpeg"/></item></channel></rss>'
          : itunesSearchBody([pod]),
      );
    }),
  });
  try {
    await app.renderOnce();
    await click(app, 'Podcast');
    expect(store.get(sectionAtom)).toBe('podcast');
    await click(app, 'Search', 1);
    expect(store.get(podcastViewAtom)).toBe('search');
    await click(app, 'Search podcasts...');
    await act(async () => app.mockInput.typeText('mouse'));
    await enter(app);
    await doubleClick(app, 'Mouse podcast');
    expect(requests.filter((url) => url === pod.feedUrl)).toEqual([pod.feedUrl]);
    expect(store.get(podcastViewAtom)).toBe('episodes');
    expect(app.captureCharFrame()).toContain('Mouse episode');
  } finally {
    await app.cleanup();
  }
});

test('a modal blocks blank-area clicks and wheel while scrolled rows still activate correctly afterward', async () => {
  const store = mouseStore();
  const tracks = Array.from({ length: 30 }, (_, index) =>
    makeTrack(`row-${index}`, `Mouse result ${String(index).padStart(2, '0')}`),
  );
  store.set(searchResultsAtom, { tracks, hasMore: false });
  const app = await renderTestApp({ store });
  try {
    await app.renderOnce();
    const row = app.renderer.root.findDescendantById('track-row-0');
    let scrollbox = row?.parent;
    while (scrollbox && !(scrollbox instanceof ScrollBoxRenderable)) scrollbox = scrollbox.parent;
    if (!(scrollbox instanceof ScrollBoxRenderable)) throw new Error('Missing results scrollbox');
    const rowPoint = point(app, 'Mouse result 04');
    const input = point(app, 'Search music...');
    await act(async () => store.set(overlayAtom, { kind: 'quit-confirm' }));
    await app.renderOnce();
    await act(async () => {
      await app.mockMouse.doubleClick(...rowPoint);
      await app.mockMouse.scroll(...rowPoint, 'down');
      await app.mockMouse.click(...input);
    });
    await app.renderOnce();
    expect(scrollbox.scrollTop).toBe(0);
    expect(store.get(focusedPanelAtom)).toBe('main');
    expect(app.player.played).toEqual([]);
    await act(async () => app.mockInput.pressKey('n'));
    await app.renderOnce();
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await app.mockMouse.scroll(...rowPoint, 'down');
    });
    await app.renderOnce();
    expect(scrollbox.scrollTop).toBeGreaterThan(0);
    const visible = app.captureCharFrame().match(/Mouse result (\d\d)/)?.[1];
    expect(visible).toBeDefined();
    await doubleClick(app, `Mouse result ${visible}`);
    expect(app.player.played[0]?.track.id).toBe(`row-${Number(visible)}`);
  } finally {
    await app.cleanup();
  }
});

test('catalog tabs and album cards preserve selection without activating on the first press', async () => {
  const store = mouseStore();
  const song = makeTrack('catalog-song', 'Catalog song');
  const album: AlbumDetail = {
    id: 'clicked-album',
    title: 'Clickable album',
    artist: 'Catalog artist',
    tracks: { items: [song], next: null, limitation: null },
  };
  const artist: ArtistDetail = {
    id: 'mouse-artist',
    name: 'Catalog artist',
    albums: {
      items: [{ ...album, id: 'other-album', title: 'Other album' }, album],
      next: null,
      limitation: null,
    },
    singles: { items: [], next: null, limitation: null },
    topTracks: { items: [song], next: null, limitation: null },
  };
  const app = await renderTestApp({
    store,
    music: { ...testMusicProvider, getArtist: async () => artist, getAlbum: async () => album },
  });
  try {
    await act(async () => app.runtime.catalog.openArtist(artist.id));
    await app.renderOnce();
    await click(app, 'Top songs');
    expect(store.get(catalogFrameAtom)).toMatchObject({ activeTab: 'songs' });
    await click(app, 'Albums');
    await click(app, 'Clickable album');
    expect(store.get(catalogFrameAtom)?.kind).toBe('artist');
    expect(store.get(catalogIndexAtom)).toBe(1);
    await doubleClick(app, 'Clickable album');
    expect(store.get(catalogFrameAtom)).toMatchObject({ kind: 'album', albumId: album.id });
    expect(app.captureCharFrame()).toContain('Catalog song');
  } finally {
    await app.cleanup();
  }
});
