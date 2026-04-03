import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Socket } from 'bun';
import { MpvIPC } from '../../src/player/ipc';

type ServerSocket = Socket<unknown>;

describe('MpvIPC', () => {
  // Ensure logger directory exists so Logger.appendFileSync doesn't blow up
  mkdirSync(join(homedir(), '.config', 'tunefork'), { recursive: true });

  let socketPath: string;
  let server: ReturnType<typeof Bun.listen>;
  let ipc: MpvIPC;
  let serverSockets: ServerSocket[] = [];
  let onServerData: (socket: ServerSocket, data: Buffer) => void = () => {};

  beforeEach(async () => {
    socketPath = `/tmp/tunefork-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;
    try { unlinkSync(socketPath); } catch {}

    server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) { serverSockets.push(socket); },
        data(socket, data) { onServerData(socket, data as Buffer); },
        close(socket) { serverSockets = serverSockets.filter(s => s !== socket); },
      },
    });

    ipc = new MpvIPC();
  });

  afterEach(() => {
    onServerData = () => {};
    ipc.disconnect();
    server.stop();
    try { unlinkSync(socketPath); } catch {}
    serverSockets = [];
  });

  test('connect and disconnect', async () => {
    await ipc.connect(socketPath);
    expect(ipc.connected).toBe(true);

    ipc.disconnect();
    expect(ipc.connected).toBe(false);
  });

  test('command sends JSON and receives response', async () => {
    const received: unknown[] = [];

    onServerData = (socket, data) => {
      const msg = JSON.parse(data.toString());
      received.push(msg);
      socket.write(JSON.stringify({
        error: 'success',
        data: 42,
        request_id: msg.request_id,
      }) + '\n');
    };

    await ipc.connect(socketPath);
    const result = await ipc.command('get_property', 'volume');

    expect(result).toBe(42);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(
      expect.objectContaining({
        command: ['get_property', 'volume'],
        request_id: expect.any(Number),
      }),
    );
  });

  test('command rejects on mpv error', async () => {
    onServerData = (socket, data) => {
      const msg = JSON.parse(data.toString());
      socket.write(JSON.stringify({
        error: 'property unavailable',
        request_id: msg.request_id,
      }) + '\n');
    };

    await ipc.connect(socketPath);

    await expect(ipc.command('get_property', 'bogus'))
      .rejects.toThrow('property unavailable');
  });

  test('buffer splitting — partial messages', async () => {
    onServerData = (socket, data) => {
      const msg = JSON.parse(data.toString());
      const id = msg.request_id;
      // Send response in two chunks
      socket.write(`{"error":"success","data":`);
      setTimeout(() => {
        socket.write(`42,"request_id":${id}}\n`);
      }, 20);
    };

    await ipc.connect(socketPath);
    const result = await ipc.command('get_property', 'volume');
    expect(result).toBe(42);
  });

  test('buffer splitting — multiple messages in one write', async () => {
    const messages: Array<{ request_id: number }> = [];

    onServerData = (socket, data) => {
      // Server may receive multiple newline-delimited commands in one data event
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        messages.push(msg);
      }

      // Wait for both commands to arrive before replying
      if (messages.length === 2) {
        const combined =
          JSON.stringify({ error: 'success', data: 1, request_id: messages[0].request_id }) + '\n' +
          JSON.stringify({ error: 'success', data: 2, request_id: messages[1].request_id }) + '\n';
        socket.write(combined);
      }
    };

    await ipc.connect(socketPath);

    const [r1, r2] = await Promise.all([
      ipc.command('cmd1'),
      ipc.command('cmd2'),
    ]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  test('property-change event routing', async () => {
    await ipc.connect(socketPath);

    let captured: { name: string; value: unknown } | null = null;
    ipc.onPropertyChange((name, value) => {
      captured = { name, value };
    });

    // Server sends a property-change event
    await Bun.sleep(20);
    serverSockets[0].write(
      JSON.stringify({ event: 'property-change', id: 1, name: 'time-pos', data: 42.5 }) + '\n',
    );

    await Bun.sleep(50);
    expect(captured).toEqual({ name: 'time-pos', value: 42.5 });
  });

  test('property-change with absent data field', async () => {
    await ipc.connect(socketPath);

    let captured: { name: string; value: unknown } | null = null;
    ipc.onPropertyChange((name, value) => {
      captured = { name, value };
    });

    await Bun.sleep(20);
    // Deliberately omit the `data` field
    serverSockets[0].write(
      JSON.stringify({ event: 'property-change', id: 1, name: 'duration' }) + '\n',
    );

    await Bun.sleep(50);
    expect(captured).not.toBeNull();
    expect(captured!.name).toBe('duration');
    expect(captured!.value).toBeUndefined();
  });

  test('event dispatching', async () => {
    await ipc.connect(socketPath);

    let captured: unknown = null;
    ipc.onEvent((event) => {
      captured = event;
    });

    await Bun.sleep(20);
    serverSockets[0].write(
      JSON.stringify({ event: 'end-file', reason: 'eof' }) + '\n',
    );

    await Bun.sleep(50);
    expect(captured).toEqual(expect.objectContaining({ event: 'end-file', reason: 'eof' }));
  });

  test('disconnect fires onDisconnect and rejects pending', async () => {
    // Don't respond to commands from the server side
    onServerData = () => {};

    await ipc.connect(socketPath);

    let disconnectFired = false;
    ipc.onDisconnect(() => { disconnectFired = true; });

    // Send a command that will never get a response
    const cmdPromise = ipc.command('get_property', 'volume');

    // Give the write a moment to flush
    await Bun.sleep(20);

    // Forcibly disconnect — socket.end() triggers the close handler,
    // which fires onClose before disconnect() finishes its own cleanup
    ipc.disconnect();

    await expect(cmdPromise).rejects.toThrow();

    // socket.end() triggers the Bun close callback which invokes onClose,
    // so onDisconnect DOES fire (may be async — give it a tick)
    await Bun.sleep(50);
    expect(disconnectFired).toBe(true);

    // Verify connected state
    expect(ipc.connected).toBe(false);
  });
});
