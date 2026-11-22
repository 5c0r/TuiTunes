import type { MouseEvent, Renderable, RootRenderable, ScrollBoxRenderable } from '@opentui/core';
import { atom, useAtomValue, useStore } from 'jotai';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { LyricLine } from '../providers/lyrics';
import type { LyricsDocument } from '../store/lyrics';
import type { LyricFollowMode } from '../utils/config';

/**
 * Lyrics document whose follow positioning the user suspended by manual
 * scrolling; null while follow is active. The atom lives outside the Lyrics
 * pane so suspension survives pane unmount. Identity is by document object:
 * translation updates keep the same document (and the suspension), while a
 * reload or replay that produces a new document resets it.
 */
export const lyricFollowSuspendedAtom = atom<LyricsDocument | null>(null);

/** Run yoga layout now so freshly committed rows measure their real geometry. */
function refreshLayout(node: Renderable): void {
  let root = node;
  while (root.parent) root = root.parent;
  const layoutRoot = root as RootRenderable; // renderer root owns layout
  layoutRoot.calculateLayout();
}

/** Laid-out rectangle of a renderable inside its yoga parent. */
function computedRect(node: Renderable): { top: number; height: number } {
  const { top, height } = node.getLayoutNode().getComputedLayout();
  return { top, height };
}

/**
 * Move the viewport for the active row using actual laid-out coordinates —
 * row height includes wrapped and translated text, so indices are never
 * multiplied by a constant. Keep-visible scrolls the minimum distance;
 * upper-third pins the row a third from the top. Both clamp to content
 * bounds and never move the viewport for a stale child.
 */
function applyFollow(
  box: ScrollBoxRenderable,
  activeIndex: number,
  followMode: LyricFollowMode,
): void {
  const row = box.content.findDescendantById(`lyric-${activeIndex}`);
  if (!row || row.isDestroyed) return;
  refreshLayout(row);
  const { top: rowTop, height: rowHeight } = computedRect(row);
  const { height: viewHeight } = computedRect(box.viewport);
  if (!(viewHeight >= 1)) return;
  const { height: contentHeight } = computedRect(box.content);
  const maxScroll = Math.max(0, contentHeight - viewHeight);

  let target: number;
  if (followMode === 'upper-third') {
    target = rowTop - Math.floor(viewHeight / 3);
  } else {
    const current = box.scrollTop;
    if (rowHeight >= viewHeight) target = rowTop;
    else if (rowTop < current) target = rowTop;
    else if (rowTop + rowHeight > current + viewHeight) target = rowTop + rowHeight - viewHeight;
    else return; // already fully visible: no movement
  }
  target = Math.max(0, Math.min(target, maxScroll));
  if (target !== box.scrollTop) box.scrollTop = target;
}

export interface LyricFollowControl {
  readonly scrollRef: RefObject<ScrollBoxRenderable | null>;
  /** Follow is suspended for the current document after manual scrolling. */
  readonly suspended: boolean;
  /** End suspension and reposition once. */
  readonly resume: () => void;
  /** Wheel observer for the lyric scrollbox; never blocks native scrolling. */
  readonly onPaneMouse: (event: MouseEvent) => void;
}

/**
 * Keep the active lyric row positioned per the configured follow policy.
 * Manual wheel scrolling or scrollbar dragging suspends follow for the
 * current document (highlights continue); a replaced document or an explicit
 * resume restarts it. Viewport/content resize events and rendered-line
 * changes re-run the positioning with post-layout measurements, so rewrapping
 * translated text keeps the active row visible even when the cue index and
 * total content height do not change — without any polling.
 */
export function useLyricFollow({
  document,
  lines,
  activeIndex,
  followMode,
  enabled,
  scrollPresent,
}: {
  document: LyricsDocument | null;
  /** Rendered lines (translated wrapper included); identity signals rewrap. */
  lines: readonly LyricLine[] | null;
  activeIndex: number;
  followMode: LyricFollowMode;
  /** Only synced lyrics follow; unsynced text never jumps or suspends. */
  enabled: boolean;
  /** True exactly while the scrollbox is mounted in this render. */
  scrollPresent: boolean;
}): LyricFollowControl {
  const store = useStore();
  const suspendedDocument = useAtomValue(lyricFollowSuspendedAtom);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const latest = useRef({ document, enabled });
  latest.current = { document, enabled };

  const suspended = document !== null && suspendedDocument === document;

  // A replaced document (including an identical-content reload) ends
  // suspension even while the pane is hidden; translation updates keep the
  // same document object and therefore keep the suspension.
  useEffect(() => {
    if (suspendedDocument && suspendedDocument !== document)
      store.set(lyricFollowSuspendedAtom, null);
  }, [store, suspendedDocument, document]);

  const suspend = useCallback(() => {
    const { document: doc, enabled: active } = latest.current;
    if (!active || !doc) return;
    if (store.get(lyricFollowSuspendedAtom) !== doc) store.set(lyricFollowSuspendedAtom, doc);
  }, [store]);

  const resume = useCallback(() => {
    store.set(lyricFollowSuspendedAtom, null);
  }, [store]);

  const onPaneMouse = useCallback(
    (event: MouseEvent) => {
      if (event.type === 'scroll') suspend();
    },
    [suspend],
  );

  // Observe native geometry changes and manual scrollbar drags. Both resize
  // subscriptions use the renderables' own resize events, and the slider gets
  // the generic onMouse observer, so the bar's own drag handlers stay intact.
  useEffect(() => {
    if (!scrollPresent) return;
    const box = scrollRef.current;
    if (!box) return;
    const bump = () => setLayoutVersion((version) => version + 1);
    box.viewport.on('resize', bump);
    box.content.on('resize', bump);
    const slider = box.verticalScrollBar.slider;
    const observeSlider = (event: MouseEvent) => {
      if (event.type === 'down' || event.type === 'drag') suspend();
    };
    slider.onMouse = observeSlider;
    bump();
    return () => {
      box.viewport.off('resize', bump);
      box.content.off('resize', bump);
      slider.onMouse = undefined;
    };
  }, [scrollPresent, suspend]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box || !scrollPresent || !enabled || activeIndex < 0 || suspended) return;
    applyFollow(box, activeIndex, followMode);
  }, [enabled, activeIndex, suspended, followMode, document, lines, layoutVersion, scrollPresent]);

  return { scrollRef, suspended, resume, onPaneMouse };
}
