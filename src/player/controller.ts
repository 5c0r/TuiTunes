import type { Store } from 'jotai/vanilla/store';
import type { PlaybackTarget } from '../providers/types';
import {
  playerAudioBackendAtom,
  playerDurationAtom,
  playerErrorAtom,
  playerMuteAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerProcessIdentityAtom,
  playerSpeedAtom,
  playerStateAtom,
  playerVolumeAtom,
} from '../store/player';
import { Logger } from '../utils/logger';
import { MpvIPC } from './ipc';
import { killMpv, spawnMpv, type MpvProcessHandle, type MpvSpawnOptions } from './process';
import {
  normalizeAudioBackend,
  parsePlaylistEntryId,
  type MpvEvent,
  type PlayerLoadOptions,
  type PlayerState,
} from './types';

/**
 * Narrow player surface consumed by the application layer.
 * Bootstrap alone owns the concrete init/destroy lifecycle.
 */
export type PlayerPort = Pick<
  PlayerController,
  | 'play'
  | 'stop'
  | 'togglePause'
  | 'seekRelative'
  | 'seekAbsolute'
  | 'setVolume'
  | 'addVolume'
  | 'toggleMute'
  | 'setSpeed'
  | 'cycleSpeedUp'
  | 'cycleSpeedDown'
  | 'onTrackEnd'
  | 'onTrackLoaded'
>;

/**
 * Process lifecycle dependency. `start` spawns (or respawns) the player
 * process and resolves with its handle (socket path, pid, audio client
 * name); `stop` terminates it and cleans up its socket.
 */
export interface PlayerProcessPort {
  start(signal?: AbortSignal): Promise<MpvProcessHandle>;
  stop(): Promise<void>;
}

/** Real mpv-backed process port — the default controller dependency. */
export function createMpvProcessPort(options: MpvSpawnOptions = {}): PlayerProcessPort {
  return {
    start(signal?: AbortSignal): Promise<MpvProcessHandle> {
      return spawnMpv({ ...options, signal });
    },
    stop(): Promise<void> {
      return killMpv();
    },
  };
}

type TrackHandler = (target: PlaybackTarget) => void;

/** Lifecycle phase of a native playlist entry binding. */
type BindingPhase =
  /** Seen only via events; its loadfile ACK has not been processed yet. */
  | 'pending'
  /** ACK-confirmed binding whose file has not committed a file-loaded yet. */
  | 'loading'
  /** file-loaded committed for the still-current matching target. */
  | 'active'
  /** Terminated (end-file) or superseded. */
  | 'ended';

/**
 * A terminal mpv fact for an entry, possibly observed before its load ACK.
 * Buffered facts apply only when the eventual ACK identity matches.
 */
interface EndFact {
  reason: string;
  fileError?: string;
  /** First inserted native entry on a redirect (mpv end-file fields). */
  insertId: number | null;
  /** Number of entries the redirect inserted; 0 when unusable. */
  insertCount: number;
}

/**
 * A native mpv playlist entry bound to the immutable PlaybackTarget whose
 * loadfile created it, within one IPC/process epoch.
 */
interface EntryBinding {
  entryId: number;
  target: PlaybackTarget;
  epoch: number;
  phase: BindingPhase;
  /** Latest file-scoped property values observed before the entry commits. */
  props: Map<string, unknown>;
  /** file-loaded observed before the load ACK confirmed the binding. */
  loadedFact: boolean;
  /** end-file observed before the load ACK confirmed the binding. */
  endFact: EndFact | null;
  /** onTrackLoaded already fired for this target's committed file. */
  announced: boolean;
  seq: number;
}

/** A serialized load intent waiting for (or running in) its critical section. */
interface LoadJob {
  target: PlaybackTarget;
  options: PlayerLoadOptions;
  /** Internal recovery payload: resume position/pause after a respawn. */
  recovery?: { position: number; paused: boolean };
  resolve: () => void;
  reject: (err: unknown) => void;
}

const RECOVERY_RETRY_DELAY_MS = 500;
const RECOVERY_FLAP_WINDOW_MS = 5_000;
/** Positions below this are not worth a recovery seek. */
const RECOVERY_SEEK_MIN_POSITION = 2;
/** Upper bound on remembered bindings; late duplicates stay ignorable either way. */
const MAX_BINDINGS = 8;

/** Extract and validate a terminal end-file fact from an mpv event. */
function extractEndFact(event: MpvEvent): EndFact {
  const rawCount = event.playlist_insert_num_entries;
  return {
    reason: typeof event.reason === 'string' ? event.reason : 'unknown',
    fileError: typeof event.file_error === 'string' ? event.file_error : undefined,
    insertId: parsePlaylistEntryId(event.playlist_insert_id),
    insertCount:
      typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 0,
  };
}

/** mpv controls that live on the process, not on any one loaded file. */
const GLOBAL_PROPERTIES: Record<string, true> = {
  pause: true,
  volume: true,
  mute: true,
  speed: true,
};

/**
 * High-level playback controller.
 * Owns the mpv IPC connection and drives playback from complete
 * `PlaybackTarget`s — the resolved playback source is part of the target, so
 * crash recovery never reconstructs stream URLs from the provider registry.
 *
 * Every loadfile is correlated through mpv's native playlist_entry_id: the
 * ACK establishes a binding (entry id → immutable target → IPC/process
 * epoch), start-file attributes ID-less file-loaded/playback-restart events
 * to the stream-ordered entry, and end-file carries its explicit id. Only a
 * still-current matching binding may commit state, fire track callbacks,
 * advance the queue, or consume a recovery seek.
 */
export class PlayerController {
  static readonly SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;

  private ipc = new MpvIPC();
  private store: Store;
  private processPort: PlayerProcessPort;

  private currentTarget: PlaybackTarget | null = null;
  private lastPosition = 0;

  // Independent playback-state inputs, merged by deriveState().
  private fileActive = false;
  private fileLoading = false;
  private userPaused = false;
  private cachePaused = false;

  /** Recovery-seek intent, executed only when its target finishes loading. */
  private pendingSeek: { requestId: number; position: number } | null = null;
  private pendingRecovery: Promise<void> | null = null;
  private recoveryAbort: AbortController | null = null;
  private lastRecoveryAttempt = 0;

  // --- native load correlation (all state is epoch-scoped) ---

  /** Bumped on every IPC (re)connect; voids every older binding. */
  private epoch = 0;
  private bindings = new Map<number, EntryBinding>();
  private bindingSeq = 0;
  /** Entry id of the most recent start-file — attribution cursor for ID-less events. */
  private streamEntryId: number | null = null;
  /** Entry whose file-loaded committed and still owns file-scoped state. */
  private activeEntryId: number | null = null;
  /** The single loadfile command whose ACK has not been bound yet. */
  private inflightLoad: { target: PlaybackTarget; epoch: number } | null = null;
  /**
   * Pause captured from a dead process, to be reapplied by the surviving
   * preserve load before its command (a fresh process starts unpaused).
   */
  private pendingPauseReapply = false;

  // --- serialized load pipeline ---

  /** Latest unsent desired load while a critical section is running. */
  private queuedLoad: LoadJob | null = null;
  /** Job whose critical section is currently running, if any. */
  private activeJob: LoadJob | null = null;
  private pumping = false;

  private trackEndHandlers = new Set<TrackHandler>();
  private trackLoadedHandlers = new Set<TrackHandler>();

  private _destroyed = false;

  constructor(store: Store, processPort: PlayerProcessPort = createMpvProcessPort()) {
    this.store = store;
    this.processPort = processPort;
  }

  /**
   * Register a callback for when the current track finishes (EOF).
   * Receives the target that ended. Returns an unregister function;
   * unregistering is always safe.
   */
  onTrackEnd(handler: TrackHandler): () => void {
    this.trackEndHandlers.add(handler);
    return () => {
      this.trackEndHandlers.delete(handler);
    };
  }

  /**
   * Register a callback for when a track's file is loaded and playable.
   * Receives the target that loaded. Returns an unregister function.
   */
  onTrackLoaded(handler: TrackHandler): () => void {
    this.trackLoadedHandlers.add(handler);
    return () => {
      this.trackLoadedHandlers.delete(handler);
    };
  }

  /**
   * Spawn mpv, connect IPC, subscribe to property changes.
   * Must be called once at startup before any playback commands.
   */
  async init(): Promise<void> {
    const handle = await this.processPort.start();
    this.bindIpc();
    this.beginEpoch();
    await this.ipc.connect(handle.socketPath);
    await this.ipc.observeAll();
    this.publishIdentity(handle);
    Logger.info('PlayerController initialized');
  }

  /**
   * Load and play a complete playback target (track + resolved source +
   * request identity). The resolved source URL is used verbatim, both here
   * and for any later crash recovery of this target.
   *
   * Ordinary play starts unpaused. `preservePause` (a source switch) leaves
   * mpv's global pause untouched across the loadfile so user pause changes
   * made during preparation or queued loading are preserved.
   */
  async play(target: PlaybackTarget, options: PlayerLoadOptions = {}): Promise<void> {
    if (this._destroyed) throw new Error('PlayerController is destroyed');

    this.currentTarget = target;
    this.pendingSeek = null;
    this.lastPosition = 0;
    this.fileActive = false;
    this.fileLoading = true;
    this.cachePaused = false;
    // userPaused is deliberately NOT reset here: the flip belongs to the
    // load section that actually commands the unpause, so an intent
    // superseded before its command cannot misstate the live pause state.
    // While loading, deriveState() reports buffering regardless of it.
    this.store.set(playerPlaybackAtom, target);
    this.store.set(playerErrorAtom, null);
    this.store.set(playerPositionAtom, 0);
    this.store.set(playerDurationAtom, 0);
    this.deriveState();

    return this.enqueueLoad(target, options);
  }

  async togglePause(): Promise<void> {
    await this.ipc.togglePause();
  }

  async seekRelative(seconds: number): Promise<void> {
    await this.ipc.seek(seconds, 'relative');
  }

  async seekAbsolute(seconds: number): Promise<void> {
    // Clamp to valid range
    const duration = this.store.get(playerDurationAtom);
    const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    await this.ipc.seek(clamped, 'absolute+exact');
  }

  async setVolume(volume: number): Promise<void> {
    await this.ipc.setVolume(volume);
  }

  async addVolume(delta: number): Promise<void> {
    await this.ipc.addVolume(delta);
  }

  async toggleMute(): Promise<void> {
    await this.ipc.toggleMute();
  }

  async setSpeed(speed: number): Promise<void> {
    const clamped = Math.max(0.25, Math.min(4.0, speed));
    await this.ipc.command('set_property', 'speed', clamped);
  }

  async cycleSpeedUp(): Promise<void> {
    const current = this.store.get(playerSpeedAtom);
    const presets = PlayerController.SPEED_PRESETS;
    const next = presets.find((s) => s > current) ?? presets[presets.length - 1];
    await this.setSpeed(next);
  }

  async cycleSpeedDown(): Promise<void> {
    const current = this.store.get(playerSpeedAtom);
    const presets = PlayerController.SPEED_PRESETS;
    const prev = [...presets].reverse().find((s) => s < current) ?? presets[0];
    await this.setSpeed(prev);
  }

  async stop(): Promise<void> {
    if (this._destroyed) return;
    this.pendingSeek = null;
    this.pendingPauseReapply = false;
    this.clearNativeBindings();
    this.fileActive = false;
    this.fileLoading = false;
    this.userPaused = false;
    this.cachePaused = false;
    this.currentTarget = null;
    this.lastPosition = 0;
    this.store.set(playerPlaybackAtom, null);
    this.store.set(playerStateAtom, 'stopped');
    this.store.set(playerPositionAtom, 0);
    this.store.set(playerDurationAtom, 0);
    await this.ipc.stop();
  }

  /**
   * Gracefully shut down: abort and await any pending start/recovery,
   * quit mpv IPC, and stop the process. Idempotent.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;
    this.pendingSeek = null;
    this.pendingPauseReapply = false;

    // Abort and await any pending start/recovery before the final stop so a
    // late reconnect cannot revive playback during shutdown.
    this.recoveryAbort?.abort();
    if (this.pendingRecovery) {
      try {
        await this.pendingRecovery;
      } catch {
        // Recovery failures are already logged.
      }
    }

    try {
      await this.ipc.quit();
    } catch {
      // mpv may already be dead
    }
    await this.processPort.stop();

    this.fileActive = false;
    this.fileLoading = false;
    this.currentTarget = null;
    this.lastPosition = 0;
    this.beginEpoch();
    this.trackEndHandlers.clear();
    this.trackLoadedHandlers.clear();
    this.store.set(playerStateAtom, 'stopped');
    this.store.set(playerPlaybackAtom, null);
    this.store.set(playerPositionAtom, 0);
    this.store.set(playerDurationAtom, 0);
    Logger.info('PlayerController destroyed');
  }

  // --- Internal: load pipeline ---

  /**
   * Serialize the short load command/ACK critical sections (plus setPause
   * for ordinary unpaused play). While one handshake is unbound, only the
   * latest unsent desired load is kept; superseded queued loads are skipped
   * — a cancellation outcome, not a playback error. Media loading itself is
   * never awaited here. At most one unbound command handshake exists at any
   * time, which is what makes event attribution unambiguous.
   */
  private enqueueLoad(
    target: PlaybackTarget,
    options: PlayerLoadOptions,
    recovery?: LoadJob['recovery'],
  ): Promise<void> {
    // A queued job that never started is superseded by this one.
    this.queuedLoad?.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.queuedLoad = { target, options, recovery, resolve, reject };
    this.pumpLoads();
    return promise;
  }

  private pumpLoads(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.queuedLoad) {
          const job = this.queuedLoad;
          this.queuedLoad = null;
          if (this._destroyed || this.currentTarget !== job.target) {
            job.resolve();
            continue;
          }
          this.activeJob = job;
          try {
            await this.runLoadSection(job);
            job.resolve();
          } catch (err) {
            // A superseded intent's failure is a cancellation outcome, not a
            // playback error for its caller.
            if (this._destroyed || this.currentTarget !== job.target) {
              job.resolve();
            } else {
              this.handleLoadFailure(job);
              job.reject(err);
            }
          } finally {
            this.activeJob = null;
          }
        }
      } finally {
        this.pumping = false;
      }
    })();
  }

  /** One critical section: optional pause set, loadfile command, ACK→binding. */
  private async runLoadSection(job: LoadJob): Promise<void> {
    const { target, options, recovery } = job;

    await this.ensureConnected();
    if (this._destroyed || this.currentTarget !== target) return;

    if (recovery?.paused) {
      // Reapply the pause captured when the old process died BEFORE the
      // reload, so the resumed file stands still until its recovery seek.
      this.userPaused = true;
      await this.ipc.setPause(true);
    } else if (!options.preservePause) {
      this.pendingPauseReapply = false;
      // Ordinary play always starts unpaused, even if the previous file was
      // paused. The reset lives here — inside the still-current section that
      // actually commands the unpause — so a load superseded before its
      // command can never flip the pause state of the audio still playing.
      this.userPaused = false;
      await this.ipc.setPause(false);
    } else if (this.pendingPauseReapply) {
      // This preserve load survived a respawn whose audible playback was
      // paused: the fresh process started unpaused, so reapply before the
      // load to carry the user's pause through the recovery.
      this.pendingPauseReapply = false;
      this.userPaused = true;
      await this.ipc.setPause(true);
    }
    if (this._destroyed || this.currentTarget !== target) return;

    if (recovery && recovery.position > RECOVERY_SEEK_MIN_POSITION) {
      // Armed before the command: a file-loaded that precedes the ACK can
      // already consume the intent.
      this.pendingSeek = { requestId: target.requestId, position: recovery.position };
    }

    this.inflightLoad = { target, epoch: this.epoch };
    let ack: { playlistEntryId: number };
    try {
      ack = await this.ipc.loadfile(target.source.url);
    } catch (err) {
      // The load never ACKed: a binding provisionally attributed to this
      // handshake is void.
      this.dropInflightBindings(target);
      throw err;
    } finally {
      if (this.inflightLoad?.target === target) this.inflightLoad = null;
    }
    if (this._destroyed) return;
    this.bindLoadAck(ack.playlistEntryId, target);
  }

  /** A failed load must not leave buffering state behind a newer intent. */
  private handleLoadFailure(job: LoadJob): void {
    if (this._destroyed || this.currentTarget !== job.target) return;
    this.fileLoading = false;
    this.deriveState();
  }

  /** Establish the ACK-confirmed binding and settle buffered lifecycle facts. */
  private bindLoadAck(entryId: number, target: PlaybackTarget): void {
    // Provisional bindings for other entries were misattributed; void them.
    for (const b of [...this.bindings.values()]) {
      if (b.phase === 'pending' && b.entryId !== entryId) this.bindings.delete(b.entryId);
    }

    let binding = this.bindings.get(entryId);
    if (!binding) {
      binding = {
        entryId,
        target,
        epoch: this.epoch,
        phase: 'loading',
        props: new Map(),
        loadedFact: false,
        endFact: null,
        announced: false,
        seq: ++this.bindingSeq,
      };
      this.bindings.set(entryId, binding);
    } else if (binding.target !== target || binding.epoch !== this.epoch) {
      // The ACK identity collides with a binding that is not ours to confirm.
      Logger.warn(`loadfile ACK entry ${entryId} conflicts with an existing binding — ignored`);
      return;
    }

    if (binding.phase === 'pending') {
      binding.phase = 'loading';
      if (binding.loadedFact) {
        binding.loadedFact = false;
        this.commitFileLoaded(binding);
      }
      // A terminal fact buffered before the ACK applies only now that the
      // identity actually matched this load.
      if (binding.endFact) {
        const fact = binding.endFact;
        binding.endFact = null;
        this.applyEndFile(binding, fact);
      }
    }
    // 'ended' (terminated before its ACK, already settled at bind) and
    // impossible duplicates need nothing further.
    this.pruneBindings();
  }

  /** Delete provisional bindings that never received their ACK. */
  private dropInflightBindings(target: PlaybackTarget): void {
    for (const b of [...this.bindings.values()]) {
      if (b.phase === 'pending' && b.target === target && b.epoch === this.epoch) {
        this.bindings.delete(b.entryId);
      }
    }
  }

  /** Keep the binding set small; evict non-active bindings oldest-first. */
  private pruneBindings(): void {
    if (this.bindings.size <= MAX_BINDINGS) return;
    const ordered = [...this.bindings.values()].sort((a, b) => a.seq - b.seq);
    for (const b of ordered) {
      if (this.bindings.size <= MAX_BINDINGS) break;
      if (b.phase === 'active') continue;
      this.bindings.delete(b.entryId);
    }
  }

  /**
   * Commit a native file-loaded to its still-current matching target only.
   * Unknown or superseded entries can never commit a load, fire loaded
   * callbacks, mutate the committed target's fields, or consume a seek.
   */
  private commitFileLoaded(binding: EntryBinding): void {
    if (binding.phase !== 'pending' && binding.phase !== 'loading') return; // duplicate/ended
    if (binding.epoch !== this.epoch) return;
    if (binding.target !== this.currentTarget) {
      // The file that finished loading belongs to a superseded intent.
      binding.phase = 'ended';
      this.bindings.delete(binding.entryId);
      return;
    }
    binding.phase = 'active';
    this.activeEntryId = binding.entryId;
    this.fileActive = true;
    this.fileLoading = false;

    // Apply the latest file-scoped values observed before the commit.
    const buffered = binding.props;
    binding.props = new Map();
    for (const [name, value] of buffered) this.applyFileProperty(name, value);

    this.deriveState();

    if (!binding.announced) {
      // A redirect child inherits its parent's announcement: exactly one
      // onTrackLoaded per user-visible track load.
      binding.announced = true;
      for (const handler of [...this.trackLoadedHandlers]) {
        try {
          handler(binding.target);
        } catch (err) {
          Logger.error(`onTrackLoaded handler failed: ${err}`);
        }
      }
    }

    // Execute a recovery-seek intent only for the target that just loaded.
    const seek = this.pendingSeek;
    if (seek && seek.requestId === binding.target.requestId) {
      this.pendingSeek = null;
      void this.ipc.seek(seek.position, 'absolute+exact').catch((err: unknown) => {
        Logger.error(`Recovery seek failed: ${err}`);
      });
    }
  }

  // --- Internal: IPC wiring ---

  /** Register IPC handlers; done before connect so early messages are not lost. */
  private bindIpc(): void {
    this.ipc.onPropertyChange((name, value) => this.onPropertyChange(name, value));
    this.ipc.onEvent((event) => this.onEvent(event));
    this.ipc.onDisconnect(() => this.onDisconnect());
  }

  /**
   * Make sure the IPC is usable. If a recovery respawn is already in flight,
   * wait for it instead of racing a second reconnect.
   */
  private async ensureConnected(): Promise<void> {
    if (this.ipc.connected) return;
    if (!this.pendingRecovery) {
      void this.attemptRecovery();
    }
    if (this.pendingRecovery) await this.pendingRecovery;
    if (!this.ipc.connected) throw new Error('mpv IPC not connected');
  }

  // --- Internal: state derivation ---

  /**
   * Merge the independent inputs into one published state:
   * before a file is loaded, loading means buffering and otherwise stopped;
   * once loaded, user pause wins over cache pause; otherwise cache pause
   * means buffering and neither means playing.
   */
  private deriveState(): void {
    let next: PlayerState;
    if (!this.fileActive) {
      next = this.fileLoading ? 'buffering' : 'stopped';
    } else if (this.userPaused) {
      next = 'paused';
    } else if (this.cachePaused) {
      next = 'buffering';
    } else {
      next = 'playing';
    }
    this.store.set(playerStateAtom, next);
  }

  private markFileInactive(): void {
    this.fileActive = false;
    this.fileLoading = false;
    this.deriveState();
  }

  // --- Internal: mpv property/event handlers ---

  private onPropertyChange(name: string, value: unknown): void {
    // value is undefined when a property is unavailable (no file loaded);
    // unavailable or invalid payloads must not overwrite state.
    if (value === undefined) return;

    if (GLOBAL_PROPERTIES[name]) {
      this.applyGlobalProperty(name, value);
      return;
    }

    // File-scoped observations are gated by the active native entry…
    const active = this.activeBinding();
    if (active && active.epoch === this.epoch && active.target === this.currentTarget) {
      this.applyFileProperty(name, value);
      return;
    }
    // …and buffered against the entry that is still loading — so values
    // that precede the load ACK land when the binding commits — but only
    // for the entry the stream cursor actually attributes them to.
    const buffering = this.bufferingBinding();
    if (buffering) buffering.props.set(name, value);
    // Otherwise the observation belongs to a superseded or unknown file and
    // must not touch the committed target's state.
  }

  /** Volume/pause/mute/speed are process-wide controls; always applied. */
  private applyGlobalProperty(name: string, value: unknown): void {
    switch (name) {
      case 'pause':
        if (typeof value === 'boolean') {
          this.userPaused = value;
          this.deriveState();
        }
        break;
      case 'volume':
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.store.set(playerVolumeAtom, value);
        }
        break;
      case 'mute':
        if (typeof value === 'boolean') {
          this.store.set(playerMuteAtom, value);
        }
        break;
      case 'speed':
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.store.set(playerSpeedAtom, value);
        }
        break;
    }
  }

  private applyFileProperty(name: string, value: unknown): void {
    switch (name) {
      case 'time-pos':
        if (typeof value === 'number' && Number.isFinite(value)) {
          const position = Math.max(0, value);
          this.lastPosition = position;
          this.store.set(playerPositionAtom, position);
        }
        break;
      case 'duration':
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          this.store.set(playerDurationAtom, value);
        }
        break;
      case 'paused-for-cache':
        if (typeof value === 'boolean') {
          this.cachePaused = value;
          this.deriveState();
        }
        break;
      case 'current-ao':
        // Only a genuine string report updates the backend. Invalid payloads
        // (numbers, objects) and explicit nulls are unusable observations
        // and must not overwrite a known backend — same treatment as the
        // unavailable (absent-data) reports dropped before dispatch.
        if (typeof value === 'string') {
          this.store.set(playerAudioBackendAtom, normalizeAudioBackend(value));
        }
        break;
      // media-title/metadata/playlist-pos/playlist-count/idle-active/
      // core-idle are observed but carry no controller state today.
    }
  }

  private activeBinding(): EntryBinding | null {
    if (this.activeEntryId === null) return null;
    const b = this.bindings.get(this.activeEntryId);
    return b && b.phase === 'active' ? b : null;
  }

  /** The still-loading entry of the current target, if the cursor points at it. */
  private bufferingBinding(): EntryBinding | null {
    if (this.streamEntryId === null) return null;
    const b = this.bindings.get(this.streamEntryId);
    if (!b || b.epoch !== this.epoch) return null;
    if (b.phase !== 'pending' && b.phase !== 'loading') return null;
    if (b.target !== this.currentTarget) return null;
    return b;
  }

  private onEvent(event: MpvEvent): void {
    switch (event.event) {
      case 'start-file':
        this.onStartFile(event);
        break;
      case 'file-loaded':
        this.onFileLoaded();
        break;
      case 'playback-restart':
        // ID-less and already scoped to the stream-ordered start-file entry
        // by the attribution cursor. It carries no state transition of its
        // own and is never credited to whichever target is newest.
        break;
      case 'end-file':
        this.onEndFile(event);
        break;
      case 'shutdown':
        Logger.warn('mpv shutdown event received');
        this.markFileInactive();
        this.clearNativeBindings();
        break;
    }
  }

  /**
   * A start-file names the native entry mpv begins loading. With at most one
   * unbound load handshake in flight (the load pipeline is serialized), an
   * unknown entry id attributes to exactly that handshake — never to
   * whichever target is newest.
   */
  private onStartFile(event: MpvEvent): void {
    const entryId = parsePlaylistEntryId(event.playlist_entry_id);
    if (entryId === null) {
      Logger.warn('start-file without valid playlist_entry_id — cannot attribute');
      this.streamEntryId = null;
      return;
    }
    this.streamEntryId = entryId;
    if (this.bindings.has(entryId)) return; // restart of a known entry

    const inflight = this.inflightLoad;
    if (inflight && inflight.epoch === this.epoch) {
      this.bindings.set(entryId, {
        entryId,
        target: inflight.target,
        epoch: this.epoch,
        phase: 'pending',
        props: new Map(),
        loadedFact: false,
        endFact: null,
        announced: false,
        seq: ++this.bindingSeq,
      });
    } else {
      Logger.warn(
        `start-file for unknown playlist entry ${entryId} — no unbound load to attribute`,
      );
    }
  }

  private onFileLoaded(): void {
    // file-loaded is ID-less: attribute it to the stream-ordered start-file
    // entry, never to whichever target is newest.
    const entryId = this.streamEntryId;
    if (entryId === null) {
      Logger.warn('file-loaded without a start-file entry — ignored');
      return;
    }
    const binding = this.bindings.get(entryId);
    if (!binding) {
      Logger.warn(`file-loaded for unknown playlist entry ${entryId} — ignored`);
      return;
    }
    if (binding.phase === 'pending') {
      // The event preceded its load ACK: hold the fact until the binding is
      // ACK-confirmed.
      binding.loadedFact = true;
      return;
    }
    this.commitFileLoaded(binding);
  }

  private onEndFile(event: MpvEvent): void {
    // end-file carries its explicit native entry id; without a valid, known
    // id the event can never advance the queue, write errors, or mutate the
    // committed target.
    const entryId = parsePlaylistEntryId(event.playlist_entry_id);
    if (entryId === null) {
      Logger.warn('end-file without valid playlist_entry_id — ignored');
      return;
    }
    const binding = this.bindings.get(entryId);
    if (!binding) {
      Logger.debug(`end-file for unknown playlist entry ${entryId} — ignored`);
      return;
    }
    const fact = extractEndFact(event);
    if (binding.phase === 'pending') {
      // The event preceded its load ACK: the provisional attribution has
      // not been confirmed yet, so buffer the terminal fact (latest wins)
      // and touch nothing. It applies at bind time only if the eventual ACK
      // identity actually matches this entry.
      binding.endFact = fact;
      return;
    }
    this.applyEndFile(binding, fact);
  }

  /**
   * Apply a terminal fact to an ACK-verified binding. A binding whose target
   * was superseded terminates silently; the committed target alone may
   * advance the queue, publish errors, or hand ownership to a redirect child.
   */
  private applyEndFile(binding: EntryBinding, fact: EndFact): void {
    binding.phase = 'ended';
    if (this.activeEntryId === binding.entryId) this.activeEntryId = null;

    if (binding.target !== this.currentTarget) {
      // The terminated entry belongs to a superseded intent: no callbacks,
      // no state mutation for the newer target.
      this.bindings.delete(binding.entryId);
      return;
    }

    if (fact.reason === 'eof') {
      Logger.info('Track ended (EOF)');
      this.fileActive = false;
      this.fileLoading = false;
      this.pendingSeek = null;
      this.deriveState(); // stopped; last track metadata stays visible
      this.bindings.delete(binding.entryId);
      for (const handler of [...this.trackEndHandlers]) {
        try {
          handler(binding.target);
        } catch (err) {
          Logger.error(`onTrackEnd handler failed: ${err}`);
        }
      }
      return;
    }

    if (fact.reason === 'error') {
      const fileError = fact.fileError ?? 'unknown';
      Logger.error(`mpv playback error: ${fileError}`);
      this.fileActive = false;
      this.fileLoading = false;
      this.pendingSeek = null;
      this.store.set(playerErrorAtom, `Playback failed: ${fileError}`);
      this.deriveState();
      this.bindings.delete(binding.entryId);
      return;
    }

    if (fact.reason === 'redirect') {
      this.applyRedirect(binding, fact);
      return;
    }

    // Other reasons (stop/quit) fire when WE cleared playback: play()/stop()
    // already set the successor state synchronously, and a delayed event
    // must never clobber a newer target's loading state. The shutdown event
    // covers terminal cases.
  }

  /**
   * A native redirect ends the acknowledged entry and inserts children mpv
   * loaded itself. An unambiguous single-entry redirect hands the binding's
   * ownership to the inserted child so its lifecycle keeps working (state,
   * properties, one EOF). Anything else — multi-entry expansion, malformed
   * insert fields — cannot be owned: fail explicitly and stop the unowned
   * audio rather than guessing or hanging.
   */
  private applyRedirect(binding: EntryBinding, fact: EndFact): void {
    if (fact.insertId !== null && fact.insertCount === 1 && !this.bindings.has(fact.insertId)) {
      Logger.info(`mpv redirected playback to native entry ${fact.insertId}`);
      this.bindings.set(fact.insertId, {
        entryId: fact.insertId,
        target: binding.target,
        epoch: binding.epoch,
        phase: 'loading',
        props: binding.props,
        loadedFact: false,
        endFact: null,
        announced: binding.announced,
        seq: ++this.bindingSeq,
      });
      // The parent is terminally ended; the child inherits everything else.
      this.bindings.delete(binding.entryId);
      return;
    }

    Logger.error('mpv redirect inserted an unownable playlist — stopping playback');
    this.fileActive = false;
    this.fileLoading = false;
    this.pendingSeek = null;
    this.store.set(
      playerErrorAtom,
      'mpv redirected playback to an untrackable playlist — playback stopped',
    );
    this.deriveState();
    this.bindings.delete(binding.entryId);
    void this.ipc.stop().catch((err: unknown) => {
      Logger.error(`Stopping unowned redirect playback failed: ${err}`);
    });
  }

  // --- Internal: epochs and process identity ---

  private clearNativeBindings(): void {
    this.bindings.clear();
    this.streamEntryId = null;
    this.activeEntryId = null;
  }

  /**
   * Start a fresh IPC/process epoch: every older native binding, buffered
   * fact and stream attribution is void (native entry ids are per-process
   * and may be reused), and the failed/old process's published identity and
   * backend are cleared.
   */
  private beginEpoch(): void {
    this.epoch += 1;
    this.clearNativeBindings();
    this.inflightLoad = null;
    // A pause-transfer intent belongs to the recovery of the epoch that
    // captured it; a new epoch's own recovery re-arms it when applicable.
    this.pendingPauseReapply = false;
    this.store.set(playerProcessIdentityAtom, null);
    this.store.set(playerAudioBackendAtom, null);
  }

  private publishIdentity(handle: MpvProcessHandle): void {
    this.store.set(playerProcessIdentityAtom, {
      socketPath: handle.socketPath,
      pid: handle.pid,
      clientName: handle.clientName,
    });
  }

  // --- Internal: crash recovery ---

  private onDisconnect(): void {
    if (this._destroyed) return;
    Logger.warn('mpv IPC disconnected unexpectedly');
    this.fileActive = false;
    this.fileLoading = false;
    this.beginEpoch(); // process failed: identity and bindings are void
    this.deriveState();
    void this.attemptRecovery();
  }

  private async attemptRecovery(): Promise<void> {
    if (this._destroyed || this.pendingRecovery) return;

    // Bounded anti-flap: give up rather than respawn-looping a crashing mpv.
    const now = Date.now();
    if (now - this.lastRecoveryAttempt < RECOVERY_FLAP_WINDOW_MS) {
      Logger.error('mpv crashed again within 5s — giving up recovery');
      this.store.set(playerErrorAtom, 'mpv crashed repeatedly — playback stopped');
      return;
    }
    this.lastRecoveryAttempt = now;

    const abort = new AbortController();
    this.recoveryAbort = abort;
    const job = this.runRecovery(abort.signal).finally(() => {
      if (this.recoveryAbort === abort) {
        this.recoveryAbort = null;
        this.pendingRecovery = null;
      }
    });
    this.pendingRecovery = job;
    await job;
  }

  private async runRecovery(signal: AbortSignal): Promise<void> {
    try {
      // Capture the target that was audible when mpv died BEFORE waiting:
      // a newer play() arriving during the retry delay must not be mistaken
      // for the crashed target (nor replay its position).
      const target = this.currentTarget;
      const position = this.lastPosition;
      const wasPaused = this.userPaused;

      await Bun.sleep(RECOVERY_RETRY_DELAY_MS);
      if (this._destroyed || signal.aborted) return;

      const handle = await this.processPort.start(signal);
      if (this._destroyed || signal.aborted) return;

      // Fresh process identity: every native binding from the dead process
      // is void even if the OS or a new mpv reuses its entry ids or PID.
      this.beginEpoch();
      await this.ipc.connect(handle.socketPath);
      if (this._destroyed || signal.aborted) return;
      await this.ipc.observeAll();
      if (this._destroyed || signal.aborted) return;
      this.publishIdentity(handle);

      if (target && this.currentTarget === target) {
        // Reload the exact resolved source that was playing through the
        // same serialized load path as ordinary playback.
        this.fileActive = false;
        this.fileLoading = true;
        this.deriveState();
        // If a pipeline job for this target is already queued or running
        // (e.g. a play() waiting on this very respawn), it performs the
        // load itself; otherwise enqueue the recovery resume.
        if (this.activeJob?.target !== target && this.queuedLoad?.target !== target) {
          void this.enqueueLoad(
            target,
            { preservePause: true },
            { position, paused: wasPaused },
          ).catch((err: unknown) => this.handleRecoveryLoadFailure(target, err));
        } else if (wasPaused && (this.activeJob ?? this.queuedLoad)?.options.preservePause) {
          // The surviving preserve load cannot inherit the dead process's
          // pause: the fresh process starts unpaused. Transfer the captured
          // pause so it is reapplied before that load's command.
          this.pendingPauseReapply = true;
        }
        Logger.info(`Recovery complete — resumed ${target.track.title} at ${position.toFixed(0)}s`);
      } else if (target) {
        if (wasPaused && (this.activeJob ?? this.queuedLoad)?.options.preservePause) {
          // Same transfer for a newer intent that took over the respawn:
          // its preserve semantics refer to a pause only this recovery saw.
          this.pendingPauseReapply = true;
        }
        Logger.info('Recovery reconnect complete — newer playback request took over');
      } else {
        Logger.info('Recovery complete — no track to resume');
      }
    } catch (err) {
      if (signal.aborted || this._destroyed) return;
      Logger.error(`Recovery failed: ${err}`);
      this.store.set(playerErrorAtom, `mpv recovery failed: ${err}`);
      this.fileActive = false;
      this.fileLoading = false;
      this.deriveState();
    }
  }

  /** Surface a failed recovery resume without clobbering a newer intent. */
  private handleRecoveryLoadFailure(target: PlaybackTarget, err: unknown): void {
    if (this._destroyed || this.currentTarget !== target) return;
    Logger.error(`Recovery load failed: ${err}`);
    this.fileActive = false;
    this.fileLoading = false;
    this.store.set(playerErrorAtom, `mpv recovery failed: ${err}`);
    this.deriveState();
  }
}
