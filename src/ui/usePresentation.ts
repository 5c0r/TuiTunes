import type { ScrollBoxRenderable } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { useEffect, type RefObject } from 'react';
import { configAtom } from '../store/config';
import {
  asciiText,
  borderPropsFor,
  iconGlyph,
  scrollbarPropsFor,
  type IconName,
  type PresentationBorderProps,
  type PresentationScrollbarProps,
} from './presentation';

/** Presentation surface shared by every UI component. */
export interface Presentation {
  readonly ascii: boolean;
  readonly reducedMotion: boolean;
  /** Spread after the stock `borderStyle` so ASCII mode replaces border glyphs. */
  readonly borderProps: PresentationBorderProps;
  /** Spread on `<scrollbox>`; ASCII mode hides native Unicode scrollbar thumbs. */
  readonly scrollbarProps: PresentationScrollbarProps;
  /** Converts known app-owned chrome literals; identity when ASCII is off. */
  readonly text: (value: string) => string;
  /** Resolves a semantic app icon for the effective style; ASCII wins. */
  readonly icon: (name: IconName) => string;
}

/**
 * Read the shared presentation profile. When the component owns a scrollbox,
 * pass its ref: after ASCII mode toggles off, both native scrollbars are
 * manually hidden and the pinned renderer ignores the removed prop, so the
 * public resetVisibilityControl() is used to restore native auto show/hide.
 */
export function usePresentation(scrollRef?: RefObject<ScrollBoxRenderable | null>): Presentation {
  const config = useAtomValue(configAtom);
  const ascii = config.ascii === true;
  const reducedMotion = config.reducedMotion === true;

  useEffect(() => {
    if (ascii) return;
    const box = scrollRef?.current;
    box?.verticalScrollBar.resetVisibilityControl();
    box?.horizontalScrollBar.resetVisibilityControl();
  }, [ascii, scrollRef]);

  return {
    ascii,
    reducedMotion,
    borderProps: borderPropsFor(ascii),
    scrollbarProps: scrollbarPropsFor(ascii),
    text: ascii ? asciiText : (value: string) => value,
    icon: (name: IconName): string => iconGlyph(name, config.iconStyle, ascii),
  };
}
