import { Logger } from '../utils/logger';

export interface TranslationProvider {
  readonly id: string;
  readonly name: string;
  translate(text: string, targetLang: string, sourceLang?: string): Promise<string>;
  translateBatch(texts: string[], targetLang: string, sourceLang?: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Lingva — free Google Translate proxy, zero config
// ---------------------------------------------------------------------------

const DEFAULT_LINGVA_INSTANCE = 'https://lingva.ml';

export class LingvaProvider implements TranslationProvider {
  readonly id = 'lingva';
  readonly name = 'Lingva (Google Translate)';
  private baseUrl: string;

  constructor(instanceUrl?: string) {
    this.baseUrl = (instanceUrl ?? DEFAULT_LINGVA_INSTANCE).replace(/\/+$/, '');
  }

  async translate(text: string, targetLang: string, sourceLang = 'auto'): Promise<string> {
    const url = `${this.baseUrl}/api/v1/${sourceLang}/${targetLang}/${encodeURIComponent(text)}`;
    Logger.debug(
      `Lingva: GET ${this.baseUrl}/api/v1/${sourceLang}/${targetLang}/... (${text.length} chars)`,
    );
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      Logger.error(`Lingva: HTTP ${res.status} from ${this.baseUrl}`);
      throw new Error(`Lingva HTTP ${res.status}`);
    }
    const data = (await res.json()) as { translation?: string };
    Logger.debug(`Lingva: got ${data.translation?.length ?? 0} chars translated`);
    return data.translation ?? '';
  }

  async translateBatch(
    texts: string[],
    targetLang: string,
    sourceLang = 'auto',
  ): Promise<string[]> {
    // Lingva has no batch endpoint — join lines with \n, translate as one
    Logger.debug(`Lingva: batch translating ${texts.length} lines as single request`);
    const joined = texts.join('\n');
    const translated = await this.translate(joined, targetLang, sourceLang);
    const lines = translated.split('\n');
    // Pad/truncate to match input length
    while (lines.length < texts.length) lines.push('');
    Logger.debug(`Lingva: batch result — ${lines.length} lines (input: ${texts.length})`);
    return lines.slice(0, texts.length);
  }
}

// ---------------------------------------------------------------------------
// DeepL — premium quality, requires API key
// ---------------------------------------------------------------------------

const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';

export class DeepLProvider implements TranslationProvider {
  readonly id = 'deepl';
  readonly name = 'DeepL';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async translate(text: string, targetLang: string, sourceLang?: string): Promise<string> {
    const results = await this.translateBatch([text], targetLang, sourceLang);
    return results[0] ?? '';
  }

  async translateBatch(
    texts: string[],
    targetLang: string,
    sourceLang?: string,
  ): Promise<string[]> {
    const body: Record<string, unknown> = {
      text: texts,
      target_lang: targetLang.toUpperCase(),
    };
    if (sourceLang && sourceLang !== 'auto') {
      body.source_lang = sourceLang.toUpperCase();
    }

    Logger.debug(
      `DeepL: POST ${DEEPL_API_URL} with ${texts.length} texts → ${targetLang.toUpperCase()}`,
    );
    const res = await fetch(DEEPL_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      Logger.error(`DeepL: HTTP ${res.status}`);
      throw new Error(`DeepL HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      translations: Array<{ text: string; detected_source_language?: string }>;
    };

    const detected = data.translations[0]?.detected_source_language;
    Logger.debug(
      `DeepL: got ${data.translations.length} translations${detected ? ` (detected: ${detected})` : ''}`,
    );
    return data.translations.map((t) => t.text);
  }
}

// ---------------------------------------------------------------------------
// MyMemory — free fallback, limited daily quota
// ---------------------------------------------------------------------------

const MYMEMORY_API_URL = 'https://api.mymemory.translated.net/get';

export class MyMemoryProvider implements TranslationProvider {
  readonly id = 'mymemory';
  readonly name = 'MyMemory';

  async translate(text: string, targetLang: string, sourceLang = 'en'): Promise<string> {
    const langPair = `${sourceLang}|${targetLang}`;
    const url = `${MYMEMORY_API_URL}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;
    Logger.debug(`MyMemory: GET langpair=${langPair} (${text.length} chars)`);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      Logger.error(`MyMemory: HTTP ${res.status}`);
      throw new Error(`MyMemory HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      responseData?: { translatedText?: string };
    };
    Logger.debug(
      `MyMemory: got ${data.responseData?.translatedText?.length ?? 0} chars translated`,
    );
    return data.responseData?.translatedText ?? '';
  }

  async translateBatch(texts: string[], targetLang: string, sourceLang = 'en'): Promise<string[]> {
    // MyMemory has no batch endpoint — join lines with \n
    const joined = texts.join('\n');
    const translated = await this.translate(joined, targetLang, sourceLang);
    const lines = translated.split('\n');
    while (lines.length < texts.length) lines.push('');
    return lines.slice(0, texts.length);
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
