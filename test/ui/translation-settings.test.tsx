import { expect, test } from 'bun:test';
import { act } from 'react';
import { configAtom } from '../../src/store/config';
import { favoritesSetAtom } from '../../src/store/library';
import { playerMuteAtom } from '../../src/store/player';
import { queueStateAtom } from '../../src/store/queue';
import { type Overlay, overlayAtom, searchQueryAtom } from '../../src/store/ui';
import { DEFAULT_CONFIG, loadConfig, type TuiTunesConfig } from '../../src/utils/config';
import { renderTestApp, type TestAppHandle } from '../helpers/app';

type SettingsOverlay = Extract<Overlay, { kind: 'translation-settings' }>;

interface Deferred {
  promise: Promise<void>;
  resolve: (value: void | PromiseLike<void>) => void;
  reject: (reason?: unknown) => void;
}

interface TestCall {
  config: TuiTunesConfig;
  signal: AbortSignal;
  finish: Deferred;
}

function settingsOverlay(app: TestAppHandle): SettingsOverlay {
  const overlay = app.store.get(overlayAtom);
  if (overlay?.kind !== 'translation-settings') {
    throw new Error(`Expected translation-settings overlay, got ${overlay?.kind ?? 'none'}`);
  }
  return overlay;
}

/** Replace the lyrics session's connection test with a deferred boundary. */
function patchTestTranslation(app: TestAppHandle, calls: TestCall[]): void {
  const session = app.runtime.lyrics as unknown as {
    testTranslation: (config: TuiTunesConfig, signal: AbortSignal) => Promise<void>;
  };
  session.testTranslation = (config, signal) => {
    const finish = Promise.withResolvers<void>();
    calls.push({ config, signal, finish });
    return finish.promise;
  };
}

async function pressEnter(app: TestAppHandle): Promise<void> {
  await act(async () => {
    app.mockInput.pressEnter();
    await Promise.resolve();
  });
  await app.renderOnce();
}

async function pressEscape(app: TestAppHandle): Promise<void> {
  // Escape is delivered asynchronously after the terminal parser's
  // sequence-ambiguity window; await the resulting overlay change.
  const closed = Promise.withResolvers<void>();
  const unsubscribe = app.store.sub(overlayAtom, () => {
    if (app.store.get(overlayAtom) === null) closed.resolve();
  });
  const timer = setTimeout(() => closed.reject(new Error('Escape did not close overlay')), 1000);
  try {
    await act(async () => {
      app.mockInput.pressEscape();
      await closed.promise;
    });
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  await app.renderOnce();
}

async function pressKey(app: TestAppHandle, key: string): Promise<void> {
  await act(async () => {
    app.mockInput.pressKey(key);
  });
  await app.renderOnce();
}

async function pressArrow(
  app: TestAppHandle,
  direction: 'up' | 'down' | 'left' | 'right',
): Promise<void> {
  await act(async () => {
    app.mockInput.pressArrow(direction);
  });
  await app.renderOnce();
}

async function typeText(app: TestAppHandle, text: string): Promise<void> {
  await act(async () => {
    await app.mockInput.typeText(text);
  });
  await app.renderOnce();
}

async function command(app: TestAppHandle, query: string): Promise<void> {
  await act(async () => {
    app.mockInput.pressKey('p', { ctrl: true });
  });
  await app.renderOnce();
  await typeText(app, query);
  await pressEnter(app);
}

async function openSettings(app: TestAppHandle): Promise<SettingsOverlay> {
  await command(app, 'configure translation');
  return settingsOverlay(app);
}

/** Moves selection from `from` to `to` in [provider,target,source,endpoint,key,test,save,cancel]. */
const FIELD_INDEX: Record<SettingsOverlay['field'], number> = {
  provider: 0,
  target: 1,
  source: 2,
  endpoint: 3,
  key: 4,
  test: 5,
  save: 6,
  cancel: 7,
};

async function moveTo(app: TestAppHandle, field: SettingsOverlay['field']): Promise<void> {
  let remaining = FIELD_INDEX[field] - FIELD_INDEX[settingsOverlay(app).field];
  const direction = remaining > 0 ? 'down' : 'up';
  while (remaining !== 0) {
    await pressArrow(app, direction);
    remaining += remaining > 0 ? -1 : 1;
  }
}
/** Enter the field's edit mode, type a value, and commit it with Enter. */
async function editField(
  app: TestAppHandle,
  field: SettingsOverlay['field'],
  value: string,
): Promise<void> {
  await moveTo(app, field);
  await pressEnter(app); // start editing
  await typeText(app, value);
  await pressEnter(app); // commit
  expect(settingsOverlay(app).editing).toBe(false);
}

test('configure translation saves provider, target and source through the config file', async () => {
  const app = await renderTestApp();
  try {
    const overlay = await openSettings(app);
    expect(overlay.provider).toBe('none'); // default provider disables translation
    expect(overlay.field).toBe('provider');

    await pressArrow(app, 'right'); // none -> libretranslate
    await pressArrow(app, 'right'); // libretranslate -> lingva
    await pressArrow(app, 'right'); // lingva -> mymemory
    expect(settingsOverlay(app).provider).toBe('mymemory');
    await editField(app, 'target', 'VI');
    await editField(app, 'source', 'en');

    await moveTo(app, 'save');
    await pressEnter(app);

    expect(app.store.get(overlayAtom)).toBeNull();
    const saved = app.store.get(configAtom);
    expect(saved.translationProvider).toBe('mymemory');
    expect(saved.translationLanguage).toBe('vi');
    expect(saved.translationSourceLanguage).toBe('en');
    const persisted = loadConfig();
    expect(persisted.translationProvider).toBe('mymemory');
    expect(persisted.translationLanguage).toBe('vi');
    expect(persisted.translationSourceLanguage).toBe('en');
  } finally {
    await app.cleanup();
  }
});

test('stored endpoints are preserved per provider and never implicitly proxied', async () => {
  const app = await renderTestApp();
  try {
    await act(async () => {
      app.store.set(configAtom, {
        ...DEFAULT_CONFIG,
        translationProvider: 'deepl',
        deeplApiKey: 'stored-key',
        lingvaInstance: 'https://lingva.custom.example',
      });
    });
    const overlay = await openSettings(app);
    expect(overlay.provider).toBe('deepl');
    expect(overlay.endpoint).toBe('');

    await pressArrow(app, 'left'); // deepl -> mymemory
    await pressArrow(app, 'left'); // mymemory -> lingva seeds the stored instance
    expect(settingsOverlay(app).provider).toBe('lingva');
    expect(settingsOverlay(app).endpoint).toBe('https://lingva.custom.example');

    await editField(app, 'target', 'en');
    await moveTo(app, 'save');
    await pressEnter(app);

    const persisted = loadConfig();
    expect(persisted.translationProvider).toBe('lingva');
    expect(persisted.lingvaInstance).toBe('https://lingva.custom.example');
  } finally {
    await app.cleanup();
  }
});

test('save validation is actionable, keeps the form open, and blocks bad endpoints', async () => {
  const app = await renderTestApp();
  try {
    await openSettings(app);
    await pressArrow(app, 'right'); // none -> libretranslate needs target + endpoint
    await moveTo(app, 'save');
    await pressEnter(app);

    let overlay = settingsOverlay(app);
    expect(overlay.error).toBe('Enter a target language code (e.g. en, vi)');
    expect(app.captureCharFrame()).toContain('Enter a target language code');

    await editField(app, 'target', 'vi');
    await moveTo(app, 'save');
    await pressEnter(app);

    overlay = settingsOverlay(app);
    expect(overlay.error).toBe('LibreTranslate needs its server URL (e.g. http://127.0.0.1:5000)');
    expect(app.store.get(configAtom).translationProvider).toBe(DEFAULT_CONFIG.translationProvider);

    await editField(app, 'endpoint', 'http://127.0.0.1:5000');
    await moveTo(app, 'save');
    await pressEnter(app);

    expect(app.store.get(overlayAtom)).toBeNull();
    expect(loadConfig().translationProvider).toBe('libretranslate');
    expect(loadConfig().libreTranslateEndpoint).toBe('http://127.0.0.1:5000');
  } finally {
    await app.cleanup();
  }
});

test('DeepL key stays private: stored secret is never re-displayed', async () => {
  const app = await renderTestApp();
  try {
    await act(async () => {
      app.store.set(configAtom, {
        ...DEFAULT_CONFIG,
        translationProvider: 'deepl',
        deeplApiKey: 'secret-key-123',
      });
    });
    await openSettings(app);
    expect(settingsOverlay(app).keySet).toBe(true);
    let frame = app.captureCharFrame();
    expect(frame).toContain('set (hidden)');
    expect(frame).not.toContain('secret-key-123');

    await editField(app, 'key', 'new-secret-456');
    await editField(app, 'target', 'de');
    await moveTo(app, 'save');
    await pressEnter(app);
    expect(app.store.get(overlayAtom)).toBeNull();
    expect(loadConfig().deeplApiKey).toBe('new-secret-456');

    await openSettings(app);
    frame = app.captureCharFrame();
    expect(frame).toContain('set (hidden)');
    expect(frame).not.toContain('new-secret-456');
  } finally {
    await app.cleanup();
  }
});

test('manual Test Connection shows status, gates on validation, and aborts stale on draft edit', async () => {
  const calls: TestCall[] = [];
  const app = await renderTestApp();
  patchTestTranslation(app, calls);
  try {
    await act(async () => {
      app.store.set(configAtom, { ...DEFAULT_CONFIG, translationProvider: 'lingva' });
    });
    await openSettings(app);
    expect(calls).toHaveLength(0); // no startup traffic; only explicit Enter tests

    await editField(app, 'target', 'en');
    await editField(app, 'endpoint', 'https://lingva.example');
    await moveTo(app, 'test');
    await pressEnter(app);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.config.translationProvider).toBe('lingva');
    expect(calls[0]!.config.lingvaInstance).toBe('https://lingva.example');
    expect(calls[0]!.config.translationLanguage).toBe('en');
    expect(settingsOverlay(app).test.state).toBe('running');
    expect(app.captureCharFrame()).toContain('Testing');

    // Editing the draft while running aborts the stale request and resets
    // status. Provider cycling happens on the provider row.
    await moveTo(app, 'provider');
    await pressArrow(app, 'left'); // lingva -> libretranslate
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(settingsOverlay(app).test.state).toBe('idle');
    expect(app.captureCharFrame()).not.toContain('Testing');

    // Switching providers must not forward the previous provider's endpoint.
    expect(settingsOverlay(app).endpoint).toBe('');
    await editField(app, 'endpoint', 'http://127.0.0.1:5000');
    await moveTo(app, 'test');
    await pressEnter(app);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.config.translationProvider).toBe('libretranslate');
    expect(calls[1]!.config.libreTranslateEndpoint).toBe('http://127.0.0.1:5000');

    await act(async () => {
      calls[1]!.finish.resolve();
      await Promise.resolve();
    });
    await app.renderOnce();
    expect(settingsOverlay(app).test.state).toBe('ok');
    expect(app.captureCharFrame()).toContain('Connection OK');

    await editField(app, 'source', 'ja');
    expect(settingsOverlay(app).test.state).toBe('idle');
    expect(app.captureCharFrame()).not.toContain('Connection OK');
    await moveTo(app, 'test');

    // Provider failures surface their message; a newer request cannot show stale status.
    await pressEnter(app); // test again
    expect(calls).toHaveLength(3);
    await act(async () => {
      calls[2]!.finish.reject(new Error('provider down'));
      await Promise.resolve();
    });
    await app.renderOnce();
    expect(settingsOverlay(app).test).toMatchObject({ state: 'error', message: 'provider down' });
    expect(app.captureCharFrame()).toContain('provider down');
  } finally {
    await app.cleanup();
  }
});

test('Test Connection gates on provider none and missing endpoints without requests', async () => {
  const calls: TestCall[] = [];
  const app = await renderTestApp();
  patchTestTranslation(app, calls);
  try {
    await openSettings(app); // default provider: none
    await moveTo(app, 'test');
    await pressEnter(app);
    expect(calls).toHaveLength(0);
    expect(settingsOverlay(app).test).toMatchObject({
      state: 'error',
      message: 'Pick an external provider to test',
    });
    expect(app.captureCharFrame()).toContain('Pick an external provider to test');

    await moveTo(app, 'provider');
    await pressArrow(app, 'right'); // none -> libretranslate
    await editField(app, 'target', 'vi');
    await moveTo(app, 'test');
    await pressEnter(app);
    expect(calls).toHaveLength(0);
    expect(settingsOverlay(app).test).toMatchObject({
      state: 'error',
      message: 'LibreTranslate needs its server URL (e.g. http://127.0.0.1:5000)',
    });
  } finally {
    await app.cleanup();
  }
});

test('escape aborts a running test; open-form keys never leak into playback or search', async () => {
  const calls: TestCall[] = [];
  const app = await renderTestApp();
  patchTestTranslation(app, calls);
  const favoritesBefore = app.store.get(favoritesSetAtom);
  try {
    await act(async () => {
      app.store.set(configAtom, { ...DEFAULT_CONFIG, translationProvider: 'lingva' });
    });
    await openSettings(app);
    await pressKey(app, 'm');
    await pressKey(app, 'q');
    await pressKey(app, 'space');
    await pressKey(app, 'f');
    expect(app.store.get(overlayAtom)?.kind).toBe('translation-settings');
    expect(app.store.get(playerMuteAtom)).toBe(false);
    expect(app.store.get(queueStateAtom).entries).toHaveLength(0);
    expect(app.store.get(favoritesSetAtom)).toBe(favoritesBefore);

    // Text typed while editing lands in the field, not the search input.
    await editField(app, 'target', 'ja');
    expect(settingsOverlay(app).targetLanguage).toBe('ja');
    expect(app.store.get(searchQueryAtom)).toBe('');

    await editField(app, 'endpoint', 'https://lingva.example');
    await moveTo(app, 'test');
    await pressEnter(app);
    expect(settingsOverlay(app).test.state).toBe('running');

    await pressEscape(app);
    expect(app.store.get(overlayAtom)).toBeNull();
    expect(calls[0]!.signal.aborted).toBe(true);
  } finally {
    await app.cleanup();
  }
});

test('cancel discards the draft without touching saved configuration', async () => {
  const app = await renderTestApp();
  try {
    // The form stays usable on narrow terminals.
    await act(async () => {
      app.resize(62, 16);
    });
    await app.renderOnce();
    await openSettings(app);
    const narrow = app.captureCharFrame();
    expect(narrow).toContain('Translation Settings');
    expect(narrow).toContain('Provider');
    expect(narrow).toContain('Test Connection');
    expect(narrow).toContain('Save');

    await pressArrow(app, 'right'); // none -> libretranslate
    await editField(app, 'target', 'ko');
    const before = app.store.get(configAtom);

    await moveTo(app, 'cancel');
    await pressEnter(app);

    expect(app.store.get(overlayAtom)).toBeNull();
    expect(app.store.get(configAtom)).toStrictEqual(before);
  } finally {
    await app.cleanup();
  }
});
