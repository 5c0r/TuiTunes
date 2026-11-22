import { expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { createStore, Provider } from 'jotai';
import { act } from 'react';
import { queueStateAtom } from '../../src/store/queue';
import { configAtom } from '../../src/store/config';
import {
  playerDurationAtom,
  playerErrorAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerSeekableRequestAtom,
  playerStateAtom,
} from '../../src/store/player';
import { overlayAtom } from '../../src/store/ui';
import { NowPlaying, type NowPlayingCommand } from '../../src/ui/NowPlaying';
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
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain('This saved item has no supported playback source.');
    await act(async () => {
      store.set(playerErrorAtom, null);
    });
    await act(async () => setup.renderOnce());
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
      await act(async () => setup.renderOnce());
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
    await act(async () => setup.renderOnce());
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
    await act(async () => setup.renderOnce());
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
      await act(async () => setup.renderOnce());
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
    await act(async () => setup.renderOnce());
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
    await act(async () => setup.renderOnce());
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
    await act(async () => setup.renderOnce());
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
    await act(async () => setup.renderOnce());
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
    await act(async () => asciiSetup.renderOnce());
    expect(asciiSetup.captureCharFrame()).toContain('/');
  } finally {
    await act(async () => {
      asciiSetup.renderer.destroy();
    });
  }
});

async function renderMousePlayer() {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true, reducedMotion: true });
  store.set(playerPlaybackAtom, playback);
  store.set(playerStateAtom, 'playing');
  store.set(playerDurationAtom, 120);
  store.set(playerPositionAtom, 30);
  store.set(playerSeekableRequestAtom, playback.requestId);
  const commands: NowPlayingCommand[] = [];
  const seeks: Array<[number, number]> = [];
  const setup = await testRender(
    <Provider store={store}>
      <NowPlaying
        onCommand={(id) => commands.push(id)}
        onSeek={(seconds, requestId) => seeks.push([seconds, requestId])}
      />
    </Provider>,
    { width: 100, height: 12 },
  );
  const render = () => act(async () => setup.renderOnce());
  await render();
  return {
    ...setup,
    store,
    commands,
    seeks,
    render,
    dispose: () => act(async () => setup.renderer.destroy()),
    click: (x: number, y: number) => act(async () => setup.mockMouse.click(x, y)),
    bar() {
      const bar = setup.renderer.root.findDescendantById('now-playing-seek');
      if (!bar) throw new Error('Missing progress bar');
      return bar;
    },
    async clickLabel(label: string) {
      const lines = setup.captureCharFrame().split('\n');
      for (const [y, line] of lines.entries()) {
        const x = line.indexOf(label);
        if (x >= 0) {
          await act(async () => setup.mockMouse.click(x, y));
          return;
        }
      }
      throw new Error(`Missing control ${label} in:\n${lines.join('\n')}`);
    },
  };
}

test('the drawn seek bar uses its measured body width including both endpoints', async () => {
  const app = await renderMousePlayer();
  try {
    const id = playback.requestId;
    const { x, y, width } = app.bar();
    const row = app.captureCharFrame().split('\n')[y];
    expect(row.slice(x, x + width)).toMatch(/^=+o-+$/);
    await app.click(x, y);
    await app.click(x + width - 1, y);
    const midpoint = Math.floor((width - 1) / 2);
    await app.click(x + midpoint, y);
    expect(app.seeks).toEqual([
      [0, id],
      [120, id],
      [(midpoint / (width - 1)) * 120, id],
    ]);

    await act(async () => app.resize(56, 12));
    await app.render();
    const narrowed = app.bar();
    expect(narrowed.width).toBeLessThan(width);
    await app.click(narrowed.x + narrowed.width - 1, narrowed.y);
    expect(app.seeks.at(-1)).toEqual([120, id]);
  } finally {
    await app.dispose();
  }
});

test('seek presses cannot survive replacement, resize, or an intervening dialog', async () => {
  const app = await renderMousePlayer();
  try {
    const { x, y } = app.bar();
    const press = () => act(async () => app.mockMouse.pressDown(x + 5, y));
    const release = () => act(async () => app.mockMouse.release(x + 5, y));

    await press();
    await act(async () => {
      app.store.set(playerPlaybackAtom, { ...playback, requestId: playback.requestId + 1 });
      app.store.set(playerSeekableRequestAtom, playback.requestId + 1);
    });
    await app.render();
    await release();
    await press();
    await act(async () => app.resize(88, 12));
    await app.render();
    await release();
    await press();
    await act(async () => {
      app.store.set(overlayAtom, { kind: 'quit-confirm' });
      app.store.set(overlayAtom, null);
    });
    await release();
    expect(app.seeks).toEqual([]);
    await app.click(x, y);
    expect(app.seeks).toEqual([[0, playback.requestId + 1]]);
  } finally {
    await app.dispose();
  }
});

test('a seek needs matching confirmation and a finite positive duration', async () => {
  const app = await renderMousePlayer();
  try {
    const { x, y } = app.bar();
    for (const duration of [0, Infinity]) {
      await act(async () => app.store.set(playerDurationAtom, duration));
      await app.render();
      await app.click(x + 5, y);
    }
    await act(async () => {
      app.store.set(playerDurationAtom, 120);
      app.store.set(playerSeekableRequestAtom, playback.requestId + 1);
    });
    await app.render();
    await app.click(x + 5, y);
    expect(app.seeks).toEqual([]);
  } finally {
    await app.dispose();
  }
});

test('queue controls respect traversal destinations and every control respects a modal', async () => {
  const app = await renderMousePlayer();
  try {
    await app.clickLabel('Prev');
    await app.clickLabel('Next');
    expect(app.commands).toEqual([]);
    await act(async () => {
      app.store.set(playerPlaybackAtom, { ...playback, origin: { kind: 'queue', entryId: 'b' } });
      app.store.set(queueStateAtom, {
        entries: ['a', 'b'].map((entryId) => ({ entryId, track: playback.track })),
        order: ['a', 'b'],
        cursorId: 'b',
        repeat: 'off',
        shuffle: false,
      });
    });
    await app.render();
    await app.clickLabel('Next');
    await app.clickLabel('Prev');
    expect(app.commands).toEqual(['prev']);

    await act(async () => app.store.set(queueStateAtom, (queue) => ({ ...queue, repeat: 'all' })));
    await app.render();
    await app.clickLabel('Next');
    expect(app.commands).toEqual(['prev', 'next']);
    await act(async () => app.store.set(overlayAtom, { kind: 'quit-confirm' }));
    await app.render();
    for (const label of ['Prev', 'Pause', 'Next', 'Mute']) await app.clickLabel(label);
    const { x, y } = app.bar();
    await app.click(x, y);
    expect(app.commands).toEqual(['prev', 'next']);
    expect(app.seeks).toEqual([]);
  } finally {
    await app.dispose();
  }
});
