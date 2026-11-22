import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { createStore } from 'jotai';
import { act } from 'react';
import { getPlaybackSourcePreference } from '../../src/db/queries';
import { episodeToTrack, mediaKey } from '../../src/providers/media';
import type { Episode } from '../../src/providers/podcast-types';
import type {
  AlbumDetail,
  ArtistDetail,
  CatalogPage,
  IProvider,
  ResolvedPlaybackSource,
  Track,
} from '../../src/providers/types';
import { catalogStateAtom } from '../../src/store/catalog';
import { configAtom } from '../../src/store/config';
import {
  playerErrorAtom,
  playerMuteAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerSpeedAtom,
  playerStateAtom,
  playerVolumeAtom,
} from '../../src/store/player';
import { podcastEpisodesAtom } from '../../src/store/podcast';
import { queueStateAtom } from '../../src/store/queue';
import {
  layoutAtom,
  musicViewAtom,
  overlayAtom,
  podcastViewAtom,
  searchResultsAtom,
  sectionAtom,
} from '../../src/store/ui';
import { LAYOUT_ORDER } from '../../src/ui/layouts';
import { CONFIG_PATH, DEFAULT_CONFIG, loadConfig } from '../../src/utils/config';
import { makeTrack, renderTestApp, type TestAppHandle } from '../helpers/app';

const episode: Episode = {
  id: 'episode-guid',
  podcastId: 'https://example.test/feed.xml',
  podcastTitle: 'Test show',
  title: 'Selected episode',
  audioUrl: 'https://example.test/episode.mp3',
  duration: 300,
  publishDate: '2026-01-01',
};

async function command(app: TestAppHandle, query: string): Promise<void> {
  await act(async () => {
    app.mockInput.pressKey('p', { ctrl: true });
  });
  await app.renderOnce();
  await act(async () => {
    await app.mockInput.typeText(query);
  });
  await app.renderOnce();
  await act(async () => {
    app.mockInput.pressEnter();
    await Promise.resolve();
  });
  await app.renderOnce();
}

async function enter(app: TestAppHandle): Promise<void> {
  await act(async () => {
    app.mockInput.pressEnter();
    await Promise.resolve();
  });
  await app.renderOnce();
}

async function escapeUntil(app: TestAppHandle, accepted: () => boolean): Promise<void> {
  const changed = Promise.withResolvers<void>();
  const observe = () => {
    if (accepted()) changed.resolve();
  };
  const unsubscribers = [
    app.store.sub(overlayAtom, observe),
    app.store.sub(catalogStateAtom, observe),
    app.store.sub(musicViewAtom, observe),
  ];
  // Exercise the real legacy-ESC parser's ambiguity timeout, but await its
  // resulting state event rather than guessing a long-enough sleep.
  const deadline = AbortSignal.timeout(1_000);
  const expired = () => changed.reject(new Error('Escape did not reach the expected UI state'));
  deadline.addEventListener('abort', expired, { once: true });
  try {
    await act(async () => {
      app.mockInput.pressEscape();
      await changed.promise;
    });
    await app.renderOnce();
  } finally {
    deadline.removeEventListener('abort', expired);
    for (const unsubscribe of unsubscribers) unsubscribe();
  }
}

function episodeStore() {
  const store = createStore();
  store.set(sectionAtom, 'podcast');
  store.set(podcastViewAtom, 'episodes');
  store.set(podcastEpisodesAtom, [episode]);
  return store;
}

function rssSource(track: Track): ResolvedPlaybackSource {
  if (track.source?.kind !== 'podcast') throw new Error('Expected podcast fixture');
  return { kind: 'rss', url: track.source.episode.audioUrl, selection: 'auto' };
}

function picker(track: Track, id: string, requestId: number | null, selectedIdx = 0) {
  return {
    kind: 'source-picker' as const,
    dialogId: id,
    track,
    expectedRequestId: requestId,
    selectedIdx,
    value: '',
    editing: false,
    busy: false,
    error: null,
  };
}

test('selected episode custom-source input saves for future play without shortcut leaks', async () => {
  const store = episodeStore();
  const app = await renderTestApp({ store });
  const track = episodeToTrack(episode);
  try {
    await command(app, 'source selected');
    expect(store.get(overlayAtom)?.kind).toBe('source-picker');
    await act(async () => {
      app.mockInput.pressArrow('down');
      app.mockInput.pressArrow('down');
      app.mockInput.pressArrow('down');
    });
    await app.renderOnce();
    await enter(app);
    expect(store.get(overlayAtom)).toMatchObject({
      kind: 'source-picker',
      selectedIdx: 3,
      editing: true,
    });
    await act(async () => {
      await app.mockInput.typeText('https://youtu.be/jksmqlr_123');
    });
    await app.renderOnce();
    await enter(app);
    expect(store.get(overlayAtom)).toBeNull();
    expect(getPlaybackSourcePreference(app.db, mediaKey(track))).toEqual({
      mode: 'youtube-video',
      videoId: 'jksmqlr_123',
    });
    expect(app.player.played).toHaveLength(0);
    expect(store.get(queueStateAtom)).toMatchObject({ entries: [], shuffle: false, repeat: 'off' });
    expect(store.get(playerMuteAtom)).toBe(false);
  } finally {
    await app.cleanup();
  }
});

test('current-episode switch preserves controls and commits only on loaded callback', async () => {
  const store = episodeStore();
  const track = episodeToTrack(episode);
  const app = await renderTestApp({
    store,
    resolve: async (item, _signal, preference) =>
      preference?.mode === 'youtube-video'
        ? {
            kind: 'youtube',
            videoId: preference.videoId,
            url: `https://www.youtube.com/watch?v=${preference.videoId}`,
            selection: 'youtube-video',
          }
        : rssSource(item),
  });
  try {
    await act(async () => {
      await app.runtime.playback.playDirect(track);
      app.player.emitLoaded(app.player.played[0]!);
      await app.player.player.togglePause();
      store.set(playerPositionAtom, 42);
      store.set(playerVolumeAtom, 35);
      store.set(playerSpeedAtom, 1.5);
      store.set(playerMuteAtom, true);
    });
    await app.renderOnce();
    await command(app, 'source playing');
    const overlay = store.get(overlayAtom);
    expect(overlay?.kind).toBe('source-picker');
    await act(async () => {
      if (overlay?.kind !== 'source-picker') throw new Error('Source dialog missing');
      store.set(overlayAtom, { ...overlay, selectedIdx: 3, editing: true, value: 'abcdefghijk' });
    });
    await app.renderOnce();
    await enter(app);
    expect(app.player.played).toHaveLength(2);
    expect(app.player.loadOptions[1]).toEqual({ preservePause: true });
    expect(app.player.played[1]?.origin).toEqual(app.player.played[0]?.origin);
    expect(getPlaybackSourcePreference(app.db, mediaKey(track))).toEqual({ mode: 'auto' });
    await act(async () => app.player.emitLoaded(app.player.played[1]!));
    expect(getPlaybackSourcePreference(app.db, mediaKey(track))).toEqual({
      mode: 'youtube-video',
      videoId: 'abcdefghijk',
    });
    expect(store.get(playerStateAtom)).toBe('paused');
    expect(store.get(playerPositionAtom)).toBe(0);
    expect(store.get(playerVolumeAtom)).toBe(35);
    expect(store.get(playerSpeedAtom)).toBe(1.5);
    expect(store.get(playerMuteAtom)).toBe(true);
  } finally {
    await app.cleanup();
  }
});

test('late source-dialog completion cannot close a newer overlay', async () => {
  const store = episodeStore();
  const track = episodeToTrack(episode);
  const deferred = Promise.withResolvers<ResolvedPlaybackSource>();
  const app = await renderTestApp({
    store,
    resolve: async (item, signal, preference) => {
      if (preference?.mode !== 'youtube-match') return rssSource(item);
      signal.addEventListener('abort', () => deferred.reject(signal.reason), { once: true });
      return deferred.promise;
    },
  });
  try {
    await act(async () => {
      await app.runtime.playback.playDirect(track);
      app.player.emitLoaded(app.player.played[0]!);
      store.set(overlayAtom, picker(track, 'old-dialog', app.player.played[0]!.requestId, 2));
    });
    await app.renderOnce();
    await enter(app);
    expect(store.get(overlayAtom)).toMatchObject({ kind: 'source-picker', busy: true });
    await escapeUntil(app, () => store.get(overlayAtom) === null);
    await act(async () => {
      store.set(overlayAtom, { kind: 'help' });
      deferred.resolve({
        kind: 'youtube',
        videoId: 'abcdefghijk',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        selection: 'youtube-match',
      });
      await Promise.resolve();
    });
    await app.renderOnce();
    expect(store.get(overlayAtom)?.kind).toBe('help');
  } finally {
    deferred.resolve(rssSource(track));
    await app.cleanup();
  }
});

test('ASCII chrome remains ASCII in all seven layouts while media Unicode is preserved', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true, reducedMotion: true });
  const track = makeTrack('ascii-track', 'Plain title');
  store.set(searchResultsAtom, { tracks: [track], hasMore: false });
  store.set(playerPlaybackAtom, {
    track,
    source: {
      kind: 'youtube',
      url: 'https://music.youtube.com/watch?v=ascii-track',
      videoId: 'ascii-track',
      selection: 'auto',
    },
    requestId: 100,
    origin: { kind: 'direct' },
  });
  store.set(playerStateAtom, 'paused');
  const app = await renderTestApp({ store });
  try {
    for (const layout of LAYOUT_ORDER) {
      await act(async () => store.set(layoutAtom, layout));
      await app.renderOnce();
      expect(app.captureCharFrame()).not.toMatch(/[^\p{ASCII}]/u);
    }
    await act(async () => {
      store.set(layoutAtom, 'default');
      const target = store.get(playerPlaybackAtom)!;
      store.set(playerPlaybackAtom, {
        ...target,
        track: { ...target.track, title: 'Björk 東京', artist: 'Rosé' },
      });
    });
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain('Björk');
    expect(app.captureCharFrame()).toContain('東京');
    expect(app.captureCharFrame()).toContain('Rosé');
  } finally {
    await app.cleanup();
  }
});

test('display toggles retain independent persisted values and do not play anything', async () => {
  const store = createStore();
  const app = await renderTestApp({ store });
  try {
    await command(app, 'toggle ascii');
    await command(app, 'toggle icon style');
    await command(app, 'toggle reduced motion');
    await command(app, 'toggle audio spectrum');
    expect(store.get(configAtom)).toMatchObject({
      ascii: true,
      iconStyle: 'unicode',
      reducedMotion: true,
      spectrumEnabled: true,
    });
    expect(loadConfig()).toMatchObject({
      ascii: true,
      iconStyle: 'unicode',
      reducedMotion: true,
      spectrumEnabled: true,
    });
    expect(app.player.played).toHaveLength(0);
    await command(app, 'toggle reduced motion');
    expect(store.get(configAtom)).toMatchObject({
      ascii: true,
      reducedMotion: false,
      spectrumEnabled: true,
    });
    await command(app, 'toggle ascii');
    expect(loadConfig()).toMatchObject({ ascii: false, iconStyle: 'unicode' });
  } finally {
    await app.cleanup();
    rmSync(CONFIG_PATH, { force: true });
  }
});

test('rapid palette commands retain independent settings before React rerenders', async () => {
  const store = createStore();
  const app = await renderTestApp({ store });
  try {
    await act(async () => {
      for (const filter of ['toggle ascii', 'toggle reduced motion', 'toggle audio spectrum']) {
        store.set(overlayAtom, { kind: 'command-palette', filter, selectedIdx: 0 });
        app.mockInput.pressEnter();
      }
      await Promise.resolve();
    });
    await app.renderOnce();
    expect(store.get(configAtom)).toMatchObject({
      ascii: true,
      reducedMotion: true,
      spectrumEnabled: true,
    });
    expect(loadConfig()).toMatchObject({ ascii: true, reducedMotion: true, spectrumEnabled: true });
    expect(app.player.played).toHaveLength(0);
  } finally {
    await app.cleanup();
    rmSync(CONFIG_PATH, { force: true });
  }
});

test('failed display-setting persistence leaves the applied mode unchanged', async () => {
  const store = createStore();
  const app = await renderTestApp({ store });
  rmSync(CONFIG_PATH, { force: true });
  mkdirSync(CONFIG_PATH);
  try {
    await command(app, 'toggle ascii');
    expect(store.get(configAtom).ascii).toBe(false);
    expect(store.get(playerErrorAtom)).toContain('EISDIR');
    expect(app.captureCharFrame()).toContain('EISDIR');
  } finally {
    rmSync(CONFIG_PATH, { recursive: true, force: true });
    await app.cleanup();
  }
});

function page<T>(items: T[]): CatalogPage<T> {
  return { items, next: null, limitation: null };
}

test('real App drills into artist releases, plays complete album, and restores back selection', async () => {
  const track = { ...makeTrack('song-1', 'First song'), artistId: 'UCartist', albumId: 'MPRalbum' };
  const nextTrack = {
    ...makeTrack('song-2', 'Second song'),
    artistId: 'UCartist',
    albumId: 'MPRalbum',
  };
  const album: AlbumDetail = {
    id: 'MPRalbum',
    title: 'First album',
    artist: 'Catalog artist',
    artistId: 'UCartist',
    tracks: page([track, nextTrack]),
  };
  const artist: ArtistDetail = {
    id: 'UCartist',
    name: 'Catalog artist',
    albums: page([album]),
    singles: page([]),
    topTracks: page([track]),
  };
  const music: IProvider = {
    id: 'test-music',
    name: 'Catalog test',
    icon: '',
    search: async () => ({ tracks: [track], hasMore: false }),
    getTrack: async () => track,
    getStreamUrl: async () => '',
    getArtist: async () => artist,
    getAlbum: async () => album,
  };
  const store = createStore();
  store.set(searchResultsAtom, { tracks: [track], hasMore: false });
  const app = await renderTestApp({ store, music });
  try {
    await act(async () => app.runtime.playback.enqueue(makeTrack('existing', 'Already queued')));
    await command(app, 'open primary artist');
    expect(store.get(musicViewAtom)).toBe('catalog');
    expect(app.captureCharFrame()).toContain('Catalog artist');
    expect(app.captureCharFrame()).toContain('First album');
    await enter(app);
    expect(app.captureCharFrame()).toContain('First song');
    await command(app, 'play album');
    expect(store.get(queueStateAtom).entries.map((entry) => entry.track.id)).toEqual([
      'existing',
      'song-1',
      'song-2',
    ]);
    expect(app.player.played[app.player.played.length - 1]?.track.id).toBe('song-1');
    expect(app.player.played[app.player.played.length - 1]?.origin.kind).toBe('queue');
    await escapeUntil(app, () => store.get(catalogStateAtom).frames.length === 1);
    expect(app.captureCharFrame()).toContain('First album');
    await escapeUntil(app, () => store.get(catalogStateAtom).frames.length === 0);
    expect(store.get(musicViewAtom)).toBe('search');
    expect(app.captureCharFrame()).toContain('First song');
  } finally {
    await app.cleanup();
  }
});
