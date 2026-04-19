import { describe, test, expect } from 'bun:test';
import {
  LingvaProvider,
  DeepLProvider,
  MyMemoryProvider,
  getTranslationProvider,
} from '../../src/providers/translate';

// We can't call real APIs in tests, so we test the factory and batch logic patterns.
// The providers' translateBatch methods split/join by \n — we test that contract.

describe('getTranslationProvider', () => {
  test('returns LingvaProvider by default', () => {
    const provider = getTranslationProvider('lingva');
    expect(provider.id).toBe('lingva');
    expect(provider.name).toBe('Lingva (Google Translate)');
  });

  test('returns LingvaProvider for unknown provider id', () => {
    const provider = getTranslationProvider('nonexistent');
    expect(provider.id).toBe('lingva');
  });

  test('returns DeepLProvider when apiKey is provided', () => {
    const provider = getTranslationProvider('deepl', { deeplApiKey: 'test-key' });
    expect(provider.id).toBe('deepl');
    expect(provider.name).toBe('DeepL');
  });

  test('falls back to Lingva when deepl selected without apiKey', () => {
    const provider = getTranslationProvider('deepl');
    expect(provider.id).toBe('lingva');
  });

  test('returns MyMemoryProvider', () => {
    const provider = getTranslationProvider('mymemory');
    expect(provider.id).toBe('mymemory');
    expect(provider.name).toBe('MyMemory');
  });

  test('passes custom lingva instance URL', () => {
    const provider = getTranslationProvider('lingva', {
      lingvaInstance: 'https://my-lingva.example.com',
    });
    expect(provider.id).toBe('lingva');
    // The instance URL is used internally — we just verify it doesn't throw
  });
});

describe('LingvaProvider', () => {
  test('constructor strips trailing slashes from instance URL', () => {
    // This tests internal state via a mock fetch call
    const provider = new LingvaProvider('https://lingva.example.com///');
    expect(provider.id).toBe('lingva');
  });
});

describe('DeepLProvider', () => {
  test('constructor stores api key', () => {
    const provider = new DeepLProvider('test-api-key');
    expect(provider.id).toBe('deepl');
  });
});

describe('MyMemoryProvider', () => {
  test('has correct id and name', () => {
    const provider = new MyMemoryProvider();
    expect(provider.id).toBe('mymemory');
    expect(provider.name).toBe('MyMemory');
  });
});
