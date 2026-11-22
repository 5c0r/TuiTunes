import { ScrollBoxRenderable, type Renderable, type RootRenderable } from '@opentui/core';
import { expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { createStore, Provider } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { act } from 'react';
import { configAtom } from '../../src/store/config';
import {
  lyricsDocumentAtom,
  lyricsTranslationAtom,
  translationEnabledAtom,
  type LyricsDocument,
} from '../../src/store/lyrics';
import { playerPositionAtom } from '../../src/store/player';
import { overlayAtom } from '../../src/store/ui';
import { DEFAULT_CONFIG } from '../../src/utils/config';
import { Lyrics, lyricFollowSuspendedAtom } from '../../src/ui/Lyrics';

const WIDTH = 40;
const HEIGHT = 14;
/** Inner column that hit-testing resolves to the native scrollbar. */
const BAR_COLUMN = WIDTH - 2;

const LINES = Array.from({ length: 30 }, (_, i) => ({
  time: 5 * (i + 1),
  text: `line-${String(i).padStart(2, '0')}`,
}));

function makeDocument(overrides: Partial<LyricsDocument> = {}): LyricsDocument {
  return {
    mediaKey: 'media-a',
    sourceKey: 'lrclib',
    contentHash: 'hash-a',
    original: { lines: LINES, synced: true, source: 'lrclib' },
    ...overrides,
  };
}

function setupStore(
  document: LyricsDocument,
  { translated, ascii = true }: { translated?: string[]; ascii?: boolean } = {},
): Store {
  const store = createStore();
  store.set(configAtom, { ...DEFAULT_CONFIG, ascii, translationLanguage: 'en' });
  store.set(lyricsDocumentAtom, document);
  if (translated) {
    store.set(translationEnabledAtom, true);
    store.set(lyricsTranslationAtom, {
      documentKey: JSON.stringify([document.mediaKey, document.contentHash]),
      targetLang: 'en',
      engineKey: 'engine-key',
      lines: translated,
    });
  }
  return store;
}

type Setup = Awaited<ReturnType<typeof testRender>>;

async function renderLyrics(
  store: Store,
  props: { delayMs?: number; followMode?: 'keep-visible' | 'upper-third' } = {},
  width = WIDTH,
  height = HEIGHT,
): Promise<Setup> {
  const setup = await testRender(
    <Provider store={store}>
      <Lyrics delayMs={props.delayMs} followMode={props.followMode} />
    </Provider>,
    { width, height },
  );
  await act(async () => setup.renderOnce());
  return setup;
}

/** Apply one state change, commit it, then draw exactly one fresh frame. */
async function redraw(_store: Store, setup: Setup, mutate: () => void): Promise<void> {
  await act(async () => {
    mutate();
  });
  await act(async () => setup.renderOnce());
}

function findScrollBox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node;
  for (const child of node.getChildren()) {
    const found = findScrollBox(child);
    if (found) return found;
  }
  return undefined;
}

function scrollBoxOf(setup: Setup): ScrollBoxRenderable {
  const box = findScrollBox(setup.renderer.root);
  if (!box) throw new Error('Lyrics scrollbox not found in rendered tree');
  return box;
}

/** Expected follow target computed from the actual laid-out geometry. */
function expectedTarget(
  box: ScrollBoxRenderable,
  index: number,
  mode: 'keep-visible' | 'upper-third',
  currentScroll = box.scrollTop,
): number {
  const row = box.content.findDescendantById(`lyric-${index}`);
  if (!row) throw new Error(`lyric row ${index} not found`);
  let root: Renderable = box;
  while (root.parent) root = root.parent;
  const layoutRoot = root as RootRenderable; // renderer root owns layout
  layoutRoot.calculateLayout();
  const rowLayout = row.getLayoutNode().getComputedLayout();
  const viewHeight = box.viewport.getLayoutNode().getComputedLayout().height;
  const contentHeight = box.content.getLayoutNode().getComputedLayout().height;
  const maxScroll = Math.max(0, contentHeight - viewHeight);
  const target =
    mode === 'upper-third'
      ? rowLayout.top - Math.floor(viewHeight / 3)
      : rowLayout.top < currentScroll || rowLayout.height >= viewHeight
        ? rowLayout.top
        : rowLayout.top + rowLayout.height - viewHeight;
  return Math.max(0, Math.min(target, maxScroll));
}

/** Screen position of a text fragment in the captured frame. */
function framePoint(setup: Setup, needle: string): { x: number; y: number } {
  const lines = setup.captureCharFrame().split('\n');
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle);
    if (x >= 0) return { x, y };
  }
  throw new Error(`${needle} not visible in frame`);
}

test('keep-visible follows the active row using actual wrapped translated geometry', async () => {
  const document = makeDocument();
  const translated = LINES.map((_, i) =>
    i === 11 ? 'very long translated line that wraps twice in this pane' : `tl-${i}`,
  );
  const store = setupStore(document, { translated });
  const setup = await renderLyrics(store);
  try {
    const box = scrollBoxOf(setup);
    expect(box.scrollTop).toBe(0);

    await redraw(store, setup, () => store.set(playerPositionAtom, 5 * 12));

    // Row 11 carries wrapped translated rows, so a constant row height would
    // misplace the viewport; the target must match the measured layout.
    expect(box.scrollTop).toBe(expectedTarget(box, 11, 'keep-visible'));
    const frame = setup.captureCharFrame();
    expect(frame).toContain('line-11');
    expect(frame).toContain('very long translated');
    expect(frame).not.toContain('line-29');
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('upper-third pins the active row a third from the viewport top', async () => {
  const store = setupStore(makeDocument());
  const setup = await renderLyrics(store, { followMode: 'upper-third' });
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, LINES[15].time));
    expect(box.scrollTop).toBe(expectedTarget(box, 15, 'upper-third'));
    expect(setup.captureCharFrame()).toContain('line-15');
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('rewrap after a width change keeps the active row visible without a cue change', async () => {
  const document = makeDocument();
  const translated = LINES.map((_, i) =>
    i === 11 ? 'translated text long enough to wrap when the pane narrows' : `tl-${i}`,
  );
  const store = setupStore(document, { translated });
  const setup = await renderLyrics(store);
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, 5 * 12));
    const wideScroll = box.scrollTop;
    expect(setup.captureCharFrame()).toContain('line-11');

    // Narrowing rewraps the translated rows; the follow must re-measure and
    // keep the same active row visible even though the cue index is fixed.
    await act(async () => setup.resize(24, HEIGHT));
    await act(async () => setup.renderOnce());
    await act(async () => setup.renderOnce());

    expect(box.scrollTop).toBe(expectedTarget(box, 11, 'keep-visible'));
    expect(box.scrollTop).toBeGreaterThan(wideScroll);
    expect(setup.captureCharFrame()).toContain('line-11');
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('wheel scrolling suspends follow, highlights continue, and Follow Lyrics resumes once', async () => {
  const store = setupStore(makeDocument());
  const setup = await renderLyrics(store);
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, LINES[15].time));
    expect(setup.captureCharFrame()).toContain('line-15');

    await act(async () => setup.mockMouse.scroll(10, 6, 'up'));
    await act(async () => setup.renderOnce());
    const manualScroll = box.scrollTop;
    expect(manualScroll).toBeLessThan(expectedTarget(box, 15, 'keep-visible'));
    expect(store.get(lyricFollowSuspendedAtom)).toBe(store.get(lyricsDocumentAtom));

    // Suspension holds across further cue changes; the viewport stays put.
    await redraw(store, setup, () => store.set(playerPositionAtom, LINES[17].time));
    expect(box.scrollTop).toBe(manualScroll);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Follow Lyrics');

    // Clicking the visible action resumes follow and repositions once.
    const point = framePoint(setup, 'Follow Lyrics');
    await act(async () => setup.mockMouse.click(point.x, point.y));
    await act(async () => setup.renderOnce());
    expect(store.get(lyricFollowSuspendedAtom)).toBeNull();
    expect(box.scrollTop).toBe(expectedTarget(box, 17, 'keep-visible'));
    expect(setup.captureCharFrame()).toContain('# line-17');
    expect(setup.captureCharFrame()).not.toContain('Follow Lyrics');
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('an open overlay blocks the Follow Lyrics pointer action', async () => {
  const store = setupStore(makeDocument());
  const setup = await renderLyrics(store);
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, LINES[15].time));
    await act(async () => setup.mockMouse.scroll(10, 6, 'up'));
    await act(async () => setup.renderOnce());
    const manualScroll = box.scrollTop;
    const point = framePoint(setup, 'Follow Lyrics');

    await redraw(store, setup, () => store.set(overlayAtom, { kind: 'quit-confirm' }));
    await act(async () => setup.mockMouse.click(point.x, point.y));
    await act(async () => setup.renderOnce());
    expect(store.get(lyricFollowSuspendedAtom)).not.toBeNull();
    expect(box.scrollTop).toBe(manualScroll);

    await redraw(store, setup, () => store.set(overlayAtom, null));
    await act(async () => setup.mockMouse.click(point.x, point.y));
    await act(async () => setup.renderOnce());
    expect(store.get(lyricFollowSuspendedAtom)).toBeNull();
    expect(box.scrollTop).toBe(expectedTarget(box, 15, 'keep-visible'));
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('native scrollbar dragging still scrolls and suspends follow', async () => {
  const store = setupStore(makeDocument(), { ascii: false });
  const setup = await renderLyrics(store);
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, 5 * 12));
    const before = box.scrollTop;

    await act(async () => setup.mockMouse.drag(BAR_COLUMN, 8, BAR_COLUMN, 11));
    await act(async () => setup.renderOnce());
    // The bar itself scrolled (native handlers intact) and follow suspended.
    expect(box.scrollTop).toBeGreaterThan(before);
    expect(store.get(lyricFollowSuspendedAtom)).toBe(store.get(lyricsDocumentAtom));

    // A far-away early cue must not move the manually dragged viewport.
    const manualHeldScroll = box.scrollTop;
    await redraw(store, setup, () => store.set(playerPositionAtom, LINES[3].time));
    expect(box.scrollTop).toBe(manualHeldScroll);

    await redraw(store, setup, () => store.set(lyricFollowSuspendedAtom, null));
    expect(box.scrollTop).toBe(expectedTarget(box, 3, 'keep-visible', manualHeldScroll));
    expect(setup.captureCharFrame()).toContain('line-03');
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('lyric delay shifts the highlight, follows, and relabels adjusted cues', async () => {
  const store = setupStore(makeDocument());
  const setup = await renderLyrics(store, { delayMs: -30_000 });
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, LINES[12].time - 30));
    // The -30s delay lifts line-12's cue to 35s, so index 12 is already
    // active at 35s where the undelayed lyric would still show index 6.
    expect(setup.captureCharFrame()).toContain('# line-12');
    expect(box.scrollTop).toBe(expectedTarget(box, 12, 'keep-visible'));

    // Labels show adjusted cue times: line 0 (5s) with -20s becomes 0:00.
    const relabeled = await renderLyrics(store, { delayMs: -20_000 });
    try {
      // At time zero every early cue is negative: line-03 leads and the
      // line-00 label clamps to 0:00 instead of showing a negative time.
      await redraw(store, relabeled, () => store.set(playerPositionAtom, 0));
      const frame = relabeled.captureCharFrame();
      expect(frame).toContain('# line-03');
      expect(frame).toContain('[0:00]   line-00');
      expect(frame).not.toContain('0:-');
    } finally {
      await act(async () => relabeled.renderer.destroy());
    }
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('first and last cues clamp follow to the content bounds', async () => {
  const store = setupStore(makeDocument());
  const setup = await renderLyrics(store);
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, 5));
    expect(box.scrollTop).toBe(0);
    expect(setup.captureCharFrame()).toContain('line-00');

    await redraw(store, setup, () => store.set(playerPositionAtom, 5 * 30));
    const maxScroll = Math.max(
      0,
      box.content.getLayoutNode().getComputedLayout().height -
        box.viewport.getLayoutNode().getComputedLayout().height,
    );
    expect(box.scrollTop).toBe(maxScroll);
    expect(setup.captureCharFrame()).toContain('line-29');
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('unsynced lyrics never auto-jump and manual scrolling does not suspend', async () => {
  const document = makeDocument({
    original: { lines: LINES, synced: false, source: 'lrclib' },
  });
  const store = setupStore(document);
  const setup = await renderLyrics(store);
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, 120));
    expect(box.scrollTop).toBe(0);
    expect(setup.captureCharFrame()).toContain('line-00');

    // Native wheel scrolling still works; follow just never engages.
    await act(async () => setup.mockMouse.scroll(10, 6, 'down'));
    await act(async () => setup.renderOnce());
    expect(box.scrollTop).toBeGreaterThan(0);
    expect(store.get(lyricFollowSuspendedAtom)).toBeNull();
    expect(setup.captureCharFrame()).not.toContain('Follow Lyrics');
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('document replacement resets suspension while translation wrappers keep it', async () => {
  const document = makeDocument();
  const translated = LINES.map((_, i) => `tl-${i}`);
  const store = setupStore(document, { translated });
  const setup = await renderLyrics(store);
  try {
    const box = scrollBoxOf(setup);
    await redraw(store, setup, () => store.set(playerPositionAtom, LINES[16].time));
    await act(async () => setup.mockMouse.scroll(10, 6, 'up'));
    await act(async () => setup.renderOnce());
    const manualScroll = box.scrollTop;
    expect(store.get(lyricFollowSuspendedAtom)).toBe(document);

    // A translation arriving for the same document keeps the suspension.
    await redraw(store, setup, () =>
      store.set(lyricsTranslationAtom, {
        documentKey: JSON.stringify([document.mediaKey, document.contentHash]),
        targetLang: 'en',
        engineKey: 'engine-key',
        lines: LINES.map((_, i) => `rewrapped translation ${i} that is longer`),
      }),
    );
    await act(async () => setup.renderOnce());
    expect(store.get(lyricFollowSuspendedAtom)).toBe(document);
    expect(setup.captureCharFrame()).toContain('Follow Lyrics');

    // Replacing the document — even with identical content — resets it.
    const replacement = makeDocument();
    await redraw(store, setup, () => store.set(lyricsDocumentAtom, replacement));
    expect(store.get(lyricFollowSuspendedAtom)).toBeNull();
    expect(setup.captureCharFrame()).not.toContain('Follow Lyrics');
    expect(box.scrollTop).toBe(expectedTarget(box, 16, 'keep-visible'));
    expect(box.scrollTop).toBeGreaterThan(manualScroll);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test('suspension outlives pane unmount and still matches the same document', async () => {
  const document = makeDocument();
  const store = setupStore(document);
  const first = await renderLyrics(store);
  try {
    await redraw(store, first, () => store.set(playerPositionAtom, LINES[16].time));
    await act(async () => first.mockMouse.scroll(10, 6, 'up'));
    await act(async () => first.renderOnce());
    expect(store.get(lyricFollowSuspendedAtom)).toBe(document);
  } finally {
    await act(async () => first.renderer.destroy());
  }

  // Pane remount with the same document: still suspended, no follow jump.
  const second = await renderLyrics(store);
  try {
    const box = scrollBoxOf(second);
    expect(store.get(lyricFollowSuspendedAtom)).toBe(document);
    expect(second.captureCharFrame()).toContain('Follow Lyrics');
    await redraw(store, second, () => store.set(playerPositionAtom, LINES[18].time));
    expect(box.scrollTop).toBe(0);
    expect(second.captureCharFrame()).not.toContain('# line-18');
  } finally {
    await act(async () => second.renderer.destroy());
  }
});
