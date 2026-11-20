import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'tuitunes-test-'));
for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
  process.env[name] = name === 'HOME' ? sandbox : join(sandbox, name.toLowerCase());
  mkdirSync(process.env[name]!, { recursive: true });
}
mkdirSync(join(sandbox, '.config', 'tuimusic'), { recursive: true });
process.once('exit', () => rmSync(sandbox, { recursive: true, force: true }));
