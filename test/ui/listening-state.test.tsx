import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from 'jotai';
import { act } from 'react';
import { runMigrations } from '../../src/db/index';
import {
  playerDurationAtom,
  playerPositionAtom,
  playerSeekableRequestAtom,
} from '../../src/store/player';
import { podcastEpisodesAtom } from '../../src/store/podcast';
import { queueStateAtom } from '../../src/store/queue';
import { musicViewAtom, overlayAtom, podcastViewAtom, sectionAtom } from '../../src/store/ui';
import { makeTrack, renderTestApp, type TestAppHandle } from '../helpers/app';

async function palette(app: TestAppHandle, name: string): Promise<void> {
  await act(async () => app.mockInput.pressKey('p', { ctrl: true }));
  await app.renderOnce();
  await act(async () => app.mockInput.typeText(name));
  await app.renderOnce();
  await press(app, 'return');
}

async function press(app: TestAppHandle, key: string): Promise<void> {
  await act(async () => {
    if (key === 'return') app.mockInput.pressEnter();
    else app.mockInput.pressKey(key);
  });
  await app.renderOnce();
}

async function pressEscape(app: TestAppHandle): Promise<void> {
  await act(async () => {
    const ready = Promise.withResolvers<void>();
    const unsubscribe = app.store.sub(overlayAtom, ready.resolve);
    const deadline = setTimeout(
      () => ready.reject(new Error('Escape did not change the overlay')),
      1_000,
    );
    try {
      app.mockInput.pressEscape();
      await ready.promise;
    } finally {
      clearTimeout(deadline);
      unsubscribe();
    }
  });
  await app.renderOnce();
}

test('episode commands save, rename, jump to, and delete a bookmark without leaking keys', async () => {
  const store = createStore();
  store.set(sectionAtom, 'podcast');
  store.set(podcastViewAtom, 'episodes');
  store.set(podcastEpisodesAtom, [
    {
      id: 'guid',
      podcastId: 'feed',
      title: 'An episode',
      podcastTitle: 'A show',
      audioUrl: 'https://example.test/episode.mp3',
      duration: 900,
      publishDate: '',
    },
  ]);
  const app = await renderTestApp({
    store,
    resolve: async (track) => {
      if (track.source?.kind !== 'podcast') throw new Error('Unexpected non-podcast fixture');
      return { kind: 'rss', url: track.source.episode.audioUrl, selection: 'auto' };
    },
  });
  try {
    await app.renderOnce();
    await press(app, 'return');
    const target = app.player.played[0];
    expect(target?.track.title).toBe('An episode');
    await act(async () => {
      app.player.emitLoaded(target);
      store.set(playerDurationAtom, 900);
      store.set(playerSeekableRequestAtom, target.requestId);
      store.set(playerPositionAtom, 73);
    });
    await palette(app, 'add bookmark');
    expect(app.captureCharFrame()).toContain('Bookmark saved at 1:13');
    await palette(app, 'episode bookmarks');
    expect(app.captureCharFrame()).toContain('Episode Bookmarks');
    await press(app, 'r');
    await press(app, 'HOME');
    await act(async () => app.mockInput.typeText('Intro: '));
    await press(app, 'return');
    expect(app.captureCharFrame()).toContain('Intro: Bookmark at 1:13');
    expect(app.player.played).toHaveLength(1);
    await press(app, 'x');
    expect(app.captureCharFrame()).toContain('Delete Intro:');
    await pressEscape(app);
    await press(app, 'return');
    expect(app.player.played).toHaveLength(2);
    expect(app.player.loadOptions[1]?.startPosition).toBe(73);

    await palette(app, 'episode bookmarks');
    await press(app, 'x');
    await press(app, 'return');
    expect(app.captureCharFrame()).toContain('No bookmarks');
    expect(app.player.played).toHaveLength(2);
    await pressEscape(app);
    await palette(app, 'resume episode');
    expect(app.player.loadOptions[2]?.startPosition).toBe(73);
    await palette(app, 'play from start');
    const restarted = app.player.played[3];
    expect(restarted?.track.title).toBe('An episode');
    expect(app.player.loadOptions[3]?.startPosition).toBeUndefined();
    await act(async () => app.player.emitLoaded(restarted));
    await press(app, 'return');
    expect(app.player.played).toHaveLength(5);
    expect(app.player.loadOptions[4]?.startPosition).toBeUndefined();
  } finally {
    await app.cleanup();
  }
});

test('reopening the queue highlights the selected duplicate but does not start traversal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tuitunes-queue-ui-'));
  const dbPath = join(root, 'library.db');
  async function openQueue() {
    const db = new Database(dbPath);
    runMigrations(db);
    const store = createStore();
    store.set(musicViewAtom, 'queue');
    return renderTestApp({ store, db });
  }
  try {
    const first = await openQueue();
    let secondId: string;
    try {
      const same = makeTrack('duplicate', 'Same track');
      const ids = await act(async () => first.runtime.playback.enqueueMany([same, same]));
      secondId = ids[1];
      await first.renderOnce();
      await act(async () => first.mockInput.pressArrow('down'));
      await first.renderOnce();
    } finally {
      await first.cleanup();
    }
    const restarted = await openQueue();
    try {
      await restarted.renderOnce();
      expect(restarted.store.get(queueStateAtom).cursorId).toBeNull();
      await press(restarted, 'n');
      expect(restarted.player.played).toEqual([]);
      await press(restarted, 'return');
      expect(restarted.player.played.map((target) => target.origin)).toEqual([
        { kind: 'queue', entryId: secondId },
      ]);
    } finally {
      await restarted.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
