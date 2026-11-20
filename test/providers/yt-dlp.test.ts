import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killAllYtDlp, runYtDlp } from '../../src/providers/yt-dlp';

const bun = process.execPath;
const fixture = (name: string) => join(import.meta.dir, '..', 'fixtures', 'ytdlp', `${name}.ts`);

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'ytdlp-test-'));
}

/** Capture the rejection of a promise that must settle with an Error. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return new Error('expected the run to reject');
}

/**
 * Real child processes cannot be driven by fake timers: await the observable
 * start signal (the fixture writing its PID/marker file), with a bounded poll
 * so a dead child fails fast instead of hanging.
 */
async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 2000 && !existsSync(path); i++) {
    await Bun.sleep(5);
  }
  expect(existsSync(path)).toBe(true);
}

/** The fixture child must be dead and reaped once runYtDlp settles. */
function expectReaped(pid: number): void {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
}

afterAll(() => {
  killAllYtDlp();
});

describe('runYtDlp', () => {
  test('resolves captured stdout on success', async () => {
    const result = await runYtDlp(['--dump-json', 'ytsearch1', 'HELLO'], {
      timeoutMs: 10_000,
      command: [bun, fixture('search')],
    });
    expect(result.stdout).toContain('"id":"HELLO"');
    expect(result.stderr).toBe('');
  });

  test('drains both pipes fully on success', async () => {
    const result = await runYtDlp(['262144', '131072', '0'], {
      timeoutMs: 10_000,
      command: [bun, fixture('flood')],
    });
    expect(result.stdout.length).toBe(262144);
    expect(result.stderr.length).toBe(131072);
  });

  test('rejects nonzero exits with bounded stderr diagnostics', async () => {
    const err = await rejection(
      runYtDlp(['1024', '50000', '3'], { timeoutMs: 10_000, command: [bun, fixture('flood')] }),
    );
    expect(err.message).toContain('exited with code 3');
    expect(err.message).toContain('[+48000 chars]');
    expect(err.message.length).toBeLessThan(2200);
  });

  test('SIGKILLs and reaps the child on timeout', async () => {
    const dir = scratchDir();
    try {
      const pidFile = join(dir, 'child.pid');
      const err = await rejection(
        runYtDlp([pidFile], { timeoutMs: 300, command: [bun, fixture('hang')] }),
      );
      expect(err.message).toContain('timed out after 300ms');
      expectReaped(Number.parseInt(readFileSync(pidFile, 'utf-8'), 10));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('SIGKILLs and reaps the child on caller abort', async () => {
    const dir = scratchDir();
    try {
      const pidFile = join(dir, 'child.pid');
      const controller = new AbortController();
      const pending = runYtDlp([pidFile], {
        timeoutMs: 10_000,
        signal: controller.signal,
        command: [bun, fixture('hang')],
      });
      await waitForFile(pidFile);
      controller.abort();
      const err = await rejection(pending);
      expect(err.message).toContain('cancelled');
      expectReaped(Number.parseInt(readFileSync(pidFile, 'utf-8'), 10));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a pre-aborted signal without spawning', async () => {
    const dir = scratchDir();
    try {
      const marker = join(dir, 'marker');
      const controller = new AbortController();
      controller.abort();
      const err = await rejection(
        runYtDlp(['--marker', marker, 'HELLO'], {
          timeoutMs: 10_000,
          signal: controller.signal,
          command: [bun, fixture('search')],
        }),
      );
      expect(err.message).toContain('cancelled before start');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('killAllYtDlp terminates tracked children synchronously', async () => {
    const dir = scratchDir();
    try {
      const pidFile = join(dir, 'child.pid');
      const pending = runYtDlp([pidFile], { timeoutMs: 60_000, command: [bun, fixture('hang')] });
      await waitForFile(pidFile);
      killAllYtDlp();
      const err = await rejection(pending);
      expect(err.message).toMatch(/exited with code/);
      expectReaped(Number.parseInt(readFileSync(pidFile, 'utf-8'), 10));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runs concurrent children independently', async () => {
    const command = [bun, fixture('search')];
    const [first, second] = await Promise.all([
      runYtDlp(['FIRST'], { timeoutMs: 10_000, command }),
      runYtDlp(['SECOND'], { timeoutMs: 10_000, command }),
    ]);
    expect(first.stdout).toContain('"id":"FIRST"');
    expect(second.stdout).toContain('"id":"SECOND"');
  });
});
