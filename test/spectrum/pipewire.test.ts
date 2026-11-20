import { describe, expect, test } from 'bun:test';
import { runPipeWireCapture } from '../../src/spectrum/pipewire';
import { SpectrumCaptureError } from '../../src/spectrum/types';
import type { CaptureEvent, CaptureTarget } from '../../src/spectrum/types';
import { type FakeChild, FakeSpawn, fakeEnv, targetFixture, textToBytes } from './fakes';

const PLAYER_NODE = 10;
const PLAYER_PORTS = [
  { id: 11, channel: 'FL' },
  { id: 12, channel: 'FR' },
];

function nodeEntry(id: number, props: Record<string, unknown>): unknown {
  return { id, type: 'PipeWire:Interface:Node', info: { props } };
}

function portEntry(id: number, nodeId: number, direction: 'in' | 'out', channel: string): unknown {
  return {
    id,
    type: 'PipeWire:Interface:Port',
    info: { direction, props: { 'node.id': nodeId, 'audio.channel': channel } },
  };
}

function linkEntry(id: number, outPort: number, inPort: number): unknown {
  return {
    id,
    type: 'PipeWire:Interface:Link',
    info: {
      props: {
        'link.output.node': PLAYER_NODE,
        'link.output.port': outPort,
        'link.input.node': 90,
        'link.input.port': inPort,
      },
    },
  };
}

function playerGraph(target: CaptureTarget): string {
  return JSON.stringify([
    nodeEntry(PLAYER_NODE, {
      'node.name': target.process.clientName,
      'application.process.id': target.process.pid,
      'media.class': 'Stream/Output/Audio',
    }),
    ...PLAYER_PORTS.map((port) => portEntry(port.id, PLAYER_NODE, 'out', port.channel)),
  ]);
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached within deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Harness {
  spawn: FakeSpawn;
  target: CaptureTarget;
  events: CaptureEvent[];
  controller: AbortController;
  run: Promise<void>;
  watcher: () => FakeChild;
  recorder: (index: number) => FakeChild;
}

function startHarness(
  options: { initialGraph?: string; target?: CaptureTarget; linkExitCode?: number } = {},
): Harness {
  const spawn = new FakeSpawn();
  const target = options.target ?? targetFixture();
  const events: CaptureEvent[] = [];
  const controller = new AbortController();
  const graph: string[] = [options.initialGraph ?? playerGraph(target)];
  spawn.onSpawn = (child) => {
    if (child.argv[0] === 'pw-dump') {
      for (const message of graph) child.pushStdout(message);
      return;
    }
    if (child.argv[0] === 'pw-link') {
      child.exit(options.linkExitCode ?? 0);
    }
  };
  const run = runPipeWireCapture(
    target,
    controller.signal,
    (event) => events.push(event),
    fakeEnv(spawn, { startupTimeoutMs: 400 }),
  );
  return {
    spawn,
    target,
    events,
    controller,
    run,
    watcher: () => spawn.lastOf('pw-dump'),
    recorder: (index) => spawn.byBinary('pw-record')[index] as FakeChild,
  };
}

/** Feed the recorder node + its capture input ports into the graph watcher. */
function publishRecorder(harness: Harness, recorderName: string): void {
  harness
    .watcher()
    .pushStdout(
      JSON.stringify([
        nodeEntry(90, { 'node.name': recorderName, 'media.class': 'Stream/Input/Audio' }),
        ...PLAYER_PORTS.map((port, index) => portEntry(100 + index, 90, 'in', port.channel)),
      ]),
    );
}

function recorderNameFrom(recorder: FakeChild): string {
  const properties = recorder.argv.find((arg) => arg.startsWith('--properties='));
  if (properties === undefined) throw new Error('pw-record argv lacks --properties');
  return (JSON.parse(properties.slice('--properties='.length)) as Record<string, unknown>)[
    'node.name'
  ] as string;
}

describe('runPipeWireCapture', () => {
  test('happy path: passive-only graph capture with exact argv and attestation', async () => {
    const harness = startHarness();
    await until(() => harness.spawn.byBinary('pw-record').length === 1);
    const recorder = harness.recorder(0);

    // Exact recorder argv: autoconnect-free, passive, target 0, raw f32.
    expect(recorder.argv).toContain('--target=0');
    expect(recorder.argv).toContain('--raw');
    expect(recorder.argv).toContain('--format=f32');
    expect(recorder.argv).toContain('--rate=48000');
    expect(recorder.argv).toContain('--channels=2');
    expect(recorder.argv).toContain('--channel-map=FL,FR');
    expect(recorder.argv[recorder.argv.length - 1]).toBe('-');
    const recorderName = recorderNameFrom(recorder);
    expect(recorderName.startsWith('TuiTunes-spectrum-')).toBe(true);
    const properties = JSON.parse(
      (recorder.argv.find((arg) => arg.startsWith('--properties=')) ?? '').slice(
        '--properties='.length,
      ),
    ) as Record<string, unknown>;
    expect(properties['node.name']).toBe(recorderName);
    expect(properties['node.autoconnect']).toBe(false);
    expect(properties['node.passive']).toBe(true);

    // Startup PCM before attestation is discarded, never published.
    recorder.pushStdout(textToBytes('garbage-pcm-before-attestation'));

    publishRecorder(harness, recorderName);
    await until(() => harness.spawn.byBinary('pw-link').length === 2);
    for (const link of harness.spawn.byBinary('pw-link')) {
      expect(link.argv[0]).toBe('pw-link');
      expect(link.argv[1]).toBe('--passive');
      expect(link.argv).toHaveLength(4);
      link.exit(0);
    }
    harness.watcher().pushStdout(JSON.stringify([linkEntry(30, 11, 100), linkEntry(31, 12, 101)]));

    await until(() => harness.events.some((event) => event.kind === 'format'));
    expect(harness.events[0]).toEqual({
      kind: 'format',
      format: { sampleRate: 48_000, channels: 2, encoding: 'f32le' },
    });

    const pcm = textToBytes('pcm-bytes');
    recorder.pushStdout(pcm);
    await until(() => harness.events.some((event) => event.kind === 'pcm'));
    const forwarded = harness.events.find((event) => event.kind === 'pcm');
    expect(forwarded).toEqual({ kind: 'pcm', bytes: pcm });

    harness.controller.abort();
    await expect(harness.run).resolves.toBeUndefined(); // abort is not an error
    expect(recorder.kills.length).toBeGreaterThan(0);
    expect(harness.watcher().kills.length).toBeGreaterThan(0);
  }, 10_000);

  test('target disappearance emits reset and resolves a fresh recorder', async () => {
    const harness = startHarness();
    await until(() => harness.spawn.byBinary('pw-record').length === 1);
    const recorder = harness.recorder(0);
    publishRecorder(harness, recorderNameFrom(recorder));
    await until(() => harness.spawn.byBinary('pw-link').length === 2);
    for (const link of harness.spawn.byBinary('pw-link')) link.exit(0);
    harness.watcher().pushStdout(JSON.stringify([linkEntry(30, 11, 100), linkEntry(31, 12, 101)]));
    await until(() => harness.events.some((event) => event.kind === 'format'));

    // The player node goes away: recorder must stop, reset must be emitted.
    harness
      .watcher()
      .pushStdout(JSON.stringify([{ id: PLAYER_NODE, type: 'PipeWire:Interface:Node' }]));
    await until(() => harness.events.some((event) => event.kind === 'reset'));
    // A returning player resolves a fresh unique target within the budget.
    harness.watcher().pushStdout(playerGraph(harness.target));
    await until(() => harness.spawn.byBinary('pw-record').length === 2);
    expect(recorder.kills.length).toBeGreaterThan(0);

    harness.controller.abort();
    await expect(harness.run).resolves.toBeUndefined();
  }, 10_000);

  test('duplicate matches are unavailable, never a best-name guess', async () => {
    const target = targetFixture();
    const doubled = JSON.stringify([
      nodeEntry(10, {
        'node.name': target.process.clientName,
        'media.class': 'Stream/Output/Audio',
      }),
      nodeEntry(20, {
        'application.name': target.process.clientName,
        'media.class': 'Stream/Output/Audio',
      }),
    ]);
    const harness = startHarness({ initialGraph: doubled, target });
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SpectrumCaptureError);
    expect((failure as SpectrumCaptureError).code).toBe('target-ambiguous');
    expect(harness.spawn.byBinary('pw-record')).toHaveLength(0); // no recorder ever
  });

  test('zero matches within the startup budget is target-not-found', async () => {
    const harness = startHarness({ initialGraph: '[]' });
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SpectrumCaptureError);
    expect((failure as SpectrumCaptureError).code).toBe('target-not-found');
  });

  test('player ports without channel labels are unsupported', async () => {
    const target = targetFixture();
    const graph = JSON.stringify([
      nodeEntry(10, {
        'node.name': target.process.clientName,
        'media.class': 'Stream/Output/Audio',
      }),
      portEntry(11, 10, 'out', 'FL'),
      {
        id: 12,
        type: 'PipeWire:Interface:Port',
        info: { direction: 'out', props: { 'node.id': 10 } }, // no audio.channel
      },
    ]);
    const harness = startHarness({ initialGraph: graph, target });
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('format');
  });

  test('malformed watcher output is a protocol error', async () => {
    const harness = startHarness();
    await until(() => harness.spawn.byBinary('pw-dump').length === 1);
    harness.watcher().pushStdout('nonsense ]]]');
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('protocol');
  });

  test('watcher exit is a process error, not a silent hang', async () => {
    const harness = startHarness();
    await until(() => harness.spawn.byBinary('pw-dump').length === 1);
    harness.watcher().exit(1);
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('process');
  });

  test('pw-link failure becomes an attestation error', async () => {
    const harness = startHarness({ linkExitCode: 1 });
    await until(() => harness.spawn.byBinary('pw-record').length === 1);
    publishRecorder(harness, recorderNameFrom(harness.recorder(0)));
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('attestation');
  });

  test('recorder exit mid-stream is a process error with stderr context', async () => {
    const harness = startHarness();
    await until(() => harness.spawn.byBinary('pw-record').length === 1);
    const recorder = harness.recorder(0);
    publishRecorder(harness, recorderNameFrom(recorder));
    await until(() => harness.spawn.byBinary('pw-link').length === 2);
    for (const link of harness.spawn.byBinary('pw-link')) link.exit(0);
    harness.watcher().pushStdout(JSON.stringify([linkEntry(30, 11, 100), linkEntry(31, 12, 101)]));
    await until(() => harness.events.some((event) => event.kind === 'format'));
    recorder.pushStderr('pw-record: cannot connect\n');
    recorder.exit(1);
    const failure = await harness.run.then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('process');
    expect((failure as SpectrumCaptureError).message).toContain('pw-record: cannot connect');
  });

  test('missing pw tools never spawn a recorder', async () => {
    const spawn = new FakeSpawn();
    spawn.missing.add('pw-dump');
    const events: CaptureEvent[] = [];
    const controller = new AbortController();
    const failure = await runPipeWireCapture(
      targetFixture(),
      controller.signal,
      (event) => events.push(event),
      fakeEnv(spawn, { startupTimeoutMs: 200 }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as SpectrumCaptureError).code).toBe('tool-missing');
    expect(events).toEqual([]);
  });
});

test('wrong-source link on a recorder input terminates capture immediately', async () => {
  const harness = startHarness();
  await until(() => harness.spawn.byBinary('pw-record').length === 1);
  const recorder = harness.recorder(0);
  publishRecorder(harness, recorderNameFrom(recorder));
  await until(() => harness.spawn.byBinary('pw-link').length === 2);
  harness.watcher().pushStdout(JSON.stringify([linkEntry(30, 11, 100), linkEntry(31, 12, 101)]));
  await until(() => harness.events.some((event) => event.kind === 'format'));
  // A foreign node's output now feeds a capture input: terminate, never wait.
  harness.watcher().pushStdout(
    JSON.stringify([
      { id: 40, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'other-app' } } },
      {
        id: 32,
        type: 'PipeWire:Interface:Link',
        info: {
          props: {
            'link.output.node': 40,
            'link.output.port': 400,
            'link.input.node': 90,
            'link.input.port': 100,
          },
        },
      },
    ]),
  );
  const failure = await harness.run.then(
    () => null,
    (error: unknown) => error,
  );
  expect((failure as SpectrumCaptureError).code).toBe('attestation');
});
