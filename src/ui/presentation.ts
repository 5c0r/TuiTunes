import type { BorderCharacters, BorderStyle } from '@opentui/core';
import type { TuiTunesConfig } from '../utils/config';

/**
 * Shared presentation profile for ASCII chrome and reduced motion.
 *
 * This module is a concrete presentation helper — two explicit glyph sets,
 * shared box-border props, scrollbar props, and app-owned chrome label
 * conversion. It is not a theme or plugin registry: colors/theme ids and
 * meaningful content are owned elsewhere and never altered here.
 */

/** Box props to spread after `borderStyle` so ASCII borders override stock glyphs. */
export interface PresentationBorderProps {
  borderStyle?: BorderStyle;
  customBorderChars?: BorderCharacters;
}

/** Scrollbox props to spread; ASCII mode hides the hardcoded Unicode thumbs. */
export interface PresentationScrollbarProps {
  scrollbarOptions?: { visible?: boolean };
}

/** All eleven BorderCharacters fields, ASCII only (`+`, `-`, `|`). */
export const ASCII_BORDER_CHARS: BorderCharacters = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  topT: '+',
  bottomT: '+',
  leftT: '+',
  rightT: '+',
  cross: '+',
};

/** Border override for ASCII mode; empty in Unicode mode (stock style stands). */
export function borderPropsFor(ascii: boolean): PresentationBorderProps {
  return ascii ? { borderStyle: 'single', customBorderChars: ASCII_BORDER_CHARS } : {};
}
/**
 * Native scrollbar thumbs are Unicode in the pinned renderer, so ASCII mode
 * hides both bars via manual visibility. The renderer's scrollbarOptions
 * setter is a plain Object.assign, so a removed prop (setter called with
 * null) is a no-op: toggling ASCII off would leave the bars manually hidden.
 * usePresentation restores native auto show/hide on the wired scrollbox by
 * calling the public ScrollBarRenderable.resetVisibilityControl().
 */
export function scrollbarPropsFor(ascii: boolean): PresentationScrollbarProps {
  return ascii ? { scrollbarOptions: { visible: false } } : {};
}

/**
 * Known app-owned chrome literals and their ASCII replacements.
 * Keys are exact literals rendered by TuiTunes chrome; user/provider text is
 * never listed here and therefore never transliterated.
 */
const ASCII_TEXT_MAP: Readonly<Record<string, string>> = {
  // Player state glyphs
  '▶': '>',
  '⏸': '||',
  '⟳': '*',
  '⏹': '[]',
  // Sidebar / header icons and markers
  '♪': '#',
  '🎙': 'P',
  '♥': '*',
  '⟲': '^',
  '📋': 'F',
  '📜': 'E',
  '▸': '>',
  '✓': 'v',
  '↑': '^',
  '↓': 'v',
  // Separators
  '│': '|',
  '—': '-',
  '•': '*',
  '·': '*',
  '→': '->',
  // NowPlaying indicators
  '⚠': '!',
  '🔇': '[M]',
  '🔊': '[V]',
  '🔁': '[R]',
  '🔂': '[R1]',
  '🔀': '[S]',
  '━': '=',
  '─': '-',
  '●': 'o',
};

/** Longest-first so multi-character keys win over their own characters. */
const ASCII_TEXT_KEYS: readonly string[] = Object.keys(ASCII_TEXT_MAP).sort(
  (a, b) => b.length - a.length,
);

/**
 * Convert known app-owned chrome literals to ASCII. Call sites pass only
 * literals they own; media/user text never flows through here, and unknown
 * strings are returned unchanged.
 */
export function asciiText(value: string): string {
  let result = value;
  for (const key of ASCII_TEXT_KEYS) {
    if (result.includes(key)) result = result.replaceAll(key, ASCII_TEXT_MAP[key]);
  }
  return result;
}

/** Braille buffering spinner for Unicode mode. */
export const UNICODE_SPINNER_FRAMES: readonly string[] = [
  '⣿',
  '⢿',
  '⠿',
  '⠏',
  '⠇',
  '⠃',
  '⠁',
  '⠀',
  '⠁',
  '⠃',
  '⠇',
  '⠏',
  '⠿',
  '⢿',
];

/** ASCII buffering spinner (`/`, `-`, `\`, `|` rotation). */
export const ASCII_SPINNER_FRAMES: readonly string[] = ['/', '-', '\\', '|'];

/** Spinner frames for the active mode; ASCII mode never animates braille. */
export function spinnerFramesFor(ascii: boolean): readonly string[] {
  return ascii ? ASCII_SPINNER_FRAMES : UNICODE_SPINNER_FRAMES;
}

/** Toggle command ids whose live state is shown in palette and help rows. */
export const TOGGLE_COMMAND_IDS = [
  'toggle-ascii',
  'toggle-reduced-motion',
  'toggle-spectrum',
] as const;
export type ToggleCommandId = (typeof TOGGLE_COMMAND_IDS)[number];

/** Current state of a presentation toggle: on, off, or effectively disabled. */
export type ToggleStatus = 'on' | 'off' | 'suppressed';

/** Row suffix showing the live On/Off state of a presentation toggle. */
export function toggleStatusLabel(status: ToggleStatus): string {
  if (status === 'on') return 'On';
  if (status === 'suppressed') return 'On (inactive)';
  return 'Off';
}

/** Live presentation state of a toggle command from the current config. */
export function toggleStatusFor(id: ToggleCommandId, config: TuiTunesConfig): ToggleStatus {
  if (id === 'toggle-ascii') return config.ascii ? 'on' : 'off';
  if (id === 'toggle-reduced-motion') return config.reducedMotion ? 'on' : 'off';
  if (!config.spectrumEnabled) return 'off';
  return config.reducedMotion ? 'suppressed' : 'on';
}
