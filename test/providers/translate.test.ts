import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_LINGVA_INSTANCE,
  DeepLProvider,
  getTranslationProvider,
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

describe('MyMemoryProvider', () => {
  test('translates lines independently in order, defaulting the source language to en', async () => {
    handler = (url) => jsonResponse({ responseData: { translatedText: `E:${myMemoryText(url)}` } });

    const provider = new MyMemoryProvider();
    const translated = await provider.translateBatch(['uno', 'dos'], 'es');

    expect(translated).toEqual(['E:uno', 'E:dos']);
    expect(calls.map((call) => new URL(call.url).searchParams.get('langpair'))).toEqual([
      'en|es',
      'en|es',
    ]);
  });

  test('honors an explicit source language', async () => {
    handler = () => jsonResponse({ responseData: { translatedText: 'ok' } });

    const provider = new MyMemoryProvider();
    await provider.translate('uno', 'es', 'it');

    expect(new URL(calls[0]?.url ?? '').searchParams.get('langpair')).toBe('it|es');
  });

  test('empty input returns an empty array without a network call', async () => {
    const provider = new MyMemoryProvider();
    expect(await provider.translateBatch([], 'es')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('rejects malformed payloads', async () => {
    handler = () => jsonResponse({ responseData: { translatedText: 7 } });
    const provider = new MyMemoryProvider();
    await expect(provider.translate('uno', 'es')).rejects.toThrow(
      'MyMemory returned a malformed translation payload',
    );
  });

  test('rejects on HTTP failure', async () => {
    handler = () => jsonResponse({}, 503);
    const provider = new MyMemoryProvider();
    await expect(provider.translate('uno', 'es')).rejects.toThrow('MyMemory HTTP 503');
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
});

describe('getTranslationProvider', () => {
  test('falls back to Lingva when DeepL is selected without an API key', () => {
    const provider = getTranslationProvider('deepl', {});
    expect(provider.id).toBe('lingva');
    expect(provider).toBeInstanceOf(LingvaProvider);
  });

  test('returns DeepL when an API key is configured', () => {
    const provider = getTranslationProvider('deepl', { deeplApiKey: 'key' });
    expect(provider.id).toBe('deepl');
    expect(provider).toBeInstanceOf(DeepLProvider);
  });

  test('returns MyMemory for its id and Lingva for unknown ids', () => {
    expect(getTranslationProvider('mymemory')).toBeInstanceOf(MyMemoryProvider);
    expect(getTranslationProvider('nonexistent')).toBeInstanceOf(LingvaProvider);
  });

  test('wires the configured Lingva instance into requests', async () => {
    handler = () => jsonResponse({ translation: 'ok' });

    const provider = getTranslationProvider('lingva', {
      lingvaInstance: 'https://my-lingva.example.com/',
    });
    await provider.translate('hello', 'en');

    expect(calls[0]?.url).toBe('https://my-lingva.example.com/api/v1/auto/en/hello');
  });
});
