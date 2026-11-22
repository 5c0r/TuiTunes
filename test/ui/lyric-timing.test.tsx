import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { createStore } from 'jotai';
import { act } from 'react';
import { configAtom } from '../../src/store/config';
import { lyricsDocumentAtom } from '../../src/store/lyrics';
import {
  playerDurationAtom,
  playerPositionAtom,
  playerSpeedAtom,
  playerStateAtom,
} from '../../src/store/player';
import { overlayAtom } from '../../src/store/ui';
import { CONFIG_PATH, DEFAULT_CONFIG, loadConfig } from '../../src/utils/config';
import { makeTrack, renderTestApp, type TestAppHandle } from '../helpers/app';
import { createTestPlayer } from '../helpers/player';

const cues = [
  { time: 5, text: 'First cue' },
  { time: 10, text: 'Second cue' },
];

async function key(app: TestAppHandle, press: () => void) {
  await act(async () => {
    press();
  });
  await app.renderOnce();
}

async function command(app: TestAppHandle, query: string) {
  await key(app, () => app.mockInput.pressKey('p', { ctrl: true }));
  await act(async () => app.mockInput.typeText(query));
  await app.renderOnce();
  await key(app, () => app.mockInput.pressEnter());
}

async function cancel(app: TestAppHandle) {
  const closed = Promise.withResolvers<void>();
  const unsubscribe = app.store.sub(overlayAtom, () => {
    if (app.store.get(overlayAtom) === null) closed.resolve();
  });
  const timer = setTimeout(() => closed.reject(new Error('Timing dialog did not close')), 1000);
  try {
    await act(async () => {
      app.mockInput.pressEscape();
      await closed.promise;
    });
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  await app.renderOnce();
}

function highlighted(app: TestAppHandle) {
  return app
    .captureCharFrame()
    .split('\n')
    .find((line) => line.includes('] # ') && line.includes(' cue'));
}

test('timing palette previews, cancels, saves and resets without replacing the lyric document', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  let fetches = 0;
  const { player } = createTestPlayer(store);
  const seeks: number[] = [];
  player.seekAbsolute = async (seconds) => {
    seeks.push(seconds);
  };
  const app = await renderTestApp({
    store,
    player,
    fetchMusicLyrics: async () => {
      fetches += 1;
      return { source: 'lrclib', sourceUrl: 'https://lrclib.net', synced: true, lines: cues };
    },
  });
  try {
    await act(async () => {
      await app.runtime.playback.playDirect(makeTrack('timing-a'));
      store.set(playerPositionAtom, 10);
    });
    const document = store.get(lyricsDocumentAtom);
    await command(app, 'adjust lyric timing');
    expect(app.captureCharFrame()).toContain('0 ms: Original timing');
    expect(app.captureCharFrame()).toContain('Cue: Second cue');
    await key(app, () => app.mockInput.pressArrow('right'));
    expect(app.captureCharFrame()).toContain('+100 ms: Later');
    expect(app.captureCharFrame()).toContain('Cue: First cue');
    await cancel(app);
    expect(highlighted(app)).toContain('Second cue');

    await command(app, 'adjust lyric timing');
    await key(app, () => app.mockInput.pressArrow('right', { shift: true }));
    expect(app.captureCharFrame()).toContain('+500 ms: Later');
    await key(app, () => app.mockInput.pressEnter());
    expect(highlighted(app)).toContain('First cue');
    expect(store.get(playerPositionAtom)).toBe(10);
    await act(async () => {
      store.set(playerSpeedAtom, 2);
      store.set(playerStateAtom, 'paused');
      store.set(playerPositionAtom, 10.5);
    });
    await app.renderOnce();
    expect(highlighted(app)).toContain('Second cue');
    await act(async () => store.set(playerPositionAtom, 10));
    await app.renderOnce();
    expect(highlighted(app)).toContain('First cue');
    expect(seeks).toEqual([]);

    await act(async () => store.set(playerDurationAtom, 10.25));
    await key(app, () => app.mockInput.pressKey('f', { ctrl: true }));
    await act(async () => app.mockInput.typeText('Second cue'));
    await app.renderOnce();
    await key(app, () => app.mockInput.pressEnter());
    expect(seeks).toEqual([10.25]);

    await command(app, 'adjust lyric timing');
    expect(app.captureCharFrame()).toContain('+500 ms: Later');
    await key(app, () => app.mockInput.pressKey('r'));
    expect(app.captureCharFrame()).toContain('0 ms: Original timing');
    await key(app, () => app.mockInput.pressEnter());
    expect(highlighted(app)).toContain('Second cue');
    expect(store.get(lyricsDocumentAtom)).toBe(document);
    expect(fetches).toBe(1);
  } finally {
    await app.cleanup();
  }
});

test('changing playback discards the open timing draft, and follow preference survives reload', async () => {
  const store = createStore();
  const app = await renderTestApp({
    store,
    fetchMusicLyrics: async () => ({ source: 'lrclib', synced: true, lines: cues }),
  });
  try {
    await act(async () => app.runtime.playback.playDirect(makeTrack('timing-a')));
    await command(app, 'adjust lyric timing');
    await key(app, () => app.mockInput.pressArrow('left'));
    expect(app.captureCharFrame()).toContain('-100 ms: Earlier');
    await act(async () => app.runtime.playback.playDirect(makeTrack('timing-b')));
    await app.renderOnce();
    expect(store.get(overlayAtom)).toBeNull();
    await command(app, 'adjust lyric timing');
    expect(app.captureCharFrame()).toContain('0 ms: Original timing');
    await cancel(app);
    await command(app, 'change lyric follow position');
    expect(loadConfig().lyricFollowMode).toBe('upper-third');
    expect(app.captureCharFrame()).toContain('Lyric follow: Upper third');
  } finally {
    await app.cleanup();
    rmSync(CONFIG_PATH, { force: true });
  }
});
