import { Logger } from '../utils/logger';

export interface TranslationProvider {
  readonly id: string;
  readonly name: string;
  translate(text: string, targetLang: string, sourceLang?: string, signal?: AbortSignal): Promise<string>;
  translateBatch(texts: string[], targetLang: string, sourceLang?: string, signal?: AbortSignal): Promise<string[]>;
  testConnection?(
    sample: string,
    targetLang: string,
    sourceLang: string,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Options every translation provider needs from the saved configuration. */
export interface TranslationProviderOptions {
  deeplApiKey?: string;
  lingvaInstance?: string;
  libreTranslateEndpoint?: string;
}

/** Combine an optional caller signal with a per-request timeout. */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

/**
 * Fetch for every translation provider: redirects are refused outright. A
 * Location header can carry credentials, and re-sending request bodies (or
 * auth headers) to any URL the endpoint names is never safe.
 */
async function fetchRefusingRedirects(
  providerLabel: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'manual' });
  } catch {
    init.signal?.throwIfAborted();
    throw new Error(`Cannot reach ${providerLabel}; check your network and configured endpoint`);
  }
  if (res.status >= 300 && res.status < 400) {
    Logger.error(`${providerLabel}: refused an HTTP redirect`);
    throw new Error(
      `${providerLabel} refused an HTTP redirect — configure the final endpoint URL directly`,
    );
  }
  return res;
}

/** At most four per-line requests are in flight at once. */
const MAX_CONCURRENT_LINE_REQUESTS = 4;

/** UTF-8 encoded byte length of a string. */
function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Translate texts independently (one request per text), preserving input
 * order, with at most MAX_CONCURRENT_LINE_REQUESTS requests in flight.
 * Empty strings are returned as-is without a network call. Abort stops
 * scheduling new requests; any failure rejects the whole translation.
 */
async function translateLinesIndependently(
  translateOne: (text: string, signal: AbortSignal) => Promise<string>,
  texts: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const results = new Array<string>(texts.length);
  let nextIndex = 0;
  const batch = new AbortController();
  const request = signal ? AbortSignal.any([signal, batch.signal]) : batch.signal;

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_LINE_REQUESTS, texts.length) }, async () => {
    try {
      for (;;) {
        request.throwIfAborted();
        const index = nextIndex++;
        if (index >= texts.length) return;
        results[index] = texts[index] === '' ? '' : await translateOne(texts[index], request);
      }
    } catch (error) {
      batch.abort(error);
      throw error;
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Split texts into ordered batches respecting both a per-request text-count
 * limit and an encoded-body limit (the body includes request metadata).
 * `skeletonBytes` is the encoded body with an empty text array, so the
 * encoded body is exactly skeleton + items + ASCII comma separators. A
 * single text that cannot fit in one request rejects explicitly instead of
 * being silently truncated.
 */
function planRequestBatches(
  texts: readonly string[],
  skeletonBytes: number,
  maxTextsPerRequest: number,
  maxBodyBytes: number,
  providerLabel: string,
): string[][] {
  const encoder = new TextEncoder();
  const encodedItemBytes = texts.map((text) => encoder.encode(JSON.stringify(text)).length);

  const batches: string[][] = [];
  let batch: string[] = [];
  let batchBytes = skeletonBytes;
  for (let index = 0; index < texts.length; index++) {
    const itemBytes = encodedItemBytes[index];
    const separatorBytes = batch.length > 0 ? 1 : 0;
    const singleItemExceedsBudget = skeletonBytes + itemBytes > maxBodyBytes;
    if (singleItemExceedsBudget) {
      throw new Error(
        `${providerLabel} request body exceeds ${maxBodyBytes} bytes for a single text (${itemBytes + skeletonBytes} bytes)`,
      );
    }
    const batchFull =
      batch.length >= maxTextsPerRequest || batchBytes + separatorBytes + itemBytes > maxBodyBytes;
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

// ---------------------------------------------------------------------------
// Lingva — free Google Translate proxy, custom instance only
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
  const res = await fetchRefusingRedirects('Lingva', url, { signal: requestSignal(signal, 10_000) });
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
      `Lingva: translate ${sourceLang} → ${targetLang} (${text.length} chars)`,
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
      (text, request) => this.translate(text, targetLang, sourceLang, request),
      texts,
      signal,
    );
    Logger.debug(`Lingva: batch result — ${translated.length} lines (input: ${texts.length})`);
    return translated;
  }
}

// ---------------------------------------------------------------------------
// LibreTranslate — self-hosted neural machine translation
// ---------------------------------------------------------------------------

/**
 * Canonical LibreTranslate endpoint identity: trims whitespace, strips
 * trailing slashes, and maps missing values to '' (there is no public
 * default instance). Used both for requests and for translation-cache
 * request hashing.
 */
export function normalizeLibreTranslateEndpoint(endpointUrl?: string | null): string {
  return endpointUrl?.trim().replace(/\/+$/, '') ?? '';
}

/** LibreTranslate requests carry ordered arrays of at most 50 texts. */
const LIBRETRANSLATE_MAX_TEXTS_PER_REQUEST = 50;

/** LibreTranslate request bodies are kept at most 128 KiB, including metadata. */
const LIBRETRANSLATE_MAX_BODY_BYTES = 128 * 1024;

/** Language detection samples at most this many UTF-8 bytes of a document. */
const LIBRETRANSLATE_DETECT_BUDGET_BYTES = 4096;

/**
 * Build a detection sample from nonempty texts without exceeding the byte
 * budget: whole texts are appended only while they still fit, so no rune is
 * ever split. When no whole text fits, the first nonempty text contributes a
 * safely truncated prefix instead. Returns null when every text is empty.
 */
function detectionSample(texts: readonly string[]): string | null {
  const parts: string[] = [];
  let bytes = 0;
  for (const text of texts) {
    if (text === '') continue;
    const textBytes = utf8ByteLength(text);
    const separatorBytes = parts.length > 0 ? 1 : 0;
    if (bytes + separatorBytes + textBytes > LIBRETRANSLATE_DETECT_BUDGET_BYTES) continue;
    parts.push(text);
    bytes += separatorBytes + textBytes;
  }
  if (parts.length > 0) return parts.join(' ');
  const first = texts.find((text) => text !== '');
  return first === undefined ? null : truncateUtf8(first, LIBRETRANSLATE_DETECT_BUDGET_BYTES);
}

/** Prefix of `text` cut at most `budget` UTF-8 bytes without splitting a code point. */
function truncateUtf8(text: string, budget: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= budget) return text;
  const truncated = new TextDecoder().decode(bytes.subarray(0, budget));
  // Drop the replacement character a split trailing sequence produces.
  return truncated.endsWith('\uFFFD') ? truncated.slice(0, -1) : truncated;
}

/** Validate a /detect response: a nonempty array ranked by confidence. */
function libreDetectedLanguage(data: unknown): string | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (typeof first !== 'object' || first === null || !('language' in first)) return null;
  const { language } = first;
  return typeof language === 'string' && language.length > 0 ? language : null;
}

/**
 * Validate a /translate response: `translatedText` must be an array of
 * strings (array in, array out) whose cardinality matches the request batch.
 * A nonempty input that comes back blank indicates a broken or filtered
 * response and rejects instead of displaying empty lines.
 */
function libreTranslateTranslations(data: unknown, batch: readonly string[]): string[] | null {
  if (typeof data !== 'object' || data === null || !('translatedText' in data)) return null;
  const { translatedText } = data;
  if (!Array.isArray(translatedText) || translatedText.length !== batch.length) return null;
  for (let index = 0; index < translatedText.length; index++) {
    const text = translatedText[index];
    if (typeof text !== 'string') return null;
    if (text.trim() === '' && batch[index].trim() !== '') return null;
  }
  return translatedText;
}

/** A /languages entry: the code plus the target codes it can translate into. */
interface LibreLanguage {
  readonly code: string;
  readonly targets: readonly string[];
}

/**
 * Parse /languages into code/targets pairs. The listing must be a nonempty
 * array of entries with a string code and a string-array targets field;
 * anything else is malformed.
 */
function parseLanguages(data: unknown): LibreLanguage[] | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const languages: LibreLanguage[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { code, targets } = entry as { code?: unknown; targets?: unknown };
    if (typeof code !== 'string' || code.length === 0) return null;
    if (!Array.isArray(targets) || !targets.every((target) => typeof target === 'string')) {
      return null;
    }
    languages.push({ code, targets });
  }
  return languages;
}

/** Distinct, actionable errors for the failure classes LibreTranslate reports. */
function libreHttpError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `LibreTranslate rejected the request (HTTP ${status}) — the instance may require an API key`,
    );
  }
  if (status === 429) {
    return new Error('LibreTranslate rate limit reached (HTTP 429) — try again later');
  }
  if (status === 400 || status === 404 || status === 422) {
    return new Error(
      `LibreTranslate could not handle the request (HTTP ${status}) — check the endpoint URL and language pair`,
    );
  }
  return new Error(`LibreTranslate HTTP ${status}`);
}

export class LibreTranslateProvider implements TranslationProvider {
  readonly id = 'libretranslate';
  readonly name = 'LibreTranslate (self-hosted)';
  private readonly endpoint: string;
  private languagesRoute: Promise<readonly LibreLanguage[]> | null = null;

  constructor(endpointUrl: string) {
    this.endpoint = normalizeLibreTranslateEndpoint(endpointUrl);
  }

  async testConnection(
    sample: string,
    targetLang: string,
    sourceLang: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (sourceLang === 'auto') {
      const languages = await this.ensureLanguages(signal);
      const available = languages.find(
        ({ code, targets }) => code !== targetLang && targets.includes(targetLang),
      );
      if (!available) throw new Error(`LibreTranslate has no source model for ${targetLang}`);
      sourceLang = available.code;
    }
    await this.translate(sample, targetLang, sourceLang, signal);
  }

  async translate(
    text: string,
    targetLang: string,
    sourceLang = 'auto',
    signal?: AbortSignal,
  ): Promise<string> {
    if (text === '') return '';
    const results = await this.translateBatch([text], targetLang, sourceLang, signal);
    return results[0] ?? '';
  }

  async translateBatch(
    texts: string[],
    targetLang: string,
    sourceLang = 'auto',
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    signal?.throwIfAborted();
    const languages = await this.ensureLanguages(signal);

    // The source language is detected exactly once per document within a
    // bounded byte budget. A detection failure rejects the translation:
    // falling back to server-side auto would silently re-detect per request
    // and can pair lines with different detected languages. With no sample
    // (every line empty) there is nothing to send at all.
    let effectiveSource = sourceLang;
    if (!sourceLang || sourceLang === 'auto') {
      const sample = detectionSample(texts);
      if (sample === null) return texts.map(() => '');
      effectiveSource = await this.detect(sample, signal);
    }

    // The /languages listing must actually support the resolved pair — not
    // merely parse. An unsupported pair rejects before any text is sent.
    const pairSupported = languages.some(
      (language) => language.code === effectiveSource && language.targets.includes(targetLang),
    );
    if (!pairSupported) {
      throw new Error(
        `LibreTranslate does not support translating ${effectiveSource} → ${targetLang}`,
      );
    }

    const skeletonBytes = new TextEncoder().encode(
      JSON.stringify({ q: [], source: effectiveSource, target: targetLang, format: 'text' }),
    ).length;
    const translated: string[] = [];
    for (const batch of planRequestBatches(
      texts,
      skeletonBytes,
      LIBRETRANSLATE_MAX_TEXTS_PER_REQUEST,
      LIBRETRANSLATE_MAX_BODY_BYTES,
      'LibreTranslate',
    )) {
      // Abort stops scheduling new batch requests.
      signal?.throwIfAborted();
      Logger.debug(
        `LibreTranslate: translating ${batch.length} texts ${effectiveSource} → ${targetLang}`,
      );
      const data = await this.request(
        'POST',
        '/translate',
        { q: batch, source: effectiveSource, target: targetLang, format: 'text' },
        15_000,
        signal,
      );
      const batchTranslations = libreTranslateTranslations(data, batch);
      if (batchTranslations === null) {
        throw new Error('LibreTranslate returned a malformed translation payload');
      }
      translated.push(...batchTranslations);
    }

    Logger.debug(`LibreTranslate: got ${translated.length} translations`);
    return translated;
  }

  /**
   * Issue a request against a LibreTranslate route. Redirects are refused
   * (see fetchRefusingRedirects): a Location header can carry credentials
   * and the request body must never be re-sent elsewhere.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const deadline = requestSignal(signal, timeoutMs);
    try {
      const res = await fetchRefusingRedirects('LibreTranslate', `${this.endpoint}${path}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        signal: deadline,
      });
      if (!res.ok) throw libreHttpError(res.status);
      try {
        const data: unknown = await res.json();
        deadline.throwIfAborted();
        return data;
      } catch {
        deadline.throwIfAborted();
        throw new Error(`LibreTranslate ${path} returned invalid JSON`);
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw new Error(`LibreTranslate ${path} timed out`);
      throw error;
    }
  }

  /**
   * Fetch and validate /languages once per provider instance. A failed
   * check is not cached: a later document retries it (self-hosted
   * instances are often restarting behind proxies).
   */
  private ensureLanguages(signal: AbortSignal | undefined): Promise<readonly LibreLanguage[]> {
    this.languagesRoute ??= this.request('GET', '/languages', undefined, 10_000, signal)
      .then((data) => {
        const languages = parseLanguages(data);
        if (languages === null) {
          throw new Error('LibreTranslate /languages returned a malformed payload');
        }
        Logger.debug(`LibreTranslate: available languages: ${languages.length}`);
        return languages;
      })
      // A trailing catch (not a rejection handler of the same .then) also
      // sees errors thrown by the parser above, so a malformed listing is
      // never cached: a later document retries the route check.
      .catch((value: unknown) => {
        this.languagesRoute = null;
        throw value;
      });
    return this.languagesRoute;
  }

  private async detect(sample: string, signal: AbortSignal | undefined): Promise<string> {
    Logger.debug(`LibreTranslate: detecting language (${sample.length} chars sample)`);
    const language = libreDetectedLanguage(
      await this.request('POST', '/detect', { q: sample }, 10_000, signal),
    );
    if (language === null) {
      throw new Error('LibreTranslate returned a malformed detection payload');
    }
    Logger.debug(`LibreTranslate: detected source language ${language}`);
    return language;
  }
}

// ---------------------------------------------------------------------------
// DeepL — premium quality, requires API key
// ---------------------------------------------------------------------------

/** DeepL accepts at most 50 texts per request. */
const DEEPL_MAX_TEXTS_PER_REQUEST = 50;

/** DeepL accepts request bodies of at most 128 KiB, including metadata. */
const DEEPL_MAX_BODY_BYTES = 128 * 1024;

function deeplSourceLang(sourceLang: string | undefined): string | undefined {
  return sourceLang && sourceLang !== 'auto' ? sourceLang.toUpperCase() : undefined;
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
  private readonly apiUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    // Free-account keys end with ":fx" and must use the free API host;
    // every other key targets the pro API host.
    this.apiUrl = apiKey.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
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
    // Empty-array skeleton: the encoded body is exactly this plus items and
    // ASCII commas, which is what planRequestBatches budgets against.
    const skeleton = upperSource
      ? JSON.stringify({ text: [], target_lang: upperTarget, source_lang: upperSource })
      : JSON.stringify({ text: [], target_lang: upperTarget });
    const batches = planRequestBatches(
      texts,
      new TextEncoder().encode(skeleton).length,
      DEEPL_MAX_TEXTS_PER_REQUEST,
      DEEPL_MAX_BODY_BYTES,
      'DeepL',
    );
    const translated: string[] = [];
    for (const batch of batches) {
      // Abort stops scheduling new batch requests.
      signal?.throwIfAborted();

      const body: Record<string, unknown> = { text: batch, target_lang: upperTarget };
      if (upperSource) body.source_lang = upperSource;

      Logger.debug(`DeepL: POST ${this.apiUrl} with ${batch.length} texts → ${upperTarget}`);
      const res = await fetchRefusingRedirects('DeepL', this.apiUrl, {
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
// MyMemory — opt-in for short lyrics, limited daily quota
// ---------------------------------------------------------------------------

const MYMEMORY_API_URL = 'https://mymemory.translated.net/get';

/** MyMemory accepts at most 500 UTF-8 bytes per query. */
const MYMEMORY_MAX_QUERY_BYTES = 500;

const MYMEMORY_QUOTA_ERROR = 'MyMemory translation quota exhausted; try again after the daily reset';

function mymemoryTranslation(data: unknown): string {
  if (typeof data !== 'object' || data === null) {
    throw new Error('MyMemory returned a malformed translation payload');
  }
  const status = 'responseStatus' in data ? Number(data.responseStatus) : 200;
  const details = 'responseDetails' in data ? data.responseDetails : null;
  if (
    status === 429 ||
    ('quotaFinished' in data && data.quotaFinished === true) ||
    (typeof details === 'string' && /quota|available free translations|usage limit/i.test(details))
  ) {
    throw new Error(MYMEMORY_QUOTA_ERROR);
  }
  if (status !== 200) throw new Error(`MyMemory rejected the translation (status ${status})`);
  const response = 'responseData' in data ? data.responseData : null;
  if (typeof response === 'object' && response !== null && 'translatedText' in response) {
    const result = response.translatedText;
    if (typeof result === 'string' && result.trim() !== '') return result;
  }
  throw new Error('MyMemory returned a malformed translation payload');
}

/** Split only oversized lines, never splitting a UTF-8 code point. */
function* myMemoryChunks(text: string): Generator<string> {
  let start = 0;
  let end = 0;
  let byteLength = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (byteLength + size > MYMEMORY_MAX_QUERY_BYTES) {
      yield text.slice(start, end);
      start = end;
      byteLength = 0;
    }
    end += char.length;
    byteLength += size;
  }
  yield text.slice(start);
}

export class MyMemoryProvider implements TranslationProvider {
  readonly id = 'mymemory';
  readonly name = 'MyMemory';

  async translate(
    text: string,
    targetLang: string,
    sourceLang = 'auto',
    signal?: AbortSignal,
  ): Promise<string> {
    if (text === '') return '';
    // MyMemory has no auto-detection: an unknown source rejects instead of
    // guessing a language the document may not be written in.
    if (!sourceLang || sourceLang === 'auto') {
      throw new Error('MyMemory requires an explicit source language');
    }
    const pair = `${sourceLang}|${targetLang}`;
    if (utf8ByteLength(text) <= MYMEMORY_MAX_QUERY_BYTES) return this.query(text, pair, signal);
    let result = '';
    for (const chunk of myMemoryChunks(text)) {
      const translated = await this.query(chunk, pair, signal);
      result += result === '' ? translated : ` ${translated}`;
    }
    return result;
  }

  private async query(text: string, langPair: string, signal: AbortSignal | undefined) {
    signal?.throwIfAborted();
    const url = `${MYMEMORY_API_URL}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;
    Logger.debug(`MyMemory: GET langpair=${langPair} (${text.length} chars)`);
    const deadline = requestSignal(signal, 10_000);
    const res = await fetchRefusingRedirects('MyMemory', url, { signal: deadline });
    if (res.status === 429) throw new Error(MYMEMORY_QUOTA_ERROR);
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const data: unknown = await res.json();
    deadline.throwIfAborted();
    return mymemoryTranslation(data);
  }

  async translateBatch(
    texts: string[],
    targetLang: string,
    sourceLang = 'auto',
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    Logger.debug(
      `MyMemory: translating ${texts.length} lines independently (≤${MAX_CONCURRENT_LINE_REQUESTS} in flight)`,
    );
    return translateLinesIndependently(
      (text, request) => this.translate(text, targetLang, sourceLang, request),
      texts,
      signal,
    );
  }
}

// ---------------------------------------------------------------------------
// No-op provider and factory
// ---------------------------------------------------------------------------

/**
 * The provider used when no usable external backend is configured ('none',
 * unknown ids, or a provider missing its required endpoint/key). Calling it
 * rejects with the actionable reason; it never performs a network request.
 */
export class NoTranslationProvider implements TranslationProvider {
  readonly id = 'none';
  readonly name = 'No external provider';

  constructor(
    private readonly reason = 'No external translation provider is configured. Use Configure Translation.',
  ) {}

  async translate(): Promise<string> {
    throw new Error(this.reason);
  }

  async translateBatch(texts: string[]): Promise<string[]> {
    if (texts.length === 0) return [];
    throw new Error(this.reason);
  }
}

/**
 * Resolve the configured external translation provider. There is no public
 * default endpoint: 'libretranslate' without an endpoint, 'lingva' without a
 * custom instance, 'deepl' without an API key, 'none', and unknown ids all
 * resolve to the no-op provider whose rejection carries the reason.
 */
export function getTranslationProvider(
  providerId: string,
  options?: TranslationProviderOptions,
): TranslationProvider {
  switch (providerId) {
    case 'deepl':
      return options?.deeplApiKey
        ? new DeepLProvider(options.deeplApiKey)
        : new NoTranslationProvider('DeepL requires an API key.');
    case 'libretranslate': {
      const endpoint = normalizeLibreTranslateEndpoint(options?.libreTranslateEndpoint);
      return endpoint
        ? new LibreTranslateProvider(endpoint)
        : new NoTranslationProvider('LibreTranslate requires a self-hosted endpoint URL.');
    }
    case 'lingva': {
      const instance = options?.lingvaInstance?.trim();
      return instance
        ? new LingvaProvider(instance)
        : new NoTranslationProvider('Lingva requires a custom instance URL.');
    }
    case 'mymemory':
      return new MyMemoryProvider();
    default:
      return new NoTranslationProvider();
  }
}
