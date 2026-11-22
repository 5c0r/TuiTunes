import { type BoxRenderable, type MouseEvent, TextAttributes } from '@opentui/core';
import { useAtomValue, useStore } from 'jotai';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { episodeProgressErrorAtom } from '../application/episode-progress';
import type { PlayerState } from '../player/types';
import { configAtom } from '../store/config';
import {
  playerDurationAtom,
  playerErrorAtom,
  playerMuteAtom,
  playerPlaybackAtom,
  playerNoticeAtom,
  playerPositionAtom,
  playerProgressAtom,
  playerSeekableRequestAtom,
  playerSpeedAtom,
  playerStateAtom,
  playerVolumeAtom,
} from '../store/player';
import { queuePersistenceErrorAtom, queueStateAtom, repeatAtom, shuffleAtom } from '../store/queue';
import { nextEntryId, previousEntryId } from '../store/queue-actions';
import { overlayAtom } from '../store/ui';
import { formatTime } from '../utils/format';
import { type IconName, spinnerFramesFor } from './presentation';
import { Spectrum } from './Spectrum';
import { usePointerClicks } from './usePointerClicks';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

/** Transport commands NowPlaying can dispatch to the shared App boundary. */
export type NowPlayingCommand = 'play-pause' | 'prev' | 'next' | 'mute';

export interface NowPlayingProps {
  /**
   * Dispatched for a transport/mute click after live eligibility checks.
   * The App wrapper owns the shared command + error boundary.
   */
  onCommand?: (id: NowPlayingCommand) => void;
  /**
   * Absolute seek into the committed target's timeline. Carries the
   * requestId the click was measured against so the boundary can reject
   * seeks for a request that has since been superseded.
   */
  onSeek?: (seconds: number, requestId: number) => void;
}

const STATE_ICON_NAMES: Record<PlayerState, IconName> = {
  playing: 'play',
  paused: 'pause',
  buffering: 'buffering',
  stopped: 'stop',
};

const FULL_CONTROL_LABELS_WIDTH = 46;
const COMPACT_CONTROL_LABELS_WIDTH = 28;

/** A pending progress-bar press, matched on release before any dispatch. */
interface SeekPress {
  x: number;
  y: number;
  left: number;
  width: number;
  requestId: number;
}

/** Actual playback source of the committed target, shown as [RSS] / [YT]. */
function sourceTag(sourceKind: 'rss' | 'youtube' | undefined): string {
  if (sourceKind === 'rss') return '[RSS]';
  if (sourceKind === 'youtube') return '[YT]';
  return '';
}

export function NowPlaying({ onCommand, onSeek }: NowPlayingProps = {}) {
  const t = useTheme();
  const p = usePresentation();
  const store = useStore();
  const config = useAtomValue(configAtom);
  const state = useAtomValue(playerStateAtom);
  const playback = useAtomValue(playerPlaybackAtom);
  const playerError = useAtomValue(playerErrorAtom);
  const episodeError = useAtomValue(episodeProgressErrorAtom);
  const queueError = useAtomValue(queuePersistenceErrorAtom);
  const notice = useAtomValue(playerNoticeAtom);
  const error = playerError ?? episodeError ?? queueError;
  const message = error ?? notice;
  const position = useAtomValue(playerPositionAtom);
  const duration = useAtomValue(playerDurationAtom);
  const volume = useAtomValue(playerVolumeAtom);
  const muted = useAtomValue(playerMuteAtom);
  const speed = useAtomValue(playerSpeedAtom);
  const progress = useAtomValue(playerProgressAtom);
  const queueState = useAtomValue(queueStateAtom);
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
  const icon = p.icon(STATE_ICON_NAMES[state]);
  const title = track?.title ?? 'No track';
  const artist = track?.artist ?? '';
  const source = p.text(sourceTag(playback?.source.kind));

  const repeatIcon: IconName = repeat === 'track' ? 'repeatOne' : 'repeat';
  const repeatIndicator = repeat === 'off' ? '' : ` ${p.icon(repeatIcon)}`;
  const shuffleIndicator = shuffle ? ` ${p.icon('shuffle')}` : '';
  const modeIndicators = `${shuffleIndicator}${repeatIndicator}`;

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

  const seekRef = useRef<BoxRenderable>(null);
  const seekPress = useRef<SeekPress | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  const syncSeekWidth = () => {
    seekPress.current = null;
    setBarWidth(seekRef.current?.width ?? 0);
  };
  const seekableRequestId = useAtomValue(playerSeekableRequestAtom);
  const canSeek =
    playback !== null &&
    seekableRequestId === playback.requestId &&
    Number.isFinite(duration) &&
    duration > 0 &&
    barWidth > 1;

  useLayoutEffect(() => {
    const clear = () => {
      seekPress.current = null;
    };
    const unsubscribeOverlay = store.sub(overlayAtom, clear);
    const unsubscribeReady = store.sub(playerSeekableRequestAtom, clear);
    return () => {
      unsubscribeOverlay();
      unsubscribeReady();
    };
  }, [store]);

  const fraction = Number.isFinite(progress) ? progress : 0;
  const interior = fraction > 0 && fraction < 1 && barWidth > 2;
  const filled = interior
    ? Math.min(barWidth - 2, Math.max(1, Math.round(fraction * (barWidth - 1))))
    : Math.round(fraction * barWidth);
  const elapsed = p.text('━').repeat(filled);
  const remaining = p.text('─').repeat(barWidth - filled - (interior ? 1 : 0));
  const compact = barWidth < FULL_CONTROL_LABELS_WIDTH;
  const showLabels = barWidth >= COMPACT_CONTROL_LABELS_WIDTH;
  const transportLabel = (name: IconName, label: string) =>
    compact ? (showLabels ? label : p.icon(name)) : `${p.icon(name)} ${label}`;

  // -- Mouse transport -----------------------------------------------------
  // Visible eligibility mirrors the keyboard/session gates:
  // - Next/Prev need a live queue cursor with a legal destination; a direct
  //   target never owns the cursor, so it never enables them. A stopped
  //   queue target (EOF / failed load) still allows manual navigation.
  // - Play-pause needs a loaded/active target, buffering included.
  // - Mute is global.
  // Release handlers re-read the live store, so a click that lands after a
  // state change can never act on stale eligibility.
  const nextEnabled = nextEntryId(queueState) !== null;
  const prevEnabled = previousEntryId(queueState) !== null;
  const pauseEnabled = playback !== null && state !== 'stopped';
  const pauseLabel = state === 'playing' || state === 'buffering' ? 'Pause' : 'Play';

  const { bind } = usePointerClicks(playback?.requestId ?? 'none', { context: state });

  function dispatchCommand(id: NowPlayingCommand): () => void {
    return () => {
      if (!onCommand) return;
      if (id === 'next' && nextEntryId(store.get(queueStateAtom)) === null) return;
      if (id === 'prev' && previousEntryId(store.get(queueStateAtom)) === null) return;
      if (
        id === 'play-pause' &&
        (store.get(playerPlaybackAtom) === null || store.get(playerStateAtom) === 'stopped')
      )
        return;
      onCommand(id);
    };
  }

  function seek(event: MouseEvent): void {
    if (!onSeek) return;
    if (event.type === 'drag' || event.type === 'scroll') {
      seekPress.current = null;
      return;
    }
    if (event.type !== 'down' && event.type !== 'up') return;
    const press = seekPress.current;
    seekPress.current = null;
    const { alt, ctrl, shift } = event.modifiers;
    if (store.get(overlayAtom) || event.button !== 0 || alt || ctrl || shift) return;

    const bar = seekRef.current;
    const requestId = store.get(playerPlaybackAtom)?.requestId;
    const liveDuration = store.get(playerDurationAtom);
    if (
      !bar ||
      bar.width <= 1 ||
      requestId === undefined ||
      store.get(playerSeekableRequestAtom) !== requestId ||
      !Number.isFinite(liveDuration) ||
      liveDuration <= 0
    )
      return;
    const { x, y } = event;
    const left = bar.x;
    const width = bar.width;
    if (y !== bar.y || x < left || x >= left + width) return;
    if (event.type === 'down') {
      seekPress.current = { x, y, left, width, requestId };
    } else if (
      press?.requestId === requestId &&
      press.x === x &&
      press.y === y &&
      press.left === left &&
      press.width === width
    ) {
      onSeek(((x - left) / (width - 1)) * liveDuration, requestId);
    }
  }

  return (
    <box
      border
      borderStyle="rounded"
      {...p.borderProps}
      borderColor={t.accent}
      width="100%"
      maxWidth={120}
      height={5 + (message ? 1 : 0) + (spectrumRow ? 1 : 0)}
      flexShrink={0}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" height={1} flexShrink={0} gap={1}>
        <text fg={t.accent} attributes={TextAttributes.BOLD} flexShrink={0}>
          {icon}
        </text>
        {status && (
          <text fg={vizColor} flexShrink={0}>
            {status}
          </text>
        )}
        <text
          fg={t.fg}
          attributes={TextAttributes.BOLD}
          truncate
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
        >
          {title}
        </text>
        {artist && !compact && barWidth >= 64 && (
          <text fg={t.dim} truncate flexShrink={1} minWidth={0}>
            {p.text('— ')}
            {artist}
          </text>
        )}
        {source && (
          <text fg={t.dim} flexShrink={0}>
            {source}
          </text>
        )}
        {!compact && modeIndicators && (
          <text fg={t.dim} flexShrink={0}>
            {modeIndicators}
          </text>
        )}
        <text fg={t.dim} truncate flexShrink={0}>
          {timeLabel}
        </text>
      </box>
      <box flexDirection="row" height={1} flexShrink={0} gap={compact ? 1 : 2}>
        <text
          fg={prevEnabled ? t.accent : t.dim}
          selectable={false}
          wrapMode="none"
          onMouse={onCommand ? bind('prev', dispatchCommand('prev')) : undefined}
        >
          {transportLabel('previous', 'Prev')}
        </text>
        <text
          fg={pauseEnabled ? t.accent : t.dim}
          selectable={false}
          wrapMode="none"
          onMouse={onCommand ? bind('play-pause', dispatchCommand('play-pause')) : undefined}
        >
          {transportLabel(pauseLabel === 'Pause' ? 'pause' : 'play', pauseLabel)}
        </text>
        <text
          fg={nextEnabled ? t.accent : t.dim}
          selectable={false}
          wrapMode="none"
          onMouse={onCommand ? bind('next', dispatchCommand('next')) : undefined}
        >
          {transportLabel('next', 'Next')}
        </text>
        <text
          fg={t.accent}
          selectable={false}
          wrapMode="none"
          onMouse={onCommand ? bind('mute', dispatchCommand('mute')) : undefined}
        >
          {transportLabel(muted ? 'mute' : 'volume', muted ? 'Unmute' : 'Mute')}
        </text>
        <text fg={t.dim} truncate>
          {muted ? '' : `${volume}%`}
          {speedLabel}
        </text>
      </box>
      <box
        id="now-playing-seek"
        ref={seekRef}
        height={1}
        flexShrink={0}
        flexDirection="row"
        onSizeChange={syncSeekWidth}
        onMouse={onSeek ? seek : undefined}
      >
        <text selectable={false} fg={canSeek ? t.accent : t.dim}>
          {elapsed}
        </text>
        {interior && (
          <text selectable={false} fg={canSeek ? t.green : t.dim}>
            {p.text('●')}
          </text>
        )}
        <text selectable={false} fg={t.border}>
          {remaining}
        </text>
      </box>
      {message ? (
        <box flexDirection="row" height={1} flexShrink={0}>
          <text fg={error ? t.red : t.accent} truncate>
            {error ? `${p.icon('warning')} ` : ''}
            {message}
          </text>
        </box>
      ) : null}
      {spectrumRow ? <Spectrum /> : null}
    </box>
  );
}
