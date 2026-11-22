export type PlayerState = 'stopped' | 'playing' | 'paused' | 'buffering';

/** Options for PlayerController.play. */
export interface PlayerLoadOptions {
  /**
   * Source-switch semantics: keep mpv's global pause untouched across the
   * loadfile — no setPause(false) is sent and userPaused is not reset, so
   * the actual pause state (including user changes made while the
   * replacement is still loading) carries through to the new file.
   */
  preservePause?: boolean;
  /**
   * Initial seek target in seconds, bound to this load's request: applied
   * at most once after this target's file loads (clamped to the usable
   * duration, skipped with a nonfatal notice when the file is not
   * seekable). The play() promise settles only after that seek has
   * succeeded or terminally failed.
   */
  startPosition?: number;
}

/** Identity of the mpv process actually backing playback. */
export interface PlayerProcessIdentity {
  /** Unix socket the controller's IPC session is connected to. */
  socketPath: string;
  /** OS pid of the owned mpv child. */
  pid: number;
  /** Unique --audio-client-name passed to this actual spawn. */
  clientName: string;
}

/**
 * Normalized audio backend derived from mpv's current-ao (observer 14).
 * null means no audio output has been reported yet.
 */
export type PlayerAudioBackend = 'pipewire' | 'pulse' | 'coreaudio' | 'unsupported' | null;

export interface MpvResponse {
  error: string;
  data?: unknown;
  request_id: number;
}

export interface MpvEvent {
  event: string;
  id?: number;
  name?: string;
  data?: unknown;
  // mpv events carry arbitrary extra fields (reason, file_error, etc.)
  [key: string]: unknown;
}

export type MpvMessage = MpvResponse | MpvEvent;

export interface MpvPropertyMap {
  'time-pos': number;
  duration: number;
  pause: boolean;
  volume: number;
  mute: boolean;
  'media-title': string;
  metadata: Record<string, string>;
  'playlist-pos': number;
  'playlist-count': number;
  'core-idle': boolean;
  'idle-active': boolean;
  'paused-for-cache': boolean;
  speed: number;
  'current-ao': string;
  /** File-scoped: whether the loaded file supports seeking. */
  'seekable': boolean;
}

export const OBSERVED_PROPERTIES: ReadonlyArray<{ id: number; name: keyof MpvPropertyMap }> = [
  { id: 1, name: 'time-pos' },
  { id: 2, name: 'duration' },
  { id: 3, name: 'pause' },
  { id: 4, name: 'volume' },
  { id: 5, name: 'mute' },
  { id: 6, name: 'media-title' },
  { id: 7, name: 'metadata' },
  { id: 8, name: 'playlist-pos' },
  { id: 9, name: 'playlist-count' },
  { id: 10, name: 'idle-active' },
  { id: 11, name: 'core-idle' },
  { id: 12, name: 'paused-for-cache' },
  { id: 13, name: 'speed' },
  { id: 14, name: 'current-ao' },
  { id: 15, name: 'seekable' },
] as const;

/**
 * Validate an mpv playlist entry identity: a nonnegative safe integer.
 * Used both for loadfile ACK payloads and event fields.
 */
export function parsePlaylistEntryId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Normalize a current-ao report into the capture-capable backend set.
 * Empty/absent reports decode to null (unknown); any other named output —
 * including the explicit `null` sink — is a known-uncapturable backend.
 */
export function normalizeAudioBackend(value: unknown): PlayerAudioBackend {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  if (name.length === 0) return null;
  if (name === 'pipewire') return 'pipewire';
  if (name === 'pulse' || name === 'pulseaudio') return 'pulse';
  if (name === 'coreaudio') return 'coreaudio';
  return 'unsupported';
}

// Discriminant: events always have `event` field. A message may have both
// `event` and `request_id` (mpv does this), so `event` takes precedence.
export function isMpvEvent(msg: MpvMessage): msg is MpvEvent {
  return 'event' in msg;
}

export function isMpvResponse(msg: MpvMessage): msg is MpvResponse {
  return 'request_id' in msg && !('event' in msg);
}
