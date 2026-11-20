import type { ScrollBoxRenderable } from '@opentui/core';
import { expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { createStore, Provider } from 'jotai';
import { act } from 'react';
import type React from 'react';
import type { Episode } from '../../src/providers/podcast-types';
import type { Track } from '../../src/providers/types';
import { configAtom } from '../../src/store/config';
import {
  lyricsDocumentAtom,
  lyricsLoadingAtom,
  translationEnabledAtom,
  lyricsTranslationAtom,
} from '../../src/store/lyrics';
import { playerPlaybackAtom } from '../../src/store/player';
import type { Overlay } from '../../src/store/ui';
import { CommandPalette } from '../../src/ui/CommandPalette';
import { Header } from '../../src/ui/Header';
import { HelpOverlay } from '../../src/ui/HelpOverlay';
import { Lyrics } from '../../src/ui/Lyrics';
import {
  ASCII_BORDER_CHARS,
  asciiText,
  borderPropsFor,
  scrollbarPropsFor,
  spinnerFramesFor,
  toggleStatusLabel,
  toggleStatusFor,
} from '../../src/ui/presentation';
import { QuitConfirm } from '../../src/ui/QuitConfirm';
import { SeekInput } from '../../src/ui/SeekInput';
import { Sidebar } from '../../src/ui/Sidebar';
import { SourcePicker } from '../../src/ui/SourcePicker';
import { TrackList } from '../../src/ui/TrackList';
import { Transcript } from '../../src/ui/Transcript';
import { TranslationLanguageInput } from '../../src/ui/TranslationLanguageInput';
import { usePresentation, type Presentation } from '../../src/ui/usePresentation';
import { DEFAULT_CONFIG } from '../../src/utils/config';

const CHROME_GLYPHS = '▶⏸⟳⏹♪🎙♥⟲📋📜▸│—•·→⚠🔇🔊🔁🔂🔀━─●⣿✓↑↓';

function expectNoChromeGlyphs(frame: string): void {
  const offender = [...frame].find((ch) => CHROME_GLYPHS.includes(ch));
  expect(offender).toBeUndefined();
}

test('asciiText converts known chrome literals only', () => {
  expect(asciiText('▶')).toBe('>');
  expect(asciiText('✓')).toBe('v');
  expect(asciiText('⏸')).toBe('||');
  expect(asciiText('♪')).toBe('#');
  expect(asciiText('🎙')).toBe('P');
  expect(asciiText('♥')).toBe('*');
  expect(asciiText('⟲')).toBe('^');
  expect(asciiText('📋')).toBe('F');
  expect(asciiText('📜')).toBe('E');
  expect(asciiText('▸')).toBe('>');
  expect(asciiText('│')).toBe('|');
  expect(asciiText('—')).toBe('-');
  expect(asciiText('•')).toBe('*');
  expect(asciiText('·')).toBe('*');
  expect(asciiText('→')).toBe('->');
  expect(asciiText('⚠')).toBe('!');
  expect(asciiText('🔇')).toBe('[M]');
  expect(asciiText('🔊')).toBe('[V]');
  expect(asciiText('🔁')).toBe('[R]');
  expect(asciiText('🔂')).toBe('[R1]');
  expect(asciiText('🔀')).toBe('[S]');
  expect(asciiText('━')).toBe('=');
  expect(asciiText('─')).toBe('-');
  expect(asciiText('●')).toBe('o');
  // Composed registry chrome converts in place.
  expect(asciiText('Off → All → Track')).toBe('Off -> All -> Track');
  // Unknown and user/media text is untouched.
  expect(asciiText('Café del Mar 中文 ☕')).toBe('Café del Mar 中文 ☕');
  expect(asciiText('no special literals')).toBe('no special literals');
});

test('ASCII borders use all eleven fields of +, -, |', () => {
  const chars = Object.values(ASCII_BORDER_CHARS);
  expect(chars).toHaveLength(11);
  for (const value of chars) {
    expect(['+', '-', '|']).toContain(value);
  }
  expect(Object.keys(ASCII_BORDER_CHARS).sort()).toEqual(
    [
      'topLeft',
      'topRight',
      'bottomLeft',
      'bottomRight',
      'horizontal',
      'vertical',
      'topT',
      'bottomT',
      'leftT',
      'rightT',
      'cross',
    ].sort(),
  );
});

test('border and scrollbar props switch on ASCII mode', () => {
  expect(borderPropsFor(false)).toEqual({});
  const asciiBorder = borderPropsFor(true);
  expect(asciiBorder.borderStyle).toBe('single');
  expect(asciiBorder.customBorderChars).toBe(ASCII_BORDER_CHARS);

  expect(scrollbarPropsFor(false)).toEqual({});
  expect(scrollbarPropsFor(true)).toEqual({ scrollbarOptions: { visible: false } });
});

test('toggle status labels cover on, off and effectively-disabled', () => {
  expect(toggleStatusLabel('on')).toBe('On');
  expect(toggleStatusLabel('off')).toBe('Off');
  expect(toggleStatusLabel('suppressed')).toBe('On (inactive)');

  expect(toggleStatusFor('toggle-ascii', DEFAULT_CONFIG)).toBe('off');
  expect(toggleStatusFor('toggle-reduced-motion', DEFAULT_CONFIG)).toBe('off');
  expect(toggleStatusFor('toggle-spectrum', DEFAULT_CONFIG)).toBe('off');

  const allOn = { ...DEFAULT_CONFIG, ascii: true, reducedMotion: true, spectrumEnabled: true };
  expect(toggleStatusFor('toggle-ascii', allOn)).toBe('on');
  expect(toggleStatusFor('toggle-reduced-motion', allOn)).toBe('on');
  expect(toggleStatusFor('toggle-spectrum', allOn)).toBe('suppressed');

  const spectrumOnly = { ...DEFAULT_CONFIG, spectrumEnabled: true };
  expect(toggleStatusFor('toggle-spectrum', spectrumOnly)).toBe('on');
});

test('spinner frames are mode-specific', () => {
  const unicode = spinnerFramesFor(false);
  const ascii = spinnerFramesFor(true);
  expect(unicode).not.toBe(ascii);
  for (const frame of ascii) {
    for (const ch of frame) {
      expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0x7f);
    }
  }
  expect(unicode.some((frame) => [...frame].some((ch) => ch.codePointAt(0)! > 0x7f))).toBe(true);
});

test('usePresentation reads both flags from config', async () => {
  const store = createStore();
  let captured: Presentation | null = null;
  const Probe = (): React.ReactNode => {
    captured = usePresentation();
    return null;
  };
  const setup = await testRender(
    <Provider store={store}>
      <Probe />
    </Provider>,
    { width: 40, height: 10 },
  );
  try {
    await setup.renderOnce();
    expect(captured!.ascii).toBe(false);
    expect(captured!.reducedMotion).toBe(false);
    expect(captured!.text('♪')).toBe('♪');
    expect(captured!.borderProps).toEqual({});
    expect(captured!.scrollbarProps).toEqual({});

    await act(async () => {
      store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true, reducedMotion: true });
    });
    await setup.renderOnce();
    expect(captured!.ascii).toBe(true);
    expect(captured!.reducedMotion).toBe(true);
    expect(captured!.text('♪')).toBe('#');
    expect(captured!.borderProps).toEqual(borderPropsFor(true));
    expect(captured!.scrollbarProps).toEqual(scrollbarPropsFor(true));
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

function ScrollProbe(props: {
  scrollRef: React.RefObject<ScrollBoxRenderable | null>;
  rows: number;
}): React.ReactNode {
  const p = usePresentation(props.scrollRef);
  return (
    <scrollbox ref={props.scrollRef} height={6} {...p.scrollbarProps}>
      {Array.from({ length: props.rows }, (_, i) => (
        <text key={i}>scroll row {i}</text>
      ))}
    </scrollbox>
  );
}

test('mounted scrollbars regain native auto visibility after ASCII toggles off', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  const overflowRef: React.RefObject<ScrollBoxRenderable | null> = { current: null };
  const setup = await testRender(
    <Provider store={store}>
      <ScrollProbe scrollRef={overflowRef} rows={40} />
    </Provider>,
    { width: 30, height: 10 },
  );
  try {
    await setup.renderOnce();
    // Overflowing content, but ASCII mode hides both native thumbs.
    expect(overflowRef.current!.verticalScrollBar.visible).toBe(false);
    expect(overflowRef.current!.horizontalScrollBar.visible).toBe(false);

    await act(async () => {
      store.set(configAtom, DEFAULT_CONFIG);
    });
    await setup.renderOnce();
    // Same mounted instance: the removed prop is a no-op, so the hook's
    // resetVisibilityControl() must restore native auto visibility — the
    // overflowing vertical bar shows again instead of staying stuck hidden.
    expect(overflowRef.current!.verticalScrollBar.visible).toBe(true);
    expect(overflowRef.current!.horizontalScrollBar.visible).toBe(false);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }

  // Fitting content must return to the native auto-hidden state, not be
  // pinned visible by the ASCII-to-Unicode transition.
  const fitStore = createStore();
  fitStore.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  const fitRef: React.RefObject<ScrollBoxRenderable | null> = { current: null };
  const fitSetup = await testRender(
    <Provider store={fitStore}>
      <ScrollProbe scrollRef={fitRef} rows={3} />
    </Provider>,
    { width: 30, height: 10 },
  );
  try {
    await fitSetup.renderOnce();
    expect(fitRef.current!.verticalScrollBar.visible).toBe(false);
    await act(async () => {
      fitStore.set(configAtom, DEFAULT_CONFIG);
    });
    await fitSetup.renderOnce();
    expect(fitRef.current!.verticalScrollBar.visible).toBe(false);
    expect(fitRef.current!.horizontalScrollBar.visible).toBe(false);
  } finally {
    await act(async () => {
      fitSetup.renderer.destroy();
    });
  }
});

const TRACKS: Track[] = [
  {
    id: 'a',
    provider: 'youtube',
    source: { kind: 'youtube', videoId: 'a' },
    title: 'Song A',
    artist: 'Artist A',
    album: 'Album A',
    duration: 61,
  },
  {
    id: 'b',
    provider: 'youtube',
    source: { kind: 'youtube', videoId: 'b' },
    title: 'Song B',
    artist: 'Artist B',
    duration: 62,
  },
];

test('TrackList and Sidebar render ASCII chrome without touching content', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  const setup = await testRender(
    <Provider store={store}>
      <Sidebar focused={false} section="music" activeView="library" />
      <TrackList tracks={TRACKS} focused={false} selectedIndex={0} playingIndex={1} />
    </Provider>,
    { width: 60, height: 14 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('# Music');
    expect(frame).toContain('* Favorites');
    expect(frame).toContain('Song A');
    expect(frame).toContain('Album A');
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('Sidebar and Header keep Unicode chrome when ASCII is off', async () => {
  const store = createStore();
  const inputRef = { current: null };
  const setup = await testRender(
    <Provider store={store}>
      <Header
        focused={false}
        inputRef={inputRef}
        section="music"
        query=""
        onInput={(): void => {}}
      />
      <Sidebar focused={false} section="podcast" activeView="feeds" />
    </Provider>,
    { width: 60, height: 14 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('♪ Music');
    expect(frame).toContain('🎙 Podcast');
    expect(frame).toContain('📋 My Feeds');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('palette and help convert app-owned labels in ASCII mode', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  const palette = await testRender(
    <Provider store={store}>
      <CommandPalette filter="repeat" selectedIdx={0} onFilterChange={(): void => {}} />
    </Provider>,
    { width: 110, height: 40 },
  );
  try {
    await palette.renderOnce();
    const frame = palette.captureCharFrame();
    expect(frame).toContain('Off -> All -> Track');
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      palette.renderer.destroy();
    });
  }

  const help = await testRender(
    <Provider store={store}>
      <HelpOverlay />
    </Provider>,
    { width: 110, height: 40 },
  );
  try {
    await help.renderOnce();
    const frame = help.captureCharFrame();
    expect(frame).toContain('* mouse wheel scroll');
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      help.renderer.destroy();
    });
  }
});

test('palette and help show live toggle states without squeezing names', async () => {
  const store = createStore();
  const palette = await testRender(
    <Provider store={store}>
      <CommandPalette filter="ascii" selectedIdx={0} onFilterChange={(): void => {}} />
    </Provider>,
    { width: 46, height: 20 },
  );
  try {
    await palette.renderOnce();
    const frame = palette.captureCharFrame();
    expect(frame).toContain('Toggle ASCII Mode');
    expect(frame).toContain('[Off]');

    await act(async () => {
      store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
    });
    await palette.renderOnce();
    expect(palette.captureCharFrame()).toContain('[On]');
  } finally {
    await act(async () => {
      palette.renderer.destroy();
    });
  }

  const spectrumStore = createStore();
  spectrumStore.set(configAtom, {
    ...DEFAULT_CONFIG,
    spectrumEnabled: true,
    reducedMotion: true,
  });
  const spectrum = await testRender(
    <Provider store={spectrumStore}>
      <CommandPalette filter="spectrum" selectedIdx={0} onFilterChange={(): void => {}} />
    </Provider>,
    { width: 60, height: 20 },
  );
  try {
    await spectrum.renderOnce();
    expect(spectrum.captureCharFrame()).toContain('[On (inactive)]');
  } finally {
    await act(async () => {
      spectrum.renderer.destroy();
    });
  }

  const helpStore = createStore();
  const help = await testRender(
    <Provider store={helpStore}>
      <HelpOverlay />
    </Provider>,
    { width: 110, height: 44 },
  );
  try {
    await help.renderOnce();
    const frame = help.captureCharFrame();
    expect(frame).toContain('Toggle Reduced Motion');
    expect(frame).toContain('Toggle Audio Spectrum');
    expect(frame).toContain('[Off]');
  } finally {
    await act(async () => {
      help.renderer.destroy();
    });
  }
});

test('quit, seek and translation dialogs convert app-owned labels in ASCII mode', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  const quit = await testRender(
    <Provider store={store}>
      <QuitConfirm visible={true} />
    </Provider>,
    { width: 60, height: 14 },
  );
  try {
    await quit.renderOnce();
    const frame = quit.captureCharFrame();
    expect(frame).toContain('Are you sure you want to quit?');
    expect(frame).toContain('+'); // ASCII border corner
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      quit.renderer.destroy();
    });
  }

  const seek = await testRender(
    <Provider store={store}>
      <SeekInput value="1:30" onInput={(): void => {}} />
    </Provider>,
    { width: 60, height: 14 },
  );
  try {
    await seek.renderOnce();
    const frame = seek.captureCharFrame();
    expect(frame).toContain('-> 1:30');
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      seek.renderer.destroy();
    });
  }

  const translation = await testRender(
    <Provider store={store}>
      <TranslationLanguageInput value="vi" currentLang="en" onInput={(): void => {}} />
    </Provider>,
    { width: 60, height: 14 },
  );
  try {
    await translation.renderOnce();
    const frame = translation.captureCharFrame();
    expect(frame).toContain('-> Vietnamese');
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      translation.renderer.destroy();
    });
  }
});

test('lyrics and transcript chrome convert while lines stay verbatim', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true, translationLanguage: 'vi' });
  store.set(translationEnabledAtom, true);
  store.set(lyricsDocumentAtom, {
    mediaKey: '["youtube","a"]',
    sourceKey: 'src',
    contentHash: 'hash-1',
    original: {
      synced: true,
      source: 'lrclib',
      sourceUrl: 'https://lyrics.example/42',
      lines: [
        { time: 0, text: 'First line é' },
        { time: 10, text: 'Second line 中文.' },
      ],
    },
  });
  store.set(lyricsTranslationAtom, {
    documentKey: JSON.stringify(['["youtube","a"]', 'hash-1']),
    targetLang: 'vi',
    engineKey: 'engine',
    lines: ['První řádek', 'Druhý řádek'],
  });
  const setup = await testRender(
    <Provider store={store}>
      <Lyrics />
    </Provider>,
    { width: 60, height: 16 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('First line é');
    expect(frame).toContain('Second line 中文.');
    expect(frame).toContain('První řádek');
    expect(frame).toContain('-> VI');
    expect(frame).toContain('#'); // active-line marker
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('transcript loading state renders ASCII chrome', async () => {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii: true });
  store.set(lyricsLoadingAtom, true);
  const setup = await testRender(
    <Provider store={store}>
      <Transcript />
    </Provider>,
    { width: 60, height: 10 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Loading transcript...');
    expectNoChromeGlyphs(frame);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

const EPISODE_TRACK: Track = (() => {
  const episode: Episode = {
    id: 'ep-1',
    podcastId: 'pod-1',
    podcastTitle: 'Example Podcast',
    title: 'Episode 42',
    audioUrl: 'https://example.com/ep42.mp3',
    duration: 3600,
    publishDate: '2026-01-01T00:00:00Z',
  };
  return {
    id: 'ep-1',
    provider: 'podcast',
    source: { kind: 'podcast', episode },
    title: 'Episode 42',
    artist: 'Example Podcast',
    duration: 3600,
  };
})();

type SourcePickerOverlay = Extract<Overlay, { kind: 'source-picker' }>;

const PICKER: SourcePickerOverlay = {
  kind: 'source-picker',
  dialogId: 'dialog-1',
  track: EPISODE_TRACK,
  expectedRequestId: null,
  selectedIdx: 0,
  value: '',
  editing: false,
  busy: false,
  error: null,
};

test('source picker renders choices, notices and actual source separately', async () => {
  const store = createStore();
  store.set(playerPlaybackAtom, {
    track: EPISODE_TRACK,
    source: { kind: 'rss', url: 'https://example.com/ep42.mp3', selection: 'rss' },
    requestId: 7,
    origin: { kind: 'direct' },
  });
  const setup = await testRender(
    <Provider store={store}>
      <SourcePicker overlay={PICKER} onChange={(): void => {}} />
    </Provider>,
    { width: 90, height: 24 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Playback Source');
    expect(frame).toContain('Episode 42');
    expect(frame).toContain('Auto');
    expect(frame).toContain('Matched YouTube when found, otherwise RSS');
    expect(frame).toContain('RSS audio');
    expect(frame).toContain('Matched YouTube');
    expect(frame).toContain('Custom YouTube');
    expect(frame).toContain('[RSS]'); // actual playback, separate from the choice list
    expect(frame).toContain('restarts playback at 0:00');
    expect(frame).not.toContain('Applying source');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test('source picker shows custom input only while editing and surfaces busy/error', async () => {
  const store = createStore();
  const edited: SourcePickerOverlay[] = [];
  const setup = await testRender(
    <Provider store={store}>
      <SourcePicker
        overlay={{ ...PICKER, selectedIdx: 3, editing: false, value: 'dQw4w9WgXcQ' }}
        onChange={(): void => {}}
      />
    </Provider>,
    { width: 90, height: 24 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain('Applying source');
    // No input while not editing: the stored ID appears as a read-only preview.
    expect(frame).toContain('Custom video: dQw4w9WgXcQ');
    expect(frame).not.toContain('Press Enter to type');
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }

  const busySetup = await testRender(
    <Provider store={createStore()}>
      <SourcePicker
        overlay={{
          ...PICKER,
          selectedIdx: 3,
          editing: true,
          value: 'https://youtu.be/dQw4w9WgXcQ',
          busy: true,
          error: 'Not a valid YouTube video ID',
        }}
        onChange={(next): void => {
          edited.push(next as SourcePickerOverlay);
        }}
      />
    </Provider>,
    { width: 90, height: 24 },
  );
  try {
    await busySetup.renderOnce();
    const frame = busySetup.captureCharFrame();
    expect(frame).toContain('Applying source...');
    expect(frame).toContain('Not a valid YouTube video ID');
    expect(frame).toContain('https://youtu.be/dQw4w9WgXcQ');
    expect(frame).not.toContain('Press Enter to type');
  } finally {
    await act(async () => {
      busySetup.renderer.destroy();
    });
  }
  expect(edited).toEqual([]);

  const emptySetup = await testRender(
    <Provider store={createStore()}>
      <SourcePicker
        overlay={{ ...PICKER, selectedIdx: 3, editing: false, value: '' }}
        onChange={(): void => {}}
      />
    </Provider>,
    { width: 90, height: 24 },
  );
  try {
    await emptySetup.renderOnce();
    expect(emptySetup.captureCharFrame()).toContain('Press Enter to type');
  } finally {
    await act(async () => {
      emptySetup.renderer.destroy();
    });
  }
});
