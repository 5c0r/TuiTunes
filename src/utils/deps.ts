import { Logger } from './logger';

const MIN_MPV_VERSION = [0, 35] as const;

function printInstallInstructions(): void {
  const platform = process.platform;
  Logger.error('mpv is not installed.');

  if (platform === 'linux') {
    Logger.info('Install with: sudo pacman -S mpv  (Arch)');
    Logger.info('         or: sudo apt install mpv  (Debian/Ubuntu)');
  } else if (platform === 'darwin') {
    Logger.info('Install with: brew install mpv');
  } else {
    Logger.info('Install mpv from https://mpv.io/installation/');
  }
}

function parseMpvVersion(output: string): [number, number] | null {
  // mpv --version outputs: "mpv v0.41.0 ..." or "mpv 0.38.0 ..."
  const match = output.match(/mpv\s+v?(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

export function checkDependencies(): boolean {
  const which = Bun.spawnSync(['which', 'mpv']);
  if (which.exitCode !== 0) {
    printInstallInstructions();
    return false;
  }

  const versionResult = Bun.spawnSync(['mpv', '--version']);
  const versionOutput = versionResult.stdout.toString();
  const version = parseMpvVersion(versionOutput);

  if (!version) {
    Logger.error('Could not parse mpv version.');
    return false;
  }

  const [major, minor] = version;
  if (major < MIN_MPV_VERSION[0] ||
      (major === MIN_MPV_VERSION[0] && minor < MIN_MPV_VERSION[1])) {
    Logger.warn(
      `mpv ${major}.${minor} is too old. TuiTunes requires mpv >= ${MIN_MPV_VERSION[0]}.${MIN_MPV_VERSION[1]}.`
    );
    return false;
  }

  return true;
}
