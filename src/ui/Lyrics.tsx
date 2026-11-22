import type { ScrollBoxRenderable } from '@opentui/core';
import { TextAttributes } from '@opentui/core';
import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import type { LyricLine } from '../providers/lyrics';
import {
  lyricsDataAtom,
  lyricsErrorAtom,
  lyricsLoadingAtom,
  translationLoadingAtom,
} from '../store/lyrics';
import { playerPositionAtom } from '../store/player';
import { Logger } from '../utils/logger';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Find the index of the active line: last line where time <= position. */
function findCurrentLine(lines: LyricLine[], position: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position) idx = i;
    else break;
  }
  return idx;
}

function lineColor(distance: number, t: ReturnType<typeof useTheme>): string {
  if (distance === 0) return t.accent;
  if (distance <= 2) return t.fg;
  if (distance <= 5) return t.dim;
  return t.border;
}

export function Lyrics() {
  const t = useTheme();
  const data = useAtomValue(lyricsDataAtom);
  const loading = useAtomValue(lyricsLoadingAtom);
  const translating = useAtomValue(translationLoadingAtom);
  const error = useAtomValue(lyricsErrorAtom);
  const position = useAtomValue(playerPositionAtom);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const p = usePresentation(scrollRef);

  // Compute current line BEFORE early returns so the effect always has it.
  // When data is absent, currentIdx stays -1 and the effect is a no-op.
  const currentIdx = data?.synced ? findCurrentLine(data.lines, position) : -1;

  // Auto-scroll: keep the active lyric line visible using OpenTUI's built-in
  // scrollChildIntoView. Scrolls the minimum amount needed — if the line is
  // already visible, it doesn't scroll at all.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || currentIdx < 0) return;
    sb.scrollChildIntoView(`lyric-${currentIdx}`);
  }, [currentIdx]);

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
      <scrollbox ref={scrollRef} {...p.scrollbarProps}>
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
            const ts = `[${formatTimestamp(line.time)}]`;

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
