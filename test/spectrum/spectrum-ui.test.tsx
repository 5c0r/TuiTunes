import { expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { Provider } from 'jotai';
import { act } from 'react';
import { DEFAULT_CONFIG } from '../../src/utils/config';
import { configAtom } from '../../src/store/config';
import { spectrumFrameAtom, spectrumStatusAtom } from '../../src/store/spectrum';
import { Spectrum, aggregateBands } from '../../src/ui/Spectrum';
import { createStore } from 'jotai';

const BARS = new Array<number>(32).fill(0).map((_, index) => (index === 20 ? 0.9 : 0));

function frameStore(statusKind: 'active' | 'unavailable' | 'starting' = 'active') {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, spectrumEnabled: true });
  store.set(
    spectrumStatusAtom,
    statusKind === 'active'
      ? { kind: 'active' }
      : statusKind === 'starting'
        ? { kind: 'starting' }
        : { kind: 'unavailable', reason: 'tool-missing', message: 'pw-dump not installed' },
  );
  if (statusKind === 'active') {
    store.set(spectrumFrameAtom, { requestId: 7, lowHz: 50, highHz: 10_000, values: BARS });
  }
  return store;
}

test('aggregateBands keeps neighboring peaks without dropping them', () => {
  const buckets = aggregateBands(BARS, 16);
  expect(buckets).toHaveLength(16);
  expect(buckets[10]).toBeCloseTo(0.9); // the loud band's bucket keeps its peak
  expect(Math.max(...buckets.slice(0, 8))).toBe(0);
});

test('active spectrum renders one real unicode ramp row sized to the component', async () => {
  const store = frameStore('active');
  const setup = await testRender(
    <Provider store={store}>
      <Spectrum />
    </Provider>,
    { width: 100, height: 6 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await act(async () => {
      await setup.renderOnce(); // onSizeChange feedback lands on the second pass
    });
    const frameText = setup.captureCharFrame();
    expect(frameText).toContain('▇'); // measured band, not a fake equalizer
    expect(frameText).not.toContain('starting');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('ascii mode uses the ASCII ramp over the same band data', async () => {
  const store = frameStore('active');
  store.set(configAtom, { ...DEFAULT_CONFIG, spectrumEnabled: true, ascii: true });
  const setup = await testRender(
    <Provider store={store}>
      <Spectrum />
    </Provider>,
    { width: 100, height: 6 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await act(async () => {
      await setup.renderOnce();
    });
    const frameText = setup.captureCharFrame();
    expect(frameText).toContain('%'); // near the top of ' .:-=+*#%@'
    expect(frameText).not.toContain('▇');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('unavailable and starting show one bounded status row', async () => {
  for (const kind of ['unavailable', 'starting'] as const) {
    const store = frameStore(kind);
    const setup = await testRender(
      <Provider store={store}>
        <Spectrum />
      </Provider>,
      { width: 60, height: 6 },
    );
    try {
      await setup.renderOnce();
      const frameText = setup.captureCharFrame();
      expect(frameText).toContain('spectrum');
      if (kind === 'unavailable') expect(frameText).toContain('pw-dump not installed');
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  }
});

test('reduced motion renders no row at all', async () => {
  const store = frameStore('active');
  store.set(configAtom, { ...DEFAULT_CONFIG, spectrumEnabled: true, reducedMotion: true });
  const setup = await testRender(
    <Provider store={store}>
      <Spectrum />
    </Provider>,
    { width: 80, height: 6 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame().trim()).toBe('');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('off renders nothing even when mounted', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, spectrumEnabled: true });
  const setup = await testRender(
    <Provider store={store}>
      <Spectrum />
    </Provider>,
    { width: 80, height: 6 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame().trim()).toBe('');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
