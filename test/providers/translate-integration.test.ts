import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runMigrations } from '../../src/db/index';
import { getTranslation, saveTranslation, type TranslationCacheKey } from '../../src/db/queries';
import { type LyricsResult, mergeTranslatedLines, parseLrc } from '../../src/providers/lyrics';
import { getTranslationProvider } from '../../src/providers/translate';

// -- Fixture: First 10 synced lines of "Unravel" by TK from Ling Tosite Sigure --
// Source: LRCLIB (https://lrclib.net)
const UNRAVEL_LRC = `[00:00.33] 教えて 教えてよ
[00:04.18] その仕組みを
[00:07.75] 僕の中に誰がいるの？
[00:14.94] 壊れた 壊れたよ
[00:18.50] この世界で
[00:22.09] 君が笑う
[00:25.62] 何も見えずに
[00:29.34]
[00:41.78] 壊れた僕なんてさ
[00:45.15] 息を止めて`;

// Expected English translations for the lyrics above — one entry per line,
// including the blank line (translations cache stores full documents).
const UNRAVEL_TRANSLATIONS = [
  'Tell me, tell me',
  'How it works',
  "Who's inside of me?",
  "It's broken, it's broken",
  'In this world',
  'You smile',
  'Without seeing anything',
  '',
  "I'm already broken",
  'I hold my breath',
];

// External providers only ever translate nonempty source lines.
const UNRAVEL_NONEMPTY_TRANSLATIONS = UNRAVEL_TRANSLATIONS.filter((text) => text !== '');

describe('Unravel lyrics parsing', () => {
  test('parseLrc extracts synced Japanese lines', () => {
    const lines = parseLrc(UNRAVEL_LRC);
    expect(lines.length).toBe(10);

    // First line: [00:00.33] 教えて 教えてよ
    expect(lines[0].time).toBeCloseTo(0.33, 1);
    expect(lines[0].text).toBe('教えて 教えてよ');

    // Second line
    expect(lines[1].time).toBeCloseTo(4.18, 1);
    expect(lines[1].text).toBe('その仕組みを');

    // Empty line at [00:29.34]
    expect(lines[7].text).toBe('');
    expect(lines[7].time).toBeCloseTo(29.34, 1);

    // Last fixture line
    expect(lines[9].text).toBe('息を止めて');
    expect(lines[9].time).toBeCloseTo(45.15, 1);
  });

  test('all lines start without translatedText', () => {
    const lines = parseLrc(UNRAVEL_LRC);
    for (const line of lines) {
      expect(line.translatedText).toBeUndefined();
    }
  });
});

describe('mergeTranslatedLines (production merge)', () => {
  let lyricsData: LyricsResult;

  beforeEach(() => {
    lyricsData = {
      lines: parseLrc(UNRAVEL_LRC),
      synced: true,
      source: 'lrclib',
      sourceUrl: 'https://lrclib.net',
    };
  });

  test('merges translated nonempty lines into each source line', () => {
    const merged = mergeTranslatedLines(lyricsData.lines, UNRAVEL_NONEMPTY_TRANSLATIONS);
    const result: LyricsResult = { ...lyricsData, lines: merged, translatedTo: 'en' };

    expect(result.translatedTo).toBe('en');
    expect(result.lines.length).toBe(10);

    expect(result.lines[0].text).toBe('教えて 教えてよ');
    expect(result.lines[0].translatedText).toBe('Tell me, tell me');

    expect(result.lines[1].text).toBe('その仕組みを');
    expect(result.lines[1].translatedText).toBe('How it works');

    expect(result.lines[2].text).toBe('僕の中に誰がいるの？');
    expect(result.lines[2].translatedText).toBe("Who's inside of me?");
  });

  test('blank source lines keep empty translated text', () => {
    const merged = mergeTranslatedLines(lyricsData.lines, UNRAVEL_NONEMPTY_TRANSLATIONS);

    expect(merged[7].text).toBe('');
    expect(merged[7].translatedText).toBe('');
  });

  test('timestamps and source order are preserved after merge', () => {
    const merged = mergeTranslatedLines(lyricsData.lines, UNRAVEL_NONEMPTY_TRANSLATIONS);

    for (let i = 0; i < lyricsData.lines.length; i++) {
      expect(merged[i].time).toBe(lyricsData.lines[i].time);
      expect(merged[i].text).toBe(lyricsData.lines[i].text);
    }
  });

  test('rejects fewer translations than nonempty lines', () => {
    const partialTranslations = ['Tell me', 'How it works', "Who's inside?"];
    expect(() => mergeTranslatedLines(lyricsData.lines, partialTranslations)).toThrow(
      'Translation cardinality mismatch',
    );
  });

  test('rejects more translations than nonempty lines', () => {
    const extra = [...UNRAVEL_NONEMPTY_TRANSLATIONS, 'too many'];
    expect(() => mergeTranslatedLines(lyricsData.lines, extra)).toThrow(
      'Translation cardinality mismatch',
    );
  });

  test('whitespace-only lines count as blank', () => {
    const merged = mergeTranslatedLines(
      [
        { time: 0, text: 'real line' },
        { time: 1, text: '   ' },
      ],
      ['translated'],
    );
    expect(merged[0].translatedText).toBe('translated');
    expect(merged[1].translatedText).toBe('');
  });
});

describe('translation cache', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  const baseKey: TranslationCacheKey = {
    mediaKey: 'media:unravel',
    sourceKey: 'lrclib|https://lrclib.net',
    contentSha256: 'content-1',
    requestSha256: 'request-1',
    translationProvider: 'lingva',
    sourceLang: 'auto',
    targetLang: 'en',
  };

  test('round-trips a full translated document', () => {
    saveTranslation(db, baseKey, UNRAVEL_TRANSLATIONS);

    expect(getTranslation(db, baseKey, UNRAVEL_TRANSLATIONS.length)).toEqual(UNRAVEL_TRANSLATIONS);
  });

  test('rejects cached rows whose line count does not match the request', () => {
    saveTranslation(db, baseKey, UNRAVEL_TRANSLATIONS);

    expect(getTranslation(db, baseKey, 3)).toBeNull();
    // The invalid row is removed instead of being served again.
    expect(getTranslation(db, baseKey, UNRAVEL_TRANSLATIONS.length)).toBeNull();
  });

  test('cached translations merge into parsed lyrics via the production merge', () => {
    saveTranslation(db, baseKey, UNRAVEL_TRANSLATIONS);

    const cached = getTranslation(db, baseKey, UNRAVEL_TRANSLATIONS.length);
    expect(cached).not.toBeNull();

    // The cache stores one entry per document line; the merge consumes the
    // nonempty subset, selected positionally from the source lines.
    const lines = parseLrc(UNRAVEL_LRC);
    const cachedNonempty = (cached ?? []).flatMap((text, index) =>
      lines[index].text.trim().length > 0 ? [text] : [],
    );
    const merged = mergeTranslatedLines(lines, cachedNonempty);

    expect(merged[0].text).toBe('教えて 教えてよ');
    expect(merged[0].translatedText).toBe('Tell me, tell me');
    expect(merged[5].text).toBe('君が笑う');
    expect(merged[5].translatedText).toBe('You smile');
  });

  test('different target languages stay isolated', () => {
    const viTranslations = ['Hãy nói cho tôi', 'Cơ chế đó', 'Ai ở trong tôi?'];

    saveTranslation(db, { ...baseKey, targetLang: 'en' }, UNRAVEL_TRANSLATIONS);
    saveTranslation(
      db,
      { ...baseKey, targetLang: 'vi', contentSha256: 'content-vi' },
      viTranslations,
    );

    expect(getTranslation(db, { ...baseKey, targetLang: 'en' }, UNRAVEL_TRANSLATIONS.length)).toEqual(
      UNRAVEL_TRANSLATIONS,
    );
    expect(
      getTranslation(db, { ...baseKey, targetLang: 'vi', contentSha256: 'content-vi' }, 3),
    ).toEqual(viTranslations);
  });

  test('different translation backends stay isolated for identical content', () => {
    // Backend identity is part of the request hash: same content translated
    // by Lingva and DeepL occupies distinct cache rows.
    const lingvaKey: TranslationCacheKey = {
      ...baseKey,
      requestSha256: 'sha:lingva:default-instance',
    };
    const deeplKey: TranslationCacheKey = {
      ...baseKey,
      translationProvider: 'deepl',
      requestSha256: 'sha:deepl',
    };

    saveTranslation(db, lingvaKey, UNRAVEL_TRANSLATIONS);
    saveTranslation(db, deeplKey, UNRAVEL_TRANSLATIONS.map((text) => `deepl:${text}`));

    expect(getTranslation(db, lingvaKey, 10)).toEqual(UNRAVEL_TRANSLATIONS);
    expect(getTranslation(db, deeplKey, 10)).toEqual(
      UNRAVEL_TRANSLATIONS.map((text) => `deepl:${text}`),
    );
  });

  test('different request identity (engine/instance) stays isolated', () => {
    saveTranslation(db, { ...baseKey, requestSha256: 'lingva-default' }, UNRAVEL_TRANSLATIONS);
    saveTranslation(
      db,
      { ...baseKey, requestSha256: 'lingva-custom-instance' },
      UNRAVEL_TRANSLATIONS.map((text) => `mirror:${text}`),
    );

    expect(getTranslation(db, { ...baseKey, requestSha256: 'lingva-default' }, 10)).toEqual(
      UNRAVEL_TRANSLATIONS,
    );
    expect(
      getTranslation(db, { ...baseKey, requestSha256: 'lingva-custom-instance' }, 10),
    ).toEqual(UNRAVEL_TRANSLATIONS.map((text) => `mirror:${text}`));
  });

  test('different content hashes stay isolated', () => {
    saveTranslation(db, { ...baseKey, contentSha256: 'content-1' }, UNRAVEL_TRANSLATIONS);
    saveTranslation(
      db,
      { ...baseKey, contentSha256: 'content-2' },
      UNRAVEL_TRANSLATIONS.map((text) => `other:${text}`),
    );

    expect(getTranslation(db, { ...baseKey, contentSha256: 'content-1' }, 10)).toEqual(
      UNRAVEL_TRANSLATIONS,
    );
    expect(getTranslation(db, { ...baseKey, contentSha256: 'content-2' }, 10)).toEqual(
      UNRAVEL_TRANSLATIONS.map((text) => `other:${text}`),
    );
  });

  test('different media and lyric sources stay isolated', () => {
    saveTranslation(db, baseKey, UNRAVEL_TRANSLATIONS);
    saveTranslation(
      db,
      { ...baseKey, mediaKey: 'media:other-track', sourceKey: 'youtube|video-1' },
      UNRAVEL_TRANSLATIONS.map((text) => `yt:${text}`),
    );

    expect(getTranslation(db, baseKey, 10)).toEqual(UNRAVEL_TRANSLATIONS);
    expect(
      getTranslation(db, { ...baseKey, mediaKey: 'media:other-track', sourceKey: 'youtube|video-1' }, 10),
    ).toEqual(UNRAVEL_TRANSLATIONS.map((text) => `yt:${text}`));
  });
});

describe('translation provider fallback behavior', () => {
  test('getTranslationProvider resolves DeepL without a key to Lingva and keeps DeepL with one', () => {
    const fallback = getTranslationProvider('deepl', {});
    expect(fallback.id).toBe('lingva');

    const deepl = getTranslationProvider('deepl', { deeplApiKey: 'key' });
    expect(deepl.id).toBe('deepl');
  });

  test('unknown provider ids resolve to Lingva and MyMemory stays distinct', () => {
    expect(getTranslationProvider('nonexistent').id).toBe('lingva');
    expect(getTranslationProvider('mymemory').id).toBe('mymemory');
  });
});
