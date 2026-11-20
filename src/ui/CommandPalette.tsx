import { TextAttributes } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { useTerminalDimensions } from '@opentui/react';
import type { Command } from '../commands';
import { filterCommands } from '../commands';
import { configAtom } from '../store/config';
import {
  TOGGLE_COMMAND_IDS,
  toggleStatusLabel,
  toggleStatusFor,
  type ToggleCommandId,
  type ToggleStatus,
} from './presentation';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';
import type { Theme } from './themes';

const MAX_VISIBLE = 15;

const TOGGLE_IDS: readonly string[] = TOGGLE_COMMAND_IDS;

function statusColor(status: ToggleStatus, t: Theme): string {
  if (status === 'on') return t.green;
  if (status === 'suppressed') return t.yellow;
  return t.dim;
}

export interface CommandPaletteProps {
  filter: string;
  selectedIdx: number;
  onFilterChange: (value: string) => void;
}

export function CommandPalette({ filter, selectedIdx, onFilterChange }: CommandPaletteProps) {
  const t = useTheme();
  const p = usePresentation();
  const config = useAtomValue(configAtom);
  const { width: terminalWidth } = useTerminalDimensions();
  // Fit narrow terminals instead of clipping row starts; descriptions clip.
  const paletteWidth = Math.max(30, Math.min(60, terminalWidth - 4));

  // Filtering always matches the static registry; the live On/Off state is
  // display-only decoration on the matching rows.
  const displayCommands = filterCommands(filter).slice(0, MAX_VISIBLE);

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={paletteWidth}
        height={20}
        border
        borderStyle="double"
        {...p.borderProps}
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
        />
        {displayCommands.map((cmd: Command, i) => {
          const toggleId = TOGGLE_IDS.includes(cmd.id) ? (cmd.id as ToggleCommandId) : null;
          const status = toggleId === null ? null : toggleStatusFor(toggleId, config);
          return (
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
                flexShrink={0}
                truncate
              >
                {p.text(cmd.name)}
              </text>
              {status !== null && (
                <text fg={statusColor(status, t)} flexShrink={0}>
                  {' '}
                  [{toggleStatusLabel(status)}]
                </text>
              )}
              <text fg={t.dim} truncate>
                {p.text(cmd.description)}
              </text>
            </box>
          );
        })}
      </box>
    </box>
  );
}
