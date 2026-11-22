import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createStore } from 'jotai';
import { createLyricsSession, type LyricsDependencies } from '../../src/application/lyrics';
import { runMigrations } from '../../src/db/index';
import type { LyricLine, LyricsResult } from '../../src/providers/lyrics';
import { mediaKey } from '../../src/providers/media';
import { getTranslationProvider, type TranslationProvider } from '../../src/providers/translate';
import type { PlaybackTarget, Track } from '../../src/providers/types';
import { configAtom } from '../../src/store/config';
import { DEFAULT_CONFIG, type TuiTunesConfig } from '../../src/utils/config';
import {
  lyricsDataAtom,
  lyricsDocumentAtom,
  lyricsErrorAtom,
  lyricsTranslationAtom,
  translationEnabledAtom,
  translationLoadingAtom,
} from '../../src/store/lyrics';
import { playerPlaybackAtom } from '../../src/store/player';
import { sectionAtom } from '../../src/store/ui';

const track = (id: string): Track => ({
  id,
  provider: 'youtube',
  source: { kind: 'youtube', videoId: id },
  title: id,
  artist: 'Artist',
  duration: 1,
});
const target = (id: string, requestId: number): PlaybackTarget => ({
  track: track(id),
  source: {
    kind: 'youtube',
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    selection: 'auto',
  },
  origin: { kind: 'direct' },
  requestId,
});
const original = (text: string): LyricsResult => ({
  source: 'lrclib',
  sourceUrl: 'https://lrclib.net',
  synced: true,
  lines: [
    { time: 1, text },
    { time: 2, text: '' },
    { time: 3, text: `${text}2` },
  ],
});
function setup(overrides: Partial<LyricsDependencies> = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  const store = createStore();
  store.set(translationEnabledAtom, true);
  const provider: TranslationProvider = {
    id: 'lingva',
    name: 'Fixture',
    translate: async (text) => `T:${text}`,
    translateBatch: async (texts) => texts.map((text) => `T:${text}`),
  };
  const session = createLyricsSession(store, {
    db,
    fetchMusicLyrics: async (value) => original(value.id),
    fetchUrl: async () => [{ time: 0, text: 'URL' }],
    fetchYouTubeCaptions: async () => null,
    fetchNativeTranslation: async () => null,
    translationProvider: () => provider,
    ...overrides,
  });
  return {
    db,
    store,
    session,
    async close() {
      await session.dispose();
      db.close();
    },
  };
}
async function drain(): Promise<void> {
  for (let index = 0; index < 15; index++) await Promise.resolve();
}

test('late A translation never replaces B or writes A text under B cache identity', async () => {
  const pending: Array<{ texts: string[]; work: PromiseWithResolvers<string[]> }> = [];
  const { db, store, session, close } = setup({
    translationProvider: () => ({
      id: 'lingva',
      name: 'Deferred',
      translate: async (text) => text,
      translateBatch(texts) {
        const work = Promise.withResolvers<string[]>();
        pending.push({ texts, work });
        return work.promise;
      },
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    expect(pending[0].texts).toEqual(['A', 'A2']);
    store.set(playerPlaybackAtom, target('B', 2));
    await session.reload();
    pending[0].work.resolve(['TA', 'TA2']);
    await drain();
    expect(store.get(lyricsDataAtom)?.lines[0]).toEqual({ time: 1, text: 'B' });
    expect(db.query('SELECT media_key FROM translations').all()).toEqual([]);
    pending[1].work.resolve(['TB', 'TB2']);
    await drain();
    expect(store.get(lyricsDataAtom)?.lines.map((line) => line.translatedText)).toEqual([
      'TB',
      '',
      'TB2',
    ]);
    expect(db.query('SELECT media_key FROM translations').all()).toEqual([
      { media_key: mediaKey(track('B')) },
    ]);
  } finally {
    await close();
  }
});
test('equal-length replacement content, endpoint and language changes cannot reuse stale cache', async () => {
  let text = 'first',
    calls = 0;
  const { db, store, session, close } = setup({
    fetchMusicLyrics: async () => original(text),
    translationProvider: () => ({
      id: 'lingva',
      name: 'Fixture',
      translate: async (value) => value,
      translateBatch: async (texts) => {
        calls++;
        return texts.map((value) => `T:${value}`);
      },
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    text = 'second';
    await session.reload();
    await drain();
    expect(store.get(lyricsDataAtom)?.lines[0].translatedText).toBe('T:second');
    store.set(configAtom, (config) => ({
      ...config,
      lingvaInstance: 'https://other.test',
      translationLanguage: 'de',
    }));
    await drain();
    expect(calls).toBe(3);
    expect(db.query('SELECT COUNT(*) AS count FROM translations').get()).toEqual({ count: 3 });
    store.set(translationEnabledAtom, false);
    expect(store.get(translationLoadingAtom)).toBe(false);
    expect(store.get(lyricsDataAtom)?.translatedTo).toBeUndefined();
  } finally {
    await close();
  }
});
test('podcast transcript ownership follows audio source across section browsing and source commands', async () => {
  const requested: string[] = [];
  const { store, session, close } = setup({
    fetchUrl: async (url) => {
      requested.push(url);
      return [{ time: 0, text: url }];
    },
  });
  try {
    const episode = {
      id: 'ep',
      podcastId: 'feed',
      podcastTitle: 'Podcast',
      title: 'Episode',
      audioUrl: 'https://audio.test/ep',
      duration: 1,
      publishDate: '2026-01-01',
    };
    store.set(playerPlaybackAtom, {
      track: { ...track('ep'), provider: 'podcast', source: { kind: 'podcast', episode } },
      source: {
        kind: 'rss',
        url: episode.audioUrl,
        transcriptUrl: 'https://rss.test/transcript',
        selection: 'auto',
      },
      requestId: 1,
      origin: { kind: 'direct' },
    });
    await session.reload();
    const document = store.get(lyricsDocumentAtom);
    store.set(sectionAtom, 'podcast');
    store.set(sectionAtom, 'music');
    expect(store.get(lyricsDocumentAtom)).toBe(document);
    await session.setTranscriptSource({ kind: 'custom', url: 'https://custom.test/transcript' });
    expect(store.get(lyricsDataAtom)?.lines[0].time).toBe(0);
    await session.setTranscriptSource({ kind: 'auto' });
    await session.reload();
    expect(requested.slice(-3)).toEqual([
      'https://custom.test/transcript',
      'https://rss.test/transcript',
      'https://rss.test/transcript',
    ]);
  } finally {
    await close();
  }
});
test('malformed translation retains originals and does not cache partial data', async () => {
  const { db, store, session, close } = setup({
    translationProvider: () => ({
      id: 'lingva',
      name: 'Broken',
      translate: async (text) => text,
      translateBatch: async () => ['one'],
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(store.get(lyricsDataAtom)?.lines[0].text).toBe('A');
    expect(store.get(lyricsDataAtom)?.translatedTo).toBeUndefined();
    expect(store.get(lyricsErrorAtom)).not.toBeNull();
    expect(db.query('SELECT * FROM translations').all()).toEqual([]);
  } finally {
    await close();
  }
});

test('native captions require complete unique timestamp alignment before external fallback', async () => {
  for (const native of [
    [{ time: 1, text: 'Native A' }],
    [
      { time: 1, text: 'Native A' },
      { time: 3, text: 'Native B' },
      { time: 3, text: 'Ambiguous' },
    ],
    [
      { time: 1, text: 'Native A' },
      { time: 3, text: 'Native B' },
    ],
  ]) {
    let externalCalls = 0;
    const { store, session, close } = setup({
      fetchMusicLyrics: async () => ({
        ...original('A'),
        source: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=A',
      }),
      fetchNativeTranslation: async () => native,
      translationProvider: () => ({
        id: 'lingva',
        name: 'Fixture',
        translate: async (text) => text,
        translateBatch: async (texts) => {
          externalCalls++;
          return texts.map((text) => `External:${text}`);
        },
      }),
    });
    try {
      store.set(playerPlaybackAtom, target('A', 1));
      await session.reload();
      await drain();
      const aligned = native.length === 2;
      expect(externalCalls).toBe(aligned ? 0 : 1);
      expect(store.get(lyricsDataAtom)?.lines.map((line) => line.translatedText)).toEqual(
        aligned ? ['Native A', '', 'Native B'] : ['External:A', '', 'External:A2'],
      );
    } finally {
      await close();
    }
  }
});
test('dispose detaches noncancellable SDK work and prevents late state commits', async () => {
  const request = Promise.withResolvers<LyricsResult | null>();
  const { store, session, db } = setup({ fetchMusicLyrics: () => request.promise });
  store.set(playerPlaybackAtom, target('A', 1));
  await session.dispose();
  request.resolve(original('late'));
  await drain();
  expect(store.get(lyricsDocumentAtom)).toBeNull();
  expect(db.query('SELECT * FROM translations').all()).toEqual([]);
  db.close();
});

// ---------------------------------------------------------------------------
// Config subscription fingerprint: display-only flags never restart work
// ---------------------------------------------------------------------------

test('display-only config changes neither clear translations nor call providers again', async () => {
  let calls = 0;
  const { store, session, close } = setup({
    translationProvider: () => ({
      id: 'lingva',
      name: 'Fixture',
      translate: async (text) => text,
      translateBatch: async (texts) => {
        calls++;
        return texts.map((text) => `T:${text}`);
      },
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(calls).toBe(1);
    const committed = store.get(lyricsDataAtom);

    for (const flag of [
      { volume: 42 },
      { ascii: true },
      { reducedMotion: true },
      { spectrumEnabled: true },
    ] as const) {
      store.set(configAtom, (config) => ({ ...config, ...flag }));
    }
    await drain();

    expect(calls).toBe(1);
    // The derived atom rebuilds its merged object on config changes with the
    // same inputs; compare content, not identity.
    expect(store.get(lyricsDataAtom)).toEqual(committed);
    expect(store.get(lyricsDocumentAtom)?.original.lines[0].text).toBe('A');
  } finally {
    await close();
  }
});

test('display-only config changes keep a pending translation running untouched', async () => {
  const work = Promise.withResolvers<string[]>();
  const { store, session, close } = setup({
    translationProvider: () => ({
      id: 'lingva',
      name: 'Deferred',
      translate: async (text) => text,
      translateBatch: () => work.promise,
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(store.get(translationLoadingAtom)).toBe(true);

    store.set(configAtom, (config) => ({
      ...config,
      volume: 10,
      ascii: true,
      reducedMotion: true,
      spectrumEnabled: true,
    }));
    await drain();

    // The in-flight request was not aborted, cleared or restarted.
    expect(store.get(translationLoadingAtom)).toBe(true);
    expect(store.get(lyricsDataAtom)?.translatedTo).toBeUndefined();

    work.resolve(['TA', 'TA2']);
    await drain();
    expect(store.get(lyricsDataAtom)?.lines.map((line) => line.translatedText)).toEqual([
      'TA',
      '',
      'TA2',
    ]);
  } finally {
    await close();
  }
});

test('translation-affecting config fields still restart the translation', async () => {
  let calls = 0;
  const { store, session, close } = setup({
    translationProvider: () => ({
      id: 'lingva',
      name: 'Fixture',
      translate: async (text) => text,
      translateBatch: async (texts) => {
        calls++;
        return texts.map((text) => `T:${text}`);
      },
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(calls).toBe(1);

    store.set(configAtom, (config) => ({ ...config, translationLanguage: 'de' }));
    await drain();
    expect(calls).toBe(2);

    store.set(configAtom, (config) => ({ ...config, lingvaInstance: 'https://de.test' }));
    await drain();
    expect(calls).toBe(3);
  } finally {
    await close();
  }
});

test('native caption translation receives the abortable translation signal', async () => {
  const received: (AbortSignal | undefined)[] = [];
  const native = Promise.withResolvers<LyricLine[] | null>();
  const { store, session, close } = setup({
    fetchMusicLyrics: async () => ({
      ...original('A'),
      source: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=A',
    }),
    fetchNativeTranslation: (_videoId, _targetLang, signal) => {
      received.push(signal);
      return native.promise;
    },
    translationProvider: () => ({
      id: 'lingva',
      name: 'Fixture',
      translate: async (text) => text,
      translateBatch: async (texts) => texts.map((text) => `External:${text}`),
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();

    expect(received[0]).toBeDefined();
    expect(received[0]?.aborted).toBe(false);

    // A translation-affecting config change restarts and aborts the old job.
    store.set(configAtom, (config) => ({ ...config, translationLanguage: 'de' }));
    await drain();
    expect(received[0]?.aborted).toBe(true);
  } finally {
    native.resolve(null);
    await close();
  }
});

// ---------------------------------------------------------------------------
// Translation-provider contract: none provider, explicit source, MyMemory
// guards, LibreTranslate endpoints, cache identity, probe, abort sibling
// ---------------------------------------------------------------------------

test('an unconfigured provider surfaces its application error and retains originals', async () => {
  const { db, store, session, close } = setup({ translationProvider: getTranslationProvider });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();

    expect(store.get(lyricsErrorAtom)).toContain('Use Configure Translation.');
    expect(store.get(lyricsDataAtom)?.lines[0]).toEqual({ time: 1, text: 'A' });
    expect(store.get(translationLoadingAtom)).toBe(false);
    expect(db.query('SELECT * FROM translations').all()).toEqual([]);
  } finally {
    await close();
  }
});

test('an explicit source language is passed through and isolated in the cache', async () => {
  const sources: string[] = [];
  const { db, store, session, close } = setup({
    translationProvider: () => ({
      id: 'lingva',
      name: 'Fixture',
      translate: async (text) => text,
      translateBatch: async (_texts, _target, source) => {
        sources.push(source ?? 'undefined');
        return ['T:A', 'T:A2'];
      },
    }),
  });
  try {
    store.set(configAtom, (config) => ({ ...config, translationSourceLanguage: 'ja' }));
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(sources).toEqual(['ja']);
    expect(db.query('SELECT source_lang FROM translations').get()).toEqual({ source_lang: 'ja' });

    // A different explicit source cannot reuse the cached translation.
    store.set(configAtom, (config) => ({ ...config, translationSourceLanguage: 'ko' }));
    await drain();
    expect(sources).toEqual(['ja', 'ko']);
  } finally {
    await close();
  }
});

test('MyMemory never receives whole podcast documents', async () => {
  let calls = 0;
  const { store, session, close } = setup({
    translationProvider: () => ({
      id: 'mymemory',
      name: 'Fixture',
      translate: async (text) => text,
      translateBatch: async () => {
        calls++;
        return [];
      },
    }),
  });
  try {
    const episode = {
      id: 'ep',
      podcastId: 'feed',
      podcastTitle: 'Podcast',
      title: 'Episode',
      audioUrl: 'https://audio.test/ep',
      duration: 1,
      publishDate: '2026-01-01',
    };
    store.set(playerPlaybackAtom, {
      track: { ...track('ep'), provider: 'podcast', source: { kind: 'podcast', episode } },
      source: {
        kind: 'rss',
        url: episode.audioUrl,
        transcriptUrl: 'https://rss.test/transcript',
        selection: 'auto',
      },
      requestId: 1,
      origin: { kind: 'direct' },
    });
    await session.reload();
    await drain();

    expect(calls).toBe(0);
    expect(store.get(lyricsErrorAtom)).toBe(
      'MyMemory is not used for whole podcast transcripts — choose another translation provider.',
    );
    expect(store.get(lyricsDataAtom)?.lines[0]?.text).toBe('URL');
  } finally {
    await close();
  }
});

test('MyMemory still translates music lyrics with an explicit source', async () => {
  let calls = 0;
  const { store, session, close } = setup({
    translationProvider: () => ({
      id: 'mymemory',
      name: 'Fixture',
      translate: async (text) => text,
      translateBatch: async (texts) => {
        calls++;
        return texts.map((text) => `T:${text}`);
      },
    }),
  });
  try {
    store.set(configAtom, (config) => ({ ...config, translationSourceLanguage: 'en' }));
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(calls).toBe(1);
    expect(store.get(lyricsErrorAtom)).toBeNull();
  } finally {
    await close();
  }
});

test('MyMemory with an unknown source language keeps the original instead of guessing', async () => {
  const { store, session, close } = setup({ translationProvider: getTranslationProvider });
  try {
    store.set(configAtom, (config) => ({ ...config, translationProvider: 'mymemory' }));
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(store.get(lyricsErrorAtom)).toBe('MyMemory requires an explicit source language');
    expect(store.get(lyricsDataAtom)?.lines[0]).toEqual({ time: 1, text: 'A' });
  } finally {
    await close();
  }
});

test('testTranslation probes synthetic text through the configured provider only', async () => {
  const factoryArguments: Array<{ id: string; endpoint?: string }> = [];
  const received: Array<{ text: string; target: string; source: string | undefined }> = [];
  const { db, store, session, close } = setup({
    translationProvider: (id, options) => {
      factoryArguments.push({ id, endpoint: options?.libreTranslateEndpoint });
      return {
        id,
        name: 'Probe',
        translate: async (text, targetLang, sourceLang) => {
          received.push({ text, target: targetLang, source: sourceLang });
          return 'probed';
        },
        translateBatch: async (texts) => texts.map((text) => text),
      };
    },
  });
  try {
    const config: TuiTunesConfig = {
      ...DEFAULT_CONFIG,
      translationProvider: 'libretranslate',
      libreTranslateEndpoint: 'http://127.0.0.1:15097',
      translationLanguage: 'ja',
      translationSourceLanguage: 'en',
    };
    await session.testTranslation(config, new AbortController().signal);

    expect(factoryArguments).toEqual([
      { id: 'libretranslate', endpoint: 'http://127.0.0.1:15097' },
    ]);
    expect(received).toEqual([{ text: 'Hello', target: 'ja', source: 'en' }]);
    expect(store.get(lyricsErrorAtom)).toBeNull();
    expect(store.get(lyricsDocumentAtom)).toBeNull();
    expect(db.query('SELECT * FROM translations').all()).toEqual([]);

    // A live playback document never feeds the probe.
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    const probes = received.length;
    await session.testTranslation(
      { ...config, translationSourceLanguage: null },
      new AbortController().signal,
    );
    expect(received[probes]).toEqual({ text: 'Hello', target: 'ja', source: 'auto' });
    expect(store.get(lyricsDataAtom)?.lines[0]?.text).toBe('A');
  } finally {
    await close();
  }
});

test('testTranslation rejects with the provider failure and honors aborts', async () => {
  const { session, close } = setup({
    translationProvider: () => ({
      id: 'libretranslate',
      name: 'Probe',
      translate: async () => {
        throw new Error('endpoint down');
      },
      translateBatch: async () => {
        throw new Error('endpoint down');
      },
    }),
  });
  try {
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      session.testTranslation(
        { ...DEFAULT_CONFIG, translationProvider: 'libretranslate' },
        aborted.signal,
      ),
    ).rejects.toThrow();

    await expect(
      session.testTranslation(
        { ...DEFAULT_CONFIG, translationProvider: 'libretranslate' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('endpoint down');
  } finally {
    await close();
  }
});

test('LibreTranslate endpoints are isolated in the translation cache', async () => {
  let calls = 0;
  const { store, session, close } = setup({
    translationProvider: () => ({
      id: 'libretranslate',
      name: 'Fixture',
      translate: async (text) => text,
      translateBatch: async (texts) => {
        calls++;
        return texts.map((text) => `T:${text}`);
      },
    }),
  });
  try {
    store.set(configAtom, (config) => ({
      ...config,
      translationProvider: 'libretranslate',
      libreTranslateEndpoint: 'http://one.test',
    }));
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(calls).toBe(1);
    expect(store.get(lyricsDataAtom)?.lines[0]?.translatedText).toBe('T:A');

    // The same document under another endpoint cannot reuse cached rows.
    store.set(configAtom, (config) => ({ ...config, libreTranslateEndpoint: 'http://two.test' }));
    await drain();
    expect(calls).toBe(2);
  } finally {
    await close();
  }
});

test('the historical Lingva cache identity still hits without a new request', async () => {
  let calls = 0;
  const { db, store, session, close } = setup({
    translationProvider: () => ({
      id: 'lingva',
      name: 'Fixture',
      translate: async (text) => text,
      translateBatch: async (texts) => {
        calls++;
        return texts.map((text) => `T:${text}`);
      },
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(calls).toBe(1);

    // The stored request hash must equal the pre-LibreTranslate tuple
    // [engine, source, target, normalized instance] byte for byte.
    const historical = createHash('sha256')
      .update(JSON.stringify(['lingva', 'auto', 'en', 'https://lingva.ml']))
      .digest('hex');
    expect(db.query('SELECT request_sha256, translation_provider FROM translations').get()).toEqual(
      { request_sha256: historical, translation_provider: 'lingva' },
    );

    await session.reload();
    await drain();
    expect(calls).toBe(1); // served from the old-format cache row
    expect(store.get(lyricsDataAtom)?.lines[0]?.translatedText).toBe('T:A');
  } finally {
    await close();
  }
});

test('aborting an in-flight translation is not an error', async () => {
  const work = Promise.withResolvers<string[]>();
  const { store, session, close } = setup({
    translationProvider: () => ({
      id: 'lingva',
      name: 'Deferred',
      translate: async (text) => text,
      translateBatch: () => work.promise,
    }),
  });
  try {
    store.set(playerPlaybackAtom, target('A', 1));
    await session.reload();
    await drain();
    expect(store.get(translationLoadingAtom)).toBe(true);

    store.set(translationEnabledAtom, false);
    expect(store.get(translationLoadingAtom)).toBe(false);
    expect(store.get(lyricsTranslationAtom)).toBeNull();

    work.reject(new Error('cancelled sibling'));
    await drain();
    expect(store.get(lyricsErrorAtom)).toBeNull();
    expect(store.get(lyricsDataAtom)?.translatedTo).toBeUndefined();
    expect(store.get(lyricsDataAtom)?.lines[0]).toEqual({ time: 1, text: 'A' });
  } finally {
    await close();
  }
});
