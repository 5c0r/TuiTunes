import { expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { createStore, Provider } from 'jotai';
import { act } from 'react';
import { configAtom } from '../../src/store/config';
import {
  playerDurationAtom,
  playerErrorAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerStateAtom,
} from '../../src/store/player';
import { NowPlaying } from '../../src/ui/NowPlaying';
import { DEFAULT_CONFIG } from '../../src/utils/config';

/** Every Unicode chrome glyph NowPlaying may render; none may appear in ASCII mode. */
const CHROME_GLYPHS = '▶⏸⟳⏹♪🎙♥⟲📋📜▸│—•·→⚠🔇🔊🔁🔂🔀━─●⣿▂▃▅▆▇';

function expectNoChromeGlyphs(frame: string): void {
  const offender = [...frame].find((ch) => CHROME_GLYPHS.includes(ch));
  expect(offender).toBeUndefined();
}

const playback = {
  track: {
    id: 'a',
    provider: 'youtube',
    source: { kind: 'youtube', videoId: 'a' },
    title: 'Current music',
    artist: 'Artist',
    duration: 60,
  },
  source: {
    kind: 'youtube',
    videoId: 'a',
    url: 'https://music.youtube.com/watch?v=a',
    selection: 'auto',
  } as const,
  requestId: 1,
  origin: { kind: 'direct' },
} as const;

test('playback errors remain visible without a loaded track', async () => {
  const store = createStore();
  store.set(playerErrorAtom, 'This saved item has no supported playback source.');
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('This saved item has no supported playback source.');
    await act(async () => {
      store.set(playerErrorAtom, null);
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain('This saved item');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('all player states retain the current media title', async () => {
  const store = createStore();
  store.set(playerPlaybackAtom, playback);
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    for (const state of ['playing', 'paused', 'buffering', 'stopped'] as const) {
      await act(async () => {
        store.set(playerStateAtom, state);
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain('Current music');
    }
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('the actual playback source is shown as [YT] or [RSS]', async () => {
  const store = createStore();
  store.set(playerPlaybackAtom, playback);
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('[YT]');

    await act(async () => {
      store.set(playerPlaybackAtom, {
        ...playback,
        source: {
          kind: 'rss',
          url: 'https://example.com/episode.mp3',
          selection: 'rss',
        },
      });
    });
    await act(async () => {
      store.set(playerPositionAtom, 30);
      store.set(playerDurationAtom, 60);
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('[RSS]');
    expect(setup.captureCharFrame()).not.toContain('[YT]');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('no fake equalizer frames are rendered in any state', async () => {
  const store = createStore();
  store.set(playerPlaybackAtom, playback);
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    for (const state of ['playing', 'paused', 'buffering', 'stopped'] as const) {
      await act(async () => {
        store.set(playerStateAtom, state);
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      for (const bar of ['▂', '▃', '▅', '▆', '▇', '▁']) {
        expect(frame).not.toContain(bar);
      }
    }
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('ASCII mode renders pure ASCII chrome while keeping content', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  store.set(playerPlaybackAtom, playback);
  store.set(playerStateAtom, 'playing');
  store.set(playerPositionAtom, 30);
  store.set(playerDurationAtom, 60);
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Current music');
    expect(frame).toContain('[YT]');
    expect(frame).toContain('o'); // ASCII progress knob
    expectNoChromeGlyphs(frame);
    for (const ch of frame) {
      expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0x7f);
    }
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('ASCII mode keeps Unicode media content byte-for-byte', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  store.set(playerPlaybackAtom, {
    ...playback,
    track: { ...playback.track, title: 'Café del Mar 中文', artist: 'Café 中文' },
  });
  store.set(playerStateAtom, 'playing');
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Café del Mar 中文');
    expect(frame).toContain('Café 中文');
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('reduced motion shows a static loading label instead of a spinner', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, reducedMotion: true });
  store.set(playerPlaybackAtom, playback);
  store.set(playerStateAtom, 'buffering');
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Loading');
    expect(frame).not.toContain('⣿');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('the buffering spinner animates only without reduced motion', async () => {
  const store = createStore();
  store.set(playerPlaybackAtom, playback);
  store.set(playerStateAtom, 'buffering');
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('⣿');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }

  const asciiStore = createStore();
  asciiStore.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  asciiStore.set(playerPlaybackAtom, playback);
  asciiStore.set(playerStateAtom, 'buffering');
  const asciiSetup = await testRender(
    <Provider store={asciiStore}>
      <NowPlaying />
    </Provider>,
    { width: 100, height: 10 },
  );
  try {
    await asciiSetup.renderOnce();
    expect(asciiSetup.captureCharFrame()).toContain('/');
  } finally {
    await act(async () => {
      asciiSetup.renderer.destroy();
    });
  }
});
