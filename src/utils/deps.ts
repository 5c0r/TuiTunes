import { readFileSync } from 'node:fs';
import { Logger } from './logger';

const MIN_MPV_VERSION = [0, 35] as const;

export interface DependencyProbe {
  which(name: 'mpv' | 'yt-dlp'): string | null;
  version(absolutePath: string): Promise<string>;
}
const systemProbe: DependencyProbe = {
  which: (name) => Bun.which(name),
  async version(absolutePath) {
    const child = Bun.spawn([absolutePath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    const [code, output, diagnostics] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0)
      throw new Error(`${absolutePath} --version failed: ${diagnostics.slice(0, 1024)}`);
    return output;
  },
};

function parseMpvVersion(output: string): [number, number] | null {
  // mpv --version outputs: "mpv v0.41.0 ..." or "mpv 0.38.0 ..."
  const match = output.match(/mpv\s+v?(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

export async function checkDependencies(probe: DependencyProbe = systemProbe): Promise<boolean> {
  let mpvOutput = '';
  for (const name of ['mpv', 'yt-dlp'] as const) {
    const binary = probe.which(name);
    if (!binary) {
      const message = `${name} is required. Install mpv and yt-dlp with your system package manager.`;
      Logger.error(message);
      process.stderr.write(`${message}\n`);
      return false;
    }
    try {
      const output = await probe.version(binary);
      if (name === 'mpv') mpvOutput = output;
    } catch (error) {
      Logger.error(`Cannot execute ${name}: ${error}`);
      process.stderr.write(`Cannot execute ${name}: ${error}\n`);
      return false;
    }
  }
  const version = parseMpvVersion(mpvOutput);
  if (
    !version ||
    version[0] < MIN_MPV_VERSION[0] ||
    (version[0] === 0 && version[1] < MIN_MPV_VERSION[1])
  ) {
    Logger.error('TuiTunes requires mpv >= 0.35 with a readable version.');
    return false;
  }

  // WSL2 audio guidance
  if (isWSL()) {
    Logger.info('WSL2 detected. Audio requires WSLg (Win11 22H2+) or manual PulseAudio setup.');
    Logger.info('If no sound: ensure WSLg is working or configure PulseAudio forwarding.');
  }

  return true;
}

/** Detect WSL2 environment via /proc/version. */
export function isWSL(): boolean {
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}
