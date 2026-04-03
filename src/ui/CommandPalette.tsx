import React from 'react';
import { TextAttributes } from '@opentui/core';
import { filterCommands } from '../commands';
import type { Command } from '../commands';
import { useTheme } from './useTheme';

const MAX_VISIBLE = 15;

export interface CommandPaletteProps {
  visible: boolean;
  filter: string;
  selectedIdx: number;
  onFilterChange: (value: string) => void;
  onSubmit: () => void;
}

export function CommandPalette({
  visible,
  filter,
  selectedIdx,
  onFilterChange,
  onSubmit,
}: CommandPaletteProps) {
  const t = useTheme();

  if (!visible) return null;

  const displayCommands = filterCommands(filter).slice(0, MAX_VISIBLE);

  return (
    <box
      position="absolute"
      top={0} left={0} right={0} bottom={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={60}
        height={20}
        border
        borderStyle="double"
        borderColor={t.accent}
        backgroundColor={t.bg}
        title="Command Palette"
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <input
          focused={true}
          placeholder="Type a command..."
          value={filter}
          onInput={onFilterChange}
          onSubmit={onSubmit as never}
        />
        {displayCommands.map((cmd: Command, i: number) => (
          <box
            key={cmd.id}
            flexDirection="row"
            backgroundColor={i === selectedIdx ? t.selection : undefined}
            paddingLeft={1}
          >
            <text
              fg={i === selectedIdx ? t.accent : t.fg}
              attributes={i === selectedIdx ? TextAttributes.BOLD : 0}
              flexGrow={1}
            >
              {cmd.name}
            </text>
            <text fg={t.dim}>{cmd.description}</text>
            {cmd.shortcut && <text fg={t.yellow}> [{cmd.shortcut}]</text>}
          </box>
        ))}
      </box>
    </box>
  );
}
