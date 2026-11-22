import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/react';
import { useAtomValue } from 'jotai';
import { activeLyricIndex } from '../application/lyric-timing';
import { playerPositionAtom } from '../store/player';
import type { Overlay } from '../store/ui';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

export function LyricTiming({ overlay }: { overlay: Extract<Overlay, { kind: 'lyric-timing' }> }) {
  const { width } = useTerminalDimensions();
  const p = usePresentation();
  const t = useTheme();
  const { context, delayMs, error } = overlay;
  const position = useAtomValue(playerPositionAtom);
  const lines = context.document.original.lines;
  const cue = lines[activeLyricIndex(lines, position, delayMs)];
  const signedDelay = `${delayMs > 0 ? '+' : ''}${delayMs} ms`;
  return (
    <box
      position="absolute"
      top={0}
      bottom={0}
      left={0}
      right={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        title="Adjust Lyric Timing"
        width={Math.min(54, Math.max(1, width - 2))}
        height={error ? 8 : 7}
        border
        borderStyle="double"
        {...p.borderProps}
        borderColor={t.accent}
        backgroundColor={t.bg}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
      >
        <text fg={t.fg} attributes={TextAttributes.BOLD} truncate>
          {signedDelay}: {delayMs === 0 ? 'Original timing' : delayMs < 0 ? 'Earlier' : 'Later'}
        </text>
        <text fg={t.accent} truncate>
          {cue ? `Cue: ${cue.text}` : 'Before the first cue'}
        </text>
        <text fg={t.dim} truncate>
          {'[Left/Right] 100 ms [Shift] 500 ms'}
        </text>
        <text fg={t.dim} truncate>
          {'[r] Reset [Enter] Save [Esc] Cancel'}
        </text>
        {error && (
          <text fg={t.red} truncate>
            {error}
          </text>
        )}
      </box>
    </box>
  );
}
