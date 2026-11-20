import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Subprocess } from 'bun';
import { createStore } from 'jotai';
import { createSpectrumSession } from '../../src/application/spectrum';
import { createMpvProcessPort, PlayerController } from '../../src/player/controller';
import type { PlaybackTarget } from '../../src/providers/types';
import { SpectrumAnalyzer } from '../../src/spectrum/analyzer';
import { createSpectrumCapturePort } from '../../src/spectrum/capture';
import type { CaptureEvent, CaptureTarget } from '../../src/spectrum/types';
import { configAtom } from '../../src/store/config';
import { playerProcessIdentityAtom, playerStateAtom } from '../../src/store/player';
import { spectrumFrameAtom, spectrumStatusAtom } from '../../src/store/spectrum';

/** Real platform-clock/IPC tests. No host audio server is used by Linux cases. */
const enabled = process.env.TUITUNES_SPECTRUM_INTEGRATION === '1';
const backend = process.env.TUITUNES_SPECTRUM_TEST_BACKEND ?? '';
const backends = ['pipewire', 'pulse', 'wslg', 'coreaudio'];
const rate = 48_000;
const targetHz = 440;
const decoyHz = 3_000;
const chunkMs = 100;

type Env = Record<string, string | undefined>;
type Child = Pick<Subprocess, 'exited' | 'exitCode' | 'kill'>;
type Row = Record<string, unknown>;

function register(selected: string, name: string, fn: () => Promise<void>): void {
  (enabled && backend === selected ? test : test.skip)(
    name,
    fn,
    selected === 'coreaudio' ? 150_000 : 45_000,
  );
}

function row(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface ToneSource {
  pid: number;
  diagnostic: { value: string };
  silence(): void;
  close(): Promise<void>;
}

function rows(text: string): Row[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(row)) throw new Error('Expected an object array');
  return parsed;
}

function requireTools(names: string[]): void {
  for (const name of names) {
    if (!Bun.which(name)) throw new Error(`Integration prerequisite missing: ${name}`);
  }
}

async function stop(proc: Child): Promise<void> {
  if (proc.exitCode !== null) {
    await proc.exited;
    return;
  }
  proc.kill('SIGTERM');
  const force = setTimeout(() => proc.kill('SIGKILL'), 500);
  const deadline = Promise.withResolvers<never>();
  const ceiling = setTimeout(
    () => deadline.reject(new Error('Owned test child did not reap')),
    3_000,
  );
  try {
    await Promise.race([proc.exited, deadline.promise]);
  } finally {
    clearTimeout(force);
    clearTimeout(ceiling);
  }
}

async function text(stream: ReadableStream<Uint8Array>, limit = 8 * 1024 * 1024): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return result + decoder.decode();
      result += decoder.decode(part.value, { stream: true });
      if (result.length > limit) throw new Error('Private tool output exceeded its bound');
    }
  } finally {
    reader.releaseLock();
  }
}

async function command(env: Env, argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const stdout = text(proc.stdout);
  const stderr = text(proc.stderr);
  const deadline = setTimeout(() => proc.kill('SIGKILL'), 3_000);
  try {
    const [code, out, err] = await Promise.all([proc.exited, stdout, stderr]);
    if (code !== 0) throw new Error(`${argv.join(' ')} exited ${code}: ${err.slice(-2_000)}`);
    return out;
  } finally {
    clearTimeout(deadline);
    await stop(proc);
    await Promise.allSettled([stdout, stderr]);
  }
}

/** Condition polling is intentional: it exercises real daemon/IPC readiness. */
async function until(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  for (;;) {
    try {
      if (await condition()) return;
    } catch (error) {
      failure = error;
    }
    if (Date.now() >= deadline)
      throw new Error(`${label}: ${String(failure ?? 'deadline expired')}`);
    await Bun.sleep(25);
  }
}

function launch(env: Env, argv: string[]) {
  const proc = Bun.spawn(argv, { env, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
  const diagnostic = { value: '' };
  const reader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      diagnostic.value = (diagnostic.value + decoder.decode(chunk, { stream: true })).slice(-8_192);
    }
  })();
  return {
    proc,
    diagnostic,
    async close() {
      await stop(proc);
      await reader;
    },
  };
}

function source(
  env: Env,
  ao: 'pipewire' | 'pulse',
  clientName: string,
  frequency: number,
  channels = 2,
): ToneSource {
  const layout = channels === 1 ? 'mono' : channels === 6 ? '5.1' : 'stereo';
  const child = launch(env, [
    'mpv',
    '--no-config',
    '--load-scripts=no',
    '--no-video',
    '--terminal=no',
    '--no-input-default-bindings',
    `--audio-client-name=${clientName}`,
    `--ao=${ao}`,
    `--audio-channels=${layout}`,
    '--demuxer=rawaudio',
    '--demuxer-rawaudio-format=floatle',
    '--demuxer-rawaudio-rate=48000',
    `--demuxer-rawaudio-channels=${layout}`,
    '--cache=no',
    '--audio-buffer=0.05',
    '--',
    '-',
  ]);
  const samples = new Float32Array(((rate * chunkMs) / 1000) * channels);
  for (let i = 0; i < samples.length / channels; i++) {
    const sample = 0.5 * Math.sin((2 * Math.PI * frequency * i) / rate);
    for (let channel = 0; channel < channels; channel++) samples[channels * i + channel] = sample;
  }
  const tone = new Uint8Array(samples.buffer);
  const silence = new Uint8Array(tone.length);
  let muted = false;
  const feed = () => {
    if (child.proc.exitCode !== null) return;
    try {
      child.proc.stdin.write(muted ? silence : tone);
    } catch {
      /* reported via diagnostics/readiness */
    }
  };
  feed();
  const timer = setInterval(feed, chunkMs);
  return {
    pid: child.proc.pid,
    diagnostic: child.diagnostic,
    silence() {
      muted = true;
    },
    async close() {
      clearInterval(timer);
      await child.close();
    },
  };
}

function environment(root: string): Env {
  const env: Env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(PIPEWIRE_|PULSE_)/.test(name)) delete env[name];
  const home = path.join(root, 'home');
  const runtime = path.join(root, 'run');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_RUNTIME_DIR: runtime,
    LC_ALL: 'C',
  });
  return env;
}

async function scopedEnvironment(env: Env, fn: () => Promise<void>): Promise<void> {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

function band(hz: number): number {
  return Math.min(31, Math.max(0, Math.floor((Math.log(hz / 50) / Math.log(10_000 / 50)) * 32)));
}

async function capture(target: CaptureTarget, seconds = 4): Promise<Float64Array> {
  const analyzer = new SpectrumAnalyzer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  let formats = 0;
  let bytes = 0;
  try {
    await createSpectrumCapturePort().run(target, controller.signal, (event: CaptureEvent) => {
      if (event.kind === 'reset') analyzer.reset();
      else if (event.kind === 'format') {
        analyzer.setFormat(event.format);
        formats++;
      } else {
        analyzer.pushPcm(event.bytes);
        bytes += event.bytes.length;
      }
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  expect(formats).toBeGreaterThan(0);
  expect(bytes).toBeGreaterThan(0);
  const analysis = analyzer.analyze();
  if (!analysis) throw new Error('No fresh PCM in private capture');
  return analysis.values;
}

function assertTone(values: Float64Array | readonly number[]): void {
  const peak = Math.max(...values);
  expect(peak).toBeGreaterThan(0.2);
  expect(Math.abs(values.indexOf(peak) - band(targetHz))).toBeLessThanOrEqual(1);
  expect(values[band(decoyHz)]).toBeLessThan(0.15);
}

function props(item: Row): Row {
  return row(item.info) && row(item.info.props) ? item.info.props : {};
}

async function graph(env: Env): Promise<Row[]> {
  return rows(await command(env, ['pw-dump']));
}

function links(items: Row[]): string {
  return items
    .filter((item) => item.type === 'PipeWire:Interface:Link')
    .map((item) => {
      const p = props(item);
      return `${item.id}:${p['link.output.port']}:${p['link.input.port']}`;
    })
    .sort()
    .join('|');
}

function nodeId(items: Row[], name: string): number | null {
  const matches = items.filter(
    (item) =>
      item.type === 'PipeWire:Interface:Node' &&
      (props(item)['node.name'] === name || props(item)['application.name'] === name),
  );
  return matches.length === 1 && typeof matches[0].id === 'number' ? matches[0].id : null;
}

function ports(items: Row[], id: number, direction: string): Row[] {
  return items.filter(
    (item) =>
      item.type === 'PipeWire:Interface:Port' &&
      Number(props(item)['node.id']) === id &&
      props(item)['port.direction'] === direction,
  );
}

async function linkPrivatePlayer(env: Env, name: string, channels: number): Promise<void> {
  let outputs: Row[] = [];
  let inputs: Row[] = [];
  await until(async () => {
    const items = await graph(env);
    const player = nodeId(items, name);
    const sink = nodeId(items, 'tuitunes_test_sink');
    if (player === null || sink === null) return false;
    outputs = ports(items, player, 'out');
    inputs = ports(items, sink, 'in');
    return outputs.length === channels && inputs.length === channels;
  }, `private PipeWire ports for ${name}`);
  for (const output of outputs) {
    const channel = props(output)['audio.channel'];
    const input = inputs.find((candidate) => props(candidate)['audio.channel'] === channel);
    if (!input) throw new Error(`Private sink has no ${String(channel)} channel`);
    await command(env, ['pw-link', String(output.id), String(input.id)]);
  }
}

function writeStereoTone(filename: string): void {
  const dataSize = 20 * rate * 4;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let sample = 0, offset = 44; offset < wav.length; sample++, offset += 4) {
    const value = Math.round(16_384 * Math.sin((2 * Math.PI * targetHz * sample) / rate));
    wav.writeInt16LE(value, offset);
    wav.writeInt16LE(value, offset + 2);
  }
  writeFileSync(filename, wav);
}

/** Hold the decoy open while the actual application owners pause and recover mpv. */
async function playbackRecovery(env: Env, root: string, ao: 'pipewire' | 'pulse'): Promise<void> {
  const filename = path.join(root, 'recovery.wav');
  writeStereoTone(filename);
  const store = createStore();
  store.set(configAtom, { ...store.get(configAtom), spectrumEnabled: true });
  const player = new PlayerController(
    store,
    createMpvProcessPort({
      extraArgs: [
        '--no-config',
        '--load-scripts=no',
        '--no-ytdl',
        `--ao=${ao}`,
        '--audio-channels=stereo',
      ],
    }),
  );
  const spectrum = createSpectrumSession(store, { capture: createSpectrumCapturePort() });
  const target: PlaybackTarget = {
    track: {
      id: 'recovery-tone',
      provider: 'fixture',
      source: null,
      title: 'Recovery tone',
      artist: 'Integration',
      duration: 20,
    },
    source: { kind: 'rss', url: pathToFileURL(filename).href, selection: 'auto' },
    requestId: 1,
    origin: { kind: 'direct' },
  };

  async function assertSpectrum(stage: string): Promise<void> {
    try {
      await until(() => {
        const frame = store.get(spectrumFrameAtom);
        return frame !== null && Math.max(...frame.values) > 0.2;
      }, stage);
    } catch (error) {
      throw new Error(
        `${String(error)}; spectrum: ${JSON.stringify(store.get(spectrumStatusAtom))}`,
      );
    }
    const frame = store.get(spectrumFrameAtom);
    if (!frame) throw new Error(`${stage}: capture lost its frame`);
    expect(frame.requestId).toBe(target.requestId);
    assertTone(frame.values);
  }

  try {
    await player.init();
    const first = store.get(playerProcessIdentityAtom);
    if (!first) throw new Error('mpv process identity missing');
    await player.play(target);
    if (ao === 'pipewire') await linkPrivatePlayer(env, first.clientName, 2);
    await assertSpectrum('initial playback spectrum');

    await player.togglePause();
    await until(() => store.get(playerStateAtom) === 'paused', 'mpv paused');
    expect(store.get(spectrumFrameAtom)).toBeNull();
    expect(store.get(spectrumStatusAtom)).toEqual({ kind: 'suppressed', reason: 'not-playing' });
    await player.togglePause();
    await assertSpectrum('resumed playback spectrum');

    process.kill(first.pid, 'SIGKILL');
    await until(() => store.get(playerStateAtom) === 'stopped', 'mpv disconnect');
    expect(store.get(spectrumFrameAtom)).toBeNull();
    await until(
      () => {
        const current = store.get(playerProcessIdentityAtom);
        return current !== null && current.clientName !== first.clientName;
      },
      'replacement mpv process',
      12_000,
    );
    const replacement = store.get(playerProcessIdentityAtom);
    if (!replacement) throw new Error('replacement process identity missing');
    if (ao === 'pipewire') await linkPrivatePlayer(env, replacement.clientName, 2);
    await assertSpectrum('recovered playback spectrum');
  } finally {
    try {
      await spectrum.dispose();
    } finally {
      await player.destroy();
    }
  }
}

for (const channels of [1, 2, 6]) {
  const positions = channels === 1 ? 'FC' : channels === 6 ? 'FL,FR,FC,LFE,RL,RR' : 'FL,FR';
  register(
    'pipewire',
    `private PipeWire (${channels} channels): target, decoy, silence and unchanged links`,
    async () => {
      requireTools(['mpv', 'pipewire', 'pw-dump', 'pw-record', 'pw-link']);
      const root = mkdtempSync(path.join(tmpdir(), 'tuitunes-pw-proof-'));
      const env = environment(root);
      env.PIPEWIRE_RUNTIME_DIR = env.XDG_RUNTIME_DIR;
      env.PIPEWIRE_REMOTE = 'pipewire-0';
      for (const name of ['client.conf.d', 'client-rt.conf.d']) {
        const directory = path.join(String(env.XDG_CONFIG_HOME), 'pipewire', name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, '99-tuitunes-proof.conf'),
          'stream.properties = { adapter.auto-port-config = "{ mode=dsp position=preserve }" node.autoconnect = false }\n',
        );
      }
      const config = path.join(root, 'daemon.conf');
      writeFileSync(
        config,
        `context.properties = { core.daemon = true default.clock.rate = 48000 default.clock.quantum = 1024 }
context.spa-libs = { "audio.convert.*" = "audioconvert/libspa-audioconvert" "support.*" = "support/libspa-support" }
context.modules = [
  { name = libpipewire-module-protocol-native args = { sockets = [ { name = "pipewire-0" } ] } }
  { name = libpipewire-module-access args = { access.socket = { pipewire-0 = "unrestricted" } } }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-metadata }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-link-factory }
]
context.objects = [ { factory = adapter args = {
  factory.name = support.null-audio-sink node.name = tuitunes_test_sink media.class = Audio/Sink
  audio.channels = ${channels} audio.position = "${positions}" node.driver = true priority.driver = 10000
  adapter.auto-port-config = { mode = dsp monitor = true position = preserve }
} } ]
`,
      );
      await scopedEnvironment(env, async () => {
        const daemon = launch(env, ['pipewire', '-c', config]);
        let target: ToneSource | undefined;
        let decoy: ToneSource | undefined;
        try {
          await until(
            () => existsSync(path.join(String(env.PIPEWIRE_RUNTIME_DIR), 'pipewire-0')),
            'private PipeWire socket',
          );
          const name = `TuiTunes-${crypto.randomUUID()}`;
          const decoyName = `decoy-${crypto.randomUUID()}`;
          target = source(env, 'pipewire', name, targetHz, channels);
          decoy = source(env, 'pipewire', decoyName, decoyHz, channels);
          await linkPrivatePlayer(env, name, channels);
          await linkPrivatePlayer(env, decoyName, channels);
          const before = links(await graph(env));
          expect(before.split('|')).toHaveLength(2 * channels);
          assertTone(
            await capture(
              { requestId: 1, process: { pid: target.pid, clientName: name }, ao: 'pipewire' },
              6,
            ),
          );
          target.silence();
          expect(
            Math.max(
              ...(await capture({
                requestId: 2,
                process: { pid: target.pid, clientName: name },
                ao: 'pipewire',
              })),
            ),
          ).toBeLessThan(0.05);
          await until(
            async () => links(await graph(env)) === before,
            'unchanged original output links',
          );
          if (channels === 2) {
            await target.close();
            await playbackRecovery(env, root, 'pipewire');
          }
        } catch (error) {
          throw new Error(
            `${String(error)}\nPRIVATE DAEMON: ${daemon.diagnostic.value}\nTARGET: ${target?.diagnostic.value ?? ''}`,
          );
        } finally {
          try {
            await Promise.all([target?.close(), decoy?.close()]);
          } finally {
            await daemon.close();
          }
        }
      }).finally(() => rmSync(root, { recursive: true, force: true }));
    },
  );
}

async function pulseRoutes(env: Env): Promise<string> {
  const inputs = rows(await command(env, ['pactl', '--format=json', 'list', 'sink-inputs']));
  const sinks = rows(await command(env, ['pactl', '--format=json', 'list', 'sinks']));
  const info: unknown = JSON.parse(await command(env, ['pactl', '--format=json', 'info']));
  if (!row(info)) throw new Error('Invalid private Pulse server info');
  return JSON.stringify({
    defaults: [info.default_sink_name, info.default_source_name],
    inputs: inputs.map((item) => ({
      index: item.index,
      sink: item.sink,
      mute: item.mute,
      volume: item.volume,
    })),
    sinks: sinks.map((item) => ({
      index: item.index,
      name: item.name,
      monitor: item.monitor_source,
      mute: item.mute,
      volume: item.volume,
      channels: item.channel_map,
    })),
  });
}

async function pulseMoveAndRemoval(env: Env, target: ToneSource, name: string): Promise<void> {
  await command(env, ['pactl', 'load-module', 'module-null-sink', 'sink_name=tuitunes_moved']);
  const inputs = rows(await command(env, ['pactl', '--format=json', 'list', 'sink-inputs']));
  const input = inputs.find(
    (item) => row(item.properties) && item.properties['application.name'] === name,
  );
  if (!input) throw new Error('Target input disappeared before the move test');
  const firstPcm = Promise.withResolvers<void>();
  const movedPcm = Promise.withResolvers<void>();
  const analyzer = new SpectrumAnalyzer();
  const controller = new AbortController();
  let formats = 0;
  let resets = 0;
  const deadline = setTimeout(() => controller.abort(), 15_000);
  const ended = createSpectrumCapturePort()
    .run(
      {
        requestId: 3,
        process: { pid: target.pid, clientName: name },
        ao: 'pulse',
      },
      controller.signal,
      (event) => {
        if (event.kind === 'reset') {
          resets++;
          analyzer.reset();
        } else if (event.kind === 'format') {
          formats++;
          analyzer.setFormat(event.format);
        } else {
          analyzer.pushPcm(event.bytes);
          firstPcm.resolve();
          if (formats >= 2) movedPcm.resolve();
        }
      },
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  const premature = ended.then((error) => {
    throw error ?? new Error('Capture ended before the expected stage');
  });
  try {
    await Promise.race([firstPcm.promise, premature]);
    await command(env, ['pactl', 'move-sink-input', String(input.index), 'tuitunes_moved']);
    await Promise.race([movedPcm.promise, premature]);
    expect(formats).toBeGreaterThanOrEqual(2);
    expect(resets).toBeGreaterThanOrEqual(1);
    const measured = analyzer.analyze();
    expect(measured).not.toBeNull();
    expect(Math.max(...(measured?.values ?? [1]))).toBeLessThan(0.05);
    await target.close();
    const failure = await ended;
    expect(failure).toMatchObject({ name: 'SpectrumCaptureError' });
    if (!row(failure) || typeof failure.code !== 'string') {
      throw new Error('Removal did not terminate process capture with a typed failure');
    }
    expect(['target-not-found', 'process']).toContain(failure.code);
    expect(controller.signal.aborted).toBe(false);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await ended;
  }
}

async function pulseProof(env: Env, channels = 2, privateStereoRoot?: string): Promise<void> {
  const name = `TuiTunes-${crypto.randomUUID()}`;
  const target = source(env, 'pulse', name, targetHz, channels);
  const decoy = source(env, 'pulse', `decoy-${crypto.randomUUID()}`, decoyHz, channels);
  try {
    await until(async () => {
      const inputs = rows(await command(env, ['pactl', '--format=json', 'list', 'sink-inputs']));
      return inputs.some(
        (item) => row(item.properties) && item.properties['application.name'] === name,
      );
    }, 'real mpv Pulse sink input');
    const before = await pulseRoutes(env);
    assertTone(
      await capture(
        { requestId: 1, process: { pid: target.pid, clientName: name }, ao: 'pulse' },
        6,
      ),
    );
    target.silence();
    expect(
      Math.max(
        ...(await capture({
          requestId: 2,
          process: { pid: target.pid, clientName: name },
          ao: 'pulse',
        })),
      ),
    ).toBeLessThan(0.05);
    expect(await pulseRoutes(env)).toBe(before);
    if (privateStereoRoot) {
      await pulseMoveAndRemoval(env, target, name);
      await playbackRecovery(env, privateStereoRoot, 'pulse');
    }
  } catch (error) {
    throw new Error(
      `${String(error)}\nTARGET: ${target.diagnostic.value}\nDECOY: ${decoy.diagnostic.value}`,
    );
  } finally {
    await Promise.all([target.close(), decoy.close()]);
  }
}

for (const channels of [1, 2, 6]) {
  register(
    'pulse',
    `private PulseAudio (${channels} channels): target, decoy, silence and unchanged routes`,
    async () => {
      requireTools(['mpv', 'pulseaudio', 'pactl', 'parec']);
      const root = mkdtempSync(path.join(tmpdir(), 'tuitunes-pa-proof-'));
      const env = environment(root);
      const socket = path.join(String(env.XDG_RUNTIME_DIR), 'native');
      env.PULSE_SERVER = `unix:${socket}`;
      env.PULSE_RUNTIME_PATH = env.XDG_RUNTIME_DIR;
      env.PULSE_STATE_PATH = env.XDG_RUNTIME_DIR;
      const clientConfig = path.join(root, 'client.conf');
      writeFileSync(clientConfig, `autospawn = no\ndefault-server = unix:${socket}\n`);
      env.PULSE_CLIENTCONFIG = clientConfig;
      await scopedEnvironment(env, async () => {
        const daemon = launch(env, [
          'pulseaudio',
          '-n',
          '--daemonize=no',
          '--exit-idle-time=-1',
          '--log-target=stderr',
          `--load=module-native-protocol-unix socket=${socket} auth-anonymous=1`,
          '--load=module-null-sink sink_name=tuitunes_it_sink',
        ]);
        try {
          await until(() => existsSync(socket), 'private Pulse socket');
          await command(env, ['pactl', 'set-default-sink', 'tuitunes_it_sink']);
          await pulseProof(env, channels, channels === 2 ? root : undefined);
        } catch (error) {
          throw new Error(`${String(error)}\nPRIVATE DAEMON: ${daemon.diagnostic.value}`);
        } finally {
          await daemon.close();
        }
      }).finally(() => rmSync(root, { recursive: true, force: true }));
    },
  );
}

register(
  'wslg',
  'attended WSLg: exact sink-input isolation on the projected Pulse server',
  async () => {
    requireTools(['mpv', 'pactl', 'parec']);
    if (!process.env.PULSE_SERVER)
      throw new Error('Attended WSLg requires an explicit projected PULSE_SERVER');
    await pulseProof({ ...process.env });
  },
);

register(
  'coreaudio',
  'attended macOS: process tap with observed PCM (not permission inference)',
  async () => {
    const pid = Number(process.env.TUITUNES_SPECTRUM_TARGET_PID);
    const name = process.env.TUITUNES_SPECTRUM_TARGET_NAME;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name)
      throw new Error('Provide the attended mpv PID/client name');
    const measured = await capture(
      { requestId: 1, process: { pid, clientName: name }, ao: 'coreaudio' },
      Number(process.env.TUITUNES_SPECTRUM_SECONDS ?? 120),
    );
    expect(Math.max(...measured)).toBeGreaterThan(0.05);
    console.log(
      'Observed process PCM; record OS/arch/helper digest, consent/refusal/revocation and decoy-isolation evidence separately.',
    );
  },
);

(enabled ? test : test.skip)('selected spectrum backend is known', () => {
  expect(backends).toContain(backend);
});
