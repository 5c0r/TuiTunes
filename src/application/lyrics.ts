import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { Store } from 'jotai/vanilla/store';
import { getTranslation, saveTranslation, type TranslationCacheKey } from '../db/queries';
import { type fetchLyrics, type LyricsResult, mergeTranslatedLines } from '../providers/lyrics';
import { mediaKey } from '../providers/media';
import type { extractYouTubeSrt } from '../providers/podcast-youtube';
import { parseSrt } from '../providers/subtitle-parser';
import type { fetchTranscriptUrl } from '../providers/transcript';
import { type getTranslationProvider, normalizeLingvaInstance } from '../providers/translate';
import { alignNativeTranslation, type getTranslatedTranscript } from '../providers/youtube';
import { configAtom } from '../store/config';

import {
  type LyricsDocument,
  lyricsDocumentAtom,
  lyricsErrorAtom,
  lyricsLoadingAtom,
  lyricsTranslationAtom,
  type TranscriptSelection,
  transcriptSourceAtom,
  translationEnabledAtom,
  translationLoadingAtom,
} from '../store/lyrics';
import { playerPlaybackAtom } from '../store/player';
import type { TuiTunesConfig } from '../utils/config';
import { Logger } from '../utils/logger';

export interface LyricsDependencies {
  db: Database;
  fetchMusicLyrics: typeof fetchLyrics;
  fetchUrl: typeof fetchTranscriptUrl;
  fetchYouTubeCaptions: typeof extractYouTubeSrt;
  fetchNativeTranslation: typeof getTranslatedTranscript;
  translationProvider: typeof getTranslationProvider;
}
export interface LyricsSession {
  reload(): Promise<void>;
  setTranscriptSource(source: TranscriptSelection): Promise<void>;
  dispose(): Promise<void>;
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Only translation-affecting config fields restart translation. Display-only
 * flags (volume, ASCII, reduced motion, spectrum) never clear lyrics or
 * translations, abort their in-flight request, or trigger provider calls.
 */
function translationFingerprint(config: TuiTunesConfig): string {
  return JSON.stringify([
    config.translationLanguage,
    config.translationProvider,
    config.deeplApiKey,
    config.lingvaInstance,
  ]);
}
export function createLyricsSession(store: Store, deps: LyricsDependencies): LyricsSession {
  let disposed = false,
    sourceGeneration = 0,
    translationGeneration = 0,
    resetting = false;
  let sourceController: AbortController | null = null,
    translationController: AbortController | null = null;
  let sourceJob: Promise<void> = Promise.resolve();
  let playbackIdentity = '';
  let configFingerprint = translationFingerprint(store.get(configAtom));
  const childJobs = new Set<Promise<void>>();
  function error(value: unknown): void {
    const message = value instanceof Error ? value.message : String(value);
    store.set(lyricsErrorAtom, message);
    Logger.warn(`Lyrics: ${message}`);
  }
  function cancelTranslation(): void {
    ++translationGeneration;
    translationController?.abort();
    translationController = null;
    store.set(lyricsTranslationAtom, null);
    store.set(translationLoadingAtom, false);
  }
  async function translate(document: LyricsDocument): Promise<void> {
    cancelTranslation();
    if (disposed || !store.get(translationEnabledAtom)) return;
    const generation = translationGeneration;
    const controller = new AbortController();
    translationController = controller;
    const config = store.get(configAtom),
      target = store.get(playerPlaybackAtom);
    const targetLang = config.translationLanguage || 'en';
    const provider = deps.translationProvider(config.translationProvider, {
      deeplApiKey: config.deeplApiKey ?? undefined,
      lingvaInstance: config.lingvaInstance ?? undefined,
    });
    const sourceLang =
      document.original.originalLanguage || (provider.id === 'mymemory' ? 'en' : 'auto');
    const current = () =>
      !disposed &&
      !controller.signal.aborted &&
      generation === translationGeneration &&
      store.get(lyricsDocumentAtom) === document &&
      store.get(translationEnabledAtom);
    const makeKey = (engine: string, language: string): TranslationCacheKey => ({
      mediaKey: document.mediaKey,
      sourceKey: document.sourceKey,
      contentSha256: document.contentHash,
      requestSha256: hash([
        engine,
        language,
        targetLang,
        engine === 'lingva' ? normalizeLingvaInstance(config.lingvaInstance) : null,
      ]),
      translationProvider: engine,
      sourceLang: language,
      targetLang,
    });
    function commit(key: TranslationCacheKey, lines: string[], cache: boolean): void {
      if (!current()) return;
      if (cache) saveTranslation(deps.db, key, lines);
      store.set(lyricsTranslationAtom, {
        documentKey: JSON.stringify([document.mediaKey, document.contentHash]),
        targetLang,
        engineKey: key.requestSha256,
        lines,
      });
    }
    store.set(translationLoadingAtom, true);
    try {
      if (
        target?.source.kind === 'youtube' &&
        document.original.synced &&
        document.original.source === 'youtube' &&
        document.original.sourceUrl &&
        new URL(document.original.sourceUrl).searchParams.get('v') === target.source.videoId
      ) {
        const key = makeKey('youtube', document.original.originalLanguage || 'auto');
        const cached = getTranslation(deps.db, key, document.original.lines.length);
        if (cached) {
          commit(key, cached, false);
          return;
        }
        const native = await deps.fetchNativeTranslation(
          target.source.videoId,
          targetLang,
          controller.signal,
        );
        if (!current()) return;
        const aligned =
          native &&
          alignNativeTranslation(document.original.lines, native)?.map(
            (line) => line.translatedText ?? '',
          );
        if (aligned) {
          commit(key, aligned, true);
          return;
        }
      }
      const key = makeKey(provider.id, sourceLang);
      const cached = getTranslation(deps.db, key, document.original.lines.length);
      if (cached) {
        commit(key, cached, false);
        return;
      }
      const texts = document.original.lines
        .filter((line) => line.text.trim())
        .map((line) => line.text);
      const translated = await provider.translateBatch(
        texts,
        targetLang,
        sourceLang,
        controller.signal,
      );
      if (!current()) return;
      const merged = mergeTranslatedLines(document.original.lines, translated);
      commit(
        key,
        merged.map((line) => line.translatedText ?? ''),
        true,
      );
    } catch (value) {
      if (current()) error(value);
    } finally {
      if (current()) store.set(translationLoadingAtom, false);
    }
  }
  function startTranslation(): void {
    const document = store.get(lyricsDocumentAtom);
    if (!document) {
      cancelTranslation();
      return;
    }
    void translate(document).catch((value) => {
      if (!disposed) error(value);
    });
  }
  function reload(): Promise<void> {
    ++sourceGeneration;
    const generation = sourceGeneration;
    sourceController?.abort();
    cancelTranslation();
    const controller = new AbortController();
    sourceController = controller;
    const target = store.get(playerPlaybackAtom),
      selection = store.get(transcriptSourceAtom);
    store.set(lyricsDocumentAtom, null);
    store.set(lyricsErrorAtom, null);
    store.set(lyricsLoadingAtom, !!target);
    if (!target || disposed) return Promise.resolve();
    const current = () =>
      !disposed && generation === sourceGeneration && !controller.signal.aborted;
    sourceJob = (async () => {
      try {
        let data: LyricsResult | null;
        if (selection.kind === 'custom') {
          data = {
            lines: await deps.fetchUrl(selection.url, controller.signal),
            synced: true,
            source: 'custom',
            sourceUrl: selection.url,
          };
        } else if (target.track.source?.kind !== 'podcast') {
          data = await deps.fetchMusicLyrics(target.track, controller.signal);
        } else if (target.source.kind === 'youtube') {
          const captions = await deps.fetchYouTubeCaptions(
            target.source.videoId,
            controller.signal,
          );
          data = captions
            ? {
                lines: parseSrt(captions.srt),
                synced: true,
                source: 'youtube',
                sourceUrl: captions.videoUrl,
              }
            : null;
        } else if (target.source.transcriptUrl) {
          data = {
            lines: await deps.fetchUrl(target.source.transcriptUrl, controller.signal),
            synced: true,
            source: 'rss',
            sourceUrl: target.source.transcriptUrl,
          };
        } else data = null;
        if (!current()) return;
        if (data?.lines.length) {
          const sourceKey = JSON.stringify([
            data.source,
            data.sourceUrl ??
              (target.source.kind === 'youtube' ? target.source.videoId : target.source.url),
          ]);
          const document: LyricsDocument = {
            mediaKey: mediaKey(target.track),
            sourceKey,
            contentHash: hash([
              sourceKey,
              data.synced,
              data.lines.map((line) => [Math.round(line.time * 1000), line.text]),
            ]),
            original: data,
          };
          store.set(lyricsDocumentAtom, document);
          startTranslation();
        }
      } catch (value) {
        if (current()) error(value);
      } finally {
        if (current()) store.set(lyricsLoadingAtom, false);
      }
    })();
    if (selection.kind === 'custom' || target.track.source?.kind === 'podcast') {
      const job = sourceJob;
      childJobs.add(job);
      void job.finally(() => childJobs.delete(job));
    }
    return sourceJob;
  }
  function playbackChanged(): void {
    const target = store.get(playerPlaybackAtom);
    const identity = target
      ? JSON.stringify([target.requestId, mediaKey(target.track), target.source])
      : '';
    if (identity === playbackIdentity) return;
    playbackIdentity = identity;
    resetting = true;
    store.set(transcriptSourceAtom, { kind: 'auto' });
    resetting = false;
    void reload();
  }
  const unsubscribers = [
    store.sub(playerPlaybackAtom, playbackChanged),
    store.sub(transcriptSourceAtom, () => {
      if (!resetting) void reload();
    }),
    store.sub(translationEnabledAtom, startTranslation),
    store.sub(configAtom, () => {
      const fingerprint = translationFingerprint(store.get(configAtom));
      if (fingerprint === configFingerprint) return;
      configFingerprint = fingerprint;
      startTranslation();
    }),
  ];
  playbackChanged();
  return {
    reload,
    setTranscriptSource(source) {
      const normalized: TranscriptSelection =
        source.kind === 'custom' && !source.url.trim() ? { kind: 'auto' } : source;
      if (JSON.stringify(store.get(transcriptSourceAtom)) === JSON.stringify(normalized))
        return reload();
      store.set(transcriptSourceAtom, normalized);
      return sourceJob;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      ++sourceGeneration;
      sourceController?.abort();
      cancelTranslation();
      store.set(lyricsLoadingAtom, false);
      await Promise.allSettled(childJobs);
    },
  };
}
