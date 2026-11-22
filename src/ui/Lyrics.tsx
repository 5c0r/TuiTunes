import { TextAttributes } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { useEffect } from 'react';
import { activeLyricIndex, effectiveCueMs } from '../application/lyric-timing';
import {
  lyricsDataAtom,
  lyricsDocumentAtom,
  lyricsErrorAtom,
  lyricsLoadingAtom,
  translationLoadingAtom,
} from '../store/lyrics';
import { playerPositionAtom } from '../store/player';
import type { LyricFollowMode } from '../utils/config';
import { Logger } from '../utils/logger';
import { useLyricFollow } from './useLyricFollow';
import { usePointerClicks } from './usePointerClicks';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';
import type { Theme } from './themes';

export { lyricFollowSuspendedAtom } from './useLyricFollow';

export interface LyricsProps {
  /** Live lyric delay in milliseconds; highlights and labels shift by it. */
  readonly delayMs?: number;
  /** Persisted follow policy for the active line. */
  readonly followMode?: LyricFollowMode;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function lineColor(distance: number, t: Theme): string {
  if (distance === 0) return t.accent;
  if (distance <= 2) return t.fg;
  if (distance <= 5) return t.dim;
  return t.border;
}

export function Lyrics({ delayMs = 0, followMode = 'keep-visible' }: LyricsProps) {
  const t = useTheme();
  const document = useAtomValue(lyricsDocumentAtom);
  const data = useAtomValue(lyricsDataAtom);
  const loading = useAtomValue(lyricsLoadingAtom);
  const translating = useAtomValue(translationLoadingAtom);
  const error = useAtomValue(lyricsErrorAtom);
  const position = useAtomValue(playerPositionAtom);

  // Compute current line BEFORE early returns so the follow hook always has
  // it. When data is absent or unsynced, currentIdx stays -1 and following is
  // a no-op: unsynced lyrics never jump.
  const currentIdx = data?.synced ? activeLyricIndex(data.lines, position, delayMs) : -1;

  const follow = useLyricFollow({
    document,
    lines: data?.lines ?? null,
    activeIndex: currentIdx,
    followMode,
    enabled: data?.synced === true,
    scrollPresent: !loading && data !== null,
  });
  const p = usePresentation(follow.scrollRef);
  const clicks = usePointerClicks(document?.mediaKey ?? 'none', {
    context: document?.contentHash ?? null,
    active: !loading && data !== null,
    scrollRef: follow.scrollRef,
  });

  // Log when translation data arrives at the rendering layer
  useEffect(() => {
    if (!data) return;
    if (data.translatedTo) {
      const translatedCount = data.lines.filter(
        (l) => l.translatedText && l.translatedText.length > 0,
      ).length;
      Logger.debug(
        `Lyrics render: displaying ${translatedCount}/${data.lines.length} translated lines (${data.source}→${data.translatedTo})`,
      );
    }
  }, [data]);

  const titleSuffix = data?.translatedTo
    ? ` [${p.text('→')} ${data.translatedTo.toUpperCase()}]`
    : translating
      ? ' [translating...]'
      : '';

  if (loading) {
    return (
      <box
        border
        borderStyle="rounded"
        {...p.borderProps}
        borderColor={t.border}
        title={`Lyrics${titleSuffix}`}
        flexGrow={1}
        paddingLeft={1}
        flexDirection="column"
      >
        <text fg={t.dim}>Loading lyrics...</text>
        {error && (
          <text fg={t.red} truncate>
            {error}
          </text>
        )}
      </box>
    );
  }

  if (!data) {
    return (
      <box
        border
        borderStyle="rounded"
        {...p.borderProps}
        borderColor={t.border}
        title="Lyrics"
        flexGrow={1}
        paddingLeft={1}
        flexDirection="column"
      >
        <text fg={t.dim}>{error ?? 'No lyrics available'}</text>
      </box>
    );
  }

  return (
    <box
      border
      borderStyle="rounded"
      {...p.borderProps}
      borderColor={t.border}
      title={`Lyrics${titleSuffix}`}
      flexGrow={1}
      flexDirection="column"
    >
      <scrollbox ref={follow.scrollRef} onMouse={follow.onPaneMouse} {...p.scrollbarProps}>
        {error && (
          <box paddingLeft={1}>
            <text fg={t.red} truncate>
              {error}
            </text>
          </box>
        )}
        {data.lines.map((line, i) => {
          if (data.synced) {
            const distance = currentIdx >= 0 ? Math.abs(i - currentIdx) : Infinity;
            const color = lineColor(distance, t);
            const isCurrent = i === currentIdx;
            const marker = isCurrent ? `${p.icon('music')} ` : '  ';
            // Label shows the effective cue; negative adjusted cues clamp to
            // zero for display while the source line stays immutable.
            const cueMs = Math.max(0, effectiveCueMs(line.time, delayMs));
            const ts = `[${formatTimestamp(cueMs / 1000)}]`;

            return (
              <box key={i} id={`lyric-${i}`} flexDirection="column">
                <text fg={color} attributes={isCurrent ? TextAttributes.BOLD : 0}>
                  {ts} {marker}
                  {line.text}
                </text>
                {line.translatedText && (
                  <text fg={t.dim} attributes={TextAttributes.DIM}>
                    {'       '}
                    {line.translatedText}
                  </text>
                )}
              </box>
            );
          }

          return (
            <box key={i} flexDirection="column">
              <text fg={t.fg}>{line.text}</text>
              {line.translatedText && (
                <text fg={t.dim} attributes={TextAttributes.DIM}>
                  {line.translatedText}
                </text>
              )}
            </box>
          );
        })}
      </scrollbox>
      {/* Manual-scroll resume action; pointer clicks respect open modals. */}
      {follow.suspended && (
        <box paddingLeft={1} paddingTop={1}>
          <text
            fg={t.accent}
            attributes={TextAttributes.BOLD}
            onMouse={clicks.bind('follow-lyrics', () => follow.resume())}
          >
            {p.icon('selected')} Follow Lyrics
          </text>
        </box>
      )}
      {/* Source attribution */}
      <box paddingLeft={1} paddingTop={1}>
        <text fg={t.border} attributes={TextAttributes.DIM}>
          Source: {data.source}
          {data.sourceUrl ? ` ${p.text('•')} ${data.sourceUrl}` : ''}
        </text>
      </box>
    </box>
  );
}
