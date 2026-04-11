import { useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { TextAttributes } from '@opentui/core';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useTheme } from './useTheme';
import { lyricsDataAtom, lyricsLoadingAtom } from '../store/lyrics';
import { playerPositionAtom } from '../store/player';
import type { LyricLine } from '../providers/lyrics';

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
  const position = useAtomValue(playerPositionAtom);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Compute current line BEFORE early returns so the effect always has it.
  // When data is absent, currentIdx stays -1 and the effect is a no-op.
  const currentIdx = data?.synced ? findCurrentLine(data.lines, position) : -1;

  // Track previous line to avoid redundant scroll updates.
  const prevIdxRef = useRef(-1);

  // Auto-scroll: center the active line at ~40% from viewport top.
  // Uses <box id="lyric-N"> wrappers (not <text>) because box elements
  // have reliable layout positions for findDescendantById.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || currentIdx < 0) return;

    // Skip scroll if the line hasn't changed.
    if (currentIdx === prevIdxRef.current) return;
    prevIdxRef.current = currentIdx;

    const child = sb.content.findDescendantById(`lyric-${currentIdx}`);
    if (!child) return;

    const viewportH = sb.viewport.height;
    const targetScroll = Math.max(0, child.y - Math.floor(viewportH * 0.4));
    sb.scrollTop = targetScroll;
  }, [currentIdx]);

  if (loading) {
    return (
      <box
        border
        borderStyle="rounded"
        borderColor={t.border}
        title="Lyrics"
        flexGrow={1}
        paddingLeft={1}
      >
        <text fg={t.dim}>Loading lyrics...</text>
      </box>
    );
  }

  if (!data) {
    return (
      <box
        border
        borderStyle="rounded"
        borderColor={t.border}
        title="Lyrics"
        flexGrow={1}
        paddingLeft={1}
      >
        <text fg={t.dim}>No lyrics available</text>
      </box>
    );
  }

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={t.border}
      title="Lyrics"
      flexGrow={1}
      flexDirection="column"
    >
      <scrollbox ref={scrollRef}>
        {data.lines.map((line, i) => {
          if (data.synced) {
            const distance = currentIdx >= 0 ? Math.abs(i - currentIdx) : Infinity;
            const color = lineColor(distance, t);
            const isCurrent = i === currentIdx;
            const marker = isCurrent ? '♪ ' : '  ';
            const ts = `[${formatTimestamp(line.time)}]`;

            return (
              <box key={i} id={`lyric-${i}`}>
                <text fg={color} attributes={isCurrent ? TextAttributes.BOLD : 0}>
                  {ts} {marker}
                  {line.text}
                </text>
              </box>
            );
          }

          return (
            <box key={i} id={`lyric-${i}`} paddingLeft={1}>
              <text fg={t.fg}>{line.text}</text>
            </box>
          );
        })}
      </scrollbox>
      {/* Source attribution */}
      <box paddingLeft={1} paddingTop={1}>
        <text fg={t.border} attributes={TextAttributes.DIM}>
          Source: {data.source}
          {data.sourceUrl ? ` • ${data.sourceUrl}` : ''}
        </text>
      </box>
    </box>
  );
}
