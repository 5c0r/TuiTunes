import React, { useEffect, useRef } from 'react';
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

  const currentIdx = data.synced ? findCurrentLine(data.lines, position) : -1;
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Auto-scroll to keep the current lyric line centered in the viewport
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || currentIdx < 0) return;

    const child = sb.content.findDescendantById(`lyric-${currentIdx}`);
    if (!child) return;

    const viewportH = sb.viewport.height;
    const targetScroll = Math.max(0, child.y - Math.floor(viewportH * 0.4));
    sb.scrollTop = targetScroll;
  }, [currentIdx]);

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
              <text
                key={i}
                id={`lyric-${i}`}
                fg={color}
                attributes={isCurrent ? TextAttributes.BOLD : 0}
              >
                {ts} {marker}{line.text}
              </text>
            );
          }

          return (
            <text key={i} fg={t.fg}>
              {line.text}
            </text>
          );
        })}
      </scrollbox>
      {/* Source attribution */}
      <box paddingLeft={1} paddingTop={1}>
        <text fg={t.border} attributes={TextAttributes.DIM}>
          Source: {data.source}{data.sourceUrl ? ` • ${data.sourceUrl}` : ''}
        </text>
      </box>
    </box>
  );
}
