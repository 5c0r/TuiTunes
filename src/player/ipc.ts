import type { Socket } from 'bun';
import { Logger } from '../utils/logger';
import {
  type MpvMessage,
  type MpvEvent,
  type MpvResponse,
  type MpvPropertyMap,
  OBSERVED_PROPERTIES,
  isMpvEvent,
} from './types';

type PropertyChangeHandler = (name: string, value: unknown) => void;
type EventHandler = (event: MpvEvent) => void;

interface PendingRequest {
  resolve: (response: MpvResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Low-level mpv JSON IPC client.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket.
 * Each request carries a `request_id`; responses echo it.
 * Events (property-change, end-file, etc.) are interleaved.
 */
export class MpvIPC {
  private socket: Socket<undefined> | null = null;
  private buffer = '';
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private propertyHandler: PropertyChangeHandler | null = null;
  private eventHandler: EventHandler | null = null;
  private _connected = false;
  private onClose: (() => void) | null = null;

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the mpv IPC socket.
   * Resolves once the TCP handshake completes.
   */
  async connect(socketPath: string): Promise<void> {
    if (this._connected) {
      Logger.warn('MpvIPC.connect called while already connected');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      // Capture `this` for the handler callbacks
      const self = this;

      Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            self.socket = socket;
            self._connected = true;
            Logger.info('mpv IPC connected');
            resolve();
          },
          data(_socket, data) {
            self.onData(data);
          },
          close() {
            self._connected = false;
            self.socket = null;
            Logger.warn('mpv IPC socket closed');
            // Reject all pending commands
            for (const [id, req] of self.pending) {
              clearTimeout(req.timer);
              req.reject(new Error('mpv IPC socket closed'));
              self.pending.delete(id);
            }
            self.onClose?.();
          },
          connectError(_socket, err) {
            self._connected = false;
            Logger.error(`mpv IPC connect error: ${err.message}`);
            reject(err);
          },
          error(_socket, err) {
            Logger.error(`mpv IPC socket error: ${err.message}`);
          },
        },
      }).catch(reject);
    });
  }

  /**
   * Register a handler for property-change events.
   */
  onPropertyChange(handler: PropertyChangeHandler): void {
    this.propertyHandler = handler;
  }

  /**
   * Register a handler for all mpv events.
   */
  onEvent(handler: EventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Register a handler for socket close.
   */
  onDisconnect(handler: () => void): void {
    this.onClose = handler;
  }

  /**
   * Send a command to mpv and wait for its response.
   * Throws on timeout or if the response has a non-success error.
   */
  async command(...args: unknown[]): Promise<unknown> {
    if (!this.socket || !this._connected) {
      throw new Error('mpv IPC not connected');
    }

    const id = ++this.requestId;
    const msg = JSON.stringify({ command: args, request_id: id }) + '\n';

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv command timed out: ${JSON.stringify(args)}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolveResponse, reject, timer });

      function resolveResponse(resp: MpvResponse): void {
        clearTimeout(timer);
        if (resp.error !== 'success') {
          reject(new Error(`mpv error: ${resp.error} (command: ${JSON.stringify(args)})`));
        } else {
          resolve(resp.data);
        }
      }

      this.socket!.write(msg);
    });
  }

  /**
   * Subscribe to property changes via observe_property.
   * Registers all properties defined in OBSERVED_PROPERTIES.
   */
  async observeAll(): Promise<void> {
    for (const prop of OBSERVED_PROPERTIES) {
      await this.command('observe_property', prop.id, prop.name);
    }
    Logger.info(`observing ${OBSERVED_PROPERTIES.length} mpv properties`);
  }

  // Convenience commands

  async loadfile(url: string, mode: 'replace' | 'append-play' = 'replace'): Promise<void> {
    await this.command('loadfile', url, mode);
  }

  async setPause(paused: boolean): Promise<void> {
    await this.command('set_property', 'pause', paused);
  }

  async togglePause(): Promise<void> {
    await this.command('cycle', 'pause');
  }

  async seek(seconds: number, mode: 'relative' | 'absolute+exact' = 'relative'): Promise<void> {
    await this.command('seek', seconds, mode);
  }

  async setVolume(volume: number): Promise<void> {
    await this.command('set_property', 'volume', Math.max(0, Math.min(150, volume)));
  }

  async addVolume(delta: number): Promise<void> {
    await this.command('add', 'volume', delta);
  }

  async toggleMute(): Promise<void> {
    await this.command('cycle', 'mute');
  }

  async stop(): Promise<void> {
    await this.command('stop');
  }

  async playlistNext(): Promise<void> {
    await this.command('playlist-next', 'weak');
  }

  async playlistPrev(): Promise<void> {
    await this.command('playlist-prev', 'weak');
  }

  async getProperty<K extends keyof MpvPropertyMap>(name: K): Promise<MpvPropertyMap[K]> {
    const data = await this.command('get_property', name);
    return data as MpvPropertyMap[K];
  }

  /**
   * Gracefully shut down: send quit, then disconnect.
   */
  async quit(): Promise<void> {
    if (this._connected) {
      try {
        // Fire-and-forget — mpv will close the socket
        this.socket?.write(JSON.stringify({ command: ['quit'], request_id: ++this.requestId }) + '\n');
      } catch {
        // Socket may already be closed
      }
    }
    this.disconnect();
  }

  /**
   * Forcibly disconnect without sending quit.
   */
  disconnect(): void {
    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        // Already closed
      }
    }
    this._connected = false;
    this.socket = null;
    this.buffer = '';
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('IPC disconnected'));
    }
    this.pending.clear();
  }

  // --- Internal ---

  private onData(data: Uint8Array): void {
    this.buffer += new TextDecoder().decode(data);
    const lines = this.buffer.split('\n');
    // Last element is either '' (complete) or a partial line
    this.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line) continue;
      let msg: MpvMessage;
      try {
        msg = JSON.parse(line) as MpvMessage;
      } catch {
        Logger.warn(`mpv IPC: unparseable message: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: MpvMessage): void {
    if (isMpvEvent(msg)) {
      this.handleEvent(msg);
    } else {
      // Response to a pending command
      const req = this.pending.get(msg.request_id);
      if (req) {
        this.pending.delete(msg.request_id);
        req.resolve(msg);
      }
    }
  }

  private handleEvent(event: MpvEvent): void {
    if (event.event === 'property-change' && event.name) {
      // CRITICAL: When a property is unavailable, `data` is ABSENT (not null).
      // Callers must check 'data' in event before using the value.
      this.propertyHandler?.(event.name, 'data' in event ? event.data : undefined);
    }
    this.eventHandler?.(event);
  }
}
