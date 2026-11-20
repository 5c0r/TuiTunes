import { atom, type PrimitiveAtom } from 'jotai';
import type { PlayerAudioBackend, PlayerProcessIdentity, PlayerState } from '../player/types';
import type { PlaybackTarget, Track } from '../providers/types';

/** Current playback position in seconds, updated ~100ms from mpv. */
export const playerPositionAtom = atom(0);

/** Duration of the current track in seconds. */
export const playerDurationAtom = atom(0);

/** Volume level, 0–100. */
export const playerVolumeAtom = atom(100);

/** Whether audio output is muted. */
export const playerMuteAtom = atom(false);

/** Playback speed multiplier (1.0 = normal). */
export const playerSpeedAtom = atom(1);

/** Current player state. */
export const playerStateAtom = atom<PlayerState>('stopped');

/**
 * The complete playback target the player is committed to:
 * track, resolved playback source, request identity, and queue/direct origin.
 */
export const playerPlaybackAtom: PrimitiveAtom<PlaybackTarget | null> = atom<PlaybackTarget | null>(
  null,
);

/** Track of the current playback target — read-only derivation of playerPlaybackAtom. */
export const playerTrackAtom = atom<Track | null>((get) => get(playerPlaybackAtom)?.track ?? null);

/** Latest player error to surface in the UI, or null when healthy. */
export const playerErrorAtom: PrimitiveAtom<string | null> = atom<string | null>(null);

/**
 * Identity of the mpv process actually backing playback (socket, pid,
 * unique audio client name), or null when none is alive. Cleared on process
 * failure/destroy; every respawn publishes a fresh identity.
 */
export const playerProcessIdentityAtom: PrimitiveAtom<PlayerProcessIdentity | null> =
  atom<PlayerProcessIdentity | null>(null);

/** Normalized audio backend of the current process (observer 14, current-ao). */
export const playerAudioBackendAtom: PrimitiveAtom<PlayerAudioBackend> =
  atom<PlayerAudioBackend>(null);

/** Playback progress as a fraction 0–1. Zero when duration is unknown. */
export const playerProgressAtom = atom((get) => {
  const d = get(playerDurationAtom);
  return d > 0 ? Math.max(0, Math.min(1, get(playerPositionAtom) / d)) : 0;
});
