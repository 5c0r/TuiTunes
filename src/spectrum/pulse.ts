/**
 * Linux native PulseAudio / WSLg capture adapter (feature 15).
 *
 * Direct single-input monitor capture: resolve exactly one sink-input owned
 * by this run's generated mpv application name (PID-checked when present),
 * then `parec --monitor-stream=<index> --device=<its sink's monitor>` — never
 * a default monitor, never the full sink mix. A `pactl subscribe` watcher
 * under the same lifetime re-resolves on moves/removals; it never moves the
 * audible stream or changes the default sink, and PULSE_SERVER/auth env is
 * preserved so WSLg's projected server is used as-is.
 */
import {
  pumpBytes,
  readLines,
  runCaptureBackend,
  runTool,
  sleep,
  stopChild,
  type CaptureChild,
  type CaptureEnv,
  type CaptureRunContext,
} from './capture';
import {
  CAPTURE_SAMPLE_RATE,
  SpectrumCaptureError,
  type CaptureEvent,
  type CaptureTarget,
} from './types';

const POLL_INTERVAL_MS = 50;
const RESOLVE_TIMEOUT_MS = 5_000;
/** Bounded consecutive re-resolve cycles before the run becomes unavailable. */
const MAX_REATTACH_CYCLES = 5;
const MIN_PROTOCOL_VERSION = 13;
const MIN_PACTL_MAJOR = 16;
/** Fixed monitor capture format per the shared contract. */
const PAREC_CHANNELS = 2;
const PAREC_CHANNEL_MAP = 'front-left,front-right';

interface SinkInput {
  index: number;
  sink: number;
  applicationName: string;
  applicationPid: number | null;
}

interface ServerInfo {
  serverName: string;
  protocolVersion: number;
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse one `pactl --format=json` document (object or array). */
export function parsePactlJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SpectrumCaptureError('protocol', `pactl emitted invalid JSON: ${error}`);
  }
  return parsed;
}

/** Validate the native server: recognized PulseAudio, protocol ≥13. */
export function parseServerInfo(doc: unknown): ServerInfo {
  if (doc == null || typeof doc !== 'object') {
    throw new SpectrumCaptureError('protocol', 'pactl info is not a JSON object');
  }
  const info = doc as Record<string, unknown>;
  const serverName =
    typeof info.server_name === 'string'
      ? info.server_name
      : typeof info['server name'] === 'string'
        ? (info['server name'] as string)
        : '';
  const rawProtocol =
    typeof info.server_protocol_version === 'number'
      ? info.server_protocol_version
      : typeof info['server protocol version'] === 'number'
        ? (info['server protocol version'] as number)
        : typeof info.protocol === 'number'
          ? info.protocol
          : NaN;
  if (serverName === '' || !Number.isInteger(rawProtocol)) {
    throw new SpectrumCaptureError('protocol', 'pactl info lacks server_name/protocol version');
  }
  return { serverName, protocolVersion: rawProtocol };
}

function readProperties(entry: Record<string, unknown>): Record<string, unknown> {
  const props = entry.properties;
  return props != null && typeof props === 'object' ? (props as Record<string, unknown>) : {};
}

/** Find the unique sink-input tagged with the client name (PID-checked). */
export function findSinkInput(doc: unknown, clientName: string, pid: number): SinkInput {
  if (!Array.isArray(doc)) {
    throw new SpectrumCaptureError('protocol', 'pactl list sink-inputs is not a JSON array');
  }
  const matches: SinkInput[] = [];
  for (const raw of doc) {
    if (raw == null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const index = parsePositiveInt(String(entry.index ?? ''));
    const sink =
      typeof entry.sink === 'number' ? entry.sink : parsePositiveInt(String(entry.sink ?? ''));
    if (index === null || sink === null) continue;
    const props = readProperties(entry);
    const applicationName =
      typeof props['application.name'] === 'string' ? (props['application.name'] as string) : '';
    if (applicationName !== clientName) continue;
    const rawPid = props['application.process.id'];
    const applicationPid =
      typeof rawPid === 'number'
        ? Math.trunc(rawPid)
        : typeof rawPid === 'string'
          ? parsePositiveInt(rawPid)
          : null;
    if (applicationPid !== null && applicationPid !== pid) continue;
    matches.push({ index, sink, applicationName, applicationPid });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new SpectrumCaptureError(
      'target-ambiguous',
      `multiple PulseAudio sink-inputs match ${clientName} (${matches.length}); refusing to guess`,
    );
  }
  throw new SpectrumCaptureError('target-not-found', `no PulseAudio sink-input for ${clientName}`);
}

/** Resolve a sink's monitor_source by index. */
export function findSinkMonitor(doc: unknown, sinkIndex: number): string {
  if (!Array.isArray(doc)) {
    throw new SpectrumCaptureError('protocol', 'pactl list sinks is not a JSON array');
  }
  for (const raw of doc) {
    if (raw == null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const index =
      typeof entry.index === 'number' ? entry.index : parsePositiveInt(String(entry.index ?? ''));
    if (index !== sinkIndex) continue;
    const monitor =
      typeof entry.monitor_source === 'string'
        ? entry.monitor_source
        : typeof entry['monitor source'] === 'string'
          ? (entry['monitor source'] as string)
          : '';
    if (monitor === '') break;
    return monitor;
  }
  throw new SpectrumCaptureError('target-not-found', `sink ${sinkIndex} exposes no monitor source`);
}

interface PulseProbe {
  available: boolean;
  reason: string;
  /** True when the server is PipeWire-Pulse and the graph route is required. */
  pipeWirePulse?: boolean;
}

/**
 * Native PulseAudio availability: pactl ≥16 plus a recognized native server
 * with protocol ≥13. A PipeWire-Pulse server must use the graph adapter, and
 * unknown compatible servers are rejected until tested.
 */
export async function nativePulseAvailable(
  env: CaptureEnv,
  options: { signal?: AbortSignal } = {},
): Promise<PulseProbe> {
  try {
    const version = await runTool(env, ['pactl', '--version'], { signal: options.signal });
    const match = /pactl\s+(\d+)\./.exec(`${version.stdout}\n${version.stderr}`);
    if (match === null) return { available: false, reason: 'pactl did not report a version' };
    if (Number(match[1]) < MIN_PACTL_MAJOR) {
      return { available: false, reason: `pactl ${match[1]}.x is older than ${MIN_PACTL_MAJOR}` };
    }
    const info = await runTool(env, ['pactl', '--format=json', 'info'], { signal: options.signal });
    const server = parseServerInfo(parsePactlJson(info.stdout));
    if (server.protocolVersion < MIN_PROTOCOL_VERSION) {
      return {
        available: false,
        reason: `PulseAudio protocol ${server.protocolVersion} is older than ${MIN_PROTOCOL_VERSION}`,
      };
    }
    const lowered = server.serverName.toLowerCase();
    if (lowered.includes('pipewire')) {
      return {
        available: false,
        pipeWirePulse: true,
        reason: `${server.serverName} is a PipeWire-Pulse server; use the PipeWire graph capture`,
      };
    }
    if (!lowered.startsWith('pulseaudio')) {
      return {
        available: false,
        reason: `unrecognized server implementation "${server.serverName}"; rejected until tested`,
      };
    }
    return { available: true, reason: server.serverName };
  } catch (error) {
    const reason =
      error instanceof SpectrumCaptureError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { available: false, reason };
  }
}

interface Attachment {
  input: SinkInput;
  monitor: string;
}

async function resolveAttachment(ctx: CaptureRunContext): Promise<Attachment> {
  const { clientName, pid } = ctx.target.process;
  const deadline = ctx.now() + RESOLVE_TIMEOUT_MS;
  for (;;) {
    ctx.throwIfAborted();
    const inputs = await runTool(ctx.env, ['pactl', '--format=json', 'list', 'sink-inputs']);
    try {
      const input = findSinkInput(parsePactlJson(inputs.stdout), clientName, pid);
      const sinks = await runTool(ctx.env, ['pactl', '--format=json', 'list', 'sinks']);
      const monitor = findSinkMonitor(parsePactlJson(sinks.stdout), input.sink);
      return { input, monitor };
    } catch (error) {
      if (
        !(error instanceof SpectrumCaptureError) ||
        error.code !== 'target-not-found' ||
        ctx.now() >= deadline
      ) {
        throw error;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Start the single-input monitor recorder with the exact argv contract. */
function startParec(ctx: CaptureRunContext, attachment: Attachment): CaptureChild {
  return ctx.spawn([
    'parec',
    '--raw',
    `--device=${attachment.monitor}`,
    `--monitor-stream=${attachment.input.index}`,
    '--format=float32le',
    `--rate=${CAPTURE_SAMPLE_RATE}`,
    `--channels=${PAREC_CHANNELS}`,
    `--channel-map=${PAREC_CHANNEL_MAP}`,
  ]);
}

/** Parse `pactl subscribe` event lines; true when relevant to our objects. */
export function isRelevantSubscribeLine(
  line: string,
  inputIndex: number,
  sinkIndex: number,
): boolean {
  const match =
    /^Event '(new|change|remove)' on (server|client|sink-input|sink|source|source-output|module) #(\d+)/.exec(
      line,
    );
  if (match === null) return false;
  const object = match[2];
  const index = Number(match[3]);
  if (object === 'server') return true; // server restart: re-resolve everything
  if (object === 'sink-input') return index === inputIndex; // covers moves/changes/removals
  if (object === 'sink') return index === sinkIndex; // monitor may vanish with its sink
  return false;
}

/** Native PulseAudio / WSLg capture run. */
export async function runPulseCapture(
  target: CaptureTarget,
  signal: AbortSignal,
  emit: (event: CaptureEvent) => void,
  env: CaptureEnv,
): Promise<void> {
  await runCaptureBackend('pulse', target, signal, emit, env, async (ctx) => {
    const server = parseServerInfo(
      parsePactlJson((await runTool(ctx.env, ['pactl', '--format=json', 'info'])).stdout),
    );
    if (server.protocolVersion < MIN_PROTOCOL_VERSION) {
      throw new SpectrumCaptureError(
        'protocol',
        `PulseAudio protocol ${server.protocolVersion} < ${MIN_PROTOCOL_VERSION}`,
      );
    }
    if (server.serverName.toLowerCase().includes('pipewire')) {
      // Re-checked inside the adapter, not only in dispatch: a PipeWire-Pulse
      // server must use the graph capture, never a default monitor.
      throw new SpectrumCaptureError(
        'unsupported',
        `${server.serverName} is a PipeWire-Pulse server; use the PipeWire graph capture`,
      );
    }
    for (let cycle = 0; ; cycle++) {
      ctx.throwIfAborted();
      const attachment = await resolveAttachment(ctx);
      const recorder = startParec(ctx, attachment);
      let lastStderr = '';
      const stderrReader = readLines(recorder.stderr, (line) => {
        lastStderr = line;
      }).catch(() => undefined);
      const recorderExit: { resolved: boolean; code: number | null } = {
        resolved: false,
        code: null,
      };
      void recorder.exited.then(
        (code) => {
          recorderExit.code = code;
          recorderExit.resolved = true;
        },
        () => {
          recorderExit.resolved = true;
        },
      );

      // Subscription lives under the same capture lifetime, LC_ALL=C for the
      // event grammar. It only observes; it never routes audio. Overflow and
      // reader failures are never dropped silently: overflow coalesces into a
      // dirty flag that forces re-resolution, failures fail the run.
      const pending: string[] = [];
      const subscription = { overflow: false, error: null as unknown };
      const subscriber = ctx.spawn(['pactl', 'subscribe'], { env: { LC_ALL: 'C' } });
      const subscriberReader = readLines(subscriber.stdout, (line) => {
        if (pending.length < 64) pending.push(line);
        else subscription.overflow = true; // coalesce: re-resolve, keep bounded
      }).catch((error) => {
        subscription.error = error;
      });
      void readLines(subscriber.stderr, () => {}).catch(() => undefined);
      let subscriberExit = false;
      void subscriber.exited.finally(() => {
        subscriberExit = true;
      });

      const gate = { open: true };
      emit({
        kind: 'format',
        format: { sampleRate: CAPTURE_SAMPLE_RATE, channels: PAREC_CHANNELS, encoding: 'f32le' },
      });
      const stdoutReader = pumpBytes(recorder.stdout, (chunk) => {
        if (gate.open) emit({ kind: 'pcm', bytes: chunk });
      }).catch(() => undefined);

      // Steady state until a relevant event forces a fresh exact attachment.
      let reattach = false;
      while (!reattach) {
        ctx.throwIfAborted();
        await sleep(POLL_INTERVAL_MS);
        if (recorderExit.resolved) {
          // Native Pulse can kill the old monitor before delivering the move
          // event. Re-attest the exact input instead of trusting event order.
          gate.open = false;
          const latest = await resolveAttachment(ctx);
          if (
            latest.input.index !== attachment.input.index ||
            latest.input.sink !== attachment.input.sink ||
            latest.monitor !== attachment.monitor
          ) {
            reattach = true;
            break;
          }
          await stderrReader;
          const exitCode = recorderExit.code;
          throw new SpectrumCaptureError(
            'process',
            `parec exited with code ${exitCode}${lastStderr !== '' ? `: ${lastStderr}` : ''}`,
          );
        }
        if (subscriberExit) {
          throw new SpectrumCaptureError('process', 'pactl subscribe exited unexpectedly');
        }
        if (subscription.error !== null) {
          throw new SpectrumCaptureError(
            'protocol',
            `pactl subscribe reader failed: ${subscription.error}`,
          );
        }
        if (subscription.overflow) {
          reattach = true; // too many events to inspect: re-resolve exactly
          break;
        }
        while (pending.length > 0) {
          const line = pending.shift() as string;
          if (isRelevantSubscribeLine(line, attachment.input.index, attachment.input.sink)) {
            reattach = true; // stop recording and re-read JSON before attaching
            break;
          }
        }
      }
      // Gate off BEFORE teardown so no stale PCM is forwarded after reset,
      // and retain+await both readers before emitting the reset.
      gate.open = false;
      await stopChild(recorder);
      await stopChild(subscriber);
      await Promise.allSettled([stdoutReader, stderrReader, subscriberReader]);
      emit({ kind: 'reset' });
      if (cycle + 1 >= MAX_REATTACH_CYCLES) {
        throw new SpectrumCaptureError(
          'process',
          `sink-input moved/removed ${MAX_REATTACH_CYCLES} times in a row; capture unavailable`,
        );
      }
    }
  });
}
