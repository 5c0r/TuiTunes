import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('preload protects an outer HOME from config, DB and logger writes', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'outer-home-'));
  try {
    const dir = join(outer, '.config', 'tuimusic');
    mkdirSync(dir, { recursive: true });
    const names = ['config.json', 'tuimusic.db', 'debug.log'];
    for (const name of names) writeFileSync(join(dir, name), `sentinel:${name}`);
    const child = Bun.spawn([process.execPath, 'test', 'test/fixtures/isolation-child.test.ts'], {
      env: { ...process.env, HOME: outer, TUITUNES_ISOLATION_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, output: code ? stdout + stderr : '' }).toEqual({ code: 0, output: '' });
    for (const name of names)
      expect(readFileSync(join(dir, name), 'utf8')).toBe(`sentinel:${name}`);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
