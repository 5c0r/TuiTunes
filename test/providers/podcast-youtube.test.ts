import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Episode } from '../../src/providers/podcast-types';
import { extractYouTubeSrt, findYouTubeVideoId } from '../../src/providers/podcast-youtube';

const bun = process.execPath;
const searchFixture = join(import.meta.dir, '..', 'fixtures', 'ytdlp', 'search.ts');
const captionsFixture = join(import.meta.dir, '..', 'fixtures', 'ytdlp', 'captions.ts');

function makeEpisode(over: Partial<Episode> = {}): Episode {
  return {
    id: 'ep-1',
    podcastId: 'pod-1',
    podcastTitle: 'Show',
    title: 'Pilot',
    audioUrl: 'https://example.com/a.mp3',
    duration: 0,
    publishDate: '',
    ...over,
  };
}

/** Command seam plus an invocation counter backed by the fixture marker file. */
function searchSeam(dir: string): { command: readonly string[]; calls: () => number } {
  const marker = join(dir, 'calls');
  writeFileSync(marker, '');
  return {
    command: [bun, searchFixture, '--marker', marker],
    calls: () =>
      readFileSync(marker, 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0).length,
  };
}

/** Real child processes cannot be driven by fake timers; await the fixture's observable start signal. */
async function waitForCalls(calls: () => number, count: number): Promise<void> {
  for (let i = 0; i < 2000 && calls() < count; i++) {
    await Bun.sleep(5);
  }
}

function leftoverCaptionDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('tuimusic-yt-'));
}

describe('findYouTubeVideoId', () => {
  test('resolves the video id from yt-dlp search output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytmatch-test-'));
    try {
      const seam = searchSeam(dir);
      const id = await findYouTubeVideoId(makeEpisode(), undefined, { command: seam.command });
      expect(id).toBe('Show_Pilot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('caches successful matches by podcast id plus episode id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytmatch-test-'));
    try {
      const seam = searchSeam(dir);
      const episode = makeEpisode({ podcastId: 'pod-A', id: 'ep-1' });
      await findYouTubeVideoId(episode, undefined, { command: seam.command });
      await findYouTubeVideoId(episode, undefined, { command: seam.command });
      expect(seam.calls()).toBe(1);

      // Same title under another podcast is a distinct cache entry.
      await findYouTubeVideoId(makeEpisode({ podcastId: 'pod-B', id: 'ep-1' }), undefined, {
        command: seam.command,
      });
      expect(seam.calls()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not cache searches that find no result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytmatch-test-'));
    try {
      const seam = searchSeam(dir);
      const miss = makeEpisode({ podcastId: 'pod-M', id: 'ep-m', title: 'NOHIT' });
      expect(await findYouTubeVideoId(miss, undefined, { command: seam.command })).toBeNull();
      expect(await findYouTubeVideoId(miss, undefined, { command: seam.command })).toBeNull();
      expect(seam.calls()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not cache unusable search output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytmatch-test-'));
    try {
      const seam = searchSeam(dir);
      const garbage = makeEpisode({ podcastId: 'pod-G', id: 'ep-g', title: 'GARBAGE' });
      expect(await findYouTubeVideoId(garbage, undefined, { command: seam.command })).toBeNull();
      const empty = makeEpisode({ podcastId: 'pod-E', id: 'ep-e', title: 'EMPTY' });
      expect(await findYouTubeVideoId(empty, undefined, { command: seam.command })).toBeNull();
      expect(seam.calls()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('propagates caller cancellation and does not cache it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytmatch-test-'));
    try {
      const seam = searchSeam(dir);
      const controller = new AbortController();
      controller.abort();
      const cancelled = makeEpisode({ podcastId: 'pod-X', id: 'ep-x', title: 'Pilot' });
      await expect(
        findYouTubeVideoId(cancelled, controller.signal, { command: seam.command }),
      ).rejects.toThrow();
      expect(seam.calls()).toBe(0);
      // The aborted attempt left no cache entry, so the retry searches again.
      expect(await findYouTubeVideoId(cancelled, undefined, { command: seam.command })).toBe(
        'Show_Pilot',
      );
      expect(seam.calls()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('kills a hanging search on caller abort mid-flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytmatch-test-'));
    try {
      const seam = searchSeam(dir);
      const controller = new AbortController();
      const pending = findYouTubeVideoId(
        makeEpisode({ podcastId: 'pod-H', id: 'ep-h', title: 'HANG' }),
        controller.signal,
        { command: seam.command },
      );
      await waitForCalls(seam.calls, 1);
      controller.abort();
      await expect(pending).rejects.toThrow('cancelled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractYouTubeSrt', () => {
  test('returns captions with the video URL and removes its temp dir', async () => {
    const result = await extractYouTubeSrt('abc123', undefined, { command: [bun, captionsFixture] });
    expect(result?.videoUrl).toBe('https://www.youtube.com/watch?v=abc123');
    expect(result?.srt).toContain('Hello from fixture');
    expect(leftoverCaptionDirs()).toEqual([]);
  });

  test('isolates concurrent caption requests, including the same video', async () => {
    const command = [bun, captionsFixture];
    const [same1, same2, other] = await Promise.all([
      extractYouTubeSrt('dupvideo', undefined, { command }),
      extractYouTubeSrt('dupvideo', undefined, { command }),
      extractYouTubeSrt('othervideo', undefined, { command }),
    ]);
    expect(same1?.srt).toContain('Hello from fixture');
    expect(same2?.srt).toContain('Hello from fixture');
    expect(other?.srt).toContain('Hello from fixture');
    expect(leftoverCaptionDirs()).toEqual([]);
  });

  test('returns null when no caption file is produced', async () => {
    expect(
      await extractYouTubeSrt('NOFILEVIDEO', undefined, { command: [bun, captionsFixture] }),
    ).toBeNull();
    expect(leftoverCaptionDirs()).toEqual([]);
  });

  test('returns null when the caption download fails', async () => {
    expect(
      await extractYouTubeSrt('FAILVIDEO', undefined, { command: [bun, captionsFixture] }),
    ).toBeNull();
    expect(leftoverCaptionDirs()).toEqual([]);
  });

  test('propagates cancellation and still removes its temp dir', async () => {
    const controller = new AbortController();
    const pending = extractYouTubeSrt('HANGVIDEO', controller.signal, {
      command: [bun, captionsFixture],
    });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(leftoverCaptionDirs()).toEqual([]);
  });
});
