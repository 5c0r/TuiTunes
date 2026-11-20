import { describe, expect, test } from 'bun:test';
import {
  findSinkInput,
  findSinkMonitor,
  isRelevantSubscribeLine,
  nativePulseAvailable,
  parsePactlJson,
  parseServerInfo,
  runPulseCapture,
} from '../../src/spectrum/pulse';
import {
  SpectrumCaptureError,
  type CaptureEvent,
  type CaptureTarget,
} from '../../src/spectrum/types';
import { FakeSpawn, fakeEnv, targetFixture, textToBytes } from './fakes';

const CLIENT = 'TuiTunes-test-client';
const PID = 4242;

function target(): CaptureTarget {
  return targetFixture({
    ao: 'pulse',
    process: { pid: PID, clientName: CLIENT },
  });
}

function sinkInputsDoc(): string {
  return JSON.stringify([
    {
      index: 41,
      sink: 9,
      properties: { 'application.name': 'unrelated-app', 'application.process.id': '1' },
    },
    {
      index: 42,
      sink: 3,
      properties: { 'application.name': CLIENT, 'application.process.id': String(PID) },
    },
  ]);
}

function sinksDoc(): string {
  return JSON.stringify([
    { index: 9, name: 'other', monitor_source: 'other.monitor' },
    { index: 3, name: 'mine', monitor_source: 'mine.monitor' },
  ]);
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached within deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('pactl parsing', () => {
  test('parseServerInfo accepts native servers and rejects missing fields', () => {
    expect(
      parseServerInfo({ server_name: 'pulseaudio 17.0-rebootstrub', server_protocol_version: 35 }),
    ).toEqual({ serverName: 'pulseaudio 17.0-rebootstrub', protocolVersion: 35 });
    expect(parseServerInfo({ server_name: 'x', 'server protocol version': 13 })).toEqual({
      serverName: 'x',
      protocolVersion: 13,
    });
    expect(() => parseServerInfo({ server_name: 'x' })).toThrow(SpectrumCaptureError);
    expect(() => parseServerInfo([1, 2])).toThrow(SpectrumCaptureError);
  });

  test('findSinkInput matches exactly one input by name and pid', () => {
    const input = findSinkInput(parsePactlJson(sinkInputsDoc()), CLIENT, PID);
    expect(input).toEqual({
      index: 42,
      sink: 3,
      applicationName: CLIENT,
      applicationPid: PID,
    });
    // A different pid (e.g. a proxy daemon) is not our stream.
    expect(() => findSinkInput(parsePactlJson(sinkInputsDoc()), CLIENT, 777)).toThrow(
      SpectrumCaptureError,
    );
  });

  test('findSinkInput rejects zero and multiple matches without guessing', () => {
    expect(() => findSinkInput(parsePactlJson('[]'), CLIENT, PID)).toThrow(SpectrumCaptureError);
    const doubled = JSON.stringify([
      { index: 1, sink: 3, properties: { 'application.name': CLIENT } },
      { index: 2, sink: 3, properties: { 'application.name': CLIENT } },
    ]);
    const failure = (() => {
      try {
        findSinkInput(parsePactlJson(doubled), CLIENT, PID);
        return null;
      } catch (error) {
        return error as SpectrumCaptureError;
      }
    })();
    expect(failure?.code).toBe('target-ambiguous');
  });

  test('findSinkMonitor resolves the exact sink monitor', () => {
    expect(findSinkMonitor(parsePactlJson(sinksDoc()), 3)).toBe('mine.monitor');
    const bare = JSON.stringify([{ index: 3, name: 'mine' }]);
    expect(() => findSinkMonitor(parsePactlJson(bare), 3)).toThrow(SpectrumCaptureError);
  });

  test('subscribe line relevance covers moves, removals and server restarts', () => {
    expect(isRelevantSubscribeLine("Event 'change' on sink-input #42", 42, 3)).toBe(true);
    expect(isRelevantSubscribeLine("Event 'remove' on sink-input #42", 42, 3)).toBe(true);
    expect(isRelevantSubscribeLine("Event 'change' on sink-input #41", 42, 3)).toBe(false);
    expect(isRelevantSubscribeLine("Event 'change' on sink #3", 42, 3)).toBe(true);
    expect(isRelevantSubscribeLine("Event 'change' on sink #9", 42, 3)).toBe(false);
    expect(isRelevantSubscribeLine("Event 'change' on server #0", 42, 3)).toBe(true);
    expect(isRelevantSubscribeLine("Event 'new' on client #7", 42, 3)).toBe(false);
  });
});

describe('nativePulseAvailable', () => {
  test('accepts pactl 16 on a native PulseAudio server', async () => {
    const spawn = new FakeSpawn();
    spawn.onSpawn = (child) => {
      if (child.argv.join(' ').includes('--version')) {
        child.pushStdout('pactl 16.1\n');
        child.exit(0);
        return;
      }
      child.pushStdout(
        JSON.stringify({ server_name: 'pulseaudio 16.1', server_protocol_version: 35 }),
      );
      child.exit(0);
    };
    await expect(nativePulseAvailable(fakeEnv(spawn))).resolves.toEqual({
      available: true,
      reason: 'pulseaudio 16.1',
    });
  });

  test('rejects old pactl, low protocol, and PipeWire-Pulse servers', async () => {
    const old = new FakeSpawn();
    old.onSpawn = (child) => {
      child.pushStdout('pactl 15.99\n');
      child.exit(0);
    };
    await expect(nativePulseAvailable(fakeEnv(old))).resolves.toMatchObject({ available: false });

    const pipewire = new FakeSpawn();
    pipewire.onSpawn = (child) => {
      if (child.argv.join(' ').includes('--version')) {
        child.pushStdout('pactl 16.1\n');
        child.exit(0);
        return;
      }
      child.pushStdout(
        JSON.stringify({
          server_name: 'PulseAudio (on PipeWire 1.2.7)',
          server_protocol_version: 35,
        }),
      );
      child.exit(0);
    };
    const pipewireResult = await nativePulseAvailable(fakeEnv(pipewire));
    expect(pipewireResult.available).toBe(false);
    expect(pipewireResult.reason).toContain('PipeWire graph capture');

    const ancient = new FakeSpawn();
    ancient.onSpawn = (child) => {
      if (child.argv.join(' ').includes('--version')) {
        child.pushStdout('pactl 16.1\n');
        child.exit(0);
        return;
      }
      child.pushStdout(
        JSON.stringify({ server_name: 'pulseaudio 0.9', server_protocol_version: 12 }),
      );
      child.exit(0);
    };
    await expect(nativePulseAvailable(fakeEnv(ancient))).resolves.toMatchObject({
      available: false,
    });
  });
});

describe('runPulseCapture', () => {
  function start(spawn: FakeSpawn): {
    events: CaptureEvent[];
    controller: AbortController;
    run: Promise<void>;
  } {
    const events: CaptureEvent[] = [];
    const controller = new AbortController();
    const run = runPulseCapture(
      target(),
      controller.signal,
      (event) => events.push(event),
      fakeEnv(spawn, { startupTimeoutMs: 400 }),
    );
    return { events, controller, run };
  }

  function scriptPactl(
    spawn: FakeSpawn,
    options: { sinkInput?: string; sinks?: string } = {},
  ): void {
    spawn.onSpawn = (child) => {
      const argv = child.argv.join(' ');
      if (argv.includes('--version')) return;
      if (argv.includes('pactl --format=json info')) {
        child.pushStdout(
          JSON.stringify({ server_name: 'pulseaudio 16.1', server_protocol_version: 35 }),
        );
        child.exit(0);
        return;
      }
      if (argv.includes('list sink-inputs')) {
        child.pushStdout(options.sinkInput ?? '[]');
        child.exit(0);
        return;
      }
      if (argv.includes('list sinks')) {
        child.pushStdout(options.sinks ?? '[]');
        child.exit(0);
        return;
      }
      // pactl subscribe and parec stay alive until killed.
    };
  }

  test('direct single-input monitor with the exact argv contract', async () => {
    const spawn = new FakeSpawn();
    scriptPactl(spawn, { sinkInput: sinkInputsDoc(), sinks: sinksDoc() });
    const harness = start(spawn);
    await until(() => spawn.byBinary('parec').length === 1);
    const parec = spawn.byBinary('parec')[0];
    expect(parec.argv).toEqual([
      'parec',
      '--raw',
      '--device=mine.monitor',
      '--monitor-stream=42',
      '--format=float32le',
      '--rate=48000',
      '--channels=2',
      '--channel-map=front-left,front-right',
    ]);
    const subscriber = spawn.byBinary('pactl').find((child) => child.argv.includes('subscribe'));
    expect(subscriber?.argv).toEqual(['pactl', 'subscribe']);
    // The observer runs with LC_ALL=C for the event grammar.
    expect(spawn.children.find((child) => child.argv.includes('subscribe'))).toBeDefined();

    await until(() => harness.events.some((event) => event.kind === 'format'));
    expect(harness.events[0]).toEqual({
      kind: 'format',
      format: { sampleRate: 48_000, channels: 2, encoding: 'f32le' },
    });
    const pcm = textToBytes('monitor-pcm');
    parec.pushStdout(pcm);
    await until(() => harness.events.some((event) => event.kind === 'pcm'));

    harness.controller.abort();
    await expect(harness.run).resolves.toBeUndefined();
    expect(parec.kills.length).toBeGreaterThan(0);
  }, 10_000);

  test('a relevant subscribe event stops recording and re-attaches exactly', async () => {
    const spawn = new FakeSpawn();
    scriptPactl(spawn, { sinkInput: sinkInputsDoc(), sinks: sinksDoc() });
    const harness = start(spawn);
    await until(() => spawn.byBinary('parec').length === 1);
    const firstParec = spawn.byBinary('parec')[0];
    await until(() => harness.events.some((event) => event.kind === 'format'));

    const subscriber = spawn.byBinary('pactl').find((child) => child.argv.includes('subscribe'));
    subscriber?.pushStdout("Event 'change' on sink-input #42\n");
    await until(() => harness.events.some((event) => event.kind === 'reset'));
    await until(() => spawn.byBinary('parec').length === 2);
    expect(firstParec.kills.length).toBeGreaterThan(0);

    harness.controller.abort();
    await expect(harness.run).resolves.toBeUndefined();
  }, 10_000);

  test('a move reattaches when the old recorder exits before any subscribe event', async () => {
    const spawn = new FakeSpawn();
    const documents = { sinkInput: sinkInputsDoc(), sinks: sinksDoc() };
    scriptPactl(spawn, documents);
    const harness = start(spawn);
    try {
      await until(() => harness.events.some((event) => event.kind === 'format'));
      const first = spawn.byBinary('parec')[0];
      documents.sinkInput = JSON.stringify([
        {
          index: 42,
          sink: 9,
          properties: { 'application.name': CLIENT, 'application.process.id': String(PID) },
        },
      ]);
      first.pushStderr('Stream error: Entity killed\n');
      first.exit(1);
      await until(() => spawn.byBinary('parec').length === 2);
      const replacement = spawn.byBinary('parec')[1];
      expect(replacement.argv).toContain('--device=other.monitor');
      expect(replacement.argv).toContain('--monitor-stream=42');
      expect(harness.events.some((event) => event.kind === 'reset')).toBe(true);
    } finally {
      harness.controller.abort();
      await expect(harness.run).resolves.toBeUndefined();
    }
  });

  test('parec exit is a process error with stderr context', async () => {
    const spawn = new FakeSpawn();
    scriptPactl(spawn, { sinkInput: sinkInputsDoc(), sinks: sinksDoc() });
    const harness = start(spawn);
    await until(() => spawn.byBinary('parec').length === 1);
    const parec = spawn.byBinary('parec')[0];
    parec.pushStderr('parec: Failed to read from monitor stream\n');
    parec.exit(1);
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('process');
    expect((failure as SpectrumCaptureError).message).toContain('monitor stream');
  });

  test('no matching sink-input within the budget is target-not-found', async () => {
    const spawn = new FakeSpawn();
    scriptPactl(spawn); // empty sink-inputs
    const harness = start(spawn);
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('target-not-found');
    expect(spawn.byBinary('parec')).toHaveLength(0);
  }, 10_000);

  test('server protocol below 13 is rejected up front', async () => {
    const spawn = new FakeSpawn();
    spawn.onSpawn = (child) => {
      if (child.argv.join(' ').includes('pactl --format=json info')) {
        child.pushStdout(
          JSON.stringify({ server_name: 'pulseaudio', server_protocol_version: 12 }),
        );
        child.exit(0);
      }
    };
    const harness = start(spawn);
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('protocol');
  });
});

test('PipeWire-Pulse server is rejected inside the adapter, not only dispatch', async () => {
  const spawn = new FakeSpawn();
  spawn.onSpawn = (child) => {
    if (child.argv.join(' ').includes('pactl --format=json info')) {
      child.pushStdout(
        JSON.stringify({
          server_name: 'PulseAudio (on PipeWire 1.2.7)',
          server_protocol_version: 35,
        }),
      );
      child.exit(0);
    }
  };
  const controller = new AbortController();
  const failure = await runPulseCapture(
    target(),
    controller.signal,
    () => {},
    fakeEnv(spawn, { startupTimeoutMs: 300 }),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect((failure as SpectrumCaptureError).code).toBe('unsupported');
  expect((failure as SpectrumCaptureError).message).toContain('graph capture');
});

test('subscription overflow coalesces into a re-resolve, never a silent drop', async () => {
  const spawn = new FakeSpawn();
  spawn.onSpawn = (child) => {
    const argv = child.argv.join(' ');
    if (argv.includes('pactl --format=json info')) {
      child.pushStdout(
        JSON.stringify({ server_name: 'pulseaudio 16.1', server_protocol_version: 35 }),
      );
      child.exit(0);
      return;
    }
    if (argv.includes('list sink-inputs')) {
      child.pushStdout(sinkInputsDoc());
      child.exit(0);
      return;
    }
    if (argv.includes('list sinks')) {
      child.pushStdout(sinksDoc());
      child.exit(0);
    }
  };
  const events: CaptureEvent[] = [];
  const controller = new AbortController();
  const run = runPulseCapture(
    target(),
    controller.signal,
    (event) => events.push(event),
    fakeEnv(spawn, { startupTimeoutMs: 400 }),
  );
  await until(() => spawn.byBinary('parec').length === 1);
  await until(() => events.some((event) => event.kind === 'format'));
  const subscriber = spawn.byBinary('pactl').find((child) => child.argv.includes('subscribe'));
  for (let i = 0; i < 80; i++) subscriber?.pushStdout(`Event 'change' on client #${i}\n`);
  await until(() => events.some((event) => event.kind === 'reset'));
  await until(() => spawn.byBinary('parec').length === 2);
  controller.abort();
  await expect(run).resolves.toBeUndefined();
}, 10_000);
