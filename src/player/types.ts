export type PlayerState = 'stopped' | 'playing' | 'paused' | 'buffering';

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
  'duration': number;
  'pause': boolean;
  'volume': number;
  'mute': boolean;
  'media-title': string;
  'metadata': Record<string, string>;
  'playlist-pos': number;
  'playlist-count': number;
  'idle-active': boolean;
  'core-idle': boolean;
  'paused-for-cache': boolean;
  'speed': number;
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
] as const;

// Discriminant: events always have `event` field. A message may have both
// `event` and `request_id` (mpv does this), so `event` takes precedence.
export function isMpvEvent(msg: MpvMessage): msg is MpvEvent {
  return 'event' in msg;
}

export function isMpvResponse(msg: MpvMessage): msg is MpvResponse {
  return 'request_id' in msg && !('event' in msg);
}
