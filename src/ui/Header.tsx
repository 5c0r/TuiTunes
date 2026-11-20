import { type InputRenderable, TextAttributes } from '@opentui/core';
import { type RefObject, useEffect, useRef } from 'react';
import type { Section } from '../store/ui';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

export interface HeaderProps {
  focused: boolean;
  inputRef: RefObject<InputRenderable | null>;
  section: Section;
  query: string;
  onInput: (value: string) => void;
  /** Reports the input's actual focus, which can diverge from focusedPanel. */
  onFocusedChange?: (focused: boolean) => void;
  suggestions?: string[];
  suggestionIdx?: number;
  suggestionsVisible?: boolean;
}

export function Header({
  focused,
  inputRef,
  section,
  query,
  onInput,
  onFocusedChange,
  suggestions = [],
  suggestionIdx = -1,
  suggestionsVisible = false,
}: HeaderProps) {
  const t = useTheme();
  const p = usePresentation();
  const placeholder = section === 'podcast' ? 'Search podcasts...' : 'Search music...';
  const focusedChangeRef = useRef(onFocusedChange);
  focusedChangeRef.current = onFocusedChange;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onFocus = (): void => focusedChangeRef.current?.(true);
    const onBlur = (): void => focusedChangeRef.current?.(false);
    input.on('focused', onFocus);
    input.on('blurred', onBlur);
    return () => {
      input.off('focused', onFocus);
      input.off('blurred', onBlur);
    };
  }, [inputRef]);

  return (
    <box flexDirection="column">
      <box
        border
        borderStyle="rounded"
        {...p.borderProps}
        borderColor={t.accent}
        height={3}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={t.accent} attributes={TextAttributes.BOLD}>
          TuiTunes{' '}
        </text>
        {/* Section tabs */}
        <text
          fg={section === 'music' ? t.accent : t.dim}
          bg={section === 'music' ? t.selection : undefined}
          attributes={section === 'music' ? TextAttributes.BOLD : 0}
        >
          {` ${p.text('♪')} Music `}
        </text>
        <text fg={t.dim}>{p.text('│')}</text>
        <text
          fg={section === 'podcast' ? t.accent : t.dim}
          bg={section === 'podcast' ? t.selection : undefined}
          attributes={section === 'podcast' ? TextAttributes.BOLD : 0}
        >
          {` ${p.text('🎙')} Podcast `}
        </text>
        <text fg={t.dim}> </text>
        <box flexGrow={1}>
          <input
            ref={inputRef}
            placeholder={placeholder}
            focused={focused}
            value={query}
            onInput={onInput as never}
          />
        </box>
      </box>
      {suggestionsVisible && suggestions.length > 0 && (
        <box
          border
          borderStyle="rounded"
          {...p.borderProps}
          borderColor={t.dim}
          flexDirection="column"
          paddingLeft={2}
        >
          {suggestions.map((s, i) => (
            <text
              key={s}
              fg={i === suggestionIdx ? t.accent : t.fg}
              attributes={i === suggestionIdx ? TextAttributes.BOLD : 0}
            >
              {i === suggestionIdx ? `${p.text('▸')} ` : '  '}
              {s}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}
