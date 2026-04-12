
import { TextAttributes } from '@opentui/core';
import { useTheme } from './useTheme';
import type { Section } from '../store/ui';

export interface HeaderProps {
  focused: boolean;
  section: Section;
  onSearch: (query: string) => void;
  onSectionChange: (section: Section) => void;
  onInput?: (value: string) => void;
  suggestions?: string[];
  suggestionIdx?: number;
  suggestionsVisible?: boolean;
}

export function Header({ focused, section, onSearch, onSectionChange: _onSectionChange, onInput, suggestions = [], suggestionIdx = -1, suggestionsVisible = false }: HeaderProps) {
  const t = useTheme();
  const placeholder = section === 'podcast' ? 'Search podcasts...' : 'Search music...';

  return (
    <box flexDirection="column">
      <box
        border
        borderStyle="rounded"
        borderColor={t.accent}
        height={3}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={t.accent} attributes={TextAttributes.BOLD}>TuiTunes </text>
        {/* Section tabs */}
        <text
          fg={section === 'music' ? t.accent : t.dim}
          bg={section === 'music' ? t.selection : undefined}
          attributes={section === 'music' ? TextAttributes.BOLD : 0}
        >
          {' ♪ Music '}
        </text>
        <text fg={t.dim}>│</text>
        <text
          fg={section === 'podcast' ? t.accent : t.dim}
          bg={section === 'podcast' ? t.selection : undefined}
          attributes={section === 'podcast' ? TextAttributes.BOLD : 0}
        >
          {' 🎙 Podcast '}
        </text>
        <text fg={t.dim}> </text>
        <box flexGrow={1}>
          <input placeholder={placeholder} focused={focused} onSubmit={onSearch as never} onInput={onInput as never} />
        </box>
      </box>
      {suggestionsVisible && suggestions.length > 0 && (
        <box
          border
          borderStyle="rounded"
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
              {i === suggestionIdx ? '▸ ' : '  '}{s}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}
