import { TextAttributes } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import type { PlayerState } from '../player/types';
import {
  playerDurationAtom,
  playerMuteAtom,
  playerPositionAtom,
  playerProgressAtom,
  playerSpeedAtom,
  playerStateAtom,
  playerTrackAtom,
  playerVolumeAtom,
} from '../store/player';
import { repeatAtom, shuffleAtom } from '../store/queue';
import { formatTime } from '../utils/format';
import { useTheme } from './useTheme';

const STATE_ICONS: Record<PlayerState, string> = {
  playing: '▶',
  paused: '⏸',
  buffering: '⟳',
  stopped: '⏹',
};

const EQ_FRAMES = ['▂▅▇▅▃', '▃▆▅▇▂', '▅▃▂▆▇', '▇▂▃▅▆', '▆▇▅▂▃', '▃▅▆▇▅', '▂▇▃▅▆', '▅▆▇▃▂'];

const PAUSE_BARS = '▃▃▃▃▃';
const STOP_BARS = '▁▁▁▁▁';

const SPINNER_FRAMES = ['⣿', '⢿', '⠿', '⠏', '⠇', '⠃', '⠁', '⠀', '⠁', '⠃', '⠇', '⠏', '⠿', '⢿'];

export function NowPlaying() {
  const t = useTheme();
  const state = useAtomValue(playerStateAtom);
  const track = useAtomValue(playerTrackAtom);
  const position = useAtomValue(playerPositionAtom);
  const duration = useAtomValue(playerDurationAtom);
  const volume = useAtomValue(playerVolumeAtom);
  const muted = useAtomValue(playerMuteAtom);
  const speed = useAtomValue(playerSpeedAtom);
  const progress = useAtomValue(playerProgressAtom);
  const shuffle = useAtomValue(shuffleAtom);
  const repeat = useAtomValue(repeatAtom);

  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (state !== 'playing' && state !== 'buffering') return;
    const interval = setInterval(
      () => {
        setFrame((f) => f + 1);
      },
      state === 'buffering' ? 100 : 250,
    );
    return () => clearInterval(interval);
  }, [state]);

  const icon = STATE_ICONS[state];
  const title = track?.title ?? 'No track';
  const artist = track?.artist ?? '';

  const repeatIndicator = repeat === 'track' ? ' 🔂' : repeat === 'all' ? ' 🔁' : '';
  const shuffleIndicator = shuffle ? ' 🔀' : '';
  const modeIndicators = `${shuffleIndicator}${repeatIndicator}`;

  const volumeLabel = muted ? '🔇' : `🔊${volume}%`;
  const speedLabel = speed !== 1 ? ` ${speed}x` : '';
  const timeLabel = `${formatTime(position)} / ${formatTime(duration)}`;

  const viz =
    state === 'playing'
      ? EQ_FRAMES[frame % EQ_FRAMES.length]
      : state === 'buffering'
        ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
        : state === 'paused'
          ? PAUSE_BARS
          : STOP_BARS;

  const vizColor = state === 'playing' ? t.green : state === 'buffering' ? t.yellow : t.dim;

  // Progress bar with knob indicator
  const barWidth = 40;
  const filled = Math.round(progress * barWidth);
  const elapsed = '━'.repeat(filled);
  const remaining = '─'.repeat(barWidth - filled);
  const knob = filled > 0 && filled < barWidth ? '●' : '';

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={t.accent}
      height={4}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row">
        <text fg={t.accent} attributes={TextAttributes.BOLD}>
          {icon}{' '}
        </text>
        <text fg={vizColor}>{viz} </text>
        <text fg={t.fg} attributes={TextAttributes.BOLD} truncate>
          {title}
        </text>
        {artist ? <text fg={t.dim}> — {artist}</text> : null}
        <text fg={t.dim}>{modeIndicators}</text>
        <box flexGrow={1} />
        <text fg={t.dim}>
          {volumeLabel}
          {speedLabel}
          {'  '}
          {timeLabel}
        </text>
      </box>
      <box flexDirection="row">
        <text fg={t.accent}>{elapsed}</text>
        <text fg={t.green}>{knob}</text>
        <text fg={t.border}>{remaining}</text>
      </box>
    </box>
  );
}
