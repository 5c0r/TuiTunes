import { TextAttributes } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { mediaKey } from '../providers/media';
import { playerPlaybackAtom } from '../store/player';
import type { Overlay } from '../store/ui';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

/** The four fixed source policies, in overlay `selectedIdx` order. */
const CHOICES: ReadonlyArray<{ label: string; hint: string }> = [
  { label: 'Auto', hint: 'Matched YouTube when found, otherwise RSS' },
  { label: 'RSS audio', hint: 'Always play the original episode audio' },
  { label: 'Matched YouTube', hint: 'Always play the matched YouTube video' },
  { label: 'Custom YouTube', hint: 'Play a specific YouTube URL or video ID' },
];

const CUSTOM_INDEX = CHOICES.length - 1;

export interface SourcePickerProps {
  overlay: Extract<Overlay, { kind: 'source-picker' }>;
  onChange: (overlay: Overlay) => void;
}

/**
 * Pure renderer for the playback-source picker. All state lives in the
 * overlay; selection/apply/close keys are owned by the single App keyboard
 * dispatcher. This component registers no keyboard handlers.
 */
export function SourcePicker({ overlay, onChange }: SourcePickerProps) {
  const t = useTheme();
  const p = usePresentation();
  const playback = useAtomValue(playerPlaybackAtom);

  const selected = Math.min(Math.max(overlay.selectedIdx, 0), CHOICES.length - 1);
  const isCustom = selected === CUSTOM_INDEX;
  const actual =
    playback && mediaKey(playback.track) === mediaKey(overlay.track)
      ? playback.source.kind === 'rss'
        ? '[RSS]'
        : '[YT]'
      : 'none';

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
        width={64}
        height={12 + (overlay.busy ? 1 : 0) + (overlay.error ? 1 : 0)}
        border
        borderStyle="double"
        {...p.borderProps}
        borderColor={t.accent}
        backgroundColor={t.bg}
        title="Playback Source"
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={t.fg} truncate>
          For: {overlay.track.title}
          {overlay.track.artist ? `${p.text(' — ')}${overlay.track.artist}` : ''}
        </text>
        <text fg={t.dim}>Now playing from: {actual}</text>
        {CHOICES.map((choice, i) => (
          <text
            key={choice.label}
            fg={i === selected ? t.accent : t.fg}
            attributes={i === selected ? TextAttributes.BOLD : 0}
            truncate
          >
            {i === selected ? `${p.icon('selected')} ` : '  '}
            {choice.label}
            {i === selected ? ` ${p.text('·')} ${choice.hint}` : ''}
          </text>
        ))}
        {isCustom && overlay.editing ? (
          <input
            focused={true}
            placeholder="YouTube URL or 11-character video ID"
            value={overlay.value}
            onInput={(value: string) => onChange({ ...overlay, value })}
          />
        ) : (
          <text fg={isCustom ? t.yellow : t.dim} truncate>
            {isCustom
              ? overlay.value
                ? `Custom video: ${overlay.value} ${p.text('·')} Enter to edit`
                : 'Press Enter to type a YouTube URL or video ID'
              : `Video ID: ${overlay.value || 'none'}`}
          </text>
        )}
        {overlay.busy ? <text fg={t.yellow}>Applying source...</text> : null}
        {overlay.error ? (
          <text fg={t.red} truncate>
            {p.icon('warning')} {overlay.error}
          </text>
        ) : null}
        <text fg={t.dim}>Changing the audio source restarts playback at 0:00</text>
        <text fg={t.dim}>
          [{p.text('↑')}
          {p.text('↓')}] select [enter] apply [esc] close
        </text>
      </box>
    </box>
  );
}
