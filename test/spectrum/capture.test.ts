import { describe, expect, test } from 'bun:test';
import { runTool, sleep, stopChild, waitExit } from '../../src/spectrum/capture';
import {
  JsonArrayStream,
  PipeWireGraph,
  pipeWireToolsAvailable,
} from '../../src/spectrum/pipewire';
import { SpectrumCaptureError } from '../../src/spectrum/types';
import { FakeChild, FakeSpawn, fakeEnv, textToBytes } from './fakes';

describe('JsonArrayStream', () => {
  test('parses arrays fragmented across chunk boundaries', () => {
    const arrays: unknown[][] = [];
    const stream = new JsonArrayStream((entries) => arrays.push(entries));
    const json = JSON.stringify([{ id: 1 }, { id: 2 }]);
    const split = [json.slice(0, 5), json.slice(5, 11), json.slice(11)];
    for (const part of split) stream.push(textToBytes(part));
    expect(arrays).toEqual([[{ id: 1 }, { id: 2 }]]);
  });

  test('parses multiple consecutive arrays in one chunk', () => {
    const arrays: unknown[][] = [];
    const stream = new JsonArrayStream((entries) => arrays.push(entries));
    stream.push(textToBytes('[{"id":1}]\n[{"id":2}][{"id":3}]'));
    expect(arrays).toEqual([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]);
  });

  test('brackets inside strings do not terminate arrays', () => {
    const arrays: unknown[][] = [];
    const stream = new JsonArrayStream((entries) => arrays.push(entries));
    stream.push(textToBytes('[{"name":"a[b]c"},{"path":"x\\"y["}]'));
    expect(arrays).toEqual([[{ name: 'a[b]c' }, { path: 'x"y[' }]]);
  });

  test('malformed JSON is a typed protocol error', () => {
    const stream = new JsonArrayStream(() => {});
    stream.push(textToBytes('[{"id":1}'));
    expect(() => stream.push(textToBytes('oops}]'))).toThrow(SpectrumCaptureError);
  });

  test('oversized messages are rejected within the bound', () => {
    const stream = new JsonArrayStream(() => {}, 64);
    expect(() => stream.push(textToBytes(`[${'{"id":1},'.repeat(20)}]`))).toThrow(
      SpectrumCaptureError,
    );
  });

  test('junk outside arrays is a protocol error', () => {
    const stream = new JsonArrayStream(() => {});
    expect(() => stream.push(textToBytes(']'))).toThrow(SpectrumCaptureError);
  });
});

describe('PipeWireGraph', () => {
  function graphFrom(chunks: readonly string[]): PipeWireGraph {
    const graph = new PipeWireGraph();
    const stream = new JsonArrayStream((entries) => graph.applyArray(entries));
    for (const chunk of chunks) stream.push(textToBytes(chunk));
    return graph;
  }

  test('upserts nodes, ports and links from a dump', () => {
    const graph = graphFrom([
      JSON.stringify([
        {
          id: 10,
          type: 'PipeWire:Interface:Node',
          info: {
            props: {
              'node.name': 'TuiTunes-abc',
              'application.name': 'mpv',
              'application.process.id': 4242,
              'media.class': 'Stream/Output/Audio',
            },
          },
        },
        {
          id: 11,
          type: 'PipeWire:Interface:Port',
          info: { direction: 'out', props: { 'node.id': 10, 'audio.channel': 'FL' } },
        },
        {
          id: 12,
          type: 'PipeWire:Interface:Port',
          info: { direction: 'in', props: { 'node.id': 13, 'audio.channel': 'FL' } },
        },
        {
          id: 20,
          type: 'PipeWire:Interface:Link',
          info: {
            props: {
              'link.output.node': '10',
              'link.output.port': '11',
              'link.input.node': '13',
              'link.input.port': '12',
            },
          },
        },
      ]),
    ]);
    expect(graph.playerCandidates('TuiTunes-abc', 4242)).toHaveLength(1);
    expect(graph.portsOf(10, 'out')).toHaveLength(1);
    expect(graph.portsOf(10, 'out')[0]?.channel).toBe('FL');
    expect(graph.links.get(20)?.inputPort).toBe(12);
    expect(graph.portsOf(13, 'in')).toHaveLength(1);
  });

  test('entries without info remove objects (pw-dump monitor semantics)', () => {
    const graph = graphFrom([
      '[{"id":10,"type":"PipeWire:Interface:Node","info":{"props":{"node.name":"x"}}}]',
      '[{"id":10,"type":"PipeWire:Interface:Node"}]',
    ]);
    expect(graph.nodes.has(10)).toBe(false);
  });

  test('player matching is exact: name or app name, media class, pid', () => {
    const base = { 'media.class': 'Stream/Output/Audio' };
    const graph = graphFrom([
      JSON.stringify([
        {
          id: 1,
          type: 'PipeWire:Interface:Node',
          info: { props: { ...base, 'node.name': 'TuiTunes-x' } },
        },
        {
          id: 2,
          type: 'PipeWire:Interface:Node',
          info: { props: { ...base, 'application.name': 'TuiTunes-x' } },
        },
        {
          id: 3,
          type: 'PipeWire:Interface:Node',
          info: { props: { ...base, 'node.name': 'TuiTunes-x', 'application.process.id': 999 } },
        },
        {
          id: 4,
          type: 'PipeWire:Interface:Node',
          info: { props: { 'node.name': 'TuiTunes-x', 'media.class': 'Stream/Input/Audio' } },
        },
        {
          id: 5,
          type: 'PipeWire:Interface:Node',
          info: { props: { ...base, 'node.name': 'other' } },
        },
      ]),
    ]);
    expect(graph.playerCandidates('TuiTunes-x', 4242).map((node) => node.id)).toEqual([1, 2]);
    // A matching PID enables node 3; a proxy daemon pid would not fool it.
    expect(graph.playerCandidates('TuiTunes-x', 999).map((node) => node.id)).toEqual([1, 2, 3]);
  });

  test('malformed entries (non-object, missing id) are protocol errors', () => {
    const graph = new PipeWireGraph();
    expect(() => graph.applyArray([42])).toThrow(SpectrumCaptureError);
    expect(() => graph.applyArray([{ type: 'PipeWire:Interface:Node', info: {} }])).toThrow(
      SpectrumCaptureError,
    );
  });

  test('null-info removals and oversized retained identity strings fail safely', () => {
    const graph = new PipeWireGraph();
    graph.applyArray([
      { id: 1, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'player' } } },
    ]);
    graph.applyArray([{ id: 1, type: 'PipeWire:Interface:Node', info: null }]);
    expect(graph.nodes.size).toBe(0);
    expect(() =>
      graph.applyArray([
        {
          id: 2,
          type: 'PipeWire:Interface:Node',
          info: { props: { 'node.name': 'x'.repeat(513) } },
        },
      ]),
    ).toThrow('retained string bound');
  });
});

describe('pipeWireToolsAvailable', () => {
  test('accepts pw-dump 1.x and newer', async () => {
    const spawn = new FakeSpawn();
    spawn.onSpawn = (child) => {
      child.pushStdout('pw-dump version 1.2.7\n');
      child.exit(0);
    };
    await expect(pipeWireToolsAvailable(fakeEnv(spawn))).resolves.toEqual({
      available: true,
      reason: 'pw-dump (libpipewire 1.x)',
    });
  });

  test('rejects missing tools, 0.3 versions, and garbage output', async () => {
    const missing = new FakeSpawn();
    missing.missing.add('pw-dump');
    await expect(pipeWireToolsAvailable(fakeEnv(missing))).resolves.toMatchObject({
      available: false,
    });

    const old = new FakeSpawn();
    old.onSpawn = (child) => {
      child.pushStderr('pw-dump version 0.3.77\n');
      child.exit(0);
    };
    await expect(pipeWireToolsAvailable(fakeEnv(old))).resolves.toMatchObject({ available: false });

    const garbage = new FakeSpawn();
    garbage.onSpawn = (child) => {
      child.pushStdout('not a version');
      child.exit(0);
    };
    await expect(pipeWireToolsAvailable(fakeEnv(garbage))).resolves.toMatchObject({
      available: false,
    });
  });
});

describe('child teardown helpers', () => {
  test('stopChild escalates TERM then KILL with bounded grace', async () => {
    const child = new FakeChild(['stub'], 1);
    // First signal ignored, second one honored: models a hung child.
    child.kill = (signal = 'SIGTERM') => {
      child.kills.push(signal);
      if (signal === 'SIGKILL') child.exit(137);
    };
    await stopChild(child);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('waitExit reports timeouts without killing', async () => {
    const child = new FakeChild(['stub'], 2);
    const result = await waitExit(child, 20);
    expect(result.timedOut).toBe(true);
    expect(child.kills).toEqual([]);
    child.exit(0);
  });

  test('runTool surfaces nonzero exit and output', async () => {
    const spawn = new FakeSpawn();
    spawn.onSpawn = (child) => {
      child.pushStdout('hello');
      child.exit(3);
    };
    const result = await runTool(fakeEnv(spawn), ['probe']);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('hello');
  });

  test('sleep resolves (scheduler seam sanity)', async () => {
    await sleep(1);
  });
});

test('pw-dump --version accepts the real multi-line libpipewire output', async () => {
  const spawn = new FakeSpawn();
  spawn.onSpawn = (child) => {
    child.pushStdout('pw-dump\nCompiled with libpipewire 1.2.7\nLinked with libpipewire 1.2.7\n');
    child.exit(0);
  };
  await expect(pipeWireToolsAvailable(fakeEnv(spawn))).resolves.toMatchObject({ available: true });
});

test('runTool kills a hung child instead of waiting on its pipes', async () => {
  const spawn = new FakeSpawn();
  spawn.onSpawn = () => {
    // Never exits and never closes its pipes.
  };
  const child = spawn.children[0] as FakeChild | undefined;
  void child;
  const failure = await runTool(fakeEnv(spawn), ['probe'], { timeoutMs: 50 }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SpectrumCaptureError);
  const hung = spawn.children[0] as FakeChild;
  expect(hung.kills.length).toBeGreaterThan(0); // killed before readers drained
});
