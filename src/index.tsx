import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createStore } from 'jotai';
import { checkDependencies } from './utils/deps';
import { Logger } from './utils/logger';
import { loadConfig } from './utils/config';
import { PlayerController } from './player/controller';
import { playerVolumeAtom } from './store/player';
import { initProviders } from './providers/registry';
import { initDb } from './db/index';
import { App } from './app';

async function main(): Promise<void> {
  Logger.init();
  Logger.info('TuiTunes starting');
  initDb();

  // 1. Verify system dependencies
  if (!checkDependencies()) {
    process.stderr.write(
      'TuiTunes requires mpv to be installed. Check ~/.config/tuimusic/debug.log for details.\n'
    );
    process.exit(1);
  }

  // 2. Load user config
  const config = loadConfig();

  // 3. Create Jotai store (shared between controller and UI)
  const store = createStore();
  store.set(playerVolumeAtom, config.volume);

  // 4. Initialize providers (YouTube via yt-dlp)
  initProviders(config);

  // 5. Spawn mpv and connect IPC
  const controller = new PlayerController(store);
  try {
    await controller.init();
  } catch (err) {
    Logger.error(`Failed to initialize player: ${err}`);
    process.stderr.write(`Failed to start mpv: ${err}\n`);
    process.exit(1);
  }

  // 5. Set initial volume from config
  try {
    await controller.setVolume(config.volume);
  } catch {
    // Non-fatal — mpv starts at 100% by default
  }

  // 6. Create TUI renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // We handle Ctrl+C ourselves for cleanup
  });

  // 7. Render the app
  const root = createRoot(renderer);

  // 8. Cleanup on exit — must destroy renderer to restore terminal
  let exiting = false;
  async function cleanup(): Promise<void> {
    if (exiting) return;
    exiting = true;
    Logger.info('TuiTunes shutting down');
    root.unmount();
    await controller.destroy();
    renderer.destroy(); // restores alternate screen + raw mode
    process.exit(0);
  }

  root.render(<App store={store} controller={controller} onQuit={() => void cleanup()} />);

  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
