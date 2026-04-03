import type { Episode } from './podcast-types';
import { Logger } from '../utils/logger';

/**
 * Cache of episode → YouTube video ID mappings.
 * Avoids re-searching YouTube for episodes we've already matched.
 */
const videoIdCache = new Map<string, string | null>();

function cacheKey(episode: Episode): string {
  return `${episode.podcastTitle ?? ''}:${episode.title}`;
}

/**
 * Search YouTube for a podcast episode and return its video ID.
 * Returns null if no match found or yt-dlp unavailable.
 */
export async function findYouTubeVideoId(episode: Episode): Promise<string | null> {
  const key = cacheKey(episode);
  if (videoIdCache.has(key)) {
    return videoIdCache.get(key)!;
  }

  const query = `${episode.podcastTitle ?? ''} ${episode.title}`.trim();
  if (!query) return null;

  try {
    const proc = Bun.spawn(
      ['yt-dlp', '--dump-json', '--default-search', 'ytsearch1', query],
      { stdout: 'pipe', stderr: 'pipe' }
    );

    // Race: 15s timeout
    const timeoutPromise = Bun.sleep(15_000).then(() => null as string | null);
    const resultPromise = new Response(proc.stdout).text().then((output) => {
      if (!output.trim()) return null;
      try {
        const info = JSON.parse(output);
        return (info.id as string) ?? null;
      } catch {
        return null;
      }
    });

    const videoId = await Promise.race([resultPromise, timeoutPromise]);
    videoIdCache.set(key, videoId);

    if (videoId) {
      Logger.info(`YouTube match for "${episode.title}": ${videoId}`);
    } else {
      Logger.debug(`No YouTube match for "${episode.title}"`);
    }

    return videoId;
  } catch (err) {
    Logger.debug(`YouTube search failed: ${err}`);
    videoIdCache.set(key, null);
    return null;
  }
}

/**
 * Get the YouTube playback URL for an episode.
 * mpv + yt-dlp plays this directly with --ytdl-format=bestaudio.
 */
export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Extract SRT captions from a YouTube video via yt-dlp.
 * Returns the raw SRT text, or null if unavailable.
 */
export async function extractYouTubeSrt(videoId: string): Promise<{ srt: string; videoUrl: string } | null> {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { existsSync, readFileSync, unlinkSync } = await import('node:fs');

  const tempBase = join(tmpdir(), `tuimusic-yt-${videoId}`);
  const srtPath = `${tempBase}.en.srt`;
  const videoUrl = youtubeUrl(videoId);

  try {
    const proc = Bun.spawn([
      'yt-dlp', '--write-auto-sub', '--sub-lang', 'en', '--sub-format', 'srt',
      '--skip-download', '-o', tempBase, videoUrl,
    ], { stdout: 'pipe', stderr: 'pipe' });

    await proc.exited;

    if (!existsSync(srtPath)) {
      Logger.debug(`No captions for ${videoId}`);
      return null;
    }

    const srt = readFileSync(srtPath, 'utf-8');
    return { srt, videoUrl };
  } catch (err) {
    Logger.debug(`Caption extraction failed for ${videoId}: ${err}`);
    return null;
  } finally {
    try { unlinkSync(srtPath); } catch { /* may not exist */ }
  }
}
