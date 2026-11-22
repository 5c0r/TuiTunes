import { expect, test, vi } from 'bun:test';
import { KeyEvent } from '@opentui/core';
import type { MockInput } from '@opentui/core/testing';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { act } from 'react';
import {
  dispatchKey,
  type KeyboardActions,
  type KeyboardState,
} from '../../src/application/keyboard';
import { getFavorites } from '../../src/db/queries';
import type { PlayerPort } from '../../src/player/controller';
import type {
  IProvider,
  PlaybackTarget,
  SearchContinuation,
  SearchResult,
} from '../../src/providers/types';
import { favoritesSetAtom } from '../../src/store/library';
import { lyricsDocumentAtom, lyricsVisibleAtom } from '../../src/store/lyrics';
import { episodesLoadingAtom } from '../../src/store/podcast';
import { queueStateAtom } from '../../src/store/queue';
import {
  focusedPanelAtom,
  musicViewAtom,
  overlayAtom,
  podcastViewAtom,
  searchContinuationAtom,
  searchHasMoreAtom,
  searchQueryAtom,
  sectionAtom,
} from '../../src/store/ui';
import { createDeferredPodcasts, itunesSearchBody, makeTrack, renderTestApp } from '../helpers/app';
import { createTestPlayer } from '../helpers/player';

const musicSearches: Array<{ query: string; hasMore: boolean }> = [];

const music: IProvider = {
  id: 'keyboard-test',
  name: 'Keyboard test',
  icon: '',
  search: async (query): Promise<SearchResult> => {
    musicSearches.push({ query, hasMore: false });
    return { tracks: [makeTrack('result', query)], hasMore: false };
  },
  getTrack: async (id) => makeTrack(id),
  getStreamUrl: async () => '',
  getSearchSuggestions: async () => ['alpha', 'beta'],
};

function countingPlayer(
  store: Store,
  counted: Array<'toggleMute' | 'seekRelative' | 'seekAbsolute'>,
): { player: PlayerPort; counts: Map<string, number[]>; played: PlaybackTarget[] } {
  const base = createTestPlayer(store);
  const counts = new Map<string, number[]>(counted.map((name) => [name, []]));
  const player: PlayerPort = { ...base.player };
  for (const name of counted) {
    const calls = counts.get(name) ?? [];
    if (name === 'toggleMute') {
      player.toggleMute = async () => {
        calls.push(1);
      };
    } else if (name === 'seekRelative') {
      player.seekRelative = async (delta) => {
        calls.push(delta);
      };
    } else {
      player.seekAbsolute = async (position) => {
        calls.push(position);
      };
    }
  }
  return { player, counts, played: base.played };
}

async function typeQuery(mockInput: MockInput, renderOnce: () => Promise<void>, query: string) {
  await act(async () => {
    await mockInput.typeText(query);
  });
  await renderOnce();
}

async function pressEnter(mockInput: MockInput) {
  await act(async () => {
    mockInput.pressEnter();
    await Promise.resolve();
  });
}

async function escapeOverlay(store: Store, mockInput: MockInput): Promise<void> {
  await act(async () => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error('Escape did not close overlay')), 1000);
    const unsubscribe = store.sub(overlayAtom, () => {
      if (store.get(overlayAtom) === null) resolve();
    });
    mockInput.pressEscape();
    try {
      await promise;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  });
}

/** Runs a full search so the main list has a selectable result row. */
async function searchFor(
  store: Store,
  mockInput: MockInput,
  renderOnce: () => Promise<void>,
  query: string,
) {
  await act(async () => {
    store.set(focusedPanelAtom, 'search');
  });
  await renderOnce();
  await typeQuery(mockInput, renderOnce, query);
  await pressEnter(mockInput);
  await act(async () => {
    await Bun.sleep(0);
  });
  await renderOnce();
}

test('palette Enter on Mute toggles mute exactly once', async () => {
  const store = createStore();
  const counter = countingPlayer(store, ['toggleMute']);
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    player: counter.player,
    music,
  });

  try {
    await act(async () => {
      mockInput.pressKey('p', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Command Palette');

    await typeQuery(mockInput, renderOnce, 'mute');
    expect(captureCharFrame()).toContain('Toggle Mute');
    await pressEnter(mockInput);
    await renderOnce();

    expect(counter.counts.get('toggleMute')).toEqual([1]);
    expect(captureCharFrame()).not.toContain('Command Palette');
  } finally {
    await cleanup();
  }
});

test('Ctrl+Q with a selected track opens quit dialog without queue mutation', async () => {
  const store = createStore();
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    music,
  });
  try {
    await searchFor(store, mockInput, renderOnce, 'song');

    await act(async () => {
      mockInput.pressKey('q', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();

    expect(captureCharFrame()).toContain('Quit TuiTunes?');
    expect(store.get(queueStateAtom).entries).toHaveLength(0);
    expect(store.get(favoritesSetAtom).size).toBe(0);

    await escapeOverlay(store, mockInput);
    await renderOnce();
    expect(captureCharFrame()).not.toContain('Quit TuiTunes?');
  } finally {
    await cleanup();
  }
});

test('quit confirmation accepts y and ignores other application keys', async () => {
  const store = createStore();
  let quits = 0;
  const counter = countingPlayer(store, ['toggleMute']);
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    player: counter.player,
    music,
    onQuit: () => {
      quits++;
    },
  });

  try {
    await act(async () => {
      mockInput.pressKey('q', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Quit TuiTunes?');

    await act(async () => {
      mockInput.pressKey('m');
      mockInput.pressKey('x');
      await Promise.resolve();
    });
    await renderOnce();
    expect(counter.counts.get('toggleMute')).toEqual([]);
    expect(captureCharFrame()).toContain('Quit TuiTunes?');

    await act(async () => {
      mockInput.pressKey('y');
      await Promise.resolve();
    });
    expect(quits).toBe(1);
  } finally {
    await cleanup();
  }
});

test('Ctrl+F opens transcript search with data, seeks on Enter, never favorites', async () => {
  const store = createStore();
  store.set(lyricsDocumentAtom, {
    mediaKey: 'keyboard-test-media',
    sourceKey: 'test',
    contentHash: 'test-hash',
    original: {
      lines: [
        { time: 12, text: 'needle lyric' },
        { time: 40, text: 'other line' },
      ],
      synced: false,
      source: 'test',
    },
  });
  const counter = countingPlayer(store, ['seekAbsolute']);
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    player: counter.player,
    music,
  });

  try {
    await act(async () => {
      mockInput.pressKey('f', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();

    expect(captureCharFrame()).toContain('Find:');
    expect(store.get(favoritesSetAtom).size).toBe(0);
    expect(store.get(lyricsVisibleAtom)).toBe(true);

    await typeQuery(mockInput, renderOnce, 'nee');
    await pressEnter(mockInput);
    await renderOnce();

    expect(counter.counts.get('seekAbsolute')).toEqual([12]);
    expect(store.get(favoritesSetAtom).size).toBe(0);
    expect(captureCharFrame()).not.toContain('Find:');
  } finally {
    await cleanup();
  }
});

test('Ctrl+F without transcript data is consumed and never toggles favorites', async () => {
  const store = createStore();
  const { mockInput, renderOnce, cleanup } = await renderTestApp({ store, music });

  try {
    await act(async () => {
      mockInput.pressKey('f', { ctrl: true });
      mockInput.pressKey('f');
      await Promise.resolve();
    });
    await renderOnce();

    expect(store.get(overlayAtom)).toBeNull();
    expect(store.get(favoritesSetAtom).size).toBe(0);
  } finally {
    await cleanup();
  }
});

test('Enter on a highlighted suggestion searches once and keeps suggestions closed', async () => {
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const searchesBefore = musicSearches.length;
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    music,
  });
  vi.useFakeTimers();

  try {
    await typeQuery(mockInput, renderOnce, 'al');
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('alpha');
    expect(captureCharFrame()).toContain('beta');

    await act(async () => {
      mockInput.pressArrow('down');
      await Promise.resolve();
    });
    await renderOnce();
    await pressEnter(mockInput);
    await act(async () => {
      // React wrote the chosen text to the input. It must not queue new suggestions.
      vi.advanceTimersByTime(250);
    });
    await renderOnce();

    expect(musicSearches.slice(searchesBefore)).toEqual([{ query: 'alpha', hasMore: false }]);
    expect(store.get(searchQueryAtom)).toBe('alpha');
    expect(captureCharFrame()).toContain('alpha');
    expect(captureCharFrame()).not.toContain('beta');
  } finally {
    vi.useRealTimers();
    await cleanup();
  }
});

test('typing m, q, and f in the focused search input performs no application action', async () => {
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const counter = countingPlayer(store, ['toggleMute']);
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    player: counter.player,
    music,
  });

  try {
    await typeQuery(mockInput, renderOnce, 'mqf');

    expect(captureCharFrame()).toContain('mqf');
    expect(counter.counts.get('toggleMute')).toEqual([]);
    expect(store.get(queueStateAtom).entries).toHaveLength(0);
    expect(store.get(favoritesSetAtom).size).toBe(0);
  } finally {
    await cleanup();
  }
});

test('Tab followed immediately by a key cannot leak into playback commands', async () => {
  const store = createStore();
  store.set(focusedPanelAtom, 'search');
  const counter = countingPlayer(store, ['toggleMute']);
  const { mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    player: counter.player,
    music,
  });

  try {
    await act(async () => {
      mockInput.pressTab();
      mockInput.pressKey('m');
      await Promise.resolve();
    });
    expect(counter.counts.get('toggleMute')).toEqual([]);

    await renderOnce();
    expect(store.get(focusedPanelAtom)).toBe('main');

    await act(async () => {
      mockInput.pressKey('m');
      await Promise.resolve();
    });
    expect(counter.counts.get('toggleMute')).toEqual([1]);
  } finally {
    await cleanup();
  }
});

test('Ctrl+P cannot replace another blocking overlay', async () => {
  const store = createStore();
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    music,
  });

  try {
    await act(async () => {
      mockInput.pressKey('t');
      await Promise.resolve();
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Jump to Time');

    await act(async () => {
      mockInput.pressKey('p', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();

    expect(captureCharFrame()).toContain('Jump to Time');
    expect(captureCharFrame()).not.toContain('Command Palette');

    await escapeOverlay(store, mockInput);
    await renderOnce();
    expect(captureCharFrame()).not.toContain('Jump to Time');
  } finally {
    await cleanup();
  }
});

test('seek symbols seek through the real App', async () => {
  const store = createStore();
  const counter = countingPlayer(store, ['seekRelative']);
  const { mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    player: counter.player,
    music,
  });

  try {
    await act(async () => {
      mockInput.pressKey('>');
      mockInput.pressKey('<');
      await Promise.resolve();
    });
    await renderOnce();

    expect(counter.counts.get('seekRelative')).toEqual([10, -10]);
  } finally {
    await cleanup();
  }
});

test('dispatcher accepts shifted-name key encodings for symbols and letters', () => {
  const commands: string[] = [];
  const overlayKinds: string[] = [];
  const navigations: string[] = [];
  const actions: KeyboardActions = {
    command: (id: string): void => {
      commands.push(id);
    },
    setOverlay: (overlay) => {
      overlayKinds.push(overlay?.kind ?? 'null');
      state.overlay = overlay;
    },
    navigate: (direction: string): void => {
      navigations.push(direction);
    },
    setFocus: () => {},
    activateSelection: () => {},
    changeCatalogTab: () => {},
    setSuggestionIndex: () => {},
    clearSuggestions: () => {},
    submitSearch: () => {},
    submitOverlay: () => {},
  };
  const state: KeyboardState = {
    overlay: null,
    focusedPanel: 'main',
    section: 'music',
    musicView: 'search',
    podcastView: 'feeds',
    catalogKind: null,
    hasSelection: true,
    hasTranscript: false,
    transcriptMatchCount: 0,
    suggestions: [],
    suggestionIndex: -1,
    searchQuery: '',
    searchInputFocused: false,
  };
  const key = (name: string, shift: boolean) =>
    new KeyEvent({
      name,
      shift,
      ctrl: false,
      meta: false,
      option: false,
      sequence: name,
      raw: name,
      number: false,
      eventType: 'press',
      source: 'raw',
    });

  expect(dispatchKey(key('.', true), state, actions)).toBe(true);
  expect(dispatchKey(key(',', true), state, actions)).toBe(true);
  expect(dispatchKey(key('l', true), state, actions)).toBe(true);
  expect(dispatchKey(key('g', true), state, actions)).toBe(true);
  expect(dispatchKey(key('G', false), state, actions)).toBe(true);
  expect(dispatchKey(key('/', true), state, actions)).toBe(true);
  expect(dispatchKey(key('?', false), state, actions)).toBe(true);
  expect(commands).toEqual(['seek-forward', 'seek-backward', 'load-more']);
  expect(navigations).toEqual(['last', 'last']);
  expect(overlayKinds).toEqual(['help', 'null']);
});

test('? opens help and escape closes it', async () => {
  const store = createStore();
  const { captureCharFrame, mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    music,
  });

  try {
    await act(async () => {
      mockInput.pressKey('?');
      await Promise.resolve();
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Keybindings');

    await escapeOverlay(store, mockInput);
    await renderOnce();
    expect(captureCharFrame()).not.toContain('Keybindings');
  } finally {
    await cleanup();
  }
});

test('Shift+L is load-more in both encodings; plain l toggles lyrics', async () => {
  const store = createStore();
  const { mockInput, renderOnce, cleanup } = await renderTestApp({ store, music });

  try {
    await act(async () => {
      mockInput.pressKey('l', { shift: true });
      mockInput.pressKey('L');
      await Promise.resolve();
    });
    await renderOnce();
    expect(store.get(lyricsVisibleAtom)).toBe(false);

    await act(async () => {
      mockInput.pressKey('l');
      await Promise.resolve();
    });
    await renderOnce();
    expect(store.get(lyricsVisibleAtom)).toBe(true);
  } finally {
    await cleanup();
  }
});

test('Enter on a selected search result plays it as a direct playback target', async () => {
  const store = createStore();
  const counter = countingPlayer(store, []);
  const { mockInput, renderOnce, cleanup } = await renderTestApp({
    store,
    player: counter.player,
    music,
  });

  try {
    await searchFor(store, mockInput, renderOnce, 'song');
    await pressEnter(mockInput);
    await act(async () => {
      await Bun.sleep(0);
    });
    await renderOnce();

    const played = counter.played;
    expect(played).toHaveLength(1);
    expect(played[0]?.track.id).toBe('result');
    expect(played[0]?.origin.kind).toBe('direct');
  } finally {
    await cleanup();
  }
});

test('palette wires queue-add, favorite, queue-remove, and podcast-search to real operations', async () => {
  const store = createStore();
  const { db, mockInput, renderOnce, cleanup } = await renderTestApp({ store, music });

  async function paletteRun(filter: string) {
    await act(async () => {
      mockInput.pressKey('p', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();
    await typeQuery(mockInput, renderOnce, filter);
    await pressEnter(mockInput);
    await renderOnce();
  }

  try {
    await searchFor(store, mockInput, renderOnce, 'song');

    await paletteRun('add to queue');
    expect(store.get(queueStateAtom).entries).toHaveLength(1);

    await paletteRun('toggle favorite');
    expect(getFavorites(db)).toHaveLength(1);

    await act(async () => {
      store.set(musicViewAtom, 'queue');
    });
    await renderOnce();
    await paletteRun('remove from queue');
    expect(store.get(queueStateAtom).entries).toHaveLength(0);

    await paletteRun('search podcasts');
    expect(store.get(sectionAtom)).toBe('podcast');
    expect(store.get(podcastViewAtom)).toBe('search');
    expect(store.get(focusedPanelAtom)).toBe('search');
  } finally {
    await cleanup();
  }
});

test('palette load-more continues the retained search', async () => {
  const store = createStore();
  const continuation: SearchContinuation = {
    next: async () => ({ tracks: [], hasMore: false }),
  };
  const { mockInput, renderOnce, cleanup } = await renderTestApp({ store, music });

  try {
    await searchFor(store, mockInput, renderOnce, 'song');
    await act(async () => {
      store.set(searchHasMoreAtom, true);
      store.set(searchContinuationAtom, continuation);
    });
    await renderOnce();

    const searchesBefore = musicSearches.length;
    await act(async () => {
      mockInput.pressKey('p', { ctrl: true });
      await Promise.resolve();
    });
    await renderOnce();
    await typeQuery(mockInput, renderOnce, 'load more');
    await pressEnter(mockInput);
    await act(async () => {
      await Bun.sleep(0);
    });
    await renderOnce();

    expect(musicSearches.length).toBe(searchesBefore + 1);
    expect(musicSearches[musicSearches.length - 1]?.query).toBe('');
  } finally {
    await cleanup();
  }
});

test('opening a populated podcast feed keeps the search bar visible and editable', async () => {
  const podcast = {
    id: '1',
    title: 'A podcast with a title that wraps in a narrow terminal',
    author: 'Author',
    feedUrl: 'https://example.test/1.xml',
  };
  const { provider: podcasts, requests } = createDeferredPodcasts();
  const store = createStore();
  store.set(sectionAtom, 'podcast');
  store.set(focusedPanelAtom, 'search');
  const { captureCharFrame, mockInput, renderOnce, resize, cleanup } = await renderTestApp({
    store,
    podcasts,
  });

  try {
    await act(async () => resize(60, 18));
    await typeQuery(mockInput, renderOnce, 'podcast query');
    await pressEnter(mockInput);
    await act(async () => {
      requests[0]?.respond(itunesSearchBody([podcast]));
      await Bun.sleep(0);
    });
    await renderOnce();
    expect(store.get(focusedPanelAtom)).toBe('main');

    await pressEnter(mockInput);
    await act(async () => {
      const items = Array.from(
        { length: 50 },
        (_, index) =>
          `<item><guid>${index}</guid><title>Episode ${index}</title><enclosure url="https://example.test/${index}.mp3" /></item>`,
      );
      requests[1]?.respond(`<rss version="2.0"><channel>${items.join('')}</channel></rss>`);
      await Bun.sleep(0);
    });
    await renderOnce();

    expect(store.get(podcastViewAtom)).toBe('episodes');
    expect(store.get(episodesLoadingAtom)).toBe(false);
    expect(captureCharFrame()).toContain('Episode 0');
    const headerLine = () => captureCharFrame().split('\n')[1];
    expect(headerLine()).toContain('TuiTunes');
    expect(headerLine()).toContain('podcast query');
    await act(async () => {
      mockInput.pressKey('/');
    });
    await renderOnce();
    await typeQuery(mockInput, renderOnce, '!');
    expect(headerLine()).toContain('podcast query!');
  } finally {
    await cleanup();
  }
});

test('mouse-focused search consumes text without playback or library leakage', async () => {
  const store = createStore();
  const counter = countingPlayer(store, ['toggleMute']);
  const { mockInput, mockMouse, renderOnce, cleanup } = await renderTestApp({
    store,
    player: counter.player,
    music,
  });
  try {
    await renderOnce();
    await act(async () => {
      await mockMouse.click(60, 1);
      await mockInput.typeText('mqf');
    });
    await renderOnce();
    expect(store.get(focusedPanelAtom)).toBe('search');
    expect(store.get(searchQueryAtom)).toBe('mqf');
    expect(counter.counts.get('toggleMute')).toEqual([]);
    expect(store.get(queueStateAtom).entries).toEqual([]);
    expect(store.get(favoritesSetAtom).size).toBe(0);
  } finally {
    await cleanup();
  }
});

test('help keeps its title and dismissal hint inside a small resized terminal', async () => {
  const { mockInput, mockMouse, captureCharFrame, resize, renderOnce, cleanup } =
    await renderTestApp({ music });
  try {
    await act(async () => {
      mockInput.pressKey('?');
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Keybindings');
    await act(async () => {
      resize(60, 15);
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Keybindings');
    expect(captureCharFrame()).toContain('? / Esc close');
    await act(async () => {
      for (let index = 0; index < 100; index++)
        await mockMouse.scroll(20, 7, 'down', { delayMs: 0 });
    });
    await renderOnce();
    expect(captureCharFrame()).toContain('Quit');
  } finally {
    await cleanup();
  }
});
