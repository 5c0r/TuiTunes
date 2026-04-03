import { atom } from 'jotai';
import type { PlayerState } from '../player/types';
import type { Track } from '../providers/types';

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

/** Currently playing track, or null if nothing loaded. */
export const playerTrackAtom = atom<Track | null>(null);

/** Playback progress as a fraction 0–1. Zero when duration is unknown. */
export const playerProgressAtom = atom((get) => {
  const d = get(playerDurationAtom);
  return d > 0 ? get(playerPositionAtom) / d : 0;
});
