/**
 * Linux PipeWire capture adapter (feature 15).
 *
 * Graph-based, policy-free capture: a bounded `pw-dump --monitor` watcher
 * resolves exactly one Stream/Output/Audio node belonging to this run's
 * generated mpv client name, `pw-record --target=0` runs autoconnect-free and
 * passive, and only explicit `pw-link --passive` player→recorder edges are
 * added. Audible edges are never touched; there is no sink-monitor or
 * system-mix fallback, and no best-name guessing among multiple matches.
 */
import {
  pumpBytes,
  readLines,
  runCaptureBackend,
  runTool,
  sleep,
  stopChild,
  waitExit,
  type CaptureEnv,
  type CaptureRunContext,
} from './capture';
import {
  CAPTURE_SAMPLE_RATE,
  SpectrumCaptureError,
  type CaptureEvent,
  type CaptureTarget,
} from './types';

/** Cap for one in-flight pw-dump graph message before it is rejected. */
export const PW_GRAPH_MESSAGE_CAP = 8 * 1024 * 1024;
/** Aggregate cap on retained graph objects (nodes+ports+links); fail closed. */
export const PW_GRAPH_OBJECT_CAP = 20_000;
const POLL_INTERVAL_MS = 50;
// ---------------------------------------------------------------------------
// Streaming JSON-array parser for pw-dump --monitor output
// ---------------------------------------------------------------------------

/**
 * Incremental splitter for consecutive top-level JSON arrays (pw-dump emits a
 * full dump first, then fragmented change arrays, possibly split across
 * stdout chunk boundaries). Rejects malformed or oversized data.
 */
export class JsonArrayStream {
  private readonly onArray: (entries: unknown[]) => void;
  private readonly maxBytes: number;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private depth = 0;
  private start = 0;
  private scan = 0;
  private inString = false;
  private escaped = false;

  constructor(onArray: (entries: unknown[]) => void, maxBytes = PW_GRAPH_MESSAGE_CAP) {
    this.onArray = onArray;
    this.maxBytes = maxBytes;
  }

  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.buffer.length > this.maxBytes) {
      throw new SpectrumCaptureError('protocol', `pw-dump message exceeds ${this.maxBytes} byte bound`);
    }
    while (this.scan < this.buffer.length) {
      const ch = this.buffer[this.scan];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === '\\') this.escaped = true;
        else if (ch === '"') this.inString = false;
        this.scan++;
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        this.scan++;
        continue;
      }
      if (ch === '[') {
        if (this.depth === 0) this.start = this.scan;
        this.depth++;
        this.scan++;
        continue;
      }
      if (ch === ']') {
        if (this.depth === 0) {
          throw new SpectrumCaptureError('protocol', 'unbalanced bracket in pw-dump output');
        }
        this.depth--;
        this.scan++;
        if (this.depth === 0) {
          this.emitArray(this.buffer.slice(this.start, this.scan));
          this.buffer = this.buffer.slice(this.scan);
          this.scan = 0;
        }
        continue;
      }
      if (this.depth === 0 && ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') {
        throw new SpectrumCaptureError('protocol', `unexpected ${JSON.stringify(ch)} outside pw-dump array`);
      }
      this.scan++;
    }
  }

  private emitArray(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SpectrumCaptureError('protocol', `pw-dump array is not valid JSON: ${error}`);
    }
    if (!Array.isArray(parsed)) {
      throw new SpectrumCaptureError('protocol', 'pw-dump message is not a JSON array');
    }
    this.onArray(parsed);
  }
}

// ---------------------------------------------------------------------------
// Bounded graph model
// ---------------------------------------------------------------------------

interface GraphNode {
  id: number;
  name: string;
  appName: string;
  pid: number | null;
  mediaClass: string;
}

interface GraphPort {
  id: number;
  nodeId: number;
  direction: 'in' | 'out' | 'unknown';
  channel: string | null;
}

interface GraphLink {
  id: number;
  outputNode: number;
  outputPort: number;
  inputNode: number;
  inputPort: number;
}

function propString(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  if (typeof value === 'string' && value.length > 512) {
    throw new SpectrumCaptureError('protocol', `PipeWire graph property ${key} exceeded its retained string bound`);
  }
  return typeof value === 'string' ? value : '';
}

function propInt(props: Record<string, unknown>, key: string): number | null {
  const value = props[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

function extractProps(info: unknown): Record<string, unknown> {
  if (info == null || typeof info !== 'object') return {};
  const props = (info as Record<string, unknown>).props;
  if (props != null && typeof props === 'object') return props as Record<string, unknown>;
  return {};
}

/** Bounded view of the relevant PipeWire graph (nodes, ports, links). */
export class PipeWireGraph {
  readonly nodes = new Map<number, GraphNode>();
  readonly ports = new Map<number, GraphPort>();
  readonly links = new Map<number, GraphLink>();

  /** Apply one pw-dump change array: upserts carry info, bare objects remove. */
  applyArray(entries: readonly unknown[]): void {
    for (const raw of entries) {
      if (raw == null || typeof raw !== 'object') {
        throw new SpectrumCaptureError('protocol', 'pw-dump entry is not an object');
      }
      const entry = raw as Record<string, unknown>;
      const id = entry.id;
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
        throw new SpectrumCaptureError('protocol', 'pw-dump entry has no integer id');
      }
      const type = typeof entry.type === 'string' ? entry.type : '';
      if (entry.info === undefined || entry.info === null) {
        this.remove(id);
        continue;
      }
      const props = extractProps(entry.info);
      if (type.endsWith(':Node')) {
        this.nodes.set(id, {
          id,
          name: propString(props, 'node.name'),
          appName: propString(props, 'application.name'),
          pid: propInt(props, 'application.process.id') ?? propInt(props, 'application.process.pid'),
          mediaClass: propString(props, 'media.class'),
        });
      } else if (type.endsWith(':Port')) {
        const info = entry.info as Record<string, unknown>;
        const rawDirection =
          propString(props, 'port.direction') ||
          (info.direction === 'in' || info.direction === 'out' ? String(info.direction) : '');
        this.ports.set(id, {
          id,
          nodeId: propInt(props, 'node.id') ?? -1,
          direction: rawDirection === 'out' ? 'out' : rawDirection === 'in' ? 'in' : 'unknown',
          channel: propString(props, 'audio.channel') || null,
        });
      } else if (type.endsWith(':Link')) {
        this.links.set(id, {
          id,
          outputNode: propInt(props, 'link.output.node') ?? -1,
          outputPort: propInt(props, 'link.output.port') ?? -1,
          inputNode: propInt(props, 'link.input.node') ?? -1,
          inputPort: propInt(props, 'link.input.port') ?? -1,
        });
      }
      // Other object types (modules, clients, factories) are irrelevant here.
    }
    if (this.nodes.size + this.ports.size + this.links.size > PW_GRAPH_OBJECT_CAP) {
      throw new SpectrumCaptureError(
        'protocol',
        `PipeWire graph exceeded ${PW_GRAPH_OBJECT_CAP} retained objects; refusing unbounded state`,
      );
    }
  }

  private remove(id: number): void {
    this.nodes.delete(id);
    this.ports.delete(id);
    this.links.delete(id);
  }

  /** Player candidates: output streams tagged with this run's client name. */
  playerCandidates(clientName: string, pid: number): GraphNode[] {
    const matches: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.mediaClass !== 'Stream/Output/Audio') continue;
      if (node.name !== clientName && node.appName !== clientName) continue;
      // Trust an actual application PID when the graph supplies one; a Pulse
      // proxy daemon's PID must never be confused with mpv's.
      if (node.pid !== null && node.pid !== pid) continue;
      matches.push(node);
    }
    return matches;
  }

  portsOf(nodeId: number, direction: 'in' | 'out'): GraphPort[] {
    const found: GraphPort[] = [];
    for (const port of this.ports.values()) {
      if (port.nodeId === nodeId && port.direction === direction) found.push(port);
    }
    return found.sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

interface PipeWireProbe {
  available: boolean;
  reason: string;
}

/** Cheap, bounded probe: PipeWire tools ≥1.0 must exist for the graph route. */
export async function pipeWireToolsAvailable(
  env: CaptureEnv,
  options: { signal?: AbortSignal } = {},
): Promise<PipeWireProbe> {
  try {
    const { code, stdout, stderr } = await runTool(env, ['pw-dump', '--version'], { signal: options.signal });
    const text = `${stdout}\n${stderr}`;
    // Real tools print "%s\nCompiled with libpipewire X.Y\nLinked with
    // libpipewire X.Y"; the legacy "pw-dump version X" spelling is accepted too.
    const match = /libpipewire[^\d]*(\d+)\.|pw-dump\s+version\s+(\d+)\./.exec(text);
    if (match === null) {
      return { available: false, reason: `pw-dump did not report a version (${text.trim().slice(0, 80)})` };
    }
    const major = Number(match[1] ?? match[2]);
    if (major < 1) {
      return { available: false, reason: `pw-dump version ${major}.x is older than 1.0` };
    }
    if (code !== 0) {
      return { available: false, reason: `pw-dump --version exited with code ${code}` };
    }
    return { available: true, reason: `pw-dump (libpipewire ${major}.x)` };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

interface WatcherState {
  graph: PipeWireGraph;
  version: number;
  error: unknown | null;
  exited: boolean;
  /** Publishing gate: any graph update closes it synchronously. */
  gate: { open: boolean } | null;
}

function startWatcher(ctx: CaptureRunContext): WatcherState {
  const watcher = ctx.spawn(['pw-dump', '--monitor', '--no-colors']);
  const state: WatcherState = {
    graph: new PipeWireGraph(),
    version: 0,
    error: null,
    exited: false,
    gate: null,
  };
  const stream = new JsonArrayStream((entries) => {
    // Close the gate BEFORE applying the update: no PCM is published against
    // a graph state that has not been re-attested.
    if (state.gate !== null) state.gate.open = false;
    state.graph.applyArray(entries);
    state.version++;
  });
  void pumpBytes(watcher.stdout, (chunk) => stream.push(chunk)).catch((error) => {
    state.error = error;
  });
  void readLines(watcher.stderr, () => {}).catch(() => undefined);
  void watcher.exited.finally(() => {
    state.exited = true;
  });
  return state;
}

function watcherFailure(state: WatcherState): SpectrumCaptureError | null {
  if (state.error instanceof SpectrumCaptureError) return state.error;
  if (state.error !== null) {
    return new SpectrumCaptureError('protocol', `pw-dump watcher failed: ${state.error}`);
  }
  if (state.exited) {
    return new SpectrumCaptureError(
      'process',
      state.version === 0
        ? 'pw-dump --monitor exited before producing graph data'
        : 'pw-dump --monitor exited unexpectedly',
    );
  }
  return null;
}

/** Resolve exactly one player node within the startup budget. */
async function resolvePlayerNode(
  ctx: CaptureRunContext,
  state: WatcherState,
): Promise<GraphNode> {
  const deadline = ctx.now() + ctx.startupMs;
  for (;;) {
    ctx.throwIfAborted();
    const failure = watcherFailure(state);
    if (failure !== null) throw failure;
    const { clientName, pid } = ctx.target.process;
    const matches = state.graph.playerCandidates(clientName, pid);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new SpectrumCaptureError(
        'target-ambiguous',
        `multiple PipeWire output nodes match ${clientName} (${matches.length}); refusing to guess`,
      );
    }
    if (ctx.now() >= deadline) {
      throw new SpectrumCaptureError(
        'target-not-found',
        `no PipeWire Stream/Output/Audio node for ${clientName} within ${ctx.startupMs}ms`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Player output ports with explicit channel labels; no stereo assumption. */
function playerOutputPorts(graph: PipeWireGraph, node: GraphNode): GraphPort[] {
  const ports = graph.portsOf(node.id, 'out');
  if (ports.length < 1 || ports.length > 8) {
    throw new SpectrumCaptureError(
      'format',
      `player node exposes ${ports.length} output ports; only 1..8 are supported`,
    );
  }
  const labels: string[] = [];
  for (const port of ports) {
    if (port.channel === null || port.channel.length === 0) {
      throw new SpectrumCaptureError('format', `player output port ${port.id} has no audio.channel label`);
    }
    labels.push(port.channel);
  }
  return ports;
}

async function waitRecorderPorts(
  ctx: CaptureRunContext,
  state: WatcherState,
  recorderName: string,
  channelCount: number,
): Promise<GraphPort[]> {
  const deadline = ctx.now() + ctx.startupMs;
  for (;;) {
    ctx.throwIfAborted();
    const failure = watcherFailure(state);
    if (failure !== null) throw failure;
    const recorderNode = [...state.graph.nodes.values()].find((node) => node.name === recorderName);
    if (recorderNode !== undefined) {
      const ports = state.graph.portsOf(recorderNode.id, 'in');
      if (ports.length === channelCount) return ports;
    }
    if (ctx.now() >= deadline) {
      throw new SpectrumCaptureError('process', `recorder ${recorderName} did not expose ${channelCount} input ports`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Attest the recorder's only inbound edges are our player→recorder passive
 * links: every capture input linked, nothing extra, nothing from elsewhere.
 */
function attestLinks(
  graph: PipeWireGraph,
  captureNode: number,
  capturePorts: readonly GraphPort[],
  playerNode: number,
  playerPorts: readonly GraphPort[],
): boolean {
  const expectedInputs = new Set(capturePorts.map((port) => port.id));
  const expectedOutputs = new Set(playerPorts.map((port) => port.id));
  const inbound = new Map<number, GraphLink[]>();
  for (const link of graph.links.values()) {
    if (!expectedInputs.has(link.inputPort)) continue;
    const list = inbound.get(link.inputPort) ?? [];
    list.push(link);
    inbound.set(link.inputPort, list);
  }
  if (inbound.size !== expectedInputs.size) return false;
  for (const links of inbound.values()) {
    if (links.length !== 1) return false;
    const link = links[0];
    if (!expectedOutputs.has(link.outputPort)) return false;
    if (link.outputNode !== playerNode || link.inputNode !== captureNode) return false;
  }
  return true;
}

async function linkPassive(
  ctx: CaptureRunContext,
  playerPort: GraphPort,
  capturePort: GraphPort,
): Promise<void> {
  const child = ctx.spawn(['pw-link', '--passive', String(playerPort.id), String(capturePort.id)]);
  void pumpBytes(child.stdout, () => {}).catch(() => undefined);
  void pumpBytes(child.stderr, () => {}).catch(() => undefined);
  const { code, timedOut } = await waitExit(child, ctx.startupMs);
  if (timedOut) {
    await stopChild(child);
    throw new SpectrumCaptureError('attestation', 'pw-link did not exit');
  }
  if (code !== 0) {
    throw new SpectrumCaptureError(
      'attestation',
      `pw-link --passive ${playerPort.id} ${capturePort.id} exited with code ${code}`,
    );
  }
}


function recorderNodeFor(graph: PipeWireGraph, recorderName: string): GraphNode | undefined {
  return [...graph.nodes.values()].find((node) => node.name === recorderName);
}

/**
 * PipeWire graph capture run. Restarts the recorder (never a fallback source)
 * when the target node, its ports or the channel layout change.
 */
export async function runPipeWireCapture(
  target: CaptureTarget,
  signal: AbortSignal,
  emit: (event: CaptureEvent) => void,
  env: CaptureEnv,
): Promise<void> {
  await runCaptureBackend('pipewire', target, signal, emit, env, async (ctx) => {
    const state = startWatcher(ctx);
    try {
      for (;;) {
        ctx.throwIfAborted();
        const node = await resolvePlayerNode(ctx, state);
        const playerPorts = playerOutputPorts(state.graph, node);
        const channels = playerPorts.length;
        const recorderName = `TuiTunes-spectrum-${crypto.randomUUID()}`;
        const properties = JSON.stringify({
          'node.name': recorderName,
          'node.autoconnect': false,
          'node.passive': true,
          'media.name': 'TuiTunes spectrum analysis',
        });
        const recorder = ctx.spawn([
          'pw-record',
          '--target=0',
          '--raw',
          '--format=f32',
          `--rate=${CAPTURE_SAMPLE_RATE}`,
          `--channels=${channels}`,
          `--channel-map=${playerPorts.map((port) => port.channel).join(',')}`,
          `--properties=${properties}`,
          '-',
        ]);
        const recorderExit: { resolved: boolean; code: number | null } = { resolved: false, code: null };
        void recorder.exited.then(
          (code) => {
            recorderExit.code = code;
            recorderExit.resolved = true;
          },
          () => {
            recorderExit.resolved = true;
          },
        );
        let lastStderr = '';
        void readLines(recorder.stderr, (line) => {
          lastStderr = line;
        }).catch(() => undefined);
        const gate = { open: false };
        state.gate = gate; // any graph update closes this synchronously
        void pumpBytes(recorder.stdout, (chunk) => {
          // PCM is published only while the re-attested gate is open; startup
          // and mid-update bytes are discarded, never published.
          if (gate.open) emit({ kind: 'pcm', bytes: chunk });
        }).catch(() => undefined);

        const capturePorts = await waitRecorderPorts(ctx, state, recorderName, channels);
        const recorderNode = recorderNodeFor(state.graph, recorderName);
        if (recorderNode === undefined) {
          throw new SpectrumCaptureError('process', `recorder node ${recorderName} vanished from the graph`);
        }
        for (let i = 0; i < channels; i++) {
          await linkPassive(ctx, playerPorts[i], capturePorts[i]);
        }
        const deadline = ctx.now() + ctx.startupMs;
        for (;;) {
          ctx.throwIfAborted();
          const failure = watcherFailure(state);
          if (failure !== null) throw failure;
          if (attestLinks(state.graph, recorderNode.id, capturePorts, node.id, playerPorts)) break;
          if (ctx.now() >= deadline) {
            throw new SpectrumCaptureError(
              'attestation',
              `recorder inputs were not linked solely to the player node within ${ctx.startupMs}ms`,
            );
          }
          await sleep(POLL_INTERVAL_MS);
        }
        emit({ kind: 'format', format: { sampleRate: CAPTURE_SAMPLE_RATE, channels, encoding: 'f32le' } });
        gate.open = true;
        let attestVersion = state.version;

        // Steady state: every graph update synchronously closed the gate;
        // re-attest exact identity, ports and links before reopening it.
        let restart = false;
        while (!restart) {
          ctx.throwIfAborted();
          await sleep(POLL_INTERVAL_MS);
          const failure = watcherFailure(state);
          if (failure !== null) throw failure;
          if (recorderExit.resolved) {
            const code = recorderExit.code;
            throw new SpectrumCaptureError(
              'process',
              `pw-record exited with code ${code}${lastStderr !== '' ? `: ${lastStderr}` : ''}`,
            );
          }
          if (state.version !== attestVersion) {
            gate.open = false;
            attestVersion = state.version;
            // Exact identity + uniqueness first: another matching node means
            // this graph is ambiguous, and a missing node means restart.
            const candidates = state.graph.playerCandidates(
              ctx.target.process.clientName,
              ctx.target.process.pid,
            );
            if (candidates.length !== 1 || candidates[0]?.id !== node.id) {
              if (state.graph.nodes.get(node.id) === undefined) {
                restart = true; // target removal: resolve a fresh unique target
                break;
              }
              throw new SpectrumCaptureError(
                'target-ambiguous',
                `player node identity changed during capture (candidates: ${candidates.length})`,
              );
            }
            const currentPorts = state.graph.portsOf(node.id, 'out');
            if (
              currentPorts.length !== playerPorts.length ||
              currentPorts.some((port, i) => port.id !== playerPorts[i].id || port.channel !== playerPorts[i].channel)
            ) {
              restart = true; // channel-layout change: renegotiate the recorder
              break;
            }
            // Wrong-source or missing links terminate the run immediately —
            // they are never tolerated until the next poll.
            if (!attestLinks(state.graph, recorderNode.id, capturePorts, node.id, playerPorts)) {
              throw new SpectrumCaptureError(
                'attestation',
                'recorder links no longer match exactly the player node; terminating capture',
              );
            }
            gate.open = true; // re-attested: publish again
          }
        }
        gate.open = false;
        emit({ kind: 'reset' });
        await stopChild(recorder); // removes its ports and private capture links
      }
    } finally {
      // Watcher belongs to this run; ctx.stopOwned() also covers it.
      await ctx.stopOwned();
    }
  });
}
