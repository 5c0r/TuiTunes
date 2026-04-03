import React from 'react';
import { TextAttributes } from '@opentui/core';
import { useTheme } from './useTheme';

export interface QuitConfirmProps {
  visible: boolean;
}

export function QuitConfirm({ visible }: QuitConfirmProps) {
  const t = useTheme();

  if (!visible) return null;

  return (
    <box
      position="absolute"
      top={0} left={0} right={0} bottom={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={36}
        height={7}
        border
        borderStyle="double"
        borderColor={t.red}
        backgroundColor={t.bg}
        title="Quit TuneFork?"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        gap={1}
      >
        <text fg={t.fg}>Are you sure you want to quit?</text>
        <box flexDirection="row" gap={2}>
          <text fg={t.green} attributes={TextAttributes.BOLD}>[y] Yes</text>
          <text fg={t.red} attributes={TextAttributes.BOLD}>[n] No</text>
          <text fg={t.dim}>[esc] Cancel</text>
        </box>
      </box>
    </box>
  );
}
