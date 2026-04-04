
import { TextAttributes } from '@opentui/core';
import { useTheme } from './useTheme';

export interface TranscriptUrlInputProps {
  visible: boolean;
  value: string;
  onInput: (value: string) => void;
}

export function TranscriptUrlInput({ visible, value, onInput }: TranscriptUrlInputProps) {
  const t = useTheme();

  if (!visible) return null;

  const looksValid = value.trim().length === 0 || /^https?:\/\//.test(value.trim());

  return (
    <box
      position="absolute"
      top={0} left={0} right={0} bottom={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={60}
        height={8}
        border
        borderStyle="double"
        borderColor={looksValid ? t.accent : t.red}
        backgroundColor={t.bg}
        title="Custom Transcript URL"
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        gap={1}
      >
        <text fg={t.dim}>Enter a URL to a .srt or .vtt transcript file:</text>
        <input
          focused={true}
          placeholder="https://example.com/transcript.srt"
          value={value}
          onInput={onInput}
        />
        <text fg={t.dim} attributes={TextAttributes.DIM}>
          [Enter] load  [Escape] cancel  [empty + Enter] reset to auto
        </text>
      </box>
    </box>
  );
}
