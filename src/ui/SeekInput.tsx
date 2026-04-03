import React from 'react';
import { TextAttributes } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { useTheme } from './useTheme';
import { playerPositionAtom, playerDurationAtom } from '../store/player';
import { formatTime } from '../utils/format';

export interface SeekInputProps {
  visible: boolean;
  value: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
}

/**
 * Parse a time string into seconds.
 * Accepts: "90" (seconds), "1:30" (m:ss), "1:05:30" (h:mm:ss)
 */
export function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Pure seconds: "90", "150.5"
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }

  // m:ss or h:mm:ss
  const parts = trimmed.split(':').map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return null;
}

export function SeekInput({ visible, value, onInput }: SeekInputProps) {
  const t = useTheme();
  const position = useAtomValue(playerPositionAtom);
  const duration = useAtomValue(playerDurationAtom);

  if (!visible) return null;

  const parsed = parseTimeInput(value);
  const outOfRange = parsed !== null && duration > 0 && parsed > duration;
  const valid = parsed !== null && parsed >= 0 && !outOfRange;
  const empty = value.trim() === '';
  const badFormat = !empty && parsed === null;

  return (
    <box
      position="absolute"
      top={0} left={0} right={0} bottom={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={40}
        height={7}
        border
        borderStyle="double"
        borderColor={badFormat || outOfRange ? t.red : valid ? t.accent : t.yellow}
        backgroundColor={t.bg}
        title="Jump to Time"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        gap={1}
      >
        <text fg={t.dim}>
          Current: {formatTime(position)} / {formatTime(duration)}
        </text>
        <box flexDirection="row" gap={1}>
          <text fg={t.fg}>Time: </text>
          <input
            focused={true}
            placeholder="1:30 or 90"
            value={value}
            onInput={onInput}
          />
        </box>
        <text fg={badFormat || outOfRange ? t.red : t.dim} attributes={TextAttributes.DIM}>
          {badFormat ? 'Invalid format. Use m:ss, h:mm:ss, or seconds'
            : outOfRange ? `${formatTime(parsed!)} exceeds track length (${formatTime(duration)})`
            : parsed !== null ? `→ ${formatTime(parsed)}`
            : 'Enter time as m:ss, h:mm:ss, or seconds'}
        </text>
      </box>
    </box>
  );
}
