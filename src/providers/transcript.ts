import { tmpdir } from 'os';
import { join } from 'path';
import { unlink } from 'fs/promises';
import type { LyricLine } from './lyrics';
import type { Episode } from './podcast-types';
import { parseSrt, parseVtt } from './subtitle-parser';
import { Logger } from '../utils/logger';

export interface TranscriptResult {
  lines: LyricLine[];
  source: 'rss' | 'youtube';
  sourceUrl?: string;
}

/** Fetch transcript from RSS transcript URL or YouTube auto-subs. */
export async function fetchTranscript(episode: Episode): Promise<TranscriptResult | null> {
  // Strategy 1: RSS-provided transcript URL
  if (episode.transcriptUrl) {
    try {
      const lines = await fetchFromUrl(episode.transcriptUrl);
      if (lines.length > 0) {
        return { lines, source: 'rss', sourceUrl: episode.transcriptUrl };
      }
    } catch (err) {
      Logger.warn(`RSS transcript fetch failed for "${episode.title}": ${err}`);
    }
  }

  // Strategy 2: YouTube auto-generated subtitles via yt-dlp
  try {
    const ytResult = await fetchFromYoutube(episode);
    if (ytResult && ytResult.lines.length > 0) {
      return { lines: ytResult.lines, source: 'youtube', sourceUrl: ytResult.videoUrl };
    }
  } catch (err) {
    Logger.debug(`YouTube transcript fetch failed for "${episode.title}": ${err}`);
  }

  return null;
}

async function fetchFromUrl(url: string): Promise<LyricLine[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching transcript`);
  }
  const text = await response.text();
  if (url.endsWith('.vtt') || text.trimStart().startsWith('WEBVTT')) {
    return parseVtt(text);
  }
  // Default to SRT
  return parseSrt(text);
}

async function fetchFromYoutube(episode: Episode): Promise<{ lines: LyricLine[]; videoUrl: string } | null> {
  const searchQuery = `${episode.podcastTitle ?? ''} ${episode.title}`.trim();

  // Find the video via yt-dlp JSON dump
  const searchProc = Bun.spawn(
    ['yt-dlp', '--dump-json', '--default-search', 'ytsearch1', searchQuery],
    { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
  );
  const searchOutput = await new Response(searchProc.stdout).text();
  const searchExit = await searchProc.exited;
  if (searchExit !== 0 || !searchOutput.trim()) {
    Logger.debug('yt-dlp search returned no results');
    return null;
  }

  let videoId: string;
  try {
    const info = JSON.parse(searchOutput);
    videoId = info.id;
    if (!videoId) return null;
  } catch {
    Logger.debug('Failed to parse yt-dlp JSON output');
    return null;
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const tempBase = join(tmpdir(), `tunefork-transcript-${videoId}`);
  const srtPath = `${tempBase}.en.srt`;

  try {
    // Download auto-generated subtitles
    const subProc = Bun.spawn(
      [
        'yt-dlp',
        '--write-auto-sub',
        '--sub-lang', 'en',
        '--sub-format', 'srt',
        '--skip-download',
        '-o', tempBase,
        videoUrl,
      ],
      { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
    );
    await subProc.exited;

    const srtFile = Bun.file(srtPath);
    if (!await srtFile.exists()) {
      Logger.debug(`No subtitle file generated for ${videoId}`);
      return null;
    }

    const srtText = await srtFile.text();
    return { lines: parseSrt(srtText), videoUrl: videoUrl };
  } finally {
    // Clean up temp file regardless of success/failure
    try {
      await unlink(srtPath);
    } catch {
      // File may not exist if subtitle download failed
    }
  }
}
