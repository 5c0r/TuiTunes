import React from 'react';
import { TextAttributes } from '@opentui/core';
import { useTheme } from './useTheme';
import type { Section } from '../store/ui';

export interface HeaderProps {
  focused: boolean;
  section: Section;
  onSearch: (query: string) => void;
  onSectionChange: (section: Section) => void;
}

export function Header({ focused, section, onSearch, onSectionChange }: HeaderProps) {
  const t = useTheme();
  const placeholder = section === 'podcast' ? 'Search podcasts...' : 'Search music...';

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={t.accent}
      height={3}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={t.accent} attributes={TextAttributes.BOLD}>TuneFork </text>
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
        <input placeholder={placeholder} focused={focused} onSubmit={onSearch as never} />
      </box>
    </box>
  );
}
