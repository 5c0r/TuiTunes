import type { ScrollBoxRenderable } from '@opentui/core';
import { TextAttributes } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { useRef } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import { COMMANDS, type Command, KEY_BINDINGS } from '../commands';
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

/** Navigation/input rows that have no command id. */
const BINDING_ROWS: ReadonlyArray<{ key: string; description: string }> = KEY_BINDINGS.map(
  (binding) => ({ key: binding.keys, description: binding.label }),
);

/** Registry commands that carry a shortcut. */
const COMMAND_ROWS: ReadonlyArray<{ key: string; description: string }> = (
  COMMANDS as readonly Command[]
).flatMap((command) =>
  command.shortcut !== undefined ? [{ key: command.shortcut, description: command.name }] : [],
);

/** Presentation toggles carry no shortcut but still show their live state. */
const TOGGLE_ROWS: ReadonlyArray<{ key: string; description: string; id: ToggleCommandId }> =
  TOGGLE_COMMAND_IDS.flatMap((id) => {
    const command = (COMMANDS as readonly Command[]).find((entry) => entry.id === id);
    return command ? [{ key: '-', description: command.name, id }] : [];
  });

type HelpRow = { key: string; description: string; id?: ToggleCommandId };

const HELP_ROWS: readonly HelpRow[] = [...BINDING_ROWS, ...COMMAND_ROWS, ...TOGGLE_ROWS];

function statusColor(status: ToggleStatus, t: Theme): string {
  if (status === 'on') return t.green;
  if (status === 'suppressed') return t.yellow;
  return t.dim;
}

export function HelpOverlay() {
  const t = useTheme();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const p = usePresentation(scrollRef);
  const config = useAtomValue(configAtom);
  const { width, height } = useTerminalDimensions();
  const panelWidth = Math.max(1, Math.min(100, width - 4));
  const columnCount = panelWidth >= 88 ? 2 : 1;
  const rowsPerColumn = Math.ceil(HELP_ROWS.length / columnCount);
  const columnWidth = Math.max(1, Math.floor((panelWidth - 6) / columnCount));
  const panelHeight = Math.max(1, Math.min(height - 2, rowsPerColumn + 4));
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
        width={panelWidth}
        height={panelHeight}
        border
        borderStyle="double"
        {...p.borderProps}
        borderColor={t.accent}
        backgroundColor={t.bg}
        title="Keybindings"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        flexDirection="column"
      >
        <scrollbox
          ref={scrollRef}
          height={Math.max(1, panelHeight - 4)}
          flexShrink={0}
          {...p.scrollbarProps}
        >
          <box flexDirection="row" height={rowsPerColumn} flexShrink={0}>
            {Array.from({ length: columnCount }, (_, column) => (
              <box
                key={column}
                width={columnWidth}
                height={rowsPerColumn}
                flexDirection="column"
                flexShrink={0}
              >
                {HELP_ROWS.slice(column * rowsPerColumn, (column + 1) * rowsPerColumn).map(
                  (row) => {
                    const status = row.id ? toggleStatusFor(row.id, config) : null;
                    return (
                      <box
                        key={`${row.key}:${row.description}`}
                        flexDirection="row"
                        height={1}
                        flexShrink={0}
                      >
                        <text fg={t.accent} attributes={TextAttributes.BOLD}>
                          {p.text(row.key.padEnd(12))}
                        </text>
                        <text fg={t.fg}>{p.text(row.description)}</text>
                        {status !== null && (
                          <text fg={statusColor(status, t)}>[{toggleStatusLabel(status)}]</text>
                        )}
                      </box>
                    );
                  },
                )}
              </box>
            ))}
          </box>
        </scrollbox>
        <text fg={t.dim} height={1} flexShrink={0}>
          {p.text('? / Esc close · mouse wheel scroll')}
        </text>
      </box>
    </box>
  );
}
