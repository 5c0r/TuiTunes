import type { MouseEvent, Renderable, ScrollBoxRenderable } from '@opentui/core';
import { useStore } from 'jotai';
import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';
import { overlayAtom } from '../store/ui';

const DOUBLE_CLICK_MS = 350;

type Target = { row: Renderable; key: string; top: number; left: number };
type Press = Target & { x: number; y: number };

/** One press and double-click candidate per visible surface, never per list row. */
export function usePointerClicks(
  scope: unknown,
  {
    context,
    active = true,
    scrollRef,
  }: {
    context?: unknown;
    active?: boolean;
    scrollRef?: RefObject<ScrollBoxRenderable | null>;
  } = {},
) {
  const store = useStore();
  const press = useRef<Press | null>(null);
  const candidate = useRef<(Target & { at: number }) | null>(null);
  const visibleScope = useRef({ scope, context });
  const clear = useCallback(() => {
    press.current = null;
    candidate.current = null;
  }, []);
  useLayoutEffect(() => {
    const last = visibleScope.current;
    if (last.scope !== scope || last.context !== context) {
      visibleScope.current = { scope, context };
      clear();
    } else if (!active) {
      clear();
    }
  }, [active, clear, scope, context]);
  useLayoutEffect(() => store.sub(overlayAtom, clear), [store, clear]);

  function bind(key: string, click: (activate: boolean) => void, double = false) {
    return function (this: Renderable, event: MouseEvent): void {
      if (event.type === 'drag' || event.type === 'scroll') {
        clear();
        return;
      }
      if (event.type !== 'down' && event.type !== 'up') return;
      const { alt, ctrl, shift } = event.modifiers;
      if (store.get(overlayAtom) || event.button !== 0 || alt || ctrl || shift) {
        clear();
        return;
      }
      const { x, y } = event;
      const top = scrollRef?.current?.scrollTop ?? 0;
      const left = scrollRef?.current?.scrollLeft ?? 0;
      if (event.type === 'down') {
        const last = candidate.current;
        if (last?.row !== this || last.key !== key || last.top !== top || last.left !== left)
          candidate.current = null;
        press.current = { row: this, key, x, y, top, left };
        return;
      }
      const held = press.current;
      press.current = null;
      // Same cell also distinguishes a normal release on selectable Text
      // (OpenTUI marks even that as selection dragging) from a text drag.
      if (
        !held ||
        held.row !== this ||
        held.key !== key ||
        held.x !== x ||
        held.y !== y ||
        held.top !== top ||
        held.left !== left
      ) {
        candidate.current = null;
        return;
      }
      const at = performance.now();
      const activate =
        !double || (candidate.current !== null && at - candidate.current.at <= DOUBLE_CLICK_MS);
      candidate.current = activate ? null : { row: this, key, at, top, left };
      click(activate);
    };
  }

  return { bind, clear };
}
