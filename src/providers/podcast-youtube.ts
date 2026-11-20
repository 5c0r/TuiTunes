import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../utils/logger';
import type { Episode } from './podcast-types';
import { runYtDlp } from './yt-dlp';

const SEARCH_DEADLINE_MS = 15_000;
const CAPTION_DEADLINE_MS = 30_000;

/**
 * Internal fixture seam for tests: full argv prefix replacing ["yt-dlp"].
 * Not a public CLI option.
 */
export interface YtDlpCommandOptions {
  command?: readonly string[];
}

/** Successful episode → video matches, keyed by podcast ID + episode ID. */
const videoIdCache = new Map<string, string>();

/**
 * Search YouTube for a podcast episode and return its video ID.
 * Returns null when no match is found or the search fails; only successful
 * matches are cached. Cancellation via `signal` propagates to the caller.
 */
export async function findYouTubeVideoId(
  episode: Episode,
  signal?: AbortSignal,
  options?: YtDlpCommandOptions,
): Promise<string | null> {
  const key = JSON.stringify([episode.podcastId, episode.id]);
  const cached = videoIdCache.get(key);
  if (cached !== undefined) return cached;

  const query = `${episode.podcastTitle ?? ''} ${episode.title}`.trim();
  if (!query) return null;

  try {
    const { stdout } = await runYtDlp(['--dump-json', '--default-search', 'ytsearch1', query], {
      timeoutMs: SEARCH_DEADLINE_MS,
      signal,
      command: options?.command,
    });

    const firstLine = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      Logger.debug(`No YouTube search output for "${episode.title}"`);
      return null;
    }

    let info: unknown;
    try {
      info = JSON.parse(firstLine);
    } catch {
      info = undefined;
    }
    const videoId = readVideoId(info);
    if (!videoId) {
      Logger.debug(`Unusable yt-dlp search output for "${episode.title}"`);
      return null;
    }
    videoIdCache.set(key, videoId);
    Logger.info(`YouTube match for "${episode.title}": ${videoId}`);
    return videoId;
  } catch (err) {
    if (signal?.aborted) throw err;
    Logger.debug(`YouTube search failed for "${episode.title}": ${err}`);
    return null;
  }
}

/** Read a nonempty `id` string from parsed yt-dlp JSON. */
function readVideoId(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null || !('id' in info)) return undefined;
  const id: unknown = 'id' in info ? info.id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Get the YouTube playback URL for a video ID. */
export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Extract English auto-generated SRT captions for a YouTube video.
 * Each request owns a unique temporary directory so concurrent requests for
 * the same video cannot collide; the directory is always removed.
 * Cancellation via `signal` propagates to the caller.
 */
export async function extractYouTubeSrt(
  videoId: string,
  signal?: AbortSignal,
  options?: YtDlpCommandOptions,
): Promise<{ srt: string; videoUrl: string } | null> {
  const url = youtubeUrl(videoId);
  const tempDir = await mkdtemp(join(tmpdir(), 'tuimusic-yt-'));
  const outputBase = join(tempDir, videoId);
  const srtPath = `${outputBase}.en.srt`;

  try {
    await runYtDlp(
      [
        '--write-auto-sub',
        '--sub-lang',
        'en',
        '--sub-format',
        'srt',
        '--skip-download',
        '-o',
        outputBase,
        url,
      ],
      { timeoutMs: CAPTION_DEADLINE_MS, signal, command: options?.command },
    );

    if (!existsSync(srtPath)) {
      Logger.debug(`No captions generated for ${videoId}`);
      return null;
    }
    return { srt: readFileSync(srtPath, 'utf-8'), videoUrl: url };
  } catch (err) {
    if (signal?.aborted) throw err;
    Logger.debug(`Caption extraction failed for ${videoId}: ${err}`);
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
