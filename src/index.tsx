#!/usr/bin/env bun
import { type CliRenderer, createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createStore } from 'jotai';
import { App } from './app';
import { type AppRuntime, createAppRuntime } from './application/runtime';
import { closeDb, getDb, initDb } from './db/index';
import { PlayerController } from './player/controller';
import { killAllTracked } from './player/process';
import { fetchLyrics } from './providers/lyrics';
import { resolvePlaybackSource } from './providers/media';
import { PodcastProvider } from './providers/podcast';
import { extractYouTubeSrt } from './providers/podcast-youtube';
import { fetchTranscriptUrl } from './providers/transcript';
import { getTranslationProvider } from './providers/translate';
import {
  getTranslatedTranscript,
  shutdownYouTubeClient,
  YouTubeProvider,
} from './providers/youtube';
import { killAllYtDlp } from './providers/yt-dlp';
import { createSpectrumCapturePort, killAllSpectrumCaptures } from './spectrum/capture';
import { configAtom } from './store/config';
import { playerVolumeAtom } from './store/player';
import { loadConfig } from './utils/config';
import { checkDependencies } from './utils/deps';
import { Logger } from './utils/logger';

process.once('exit', () => {
  killAllTracked();
  killAllYtDlp();
  killAllSpectrumCaptures();
});

async function main(): Promise<number> {
  let renderer: CliRenderer | null = null;
  let player: PlayerController | null = null;
  let runtime: AppRuntime | null = null;
  let unmount: (() => void) | null = null;
  let exitCode = 0;
  const quit = Promise.withResolvers<void>();
  let quitting = false;
  const requestQuit = () => {
    quitting = true;
    quit.resolve();
  };
  process.on('SIGINT', requestQuit);
  process.on('SIGTERM', requestQuit);
  try {
    Logger.init();
    if (!(await checkDependencies())) return 1;
    const config = loadConfig(),
      store = createStore();
    store.set(configAtom, config);
    store.set(playerVolumeAtom, config.volume);
    initDb();
    player = new PlayerController(store);
    await player.init();
    await player.setVolume(config.volume);
    if (!quitting) {
      runtime = createAppRuntime(store, {
        db: getDb(),
        player,
        music: new YouTubeProvider(),
        podcasts: new PodcastProvider(),
        resolve: resolvePlaybackSource,
        capture: createSpectrumCapturePort(),
        fetchMusicLyrics: fetchLyrics,
        fetchUrl: fetchTranscriptUrl,
        fetchYouTubeCaptions: extractYouTubeSrt,
        fetchNativeTranslation: getTranslatedTranscript,
        translationProvider: getTranslationProvider,
      });
      renderer = await createCliRenderer({ exitOnCtrlC: false });
      const root = createRoot(renderer);
      unmount = () => root.unmount();
      root.render(<App store={store} runtime={runtime} onQuit={requestQuit} />);
      await quit.promise;
    }
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`TuiTunes failed: ${error}\n`);
  } finally {
    // Abort SDK work before waiting for application owners to drain it.
    const sdkDrain = shutdownYouTubeClient().catch((error: unknown) => {
      exitCode = 1;
      process.stderr.write(`YouTube cleanup failed: ${error}\n`);
    });
    process.off('SIGINT', requestQuit);
    process.off('SIGTERM', requestQuit);
    for (const cleanup of [
      () => unmount?.(),
      () => runtime?.dispose(),
      () => sdkDrain,
      () => player?.destroy(),
      () => renderer?.destroy(),
      () => closeDb(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        exitCode = 1;
        process.stderr.write(`Cleanup failed: ${error}\n`);
      }
    }
  }
  return exitCode;
}
void main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`Fatal: ${error}\n`);
    process.exit(1);
  },
);
