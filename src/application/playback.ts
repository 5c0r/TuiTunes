import type { Store } from 'jotai/vanilla/store';
import type { PlayerPort } from '../player/controller';
import { mediaKey } from '../providers/media';
import type { resolvePlaybackSource } from '../providers/media';
import type {
  PlaybackSourcePreference,
  PlaybackTarget,
  ResolvedPlaybackSource,
  Track,
} from '../providers/types';
import { playerErrorAtom, playerPlaybackAtom, playerStateAtom } from '../store/player';
import { queueStateAtom } from '../store/queue';
import {
  cycleRepeat,
  enqueueEntries,
  enqueueEntry,
  nextEntryId,
  previousEntryId,
  removeEntry,
  selectEntry,
  setShuffle,
} from '../store/queue-actions';

/** Outcome of a source-preference apply: saved, no-op, accepted load, cancelled, or failed. */
export type SetSourcePreferenceResult =
  | { status: 'saved' | 'unchanged' | 'loading' | 'superseded' }
  | { status: 'failed'; message: string };

export interface PlaybackSession {
  playDirect(track: Track): Promise<void>;
  playQueueEntry(entryId: string): Promise<void>;
  enqueue(track: Track): void;
  /** Atomically append a validated batch; returns the appended entry IDs. */
  enqueueMany(tracks: readonly Track[]): string[];
  /** Collect an album's tracks, then atomically enqueue and play its first entry. */
  playAlbum(loadTracks: (signal: AbortSignal) => Promise<readonly Track[]>): Promise<void>;
  remove(entryId: string): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  toggleShuffle(): void;
  cycleRepeat(): void;
  /** Saved per-episode playback-source policy for the track's media key. */
  getSourcePreference(track: Track): PlaybackSourcePreference;
  /**
   * Apply a per-episode policy. `expectedRequestId = null` (or a request that
   * no longer matches the committed target/queue entry) saves for future
   * playback only; a matching request performs a genuine active switch.
   */
  setSourcePreference(
    track: Track,
    preference: PlaybackSourcePreference,
    expectedRequestId: number | null,
  ): Promise<SetSourcePreferenceResult>;
  dispose(): Promise<void>;
}
export function createPlaybackSession(
  store: Store,
  player: PlayerPort,
  deps: {
    resolve: typeof resolvePlaybackSource;
    onLoaded: (target: PlaybackTarget) => void;
    /** Reads the saved policy for a media key; missing/invalid reads behave as Auto. */
    getSourcePreference: (key: string) => PlaybackSourcePreference;
    /** Persists a policy; Auto removes the row. Throws on DB failure. */
    saveSourcePreference: (key: string, pref: PlaybackSourcePreference) => void;
  },
): PlaybackSession {
  let generation = 0;
  let pending: AbortController | null = null;
  let disposed = false;
  let loadedRequestId: number | null = null;
  /**
   * Preference awaiting its request's still-current successful load before
   * commit; bound to the intent generation and the media-key revision that
   * was current when the switch started resolving.
   */
  let pendingPreference: {
    key: string;
    preference: PlaybackSourcePreference;
    requestId: number;
    revision: number;
  } | null = null;
  /** Monotonic per-media-key count of successful policy writes. */
  const preferenceRevisions = new Map<string, number>();
  const jobs = new Set<Promise<void>>();
  function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  function report(error: unknown): void {
    if (!disposed) store.set(playerErrorAtom, message(error));
  }
  function supported(track: Track): boolean {
    if (track.source) return true;
    report(new Error('This saved item has no supported playback source.'));
    return false;
  }
  /**
   * Resolve and load one track. Without a reservation this creates a fresh
   * playback intent; with one it reuses an intent already reserved by
   * playAlbum, so collecting and first-entry load share a single ownership
   * generation instead of the collector aborting its own playback.
   */
  async function play(
    track: Track,
    origin: PlaybackTarget['origin'],
    reservation?: { requestId: number; controller: AbortController },
  ): Promise<void> {
    if (disposed || !supported(track)) return;
    const requestId = reservation?.requestId ?? ++generation;
    const controller = reservation?.controller ?? new AbortController();
    if (!reservation) {
      pending?.abort();
      pending = controller;
    }
    store.set(playerErrorAtom, null);
    store.set(queueStateAtom, (state) =>
      origin.kind === 'queue' ? selectEntry(state, origin.entryId) : { ...state, cursorId: null },
    );
    let resolved = false;
    try {
      // Every ordinary play honors the episode's saved policy — search, feeds,
      // favorites, history, direct play and queue traversal all pass through here.
      const preference = deps.getSourcePreference(mediaKey(track));
      const source = await deps.resolve(track, controller.signal, preference);
      if (disposed || requestId !== generation || controller.signal.aborted) return;
      if (
        origin.kind === 'queue' &&
        !store.get(queueStateAtom).entries.some((entry) => entry.entryId === origin.entryId)
      )
        return;
      resolved = true;
      await player.play({ track: { ...track, resolvedSource: source }, source, requestId, origin });
    } catch (error) {
      if (disposed || requestId !== generation || controller.signal.aborted) return;
      if (!resolved) {
        const previous = store.get(playerPlaybackAtom)?.origin;
        store.set(queueStateAtom, (state) => ({
          ...state,
          cursorId:
            previous?.kind === 'queue' &&
            state.entries.some((entry) => entry.entryId === previous.entryId)
              ? previous.entryId
              : null,
        }));
      } else {
        await player.stop().catch(report);
      }
      report(error);
    } finally {
      if (pending === controller) pending = null;
    }
  }
  function start(track: Track, origin: PlaybackTarget['origin']): Promise<void> {
    const job = play(track, origin);
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    return job;
  }
  function playQueueEntry(entryId: string): Promise<void> {
    const entry = store.get(queueStateAtom).entries.find((item) => item.entryId === entryId);
    return entry ? start(entry.track, { kind: 'queue', entryId }) : Promise.resolve();
  }
  function sameSourcePreference(a: PlaybackSourcePreference, b: PlaybackSourcePreference): boolean {
    if (a.mode !== b.mode) return false;
    return a.mode !== 'youtube-video' || (b.mode === 'youtube-video' && a.videoId === b.videoId);
  }
  /** Same audible audio: same YouTube video or same RSS URL, regardless of policy. */
  function sameAudioIdentity(a: ResolvedPlaybackSource, b: ResolvedPlaybackSource): boolean {
    if (a.kind !== b.kind) return false;
    return a.kind === 'youtube' && b.kind === 'youtube' ? a.videoId === b.videoId : a.url === b.url;
  }
  async function setSourcePreference(
    track: Track,
    preference: PlaybackSourcePreference,
    expectedRequestId: number | null,
  ): Promise<SetSourcePreferenceResult> {
    if (disposed) return { status: 'failed', message: 'Playback session is disposed.' };
    if (!track.source)
      return { status: 'failed', message: 'This saved item has no supported playback source.' };
    if (track.source.kind !== 'podcast' && preference.mode !== 'auto')
      return { status: 'failed', message: 'Only podcast episodes support source preferences.' };
    const key = mediaKey(track);
    const stored = deps.getSourcePreference(key);
    /** Persist for future playback only; never touch audio or the queue. */
    const saveForFuture = (): SetSourcePreferenceResult => {
      if (sameSourcePreference(stored, preference)) return { status: 'unchanged' };
      try {
        deps.saveSourcePreference(key, preference);
      } catch (error) {
        return { status: 'failed', message: message(error) };
      }
      // A later future-only save invalidates an earlier pending active write
      // for the same episode without undoing an audio load already accepted;
      // the revision counter also guards switches still mid-resolution.
      preferenceRevisions.set(key, (preferenceRevisions.get(key) ?? 0) + 1);
      if (pendingPreference?.key === key) pendingPreference = null;
      return { status: 'saved' };
    };
    const committed = store.get(playerPlaybackAtom);
    const originEntryId = committed?.origin.kind === 'queue' ? committed.origin.entryId : null;
    // A genuine switch needs both the captured request ID and the episode
    // media key to match the committed target; otherwise save for future only.
    if (
      expectedRequestId === null ||
      committed === null ||
      committed.requestId !== expectedRequestId ||
      mediaKey(committed.track) !== key ||
      (originEntryId !== null &&
        !store.get(queueStateAtom).entries.some((entry) => entry.entryId === originEntryId))
    )
      return saveForFuture();

    // Genuine active switch: reserve the intent so any newer playback intent
    // (direct, queue, next, source, album) cancels both switch and pending write.
    const requestId = ++generation;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    // Capture the policy revision before resolution: a newer same-key save
    // during resolution means this switch may still switch audio, but its
    // preference write can never overwrite the newer policy.
    const revision = preferenceRevisions.get(key) ?? 0;
    try {
      const source = await deps.resolve(track, controller.signal, preference);
      const current = store.get(playerPlaybackAtom);
      if (
        disposed ||
        controller.signal.aborted ||
        requestId !== generation ||
        current?.requestId !== expectedRequestId ||
        mediaKey(current.track) !== key
      )
        return { status: 'superseded' };
      if (
        originEntryId !== null &&
        !store.get(queueStateAtom).entries.some((entry) => entry.entryId === originEntryId)
      ) {
        // The originating queue entry vanished mid-resolution; do not resurrect it.
        return saveForFuture();
      }
      if (
        sameAudioIdentity(source, committed.source) &&
        loadedRequestId === expectedRequestId &&
        store.get(playerStateAtom) !== 'stopped'
      ) {
        // Audibly identical, loaded and still-active audio: save the policy
        // without reload, seek, history row or lyric reset. Never rewrite the
        // committed source's tag.
        if ((preferenceRevisions.get(key) ?? 0) !== revision) return { status: 'superseded' };
        if (sameSourcePreference(stored, preference)) return { status: 'unchanged' };
        try {
          deps.saveSourcePreference(key, preference);
        } catch (error) {
          return { status: 'failed', message: message(error) };
        }
        preferenceRevisions.set(key, revision + 1);
        return { status: 'saved' };
      }
      // Install the request-bound pending write before issuing the load so a
      // file-loaded event racing the load command still finds its preference.
      pendingPreference = { key, preference, requestId, revision };
      // Fresh request, same origin/queue entry, position zero; mpv keeps the
      // user's pause/volume/mute/speed across the loadfile.
      try {
        await player.play(
          {
            track: { ...track, resolvedSource: source },
            source,
            requestId,
            origin: committed.origin,
          },
          { preservePause: true },
        );
      } catch (error) {
        // The load was rejected; drop the pending write only if this switch
        // still owns the slot.
        if (pendingPreference?.requestId === requestId) pendingPreference = null;
        throw error;
      }
      // The load command was accepted; the preference becomes durable only
      // when this exact request is still current on its loaded event.
      return { status: 'loading' };
    } catch (error) {
      // Resolution/load failure leaves old audio and the old preference intact.
      if (disposed || controller.signal.aborted || requestId !== generation)
        return { status: 'superseded' };
      return { status: 'failed', message: message(error) };
    } finally {
      if (pending === controller) pending = null;
    }
  }
  const unLoaded = player.onTrackLoaded((target) => {
    if (
      disposed ||
      store.get(playerPlaybackAtom)?.requestId !== target.requestId ||
      loadedRequestId === target.requestId
    )
      return;
    loadedRequestId = target.requestId;
    try {
      deps.onLoaded(target);
    } catch (error) {
      report(error);
    }
    if (
      pendingPreference?.requestId === target.requestId &&
      // A newer reserved intent (even one still resolving) owns playback now;
      // its history callback above still ran, but the preference must not commit.
      target.requestId === generation &&
      (preferenceRevisions.get(pendingPreference.key) ?? 0) === pendingPreference.revision
    ) {
      const commit = pendingPreference;
      pendingPreference = null;
      try {
        deps.saveSourcePreference(commit.key, commit.preference);
        preferenceRevisions.set(commit.key, commit.revision + 1);
      } catch (error) {
        // Audio already loaded and playing; only the preference was not saved.
        report(error);
      }
    } else if (pendingPreference?.requestId === target.requestId) {
      pendingPreference = null;
    }
  });
  const unEnd = player.onTrackEnd((target) => {
    if (disposed || pending || store.get(playerPlaybackAtom)?.requestId !== target.requestId)
      return;
    const state = store.get(queueStateAtom);
    if (state.repeat === 'track') {
      void start(target.track, target.origin);
    } else if (target.origin.kind === 'queue') {
      const next = nextEntryId(state);
      if (next) void playQueueEntry(next);
    }
  });
  /** Batch enqueue shared by the session API and album playback. */
  function enqueueMany(tracks: readonly Track[]): string[] {
    if (disposed || tracks.length === 0) return [];
    // The whole batch is validated before any mutation; one store update
    // appends every row with its own fresh entry identity.
    if (tracks.some((track) => !supported(track))) return [];
    const entries = tracks.map((track) => ({ entryId: crypto.randomUUID(), track }));
    store.set(queueStateAtom, (state) => enqueueEntries(state, entries));
    return entries.map((entry) => entry.entryId);
  }
  return {
    playDirect: (track) => start(track, { kind: 'direct' }),
    playQueueEntry,
    enqueue(track) {
      if (!disposed && supported(track))
        store.set(queueStateAtom, (state) =>
          enqueueEntry(state, { entryId: crypto.randomUUID(), track }),
        );
    },
    enqueueMany(tracks) {
      return enqueueMany(tracks);
    },
    async playAlbum(loadTracks) {
      if (disposed) return;
      // Reserve the playback intent before collecting: old audio and the
      // queue stay untouched while pages load, and any newer playback intent
      // aborts this collector so it cannot steal playback later.
      const requestId = ++generation;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      store.set(playerErrorAtom, null);
      try {
        const tracks = await loadTracks(controller.signal);
        if (disposed || controller.signal.aborted || requestId !== generation) return;
        if (tracks.length === 0) {
          report(new Error('This album has no supported tracks.'));
          return;
        }
        // Strict batch validation: any unsupported row rejects the whole
        // album action with the queue untouched — never a partial enqueue.
        const ids = enqueueMany(tracks);
        if (ids.length === 0) return;
        // Reuse the reserved intent through first-entry load: the album's own
        // play must not abort its collector or lose intent ownership.
        await play(tracks[0], { kind: 'queue', entryId: ids[0] }, { requestId, controller });
      } catch (error) {
        if (disposed || controller.signal.aborted || requestId !== generation) return;
        report(error);
      } finally {
        if (pending === controller) pending = null;
      }
    },
    async remove(entryId) {
      if (disposed) return;
      const transition = removeEntry(store.get(queueStateAtom), entryId);
      const audible = store.get(playerPlaybackAtom)?.origin;
      store.set(queueStateAtom, transition.state);
      if (transition.removedCurrent) {
        const removalGeneration = ++generation;
        pending?.abort();
        pending = null;
        await player.stop();
        if (!disposed && generation === removalGeneration && transition.successorId)
          await playQueueEntry(transition.successorId);
      } else if (audible?.kind === 'queue' && audible.entryId === entryId) {
        await player.stop();
      }
    },
    async next() {
      const id = nextEntryId(store.get(queueStateAtom));
      if (id) await playQueueEntry(id);
    },
    async previous() {
      const id = previousEntryId(store.get(queueStateAtom));
      if (id) await playQueueEntry(id);
    },
    toggleShuffle() {
      if (!disposed) store.set(queueStateAtom, (state) => setShuffle(state, !state.shuffle));
    },
    cycleRepeat() {
      if (!disposed) store.set(queueStateAtom, cycleRepeat);
    },
    getSourcePreference: (track) => deps.getSourcePreference(mediaKey(track)),
    setSourcePreference(track, preference, expectedRequestId) {
      const outcome = setSourcePreference(track, preference, expectedRequestId);
      const drain = outcome.then(
        () => undefined,
        () => undefined,
      );
      jobs.add(drain);
      void drain.finally(() => jobs.delete(drain));
      return outcome;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      pending?.abort();
      pending = null;
      pendingPreference = null;
      unLoaded();
      unEnd();
      await Promise.allSettled(jobs);
    },
  };
}
