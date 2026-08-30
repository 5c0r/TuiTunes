import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { runMigrations } from '../../src/db/index';
import { getTranslation, saveTranslation } from '../../src/db/queries';
import { type LyricsResult, parseLrc } from '../../src/providers/lyrics';
import { getTranslationProvider, LingvaProvider } from '../../src/providers/translate';

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

// Expected English translations for the lyrics above
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

/**
 * Simulate the core translation merge logic from app.tsx's doTranslation.
 * This is the same algorithm used in the effect — extracted for testability.
 */
function mergeTranslation(
  lyricsData: LyricsResult,
  translatedTexts: string[],
  targetLang: string,
): LyricsResult {
  let translatedIdx = 0;
  const mergedLines = lyricsData.lines.map((line) => {
    if (line.text.trim().length === 0) {
      return { ...line, translatedText: '' };
    }
    const translated = translatedTexts[translatedIdx] ?? '';
    translatedIdx++;
    return { ...line, translatedText: translated };
  });

  return { ...lyricsData, lines: mergedLines, translatedTo: targetLang };
}

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

describe('Unravel translation merge', () => {
  let lyricsData: LyricsResult;

  beforeEach(() => {
    const lines = parseLrc(UNRAVEL_LRC);
    lyricsData = {
      lines,
      synced: true,
      source: 'lrclib',
      sourceUrl: 'https://lrclib.net',
    };
  });

  test('merges translated text into each line', () => {
    const result = mergeTranslation(lyricsData, UNRAVEL_TRANSLATIONS, 'en');

    expect(result.translatedTo).toBe('en');
    expect(result.lines.length).toBe(10);

    // First line: original + translated
    expect(result.lines[0].text).toBe('教えて 教えてよ');
    expect(result.lines[0].translatedText).toBe('Tell me, tell me');

    // Second line
    expect(result.lines[1].text).toBe('その仕組みを');
    expect(result.lines[1].translatedText).toBe('How it works');

    // Third line with question mark
    expect(result.lines[2].text).toBe('僕の中に誰がいるの？');
    expect(result.lines[2].translatedText).toBe("Who's inside of me?");
  });

  test('empty lines get empty translation', () => {
    const result = mergeTranslation(lyricsData, UNRAVEL_TRANSLATIONS, 'en');

    // Line 7 is empty in the original
    expect(result.lines[7].text).toBe('');
    expect(result.lines[7].translatedText).toBe('');
  });

  test('timestamps are preserved after merge', () => {
    const result = mergeTranslation(lyricsData, UNRAVEL_TRANSLATIONS, 'en');

    // Timestamps should be identical to original
    for (let i = 0; i < lyricsData.lines.length; i++) {
      expect(result.lines[i].time).toBe(lyricsData.lines[i].time);
    }
  });

  test('original source metadata is preserved', () => {
    const result = mergeTranslation(lyricsData, UNRAVEL_TRANSLATIONS, 'en');

    expect(result.source).toBe('lrclib');
    expect(result.sourceUrl).toBe('https://lrclib.net');
    expect(result.synced).toBe(true);
  });

  test('handles fewer translations than non-empty lines gracefully', () => {
    // Only 3 translations for 9 non-empty lines
    const partialTranslations = ['Tell me', 'How it works', "Who's inside?"];
    const result = mergeTranslation(lyricsData, partialTranslations, 'en');

    expect(result.lines[0].translatedText).toBe('Tell me');
    expect(result.lines[1].translatedText).toBe('How it works');
    expect(result.lines[2].translatedText).toBe("Who's inside?");
    // Remaining non-empty lines get empty string (from undefined ?? '')
    expect(result.lines[3].translatedText).toBe('');
  });
});

describe('Unravel translation caching', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  test('caches and retrieves Unravel translation', () => {
    const trackId = 'unravel-test-id';
    saveTranslation(db, trackId, 'lrclib', 'en', 'lingva', UNRAVEL_TRANSLATIONS);

    const cached = getTranslation(db, trackId, 'lrclib', 'en');
    expect(cached).toEqual(UNRAVEL_TRANSLATIONS);
  });

  test('cache applies correctly to parsed lyrics', () => {
    const trackId = 'unravel-test-id';
    saveTranslation(db, trackId, 'lrclib', 'en', 'lingva', UNRAVEL_TRANSLATIONS);

    const cached = getTranslation(db, trackId, 'lrclib', 'en')!;
    const lines = parseLrc(UNRAVEL_LRC);

    // Simulate the cache-hit path from the translation effect
    const mergedLines = lines.map((line, i) => ({
      ...line,
      translatedText: cached[i] ?? '',
    }));

    expect(mergedLines[0].text).toBe('教えて 教えてよ');
    expect(mergedLines[0].translatedText).toBe('Tell me, tell me');
    expect(mergedLines[5].text).toBe('君が笑う');
    expect(mergedLines[5].translatedText).toBe('You smile');
  });

  test('different target languages are cached separately', () => {
    const trackId = 'unravel-test-id';
    const viTranslations = ['Hãy nói cho tôi', 'Cơ chế đó', 'Ai ở trong tôi?'];

    saveTranslation(db, trackId, 'lrclib', 'en', 'lingva', UNRAVEL_TRANSLATIONS);
    saveTranslation(db, trackId, 'lrclib', 'vi', 'lingva', viTranslations);

    expect(getTranslation(db, trackId, 'lrclib', 'en')).toEqual(UNRAVEL_TRANSLATIONS);
    expect(getTranslation(db, trackId, 'lrclib', 'vi')).toEqual(viTranslations);
  });
});

describe('translation provider batch logic', () => {
  test('LingvaProvider has correct interface', () => {
    const provider = new LingvaProvider();
    expect(provider.id).toBe('lingva');
    expect(provider.name).toBe('Lingva (Google Translate)');
    expect(typeof provider.translateBatch).toBe('function');
  });

  test('getTranslationProvider falls back correctly', () => {
    // DeepL without key -> Lingva
    const fallback = getTranslationProvider('deepl', {});
    expect(fallback.id).toBe('lingva');

    // DeepL with key -> DeepL
    const deepl = getTranslationProvider('deepl', { deeplApiKey: 'key' });
    expect(deepl.id).toBe('deepl');

    // Unknown -> Lingva
    const unknown = getTranslationProvider('nonexistent');
    expect(unknown.id).toBe('lingva');
  });
});
