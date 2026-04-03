import type { Track } from './types';
import { Logger } from '../utils/logger';

export interface LyricLine {
  time: number;
  text: string;
}

export interface LyricsResult {
  lines: LyricLine[];
  synced: boolean;
  source: string;
  sourceUrl?: string;
}

interface LrclibResponse {
  syncedLyrics: string | null;
  plainLyrics: string | null;
}

function parseLrc(lrc: string): LyricLine[] {
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

async function fetchFromLrclib(track: Track): Promise<LyricsResult | null> {
  const params = new URLSearchParams({
    artist_name: track.artist,
    track_name: track.title,
  });
  const url = `https://lrclib.net/api/get?${params}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let data: LrclibResponse;
  try {
    data = (await res.json()) as LrclibResponse;
  } catch {
    return null;
  }

  if (data.syncedLyrics) {
    const lines = parseLrc(data.syncedLyrics);
    if (lines.length > 0) {
      return { lines, synced: true, source: 'lrclib', sourceUrl: 'https://lrclib.net' };
    }
  }

  if (data.plainLyrics) {
    return { lines: plainToLines(data.plainLyrics), synced: false, source: 'lrclib', sourceUrl: 'https://lrclib.net' };
  }

  return null;
}

async function fetchFromYoutube(track: Track): Promise<LyricsResult | null> {
  if (track.provider !== 'youtube') return null;

  try {
    const { Innertube } = await import('youtubei.js');
    const yt = await Innertube.create({ lang: 'en', location: 'US' });
    const info = await yt.music.getInfo(track.id);
    const lyrics = await info.getLyrics();
    if (!lyrics?.description?.text) return null;

    return {
      lines: plainToLines(lyrics.description.text),
      synced: false,
      source: 'youtube',
      sourceUrl: `https://music.youtube.com/watch?v=${track.id}`,
    };
  } catch (err) {
    Logger.error(`YouTube lyrics fetch failed: ${err}`);
    return null;
  }
}

export async function fetchLyrics(track: Track): Promise<LyricsResult | null> {
  const lrclib = await fetchFromLrclib(track);
  if (lrclib) return lrclib;

  const yt = await fetchFromYoutube(track);
  if (yt) return yt;

  return null;
}
