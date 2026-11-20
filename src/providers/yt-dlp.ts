const DEFAULT_COMMAND: readonly string[] = ['yt-dlp'];
const MAX_STDERR_DIAGNOSTIC_CHARS = 2000;

export interface YtDlpRunOptions {
  /** Hard deadline for the child to exit, in milliseconds. */
  timeoutMs: number;
  /** Caller cancellation; aborting kills the child and rejects the promise. */
  signal?: AbortSignal;
  /**
   * Internal fixture seam: full argv prefix replacing ["yt-dlp"].
   * Not a public CLI option.
   */
  command?: readonly string[];
}

export interface YtDlpRunResult {
  stdout: string;
  stderr: string;
}

type YtDlpChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

function spawnPiped(argv: readonly string[]): YtDlpChild {
  return Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe' });
}

/** Live yt-dlp children, for the synchronous process-exit safety net. */
const trackedProcesses = new Set<YtDlpChild>();

function boundedStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= MAX_STDERR_DIAGNOSTIC_CHARS) return trimmed;
  const omitted = trimmed.length - MAX_STDERR_DIAGNOSTIC_CHARS;
  return `${trimmed.slice(0, MAX_STDERR_DIAGNOSTIC_CHARS)}… [+${omitted} chars]`;
}

/**
 * Run yt-dlp with a hard exit deadline and optional caller cancellation.
 * Both output pipes are drained concurrently; a nonzero exit rejects with a
 * bounded stderr diagnostic. On timeout, cancellation, or stream-read failure
 * the owned child is SIGKILLed and reaped before the promise settles.
 */
export async function runYtDlp(
  args: readonly string[],
  options: YtDlpRunOptions,
): Promise<YtDlpRunResult> {
  const argv = [...(options.command ?? DEFAULT_COMMAND), ...args];
  if (options.signal?.aborted) {
    throw new Error(`yt-dlp cancelled before start: ${argv.join(' ')}`);
  }

  const proc = spawnPiped(argv);
  trackedProcesses.add(proc);

  // Drain both pipes concurrently so a chatty child cannot deadlock.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  // Failure paths settle before the reads complete; keep them handled.
  void stdoutPromise.catch(() => {});
  void stderrPromise.catch(() => {});

  const { promise, resolve, reject } = Promise.withResolvers<YtDlpRunResult>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const cleanup = () => {
    clearTimeout(timer);
    if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);
    trackedProcesses.delete(proc);
  };

  const fail = async (err: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      proc.kill(9);
    } catch {
      /* already dead */
    }
    try {
      await proc.exited;
    } catch {
      /* already reaped */
    }
    reject(err);
  };

  onAbort = () => {
    void fail(new Error(`yt-dlp cancelled: ${argv.join(' ')}`));
  };

  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      void fail(new Error(`yt-dlp timed out after ${options.timeoutMs}ms: ${argv.join(' ')}`));
    }, options.timeoutMs);
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });

  void (async () => {
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        proc.exited,
      ]);
      if (settled) return;
      settled = true;
      cleanup();
      if (exitCode !== 0) {
        reject(new Error(`yt-dlp exited with code ${exitCode}: ${boundedStderr(stderr)}`));
        return;
      }
      resolve({ stdout, stderr });
    } catch (err) {
      await fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return promise;
}

/** Synchronously SIGKILL every tracked yt-dlp child; process-exit safety net. */
export function killAllYtDlp(): void {
  for (const proc of trackedProcesses) {
    try {
      proc.kill(9);
    } catch {
      /* already dead */
    }
  }
  trackedProcesses.clear();
}
