import { Logger } from '../utils/logger';
import { runYouTubeOperation } from './youtube';
import type { Track } from './types';

export interface LyricLine {
  time: number;
  text: string;
  translatedText?: string;
}

export interface LyricsResult {
  lines: LyricLine[];
  synced: boolean;
  source: string;
  sourceUrl?: string;
  originalLanguage?: string;
  translatedTo?: string;
}

interface LrclibResponse {
  syncedLyrics: string | null;
  plainLyrics: string | null;
}

/** LRCLIB requests give up after 5 seconds. */
const LRCLIB_TIMEOUT_MS = 5000;

export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split('\n')) {
    const match = raw.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (match) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const ms = parseInt(match[3], 10);
      const time = mins * 60 + secs + ms / (match[3].length === 3 ? 1000 : 100);
      lines.push({ time, text: match[4] });
    }
  }
  return lines;
}

function plainToLines(text: string): LyricLine[] {
  return text.split('\n').map((line) => ({ time: 0, text: line }));
}

/** Narrow runtime guard for LRCLIB JSON — only string/null fields are accepted. */
function isLrclibResponse(value: unknown): value is LrclibResponse {
  if (typeof value !== 'object' || value === null) return false;
  if (!('syncedLyrics' in value) || !('plainLyrics' in value)) return false;
  const { syncedLyrics, plainLyrics } = value;
  return (
    (syncedLyrics === null || typeof syncedLyrics === 'string') &&
    (plainLyrics === null || typeof plainLyrics === 'string')
  );
}

async function fetchFromLrclib(track: Track, signal?: AbortSignal): Promise<LyricsResult | null> {
  const params = new URLSearchParams({
    artist_name: track.artist,
    track_name: track.title,
  });
  const url = `https://lrclib.net/api/get?${params}`;

  let res: Response;
  try {
    res = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(LRCLIB_TIMEOUT_MS)])
        : AbortSignal.timeout(LRCLIB_TIMEOUT_MS),
    });
  } catch (err) {
    // Cancellation of the caller's signal rethrows; the internal LRCLIB
    // deadline still falls through to the YouTube path.
    if (signal?.aborted) throw err;
    return null;
  }

  if (!res.ok) return null;

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!isLrclibResponse(data)) return null;

  if (data.syncedLyrics) {
    const lines = parseLrc(data.syncedLyrics);
    if (lines.length > 0) {
      return { lines, synced: true, source: 'lrclib', sourceUrl: 'https://lrclib.net' };
    }
  }

  if (data.plainLyrics) {
    return {
      lines: plainToLines(data.plainLyrics),
      synced: false,
      source: 'lrclib',
      sourceUrl: 'https://lrclib.net',
    };
  }

  return null;
}

async function fetchFromYoutube(track: Track, signal?: AbortSignal): Promise<LyricsResult | null> {
  if (track.provider !== 'youtube') return null;

  try {
    // Shared client — never create a second Innertube session here. The
    // signal aborts the SDK requests through the custom fetch; cancellation
    // rethrows rather than becoming a successful empty result.
    const info = await runYouTubeOperation(signal, (yt) => yt.music.getInfo(track.id));
    const lyrics = await runYouTubeOperation(signal, () => info.getLyrics());
    if (!lyrics?.description?.text) return null;

    return {
      lines: plainToLines(lyrics.description.text),
      synced: false,
      source: 'youtube',
      sourceUrl: `https://music.youtube.com/watch?v=${track.id}`,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    Logger.error(`YouTube lyrics fetch failed: ${err}`);
    return null;
  }
}

/**
 * Fetch lyrics for a music track (LRCLIB first, then YouTube Music lyrics).
 * The optional signal aborts both paths at the HTTP level; cancellation
 * rejects instead of resolving to a successful empty result.
 */
export async function fetchLyrics(
  track: Track,
  signal?: AbortSignal,
): Promise<LyricsResult | null> {
  const lrclib = await fetchFromLrclib(track, signal);
  if (lrclib) return lrclib;

  const yt = await fetchFromYoutube(track, signal);
  if (yt) return yt;

  return null;
}

/**
 * Merge externally translated nonempty lines back into the source lyrics.
 * Requires exact nonempty-line cardinality: timestamps, source order, and
 * blank lines are preserved, blank lines receiving empty translated text.
 * Throws on cardinality mismatch so partial/malformed translations are
 * never displayed or cached.
 */
export function mergeTranslatedLines(
  lines: readonly LyricLine[],
  translatedNonemptyLines: readonly string[],
): LyricLine[] {
  const nonemptyCount = lines.filter((line) => line.text.trim().length > 0).length;
  if (nonemptyCount !== translatedNonemptyLines.length) {
    throw new Error(
      `Translation cardinality mismatch: ${translatedNonemptyLines.length} translations for ${nonemptyCount} nonempty lines`,
    );
  }

  let translatedIndex = 0;
  return lines.map((line) => {
    if (line.text.trim().length === 0) return { ...line, translatedText: '' };
    const translatedText = translatedNonemptyLines[translatedIndex++];
    return { ...line, translatedText };
  });
}
