import { TextAttributes } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import type { PlayerState } from '../player/types';
import { configAtom } from '../store/config';
import {
  playerDurationAtom,
  playerErrorAtom,
  playerMuteAtom,
  playerPlaybackAtom,
  playerPositionAtom,
  playerProgressAtom,
  playerSpeedAtom,
  playerStateAtom,
  playerVolumeAtom,
} from '../store/player';
import { repeatAtom, shuffleAtom } from '../store/queue';
import { formatTime } from '../utils/format';
import { spinnerFramesFor } from './presentation';
import { Spectrum } from './Spectrum';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

const STATE_ICONS: Record<PlayerState, string> = {
  playing: '▶',
  paused: '⏸',
  buffering: '⟳',
  stopped: '⏹',
};

/** Actual playback source of the committed target, shown as [RSS] / [YT]. */
function sourceTag(sourceKind: 'rss' | 'youtube' | undefined): string {
  if (sourceKind === 'rss') return '[RSS]';
  if (sourceKind === 'youtube') return '[YT]';
  return '';
}

export function NowPlaying() {
  const t = useTheme();
  const p = usePresentation();
  const config = useAtomValue(configAtom);
  const state = useAtomValue(playerStateAtom);
  const playback = useAtomValue(playerPlaybackAtom);
  const error = useAtomValue(playerErrorAtom);
  const position = useAtomValue(playerPositionAtom);
  const duration = useAtomValue(playerDurationAtom);
  const volume = useAtomValue(playerVolumeAtom);
  const muted = useAtomValue(playerMuteAtom);
  const speed = useAtomValue(playerSpeedAtom);
  const progress = useAtomValue(playerProgressAtom);
  const shuffle = useAtomValue(shuffleAtom);
  const repeat = useAtomValue(repeatAtom);

  const spectrumRow = config.spectrumEnabled === true && !p.reducedMotion;

  const [frame, setFrame] = useState(0);

  // The only decorative timer: the buffering spinner. It never runs under
  // reduced motion, and there is no fake equalizer anywhere.
  useEffect(() => {
    if (state !== 'buffering' || p.reducedMotion) return;
    const interval = setInterval(() => {
      setFrame((f) => f + 1);
    }, 100);
    return () => clearInterval(interval);
  }, [state, p.reducedMotion]);

  const track = playback?.track ?? null;
  const icon = p.text(STATE_ICONS[state]);
  const title = track?.title ?? 'No track';
  const artist = track?.artist ?? '';
  const source = p.text(sourceTag(playback?.source.kind));

  const repeatIndicator =
    repeat === 'track' ? ` ${p.text('🔂')}` : repeat === 'all' ? ` ${p.text('🔁')}` : '';
  const shuffleIndicator = shuffle ? ` ${p.text('🔀')}` : '';
  const modeIndicators = `${shuffleIndicator}${repeatIndicator}`;

  const volumeLabel = muted ? p.text('🔇') : `${p.text('🔊')}${volume}%`;
  const speedLabel = speed !== 1 ? ` ${speed}x` : '';
  const timeLabel = `${formatTime(position)} / ${formatTime(duration)}`;

  // Status area: animated spinner only while buffering without reduced motion;
  // a static label otherwise. Playback itself shows no fake visualization —
  // the real spectrum is an opt-in Spectrum child row below.
  const spinnerFrames = spinnerFramesFor(p.ascii);
  const status =
    state === 'buffering' && !p.reducedMotion
      ? spinnerFrames[frame % spinnerFrames.length]
      : state === 'buffering'
        ? 'Loading...'
        : '';

  const vizColor = state === 'buffering' ? t.yellow : t.dim;

  // Progress bar with knob indicator
  const barWidth = 40;
  const filled = Math.round(progress * barWidth);
  const elapsed = p.text('━').repeat(filled);
  const remaining = p.text('─').repeat(barWidth - filled);
  const knob = filled > 0 && filled < barWidth ? p.text('●') : '';

  return (
    <box
      border
      borderStyle="rounded"
      {...p.borderProps}
      borderColor={t.accent}
      height={4 + (error ? 1 : 0) + (spectrumRow ? 1 : 0)}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row">
        <text fg={t.accent} attributes={TextAttributes.BOLD}>
          {icon}{' '}
        </text>
        {status ? <text fg={vizColor}>{status} </text> : null}
        <text fg={t.fg} attributes={TextAttributes.BOLD} truncate>
          {title}
        </text>
        {artist ? (
          <text fg={t.dim} truncate>
            {p.text(' — ')}
            {artist}
          </text>
        ) : null}
        {source ? <text fg={t.dim}> {source}</text> : null}
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
      {error ? (
        <box flexDirection="row">
          <text fg={t.red} truncate>
            {p.text('⚠')} {error}
          </text>
        </box>
      ) : null}
      {spectrumRow ? <Spectrum /> : null}
    </box>
  );
}
