import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_LINGVA_INSTANCE,
  DeepLProvider,
  getTranslationProvider,
  LibreTranslateProvider,
  LingvaProvider,
  MyMemoryProvider,
  normalizeLingvaInstance,
} from '../../src/providers/translate';

// Providers never contact real services here: global fetch is replaced with a
// per-test handler and every request is recorded. Deferred responses and
// call-count signals drive concurrency deterministically — no wall-clock waits.

type RecordedCall = { url: string; init: RequestInit | undefined };

const originalFetch = globalThis.fetch;
const calls: RecordedCall[] = [];
let handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () =>
  jsonResponse({});

/** Deferred response releasers for tests that gate requests manually. */
const pendingReleases: Array<() => void> = [];
let callWaiters: Array<{ count: number; resolve: () => void }> = [];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function waitForCalls(count: number): Promise<void> {
  if (calls.length >= count) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  callWaiters.push({ count, resolve });
  return promise;
}

/** Settle every deferred response captured so far. */
function releasePending(): void {
  for (const release of pendingReleases.splice(0)) release();
}

/** Extract the translated source text from a Lingva request URL. */
function lingvaText(url: string): string {
  const segments = new URL(url).pathname.split('/'); // ['', 'api', 'v1', source, target, text]
  return decodeURIComponent(segments[5] ?? '');
}

/** Extract the source text from a MyMemory request URL. */
function myMemoryText(url: string): string {
  return new URL(url).searchParams.get('q') ?? '';
}

interface DeepLRequestBody {
  text: string[];
  target_lang: string;
  source_lang?: string;
}

function deepLBody(init: RequestInit | undefined): DeepLRequestBody {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('DeepL request body must be a JSON string');
  const parsed = JSON.parse(body) as DeepLRequestBody;
  if (!Array.isArray(parsed.text)) throw new Error('DeepL request body must carry a text array');
  return parsed;
}

interface LibreTranslateRequestBody {
  q: string[];
  source: string;
  target: string;
  format: string;
}

function libreBody(init: RequestInit | undefined): LibreTranslateRequestBody {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('LibreTranslate request body must be a JSON string');
  return JSON.parse(body) as LibreTranslateRequestBody;
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

beforeEach(() => {
  calls.length = 0;
  pendingReleases.length = 0;
  callWaiters = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      for (const waiter of callWaiters.splice(0)) {
        if (calls.length >= waiter.count) waiter.resolve();
        else callWaiters.push(waiter);
      }
      return handler(url, init);
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('normalizeLingvaInstance', () => {
  test('defaults to the exported default instance', () => {
    expect(DEFAULT_LINGVA_INSTANCE).toBe('https://lingva.ml');
    expect(normalizeLingvaInstance()).toBe(DEFAULT_LINGVA_INSTANCE);
    expect(normalizeLingvaInstance(null)).toBe(DEFAULT_LINGVA_INSTANCE);
    expect(normalizeLingvaInstance('')).toBe(DEFAULT_LINGVA_INSTANCE);
    expect(normalizeLingvaInstance('   ')).toBe(DEFAULT_LINGVA_INSTANCE);
  });

  test('strips trailing slashes but keeps the rest of the endpoint identity', () => {
    expect(normalizeLingvaInstance('https://lingva.example.com/')).toBe(
      'https://lingva.example.com',
    );
    expect(normalizeLingvaInstance('https://lingva.example.com///')).toBe(
      'https://lingva.example.com',
    );
    expect(normalizeLingvaInstance('https://lingva.example.com/sub//')).toBe(
      'https://lingva.example.com/sub',
    );
  });
});

describe('LingvaProvider', () => {
  test('translates each line independently, in order, with at most four requests in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    handler = (url) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const text = lingvaText(url);
      const { promise, resolve } = Promise.withResolvers<Response>();
      pendingReleases.push(() => {
        inFlight--;
        resolve(jsonResponse({ translation: `${text}!` }));
      });
      return promise;
    };

    const provider = new LingvaProvider('https://lingva.example.com');
    const texts = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
      'eta',
      'theta',
      'iota',
      'kappa',
    ];
    const batch = provider.translateBatch(texts, 'en');

    // Four workers start before any response settles; the cap holds at every round.
    await waitForCalls(4);
    expect(maxInFlight).toBe(4);
    releasePending();
    await waitForCalls(8);
    releasePending();
    await waitForCalls(10);
    releasePending();

    expect(await batch).toEqual(texts.map((text) => `${text}!`));
    expect(calls).toHaveLength(10);
    expect(maxInFlight).toBe(4);
    expect(inFlight).toBe(0);
  });

  test('never joins or splits source lines on newlines', async () => {
    handler = (url) => jsonResponse({ translation: `T:${lingvaText(url)}` });

    const provider = new LingvaProvider();
    const translated = await provider.translateBatch(['first\nsecond', 'third'], 'en');

    expect(translated).toEqual(['T:first\nsecond', 'T:third']);
  });

  test('empty input returns an empty array without a network call', async () => {
    const provider = new LingvaProvider();
    expect(await provider.translateBatch([], 'en')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('empty source lines are returned as-is without a network call', async () => {
    handler = (url) => jsonResponse({ translation: `${lingvaText(url)}!` });

    const provider = new LingvaProvider();
    const translated = await provider.translateBatch(['', 'hello', ''], 'en');

    expect(translated).toEqual(['', 'hello!', '']);
    expect(calls).toHaveLength(1);
  });

  test('uses the configured instance URL and default auto source language', async () => {
    handler = () => jsonResponse({ translation: 'ok' });

    const provider = new LingvaProvider('https://lingva.example.com///');
    await provider.translate('hello', 'en');

    expect(calls[0]?.url).toBe('https://lingva.example.com/api/v1/auto/en/hello');
  });

  test('passes an explicit source language through', async () => {
    handler = () => jsonResponse({ translation: 'ok' });

    const provider = new LingvaProvider('https://lingva.example.com');
    await provider.translate('hello', 'en', 'ja');

    expect(calls[0]?.url).toBe('https://lingva.example.com/api/v1/ja/en/hello');
  });

  test('rejects malformed payloads instead of silently returning empty text', async () => {
    handler = () => jsonResponse({ translation: 42 });
    const provider = new LingvaProvider();
    await expect(provider.translate('hello', 'en')).rejects.toThrow(
      'Lingva returned a malformed translation payload',
    );

    handler = () => jsonResponse({});
    await expect(provider.translate('hello', 'en')).rejects.toThrow(
      'Lingva returned a malformed translation payload',
    );
  });

  test('rejects on HTTP failure', async () => {
    handler = () => jsonResponse({}, 500);
    const provider = new LingvaProvider();
    await expect(provider.translate('hello', 'en')).rejects.toThrow('Lingva HTTP 500');
  });

  test('an already-aborted signal starts no requests', async () => {
    handler = () => jsonResponse({ translation: 'late' });
    const controller = new AbortController();
    controller.abort();

    const provider = new LingvaProvider();
    await expect(
      provider.translateBatch(['a', 'b'], 'en', 'auto', controller.signal),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('aborting mid-flight stops scheduling new requests', async () => {
    const controller = new AbortController();
    handler = (url) => {
      const text = lingvaText(url);
      const { promise, resolve } = Promise.withResolvers<Response>();
      pendingReleases.push(() => resolve(jsonResponse({ translation: text })));
      return promise;
    };

    const provider = new LingvaProvider();
    const batch = provider.translateBatch(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      'en',
      'auto',
      controller.signal,
    );
    await waitForCalls(4);

    // Four requests are already in flight; abort and let them settle.
    controller.abort();
    releasePending();

    await expect(batch).rejects.toThrow();
    expect(calls).toHaveLength(4);
  });
});

describe('LibreTranslateProvider', () => {
  const LANGUAGES = [
    { code: 'en', name: 'English', targets: ['en', 'ja', 'vi'] },
    { code: 'ja', name: 'Japanese', targets: ['en', 'ja'] },
    { code: 'vi', name: 'Vietnamese', targets: ['en', 'vi'] },
  ];

  /** Serve /languages plus an echoing /translate and a fixed /detect. */
  function echoingLibreHandler() {
    handler = (url, init) => {
      if (url.endsWith('/languages')) return jsonResponse(LANGUAGES);
      if (url.endsWith('/translate')) {
        const body = libreBody(init);
        return jsonResponse({ translatedText: body.q.map((text) => `T:${text}`) });
      }
      return jsonResponse([{ confidence: 0.99, language: 'ja' }]);
    };
  }

  test('checks /languages once, then posts ordered arrays to /translate', async () => {
    echoingLibreHandler();
    const provider = new LibreTranslateProvider('https://lt.example.com/');

    const translated = await provider.translateBatch(['uno', 'dos', 'tres'], 'en', 'ja');

    expect(calls.map((call) => call.url)).toEqual([
      'https://lt.example.com/languages',
      'https://lt.example.com/translate',
    ]);
    expect(libreBody(calls[1]?.init)).toEqual({
      q: ['uno', 'dos', 'tres'],
      source: 'ja',
      target: 'en',
      format: 'text',
    });
    expect(translated).toEqual(['T:uno', 'T:dos', 'T:tres']);

    // The route check is cached per provider instance.
    await provider.translateBatch(['cuatro'], 'en', 'ja');
    expect(calls.filter((call) => call.url.endsWith('/languages'))).toHaveLength(1);
  });

  test('an automatic connection test tries an installed source for the selected target', async () => {
    echoingLibreHandler();
    const provider = new LibreTranslateProvider('https://lt.example.com');
    await provider.testConnection('synthetic', 'en', 'auto', new AbortController().signal);
    expect(calls.map(({ url }) => url)).toEqual([
      'https://lt.example.com/languages',
      'https://lt.example.com/translate',
    ]);
    expect(libreBody(calls[1]?.init)).toMatchObject({ source: 'ja', target: 'en', q: ['synthetic'] });
  });

  test('reports an unreachable server without revealing transport details', async () => {
    handler = () => { throw new Error('private endpoint details'); };
    const provider = new LibreTranslateProvider('https://lt.example.com');
    await expect(provider.translate('text', 'en', 'ja')).rejects.toThrow(
      'Cannot reach LibreTranslate; check your network and configured endpoint',
    );
  });

  test('keeps the per-request deadline active while the response body is stalled', async () => {
    const originalTimeout = AbortSignal.timeout;
    const deadline = new AbortController();
    const reading = Promise.withResolvers<void>();
    AbortSignal.timeout = () => deadline.signal;
    try {
      handler = (url, init) => {
        if (url.endsWith('/languages')) return jsonResponse(LANGUAGES);
        return new Response(new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort', () => controller.error(init.signal?.reason), { once: true },
            );
            reading.resolve();
          },
        }));
      };
      const provider = new LibreTranslateProvider('https://lt.example.com');
      const result = provider.translate('text', 'en', 'ja');
      await reading.promise;
      deadline.abort(new DOMException('deadline', 'TimeoutError'));
      await expect(result).rejects.toThrow('LibreTranslate /translate timed out');
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  test('detects the source language exactly once per document when it is not explicit', async () => {
    const samples: string[] = [];
    handler = (url, init) => {
      if (url.endsWith('/languages')) return jsonResponse(LANGUAGES);
      if (url.endsWith('/detect')) {
        samples.push(JSON.parse(String(init?.body)).q);
        return jsonResponse([{ confidence: 0.99, language: 'ja' }]);
      }
      return jsonResponse({ translatedText: libreBody(init).q.map(() => 'ok') });
    };

    const provider = new LibreTranslateProvider('https://lt.example.com');
    await provider.translateBatch(['one line', 'two line'], 'en');

    expect(samples).toEqual(['one line two line']);
    expect(libreBody(calls[2]?.init).source).toBe('ja');

    // A new document re-detects; the /languages route check does not repeat.
    await provider.translateBatch(['other'], 'en');
    expect(samples).toEqual(['one line two line', 'other']);
    expect(calls.filter((call) => call.url.endsWith('/languages'))).toHaveLength(1);
  });

  test('an explicit source language skips detection entirely', async () => {
    echoingLibreHandler();
    const provider = new LibreTranslateProvider('https://lt.example.com');
    await provider.translateBatch(['a'], 'en', 'vi');
    expect(calls.map((call) => call.url)).toEqual([
      'https://lt.example.com/languages',
      'https://lt.example.com/translate',
    ]);
    expect(libreBody(calls[1]?.init).source).toBe('vi');
  });

  test('detection samples at most 4096 UTF-8 bytes of the document', async () => {
    const samples: string[] = [];
    handler = (url, init) => {
      if (url.endsWith('/languages')) return jsonResponse(LANGUAGES);
      if (url.endsWith('/detect')) {
        samples.push(JSON.parse(String(init?.body)).q);
        return jsonResponse([{ confidence: 1, language: 'ja' }]);
      }
      return jsonResponse({ translatedText: libreBody(init).q.map(() => 'ok') });
    };
    const fits = 'a'.repeat(3000);
    const tooBig = 'b'.repeat(3000);

    const provider = new LibreTranslateProvider('https://lt.example.com');
    await provider.translateBatch([fits, tooBig, 'c'], 'en');

    expect(samples).toEqual([`${fits} c`]);
    expect(new TextEncoder().encode(samples[0]).length).toBeLessThanOrEqual(4096);
  });

  test('prefix-truncates a single long nonempty line instead of skipping detection', async () => {
    const samples: string[] = [];
    handler = (url, init) => {
      if (url.endsWith('/languages')) return jsonResponse(LANGUAGES);
      if (url.endsWith('/detect')) {
        samples.push(JSON.parse(String(init?.body)).q);
        return jsonResponse([{ confidence: 1, language: 'ja' }]);
      }
      return jsonResponse({ translatedText: ['ok'] });
    };

    const provider = new LibreTranslateProvider('https://lt.example.com');
    await provider.translateBatch(['x'.repeat(5000)], 'en');
    await provider.translateBatch(['あ'.repeat(1500)], 'en'); // 4500 UTF-8 bytes

    expect(samples[0]).toBe('x'.repeat(4096));
    expect(new TextEncoder().encode(samples[1]).length).toBeLessThanOrEqual(4096);
    expect(samples[1]).not.toContain('\uFFFD');
    // 4095 bytes = 1365 complete three-byte characters, none split.
    expect(Array.from(samples[1])).toHaveLength(1365);
  });

  test('a detection failure rejects the translation without server-side auto fallback', async () => {
    handler = (url) => {
      if (url.endsWith('/languages')) return jsonResponse(LANGUAGES);
      if (url.endsWith('/detect')) return jsonResponse({}, 500);
      return jsonResponse({ translatedText: ['must not be reached'] });
    };

    const provider = new LibreTranslateProvider('https://lt.example.com');
    await expect(provider.translateBatch(['a'], 'en')).rejects.toThrow('LibreTranslate HTTP 500');
    expect(calls.filter((call) => call.url.endsWith('/translate'))).toHaveLength(0);
  });

  test('rejects language pairs the /languages listing does not support', async () => {
    handler = (url, init) => {
      if (url.endsWith('/languages')) return jsonResponse(LANGUAGES);
      if (url.endsWith('/detect')) return jsonResponse([{ confidence: 1, language: 'zh' }]);
      return jsonResponse({ translatedText: libreBody(init).q.map(() => 'nope') });
    };

    const provider = new LibreTranslateProvider('https://lt.example.com');
    await expect(provider.translateBatch(['a'], 'ja', 'vi')).rejects.toThrow(
      'LibreTranslate does not support translating vi → ja',
    );
    // A detected language missing from the listing rejects the same way.
    await expect(provider.translateBatch(['a'], 'ja')).rejects.toThrow(
      'LibreTranslate does not support translating zh → ja',
    );
    expect(calls.filter((call) => call.url.endsWith('/translate'))).toHaveLength(0);
  });

  test('an all-empty document returns without detection or translation', async () => {
    echoingLibreHandler();
    const provider = new LibreTranslateProvider('https://lt.example.com');
    expect(await provider.translateBatch(['', ''], 'en')).toEqual(['', '']);
    expect(calls.map((call) => call.url)).toEqual(['https://lt.example.com/languages']);
  });

  test('rejects when the endpoint does not serve a usable /languages route', async () => {
    handler = () => jsonResponse({}, 404);
    const provider = new LibreTranslateProvider('https://lt.example.com');
    await expect(provider.translateBatch(['a'], 'en', 'ja')).rejects.toThrow(
      /check the endpoint URL and language pair/,
    );
    expect(calls).toHaveLength(1);

    handler = () => jsonResponse({ code: 'en' });
    await expect(provider.translateBatch(['a'], 'en', 'ja')).rejects.toThrow(
      'LibreTranslate /languages returned a malformed payload',
    );

    handler = () => jsonResponse([]);
    await expect(provider.translateBatch(['a'], 'en', 'ja')).rejects.toThrow(
      'LibreTranslate /languages returned a malformed payload',
    );
  });

  test('distinguishes auth, rate-limit, and unsupported-request failures', async () => {
    for (const [status, pattern] of [
      [401, /may require an API key/],
      [403, /may require an API key/],
      [429, /rate limit reached/],
      [400, /language pair/],
      [500, /^LibreTranslate HTTP 500$/],
    ] as const) {
      handler = (url) =>
        url.endsWith('/languages') ? jsonResponse(LANGUAGES) : jsonResponse({}, status);
      const provider = new LibreTranslateProvider('https://lt.example.com');
      await expect(provider.translateBatch(['a'], 'en', 'ja')).rejects.toThrow(pattern);
    }
  });

  test('refuses every HTTP redirect without following or logging the target', async () => {
    for (const location of ['https://evil.example.com/translate', '/v2/translate']) {
      handler = (url) =>
        url.endsWith('/languages') ? jsonResponse(LANGUAGES) : redirectResponse(location);

      const provider = new LibreTranslateProvider('https://lt.example.com');
      await expect(provider.translateBatch(['secret line'], 'en', 'ja')).rejects.toThrow(
        'LibreTranslate refused an HTTP redirect — configure the final endpoint URL directly',
      );
      // The redirect was seen but never followed: only the configured
      // endpoint's own routes were contacted.
      expect(calls.map((call) => call.url)).toEqual([
        'https://lt.example.com/languages',
        'https://lt.example.com/translate',
      ]);
      calls.length = 0;
    }
  });

  test('rejects blank translations of nonempty inputs', async () => {
    handler = (url) =>
      url.endsWith('/languages')
        ? jsonResponse(LANGUAGES)
        : jsonResponse({ translatedText: ['', 'ok'] });
    const provider = new LibreTranslateProvider('https://lt.example.com');
    await expect(provider.translateBatch(['a', 'b'], 'en', 'ja')).rejects.toThrow(
      'LibreTranslate returned a malformed translation payload',
    );
  });

  test('splits 51 texts into ordered 50+1 batches', async () => {
    echoingLibreHandler();
    const provider = new LibreTranslateProvider('https://lt.example.com');
    const texts = Array.from({ length: 51 }, (_, index) => `line-${index}`);
    const translated = await provider.translateBatch(texts, 'en', 'ja');

    const translateCalls = calls.filter((call) => call.url.endsWith('/translate'));
    expect(translateCalls).toHaveLength(2);
    expect(libreBody(translateCalls[0]?.init).q).toHaveLength(50);
    expect(libreBody(translateCalls[1]?.init).q).toEqual(['line-50']);
    expect(translated).toEqual(texts.map((text) => `T:${text}`));
  });

  test('a single text over the body budget rejects explicitly without a translate request', async () => {
    echoingLibreHandler();
    const provider = new LibreTranslateProvider('https://lt.example.com');
    await expect(provider.translateBatch(['x'.repeat(200_000)], 'en')).rejects.toThrow(
      /exceeds 131072 bytes/,
    );
    expect(calls.filter((call) => call.url.endsWith('/translate'))).toHaveLength(0);
  });

  test('rejects payload cardinality mismatches and non-array results', async () => {
    handler = (url) =>
      url.endsWith('/languages')
        ? jsonResponse(LANGUAGES)
        : jsonResponse({ translatedText: ['only one'] });
    const provider = new LibreTranslateProvider('https://lt.example.com');
    await expect(provider.translateBatch(['a', 'b'], 'en', 'ja')).rejects.toThrow(
      'LibreTranslate returned a malformed translation payload',
    );

    handler = () => jsonResponse({ translatedText: 'single' });
    await expect(provider.translateBatch(['a'], 'en', 'ja')).rejects.toThrow(
      'LibreTranslate returned a malformed translation payload',
    );
  });

  test('an already-aborted signal starts no requests at all', async () => {
    echoingLibreHandler();
    const controller = new AbortController();
    controller.abort();
    const provider = new LibreTranslateProvider('https://lt.example.com');
    await expect(provider.translateBatch(['a', 'b'], 'en', 'ja', controller.signal)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('aborting between batches stops scheduling new requests', async () => {
    const controller = new AbortController();
    handler = (url, init) => {
      if (url.endsWith('/languages')) return jsonResponse(LANGUAGES);
      controller.abort();
      const body = libreBody(init);
      return jsonResponse({ translatedText: body.q.map((text) => `T:${text}`) });
    };
    const provider = new LibreTranslateProvider('https://lt.example.com');
    const texts = Array.from({ length: 51 }, (_, index) => `line-${index}`);
    await expect(provider.translateBatch(texts, 'en', 'ja', controller.signal)).rejects.toThrow();
    expect(calls.filter((call) => call.url.endsWith('/translate'))).toHaveLength(1);
  });

  test('empty text and empty batches never touch the network', async () => {
    echoingLibreHandler();
    const provider = new LibreTranslateProvider('https://lt.example.com');
    expect(await provider.translateBatch([], 'en')).toEqual([]);
    expect(await provider.translate('', 'en', 'ja')).toBe('');
    expect(await provider.translate('hello', 'en', 'ja')).toBe('T:hello');
    expect(calls.map((call) => call.url)).toEqual([
      'https://lt.example.com/languages',
      'https://lt.example.com/translate',
    ]);
  });
});

describe('MyMemoryProvider', () => {
  test('translates lines independently in order with the supplied source language', async () => {
    handler = (url) => jsonResponse({ responseData: { translatedText: `E:${myMemoryText(url)}` } });

    const provider = new MyMemoryProvider();
    const translated = await provider.translateBatch(['uno', 'dos'], 'es', 'it');

    expect(translated).toEqual(['E:uno', 'E:dos']);
    expect(calls.map((call) => new URL(call.url).searchParams.get('langpair'))).toEqual([
      'it|es',
      'it|es',
    ]);
  });

  test('honors an explicit source language', async () => {
    handler = () => jsonResponse({ responseData: { translatedText: 'ok' } });

    const provider = new MyMemoryProvider();
    await provider.translate('uno', 'es', 'it');

    expect(new URL(calls[0]?.url ?? '').searchParams.get('langpair')).toBe('it|es');
  });

  test('rejects an unknown source language instead of guessing one', async () => {
    handler = () => jsonResponse({ responseData: { translatedText: 'ok' } });
    const provider = new MyMemoryProvider();
    await expect(provider.translate('uno', 'es', 'auto')).rejects.toThrow(
      'MyMemory requires an explicit source language',
    );
    await expect(provider.translate('uno', 'es', '')).rejects.toThrow(
      'MyMemory requires an explicit source language',
    );
    await expect(provider.translate('uno', 'es')).rejects.toThrow(
      'MyMemory requires an explicit source language',
    );
    expect(calls).toHaveLength(0);
  });

  test('empty input returns an empty array without a network call', async () => {
    const provider = new MyMemoryProvider();
    expect(await provider.translateBatch([], 'es')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('rejects malformed payloads', async () => {
    handler = () => jsonResponse({ responseData: { translatedText: 7 } });
    const provider = new MyMemoryProvider();
    await expect(provider.translate('uno', 'es', 'it')).rejects.toThrow(
      'MyMemory returned a malformed translation payload',
    );
  });

  test('rejects on HTTP failure', async () => {
    handler = () => jsonResponse({}, 503);
    const provider = new MyMemoryProvider();
    await expect(provider.translate('uno', 'es', 'it')).rejects.toThrow('MyMemory HTTP 503');
  });

  test('rejects HTTP 200 application errors instead of returning their text', async () => {
    handler = () =>
      jsonResponse({
        responseStatus: '400',
        responseDetails: 'INVALID LANGUAGE PAIR',
        responseData: { translatedText: 'NOT A TRANSLATION' },
      });
    await expect(new MyMemoryProvider().translate('uno', 'es', 'it')).rejects.toThrow(
      'MyMemory rejected the translation (status 400)',
    );
  });

  test('an HTTP 200 quota error cancels active requests and prevents new ones', async () => {
    const quota = Promise.withResolvers<Response>();
    handler = (url, init) => {
      if (myMemoryText(url) === 'quota') return quota.promise;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    };
    const blocked = new MyMemoryProvider().translateBatch(
      ['quota', 'a', 'b', 'c', 'never'],
      'es',
      'it',
    );
    await waitForCalls(4);
    quota.resolve(
      jsonResponse({
        responseStatus: 403,
        responseDetails: 'YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.',
        responseData: { translatedText: 'QUOTA WARNING' },
      }),
    );
    await expect(blocked).rejects.toThrow('MyMemory translation quota exhausted');
    expect(calls.map((call) => myMemoryText(call.url))).toEqual(['quota', 'a', 'b', 'c']);
    expect(calls.slice(1).every((call) => call.init?.signal?.aborted)).toBe(true);
  });
});

describe('MyMemoryProvider byte budget', () => {
  test('accepts queries of at most 500 UTF-8 bytes', async () => {
    handler = () => jsonResponse({ responseData: { translatedText: 'ok' } });
    const provider = new MyMemoryProvider();
    await provider.translate('a'.repeat(500), 'en', 'es');
    await provider.translate('あ'.repeat(166), 'en', 'ja'); // 498 bytes
    expect(calls).toHaveLength(2);
  });

  test('splits oversized lines at code point boundaries and preserves order', async () => {
    handler = (url) => jsonResponse({ responseData: { translatedText: myMemoryText(url) } });
    const provider = new MyMemoryProvider();
    const first = 'あ'.repeat(166);
    const second = '🎶 and some more lyrics';
    const translated = await provider.translateBatch([first + second, '', 'last'], 'en', 'ja');
    expect(translated).toEqual([`${first} ${second}`, '', 'last']);
    const chunks = calls.map(({ url }) => myMemoryText(url)).filter((text) => text !== 'last');
    expect(chunks).toEqual([first, second]);
    expect(chunks.every((text) => Buffer.byteLength(text, 'utf8') <= 500)).toBe(true);
  });
});

describe('DeepLProvider', () => {
  function echoingHandler() {
    handler = (_url, init) =>
      jsonResponse({
        translations: deepLBody(init).text.map((text) => ({ text: `T:${text}` })),
      });
  }

  test('splits 51 texts into ordered 50+1 batches and preserves order', async () => {
    echoingHandler();

    const provider = new DeepLProvider('test-key');
    const texts = Array.from({ length: 51 }, (_, index) => `line-${index}`);
    const translated = await provider.translateBatch(texts, 'en');

    expect(calls).toHaveLength(2);
    expect(deepLBody(calls[0]?.init).text).toHaveLength(50);
    expect(deepLBody(calls[1]?.init).text).toEqual(['line-50']);
    expect(translated).toEqual(texts.map((text) => `T:${text}`));
  });

  test('splits batches by the 128 KiB encoded-body budget before the 50-text limit', async () => {
    echoingHandler();
    const encoder = new TextEncoder();

    const provider = new DeepLProvider('test-key');
    const texts = ['a'.repeat(60_000), 'b'.repeat(60_000), 'c'.repeat(60_000)];
    const translated = await provider.translateBatch(texts, 'en');

    expect(calls).toHaveLength(2);
    expect(deepLBody(calls[0]?.init).text).toHaveLength(2);
    expect(deepLBody(calls[1]?.init).text).toHaveLength(1);
    for (const call of calls) {
      expect(encoder.encode(String(call.init?.body)).length).toBeLessThanOrEqual(128 * 1024);
    }
    expect(translated).toEqual(texts.map((text) => `T:${text}`));
  });

  test('a single text over the body budget rejects explicitly without a request', async () => {
    echoingHandler();

    const provider = new DeepLProvider('test-key');
    await expect(provider.translateBatch(['x'.repeat(200_000)], 'en')).rejects.toThrow(
      /exceeds 131072 bytes/,
    );
    expect(calls).toHaveLength(0);
  });

  test('rejects a response whose cardinality does not match the request', async () => {
    handler = () => jsonResponse({ translations: [{ text: 'only one' }] });

    const provider = new DeepLProvider('test-key');
    await expect(provider.translateBatch(['a', 'b'], 'en')).rejects.toThrow(
      'DeepL returned a malformed translation payload',
    );
  });

  test('rejects non-string translation values', async () => {
    handler = () => jsonResponse({ translations: [{ text: 1 }, { text: 2 }] });

    const provider = new DeepLProvider('test-key');
    await expect(provider.translateBatch(['a', 'b'], 'en')).rejects.toThrow(
      'DeepL returned a malformed translation payload',
    );
  });

  test('a failed batch rejects the whole translation and stops later batches', async () => {
    handler = () => jsonResponse({}, 429);

    const provider = new DeepLProvider('test-key');
    const texts = Array.from({ length: 51 }, (_, index) => `line-${index}`);
    await expect(provider.translateBatch(texts, 'en')).rejects.toThrow('DeepL HTTP 429');
    expect(calls).toHaveLength(1);
  });

  test('aborting between batches stops scheduling new requests', async () => {
    const controller = new AbortController();
    handler = (_url, init) => {
      controller.abort();
      return jsonResponse({
        translations: deepLBody(init).text.map((text) => ({ text: `T:${text}` })),
      });
    };

    const provider = new DeepLProvider('test-key');
    const texts = Array.from({ length: 51 }, (_, index) => `line-${index}`);
    await expect(provider.translateBatch(texts, 'en', 'auto', controller.signal)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test('uppercases target and source languages and omits auto source', async () => {
    echoingHandler();

    const provider = new DeepLProvider('test-key');
    await provider.translateBatch(['a'], 'es', 'ja');
    expect(deepLBody(calls[0]?.init)).toEqual({
      text: ['a'],
      target_lang: 'ES',
      source_lang: 'JA',
    });

    await provider.translateBatch(['b'], 'es');
    expect(deepLBody(calls[1]?.init)).toEqual({ text: ['b'], target_lang: 'ES' });

    await provider.translateBatch(['c'], 'es', 'auto');
    expect(deepLBody(calls[2]?.init)).toEqual({ text: ['c'], target_lang: 'ES' });
  });

  test('translate delegates to a single-text batch', async () => {
    echoingHandler();

    const provider = new DeepLProvider('test-key');
    expect(await provider.translate('hello', 'en')).toBe('T:hello');
    expect(calls).toHaveLength(1);
    expect(await provider.translate('', 'en')).toBe('');
    expect(calls).toHaveLength(1);
  });

  test('empty input returns an empty array without a network call', async () => {
    echoingHandler();
    const provider = new DeepLProvider('test-key');
    expect(await provider.translateBatch([], 'en')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  test('selects the API endpoint from the key shape', async () => {
    echoingHandler();
    await new DeepLProvider('free-key:fx').translate('a', 'en');
    expect(calls[0]?.url).toBe('https://api-free.deepl.com/v2/translate');
    await new DeepLProvider('pro-key').translate('a', 'en');
    expect(calls[1]?.url).toBe('https://api.deepl.com/v2/translate');
  });

  test('refuses HTTP redirects instead of re-sending the authorized request', async () => {
    handler = () => redirectResponse('https://evil.example.com/v2/translate');
    const provider = new DeepLProvider('key:fx');
    await expect(provider.translateBatch(['a'], 'en')).rejects.toThrow(
      'DeepL refused an HTTP redirect — configure the final endpoint URL directly',
    );
    expect(calls).toHaveLength(1);
  });

});

describe('getTranslationProvider', () => {
  test('resolves configured providers to their concrete implementations', () => {
    expect(getTranslationProvider('deepl', { deeplApiKey: 'key' })).toBeInstanceOf(DeepLProvider);
    expect(getTranslationProvider('mymemory')).toBeInstanceOf(MyMemoryProvider);
    expect(
      getTranslationProvider('libretranslate', {
        libreTranslateEndpoint: 'https://lt.example.com',
      }),
    ).toBeInstanceOf(LibreTranslateProvider);
    expect(
      getTranslationProvider('lingva', { lingvaInstance: 'https://lingva.example.com' }),
    ).toBeInstanceOf(LingvaProvider);
  });

  test('providers without their required configuration resolve to the no-op provider', async () => {
    const unconfigured = [
      getTranslationProvider('none'),
      getTranslationProvider('nonexistent'),
      getTranslationProvider('deepl', {}),
      getTranslationProvider('lingva', {}),
      getTranslationProvider('lingva', { lingvaInstance: '   ' }),
      getTranslationProvider('libretranslate', {}),
    ];
    for (const provider of unconfigured) expect(provider.id).toBe('none');

    // Empty batches resolve without a network call; anything else rejects
    // with the actionable reason.
    expect(await unconfigured[0].translateBatch([], 'en')).toEqual([]);
    expect(calls).toHaveLength(0);
    await expect(unconfigured[0].translate('a', 'en')).rejects.toThrow(
      'No external translation provider is configured.',
    );
    await expect(getTranslationProvider('deepl', {}).translateBatch(['a'], 'en')).rejects.toThrow(
      'DeepL requires an API key.',
    );
    await expect(
      getTranslationProvider('lingva', {}).translateBatch(['a'], 'en'),
    ).rejects.toThrow('Lingva requires a custom instance URL.');
    await expect(
      getTranslationProvider('libretranslate', {}).translateBatch(['a'], 'en'),
    ).rejects.toThrow('LibreTranslate requires a self-hosted endpoint URL.');
    expect(calls).toHaveLength(0);
  });

  test('wires the configured Lingva instance into requests', async () => {
    handler = () => jsonResponse({ translation: 'ok' });

    const provider = getTranslationProvider('lingva', {
      lingvaInstance: 'https://my-lingva.example.com/',
    });
    await provider.translate('hello', 'en');

    expect(calls[0]?.url).toBe('https://my-lingva.example.com/api/v1/auto/en/hello');
  });

  test('wires the configured LibreTranslate endpoint into requests', async () => {
    handler = (url) =>
      url.endsWith('/languages')
        ? jsonResponse([
            { code: 'en', name: 'English', targets: ['en', 'ja'] },
            { code: 'ja', name: 'Japanese', targets: ['en', 'ja'] },
          ])
        : jsonResponse({ translatedText: ['ok'] });

    const provider = getTranslationProvider('libretranslate', {
      libreTranslateEndpoint: 'https://lt.example.com/',
    });
    await provider.translate('hello', 'en', 'ja');

    expect(calls[0]?.url).toBe('https://lt.example.com/languages');
    expect(calls[1]?.url).toBe('https://lt.example.com/translate');
  });
});
