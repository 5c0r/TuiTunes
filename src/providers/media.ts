import { Logger } from '../utils/logger';
import type { Episode } from './podcast-types';
import { findYouTubeVideoId } from './podcast-youtube';
import type { PlaybackSourcePreference, ResolvedPlaybackSource, Track, TrackSource } from './types';

export function mediaKey(track: Track): string {
  return track.source?.kind === 'podcast'
    ? JSON.stringify(['podcast', track.source.episode.podcastId, track.source.episode.id])
    : JSON.stringify([track.provider, track.id]);
}
export function episodeToTrack(episode: Episode): Track {
  return {
    id: episode.id,
    provider: 'podcast',
    source: { kind: 'podcast', episode },
    title: episode.title,
    artist: episode.podcastTitle,
    duration: episode.duration,
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function url(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}
function episode(value: unknown): value is Episode {
  return (
    record(value) &&
    ['id', 'podcastId', 'podcastTitle', 'title', 'publishDate'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    url(value.audioUrl) &&
    typeof value.duration === 'number' &&
    Number.isFinite(value.duration) &&
    value.duration >= 0 &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.transcriptUrl === undefined || url(value.transcriptUrl))
  );
}
export function serializeSource(source: TrackSource | null): string | null {
  return source ? JSON.stringify(source) : null;
}
export function parseSource(
  json: string | null,
  provider: string,
  trackId: string,
): TrackSource | null {
  if (json === null)
    return provider === 'youtube' && trackId ? { kind: 'youtube', videoId: trackId } : null;
  try {
    const value: unknown = JSON.parse(json);
    if (!record(value)) return null;
    if (value.kind === 'youtube' && typeof value.videoId === 'string' && value.videoId)
      return { kind: 'youtube', videoId: value.videoId };
    if (value.kind === 'podcast' && episode(value.episode))
      return { kind: 'podcast', episode: value.episode };
  } catch {
    /* Unavailable legacy metadata remains visible. */
  }
  return null;
}
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// Set membership keeps lookalike keys like 'constructor' from inheriting
// Object.prototype properties and passing a host/route check.
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const YOUTUBE_PATHS = new Set(['shorts', 'live', 'embed']);

/**
 * Parse a user-supplied YouTube video reference: a bare 11-character ID or an
 * HTTP(S) URL on an exact YouTube host (`/watch?v=`, `/shorts/`, `/live/`,
 * `/embed/`, or a `youtu.be` single-ID path). Returns the normalized video ID
 * or null for anything else — credentials, nonstandard ports, duplicate or
 * malformed `v` values, playlist-only links, lookalike hosts and arbitrary
 * media URLs are rejected. Timestamps are ignored; the caller always builds
 * the canonical HTTPS watch URL.
 */
export function parseYouTubeVideoId(value: string): string | null {
  const input = value.trim();
  if (VIDEO_ID.test(input)) return input;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.port !== '')
    return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (YOUTUBE_HOSTS.has(host)) {
    if (parsed.pathname === '/watch') {
      const ids = parsed.searchParams.getAll('v');
      if (ids.length === 1 && VIDEO_ID.test(ids[0])) return ids[0];
      return null;
    }
    if (segments.length === 2 && YOUTUBE_PATHS.has(segments[0]) && VIDEO_ID.test(segments[1]))
      return segments[1];
    return null;
  }
  if (SHORT_HOSTS.has(host) && segments.length === 1 && VIDEO_ID.test(segments[0]))
    return segments[0];
  return null;
}
export function serializeResolvedSource(source: ResolvedPlaybackSource | undefined): string | null {
  return source ? JSON.stringify(source) : null;
}
export function parseResolvedSource(
  json: string | null,
  source: TrackSource | null,
): ResolvedPlaybackSource | undefined {
  if (!json || !source) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (!record(value) || !url(value.url)) return undefined;
    // Legacy rows predate the selection tag; they decode as an automatic
    // choice, as does an explicit 'auto' tag. Anything else is rejected.
    const tag: unknown = value.selection;
    const selection =
      tag === undefined
        ? 'auto'
        : tag === 'auto' || tag === 'rss' || tag === 'youtube-match' || tag === 'youtube-video'
          ? tag
          : null;
    if (
      value.kind === 'youtube' &&
      (selection === 'auto' || selection === 'youtube-match' || selection === 'youtube-video') &&
      typeof value.videoId === 'string' &&
      value.videoId &&
      (source.kind === 'podcast' || (selection === 'auto' && source.videoId === value.videoId))
    ) {
      return { kind: 'youtube', url: value.url, videoId: value.videoId, selection };
    }
    if (
      value.kind === 'rss' &&
      (selection === 'auto' || selection === 'rss') &&
      source.kind === 'podcast' &&
      value.url === source.episode.audioUrl &&
      (value.transcriptUrl === undefined || url(value.transcriptUrl))
    ) {
      return { kind: 'rss', url: value.url, transcriptUrl: value.transcriptUrl, selection };
    }
  } catch {
    /* Invalid persisted resolution is recomputed from the durable source. */
  }
  return undefined;
}
export async function resolvePlaybackSource(
  track: Track,
  signal: AbortSignal,
  preference: PlaybackSourcePreference = { mode: 'auto' },
): Promise<ResolvedPlaybackSource> {
  signal.throwIfAborted();
  const source = track.source;
  if (!source) throw new Error('This saved item has no supported playback source.');
  if (source.kind === 'youtube') {
    // Music tracks have a single playback provider and stay Auto-only.
    if (preference.mode !== 'auto')
      throw new Error('Music tracks only support automatic source selection.');
    return {
      kind: 'youtube',
      videoId: source.videoId,
      url: `https://music.youtube.com/watch?v=${encodeURIComponent(source.videoId)}`,
      selection: 'auto',
    };
  }
  const saved = parseResolvedSource(serializeResolvedSource(track.resolvedSource), source);
  if (preference.mode === 'rss') {
    // The episode's original audio; no YouTube lookup of any kind.
    return {
      kind: 'rss',
      url: source.episode.audioUrl,
      transcriptUrl: source.episode.transcriptUrl,
      selection: 'rss',
    };
  }
  if (preference.mode === 'youtube-video') {
    const videoId = parseYouTubeVideoId(preference.videoId);
    if (!videoId) throw new Error('Invalid YouTube video ID.');
    return { kind: 'youtube', videoId, url: watchUrl(videoId), selection: 'youtube-video' };
  }
  if (preference.mode === 'youtube-match') {
    // Reuse a compatible non-manual resolution; a miss is an explicit error, never RSS.
    if (saved?.kind === 'youtube' && saved.selection !== 'youtube-video') return saved;
    const videoId = await matchEpisodeVideoId(source.episode, signal);
    return { kind: 'youtube', videoId, url: watchUrl(videoId), selection: 'youtube-match' };
  }
  // Auto: reuse only an Auto-tagged compatible cache, then match → RSS fallback.
  if (saved?.selection === 'auto') return saved;
  try {
    const videoId = await findYouTubeVideoId(source.episode, signal);
    signal.throwIfAborted();
    if (videoId) return { kind: 'youtube', videoId, url: watchUrl(videoId), selection: 'auto' };
  } catch (error) {
    signal.throwIfAborted();
    Logger.warn(`Podcast YouTube match failed: ${error}`);
  }
  signal.throwIfAborted();
  return {
    kind: 'rss',
    url: source.episode.audioUrl,
    transcriptUrl: source.episode.transcriptUrl,
    selection: 'auto',
  };
}

/** Canonical HTTPS watch URL; switching timelines always starts at zero. */
function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/** Episode → video match for explicit YouTube policies; a miss is an error. */
async function matchEpisodeVideoId(episode: Episode, signal: AbortSignal): Promise<string> {
  const videoId = await findYouTubeVideoId(episode, signal);
  signal.throwIfAborted();
  if (!videoId) throw new Error('No YouTube match found for this episode.');
  return videoId;
}
