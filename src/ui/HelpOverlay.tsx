
import { TextAttributes } from '@opentui/core';
import { useTheme } from './useTheme';

const KEYBINDINGS: ReadonlyArray<[key: string, description: string]> = [
  ['space', 'Play / Pause'],
  ['n', 'Next track'],
  ['p', 'Previous track'],
  ['j/k', 'Navigate list'],
  ['g/G', 'Go to top / bottom'],
  ['enter', 'Play selected'],
  ['/', 'Focus search'],
  ['escape', 'Back to main'],
  ['tab', 'Cycle focus'],
  ['+/-', 'Volume up/down'],
  ['m', 'Mute'],
  ['</>',  'Seek -10s/+10s'],
  ['t', 'Jump to time'],
  ['[/]', 'Speed down/up'],
  ['s', 'Toggle shuffle'],
  ['r', 'Cycle repeat'],
  ['f', 'Toggle favorite'],
  ['q', 'Add to queue'],
  ['x', 'Remove from queue'],
  ['ctrl+p', 'Command palette'],
  ['ctrl+l', 'Cycle layout'],
  ['l', 'Toggle lyrics'],
  ['L', 'Load more results (Shift+L)'],
  ['ctrl+f', 'Find in transcript'],
  ['ctrl+t', 'Cycle theme'],
  ['ctrl+1', 'Music section'],
  ['ctrl+2', 'Podcast section'],
  ['?', 'Toggle this help'],
  ['ctrl+c', 'Quit (alternative)'],
  ['ctrl+c', 'Quit'],
];

export interface HelpOverlayProps {
  visible: boolean;
}

export function HelpOverlay({ visible }: HelpOverlayProps) {
  const t = useTheme();
  if (!visible) return null;

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
        width={44}
        height={KEYBINDINGS.length + 4}
        border
        borderStyle="double"
        borderColor={t.accent}
        backgroundColor={t.bg}
        title="Keybindings"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        flexDirection="column"
      >
        {KEYBINDINGS.map(([key, desc]) => (
          <box key={key} flexDirection="row">
            <text fg={t.accent} attributes={TextAttributes.BOLD}>
              {key.padEnd(10)}
            </text>
            <text fg={t.fg}>{desc}</text>
          </box>
        ))}
      </box>
    </box>
  );
}
