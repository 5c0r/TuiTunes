import { Logger } from '../utils/logger';

export interface TranslationProvider {
  readonly id: string;
  readonly name: string;
  translate(text: string, targetLang: string, sourceLang?: string, signal?: AbortSignal): Promise<string>;
  translateBatch(texts: string[], targetLang: string, sourceLang?: string, signal?: AbortSignal): Promise<string[]>;
}

/** Combine an optional caller signal with a per-request timeout. */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

/** At most four per-line requests are in flight at once. */
const MAX_CONCURRENT_LINE_REQUESTS = 4;

/**
 * Translate texts independently (one request per text), preserving input
 * order, with at most MAX_CONCURRENT_LINE_REQUESTS requests in flight.
 * Empty strings are returned as-is without a network call. Abort stops
 * scheduling new requests; any failure rejects the whole translation.
 */
async function translateLinesIndependently(
  translateOne: (text: string) => Promise<string>,
  texts: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const results = new Array<string>(texts.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_LINE_REQUESTS, texts.length) }, async () => {
    for (;;) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      if (index >= texts.length) return;
      results[index] = texts[index] === '' ? '' : await translateOne(texts[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Lingva — free Google Translate proxy, zero config
// ---------------------------------------------------------------------------

export const DEFAULT_LINGVA_INSTANCE = 'https://lingva.ml';

/**
 * Canonical Lingva endpoint identity: defaults to DEFAULT_LINGVA_INSTANCE for
 * missing/empty values and strips trailing slashes. Used both for requests
 * and for translation-cache request hashing.
 */
export function normalizeLingvaInstance(instanceUrl?: string | null): string {
  const trimmed = instanceUrl?.trim();
  const instance = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_LINGVA_INSTANCE;
  return instance.replace(/\/+$/, '');
}

function lingvaTranslation(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('translation' in data)) return null;
  const { translation } = data;
  return typeof translation === 'string' ? translation : null;
}

async function fetchLingvaTranslation(url: string, signal: AbortSignal | undefined): Promise<string> {
  const res = await fetch(url, { signal: requestSignal(signal, 10_000) });
  if (!res.ok) {
    Logger.error(`Lingva: HTTP ${res.status}`);
    throw new Error(`Lingva HTTP ${res.status}`);
  }
  const translation = lingvaTranslation(await res.json());
  if (translation === null) {
    throw new Error('Lingva returned a malformed translation payload');
  }
  return translation;
}

export class LingvaProvider implements TranslationProvider {
  readonly id = 'lingva';
  readonly name = 'Lingva (Google Translate)';
  private readonly baseUrl: string;

  constructor(instanceUrl?: string | null) {
    this.baseUrl = normalizeLingvaInstance(instanceUrl);
  }

  async translate(
    text: string,
    targetLang: string,
    sourceLang = 'auto',
    signal?: AbortSignal,
  ): Promise<string> {
    if (text === '') return '';
    const url = `${this.baseUrl}/api/v1/${sourceLang}/${targetLang}/${encodeURIComponent(text)}`;
    Logger.debug(
      `Lingva: GET ${this.baseUrl}/api/v1/${sourceLang}/${targetLang}/... (${text.length} chars)`,
    );
    const translation = await fetchLingvaTranslation(url, signal);
    Logger.debug(`Lingva: got ${translation.length} chars translated`);
    return translation;
  }

  async translateBatch(
    texts: string[],
    targetLang: string,
    sourceLang = 'auto',
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    Logger.debug(
      `Lingva: translating ${texts.length} lines independently (≤${MAX_CONCURRENT_LINE_REQUESTS} in flight)`,
    );
    const translated = await translateLinesIndependently(
      (text) => this.translate(text, targetLang, sourceLang, signal),
      texts,
      signal,
    );
    Logger.debug(`Lingva: batch result — ${translated.length} lines (input: ${texts.length})`);
    return translated;
  }
}

// ---------------------------------------------------------------------------
// DeepL — premium quality, requires API key
// ---------------------------------------------------------------------------

const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';

/** DeepL accepts at most 50 texts per request. */
const DEEPL_MAX_TEXTS_PER_REQUEST = 50;

/** DeepL accepts request bodies of at most 128 KiB, including metadata. */
const DEEPL_MAX_BODY_BYTES = 128 * 1024;

function deeplSourceLang(sourceLang: string | undefined): string | undefined {
  return sourceLang && sourceLang !== 'auto' ? sourceLang.toUpperCase() : undefined;
}

/**
 * Split texts into ordered batches respecting both the 50-text and the
 * 128 KiB encoded-body limits (body includes request metadata). A single
 * text that cannot fit in one request rejects explicitly instead of being
 * silently truncated.
 */
function planDeepLBatches(
  texts: readonly string[],
  upperTarget: string,
  upperSource: string | undefined,
): string[][] {
  const encoder = new TextEncoder();
  const skeletonBytes = encoder.encode(
    JSON.stringify(
      upperSource
        ? { text: [], target_lang: upperTarget, source_lang: upperSource }
        : { text: [], target_lang: upperTarget },
    ),
  ).length;
  // Items sit between the skeleton's empty array brackets joined by ASCII
  // commas, so the encoded body is exactly skeleton + items + separators.
  const encodedItemBytes = texts.map((text) => encoder.encode(JSON.stringify(text)).length);

  const batches: string[][] = [];
  let batch: string[] = [];
  let batchBytes = skeletonBytes;
  for (let index = 0; index < texts.length; index++) {
    const itemBytes = encodedItemBytes[index];
    const separatorBytes = batch.length > 0 ? 1 : 0;
    const singleItemExceedsBudget = skeletonBytes + itemBytes > DEEPL_MAX_BODY_BYTES;
    if (singleItemExceedsBudget) {
      throw new Error(
        `DeepL request body exceeds ${DEEPL_MAX_BODY_BYTES} bytes for a single text (${itemBytes + skeletonBytes} bytes)`,
      );
    }
    const batchFull =
      batch.length >= DEEPL_MAX_TEXTS_PER_REQUEST ||
      batchBytes + separatorBytes + itemBytes > DEEPL_MAX_BODY_BYTES;
    if (batch.length > 0 && batchFull) {
      batches.push(batch);
      batch = [];
      batchBytes = skeletonBytes;
    }
    batch.push(texts[index]);
    batchBytes += (batch.length > 1 ? 1 : 0) + itemBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Validate a DeepL response: `translations` must be an array of entries with
 * string `text` whose cardinality matches the request batch.
 */
function deeplTranslations(data: unknown, expectedCount: number): string[] | null {
  if (typeof data !== 'object' || data === null || !('translations' in data)) return null;
  const { translations } = data;
  if (!Array.isArray(translations) || translations.length !== expectedCount) return null;
  const texts: string[] = [];
  for (const entry of translations) {
    if (typeof entry !== 'object' || entry === null || !('text' in entry)) return null;
    const { text } = entry;
    if (typeof text !== 'string') return null;
    texts.push(text);
  }
  return texts;
}

export class DeepLProvider implements TranslationProvider {
  readonly id = 'deepl';
  readonly name = 'DeepL';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async translate(
    text: string,
    targetLang: string,
    sourceLang?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (text === '') return '';
    const results = await this.translateBatch([text], targetLang, sourceLang, signal);
    return results[0] ?? '';
  }

  async translateBatch(
    texts: string[],
    targetLang: string,
    sourceLang?: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];

    const upperTarget = targetLang.toUpperCase();
    const upperSource = deeplSourceLang(sourceLang);
    const translated: string[] = [];
    for (const batch of planDeepLBatches(texts, upperTarget, upperSource)) {
      // Abort stops scheduling new batch requests.
      signal?.throwIfAborted();

      const body: Record<string, unknown> = { text: batch, target_lang: upperTarget };
      if (upperSource) body.source_lang = upperSource;

      Logger.debug(
        `DeepL: POST ${DEEPL_API_URL} with ${batch.length} texts → ${upperTarget}`,
      );
      const res = await fetch(DEEPL_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: requestSignal(signal, 15_000),
      });

      if (!res.ok) {
        Logger.error(`DeepL: HTTP ${res.status}`);
        throw new Error(`DeepL HTTP ${res.status}`);
      }

      const batchTranslations = deeplTranslations(await res.json(), batch.length);
      if (batchTranslations === null) {
        throw new Error('DeepL returned a malformed translation payload');
      }
      translated.push(...batchTranslations);
    }

    Logger.debug(`DeepL: got ${translated.length} translations`);
    return translated;
  }
}

// ---------------------------------------------------------------------------
// MyMemory — free fallback, limited daily quota
// ---------------------------------------------------------------------------

const MYMEMORY_API_URL = 'https://mymemory.translated.net/get';

/** Validate a MyMemory response: responseData.translatedText must be a string. */
function mymemoryTranslation(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('responseData' in data)) return null;
  const { responseData } = data;
  if (
    typeof responseData !== 'object' ||
    responseData === null ||
    !('translatedText' in responseData)
  ) {
    return null;
  }
  const { translatedText } = responseData;
  return typeof translatedText === 'string' ? translatedText : null;
}

export class MyMemoryProvider implements TranslationProvider {
  readonly id = 'mymemory';
  readonly name = 'MyMemory';

  async translate(
    text: string,
    targetLang: string,
    sourceLang = 'en',
    signal?: AbortSignal,
  ): Promise<string> {
    if (text === '') return '';
    const langPair = `${sourceLang}|${targetLang}`;
    const url = `${MYMEMORY_API_URL}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;
    Logger.debug(`MyMemory: GET langpair=${langPair} (${text.length} chars)`);
    const res = await fetch(url, { signal: requestSignal(signal, 10_000) });
    if (!res.ok) {
      Logger.error(`MyMemory: HTTP ${res.status}`);
      throw new Error(`MyMemory HTTP ${res.status}`);
    }
    const translated = mymemoryTranslation(await res.json());
    if (translated === null) {
      throw new Error('MyMemory returned a malformed translation payload');
    }
    Logger.debug(`MyMemory: got ${translated.length} chars translated`);
    return translated;
  }

  async translateBatch(
    texts: string[],
    targetLang: string,
    sourceLang = 'en',
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    Logger.debug(
      `MyMemory: translating ${texts.length} lines independently (≤${MAX_CONCURRENT_LINE_REQUESTS} in flight)`,
    );
    return translateLinesIndependently(
      (text) => this.translate(text, targetLang, sourceLang, signal),
      texts,
      signal,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getTranslationProvider(
  providerId: string,
  options?: { deeplApiKey?: string; lingvaInstance?: string },
): TranslationProvider {
  switch (providerId) {
    case 'deepl': {
      if (!options?.deeplApiKey) {
        Logger.error('DeepL requires an API key — falling back to Lingva');
        return new LingvaProvider(options?.lingvaInstance);
      }
      return new DeepLProvider(options.deeplApiKey);
    }
    case 'mymemory':
      return new MyMemoryProvider();
    default:
      return new LingvaProvider(options?.lingvaInstance);
  }
}
