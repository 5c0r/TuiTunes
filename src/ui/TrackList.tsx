import type { ScrollBoxRenderable } from '@opentui/core';
import { TextAttributes } from '@opentui/core';
import { useEffect, useRef } from 'react';
import { mediaKey } from '../providers/media';
import type { Track } from '../providers/types';
import { formatTime } from '../utils/format';
import { usePresentation } from './usePresentation';
import { usePointerClicks } from './usePointerClicks';
import { useTheme } from './useTheme';

export interface TrackListProps {
  tracks: Track[];
  focused: boolean;
  selectedIndex: number;
  /** Index of the currently playing row (highlighted with >), or -1. */
  playingIndex?: number;
  /** If true, show [x] remove hint on selected row. */
  showRemoveHint?: boolean;
  rowNotes?: readonly (string | undefined)[];
  /** Queue panels use durable entry IDs, not media identity or duplicate titles. */
  rowIds?: readonly string[];
  onRowClick?: (index: number, activate: boolean) => void;
}

export function TrackList({
  focused,
  tracks,
  selectedIndex,
  playingIndex = -1,
  showRemoveHint,
  rowNotes,
  rowIds,
  onRowClick,
}: TrackListProps) {
  const t = useTheme();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const p = usePresentation(scrollRef);
  const { bind, clear } = usePointerClicks(tracks, { context: rowIds, active: focused, scrollRef });

  // Let OpenTUI handle scroll: scrollChildIntoView scrolls the minimum
  // amount needed to keep the selected row visible (page-turn style).
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || tracks.length === 0) return;
    sb.scrollChildIntoView(`track-row-${selectedIndex}`);
  }, [selectedIndex, tracks.length]);

  if (tracks.length === 0) {
    return (
      <box paddingLeft={1} paddingTop={1}>
        <text fg={t.dim}>No tracks found</text>
      </box>
    );
  }

  return (
    <scrollbox ref={scrollRef} onMouseScroll={clear} {...p.scrollbarProps}>
      {tracks.map((track, i) => {
        const selected = i === selectedIndex;
        const rowId = rowIds?.[i] ?? `${mediaKey(track)}:${i}`;
        const playing = i === playingIndex;
        const num = String(i + 1).padStart(2, ' ');
        const dur = formatTime(track.duration);

        const icon = playing ? `${p.icon('play')} ` : selected ? `${p.icon('selected')} ` : '  ';
        const iconColor = playing ? t.green : t.accent;
        const titleColor = playing ? t.green : selected ? t.accent : t.fg;
        const metaColor = playing ? t.playingFg : selected ? t.dim : t.dim;
        const bg = selected ? t.selection : playing ? t.playing : undefined;
        const bold = selected || playing ? TextAttributes.BOLD : 0;

        return (
          <box
            key={rowId}
            id={`track-row-${i}`}
            flexDirection="column"
            backgroundColor={bg}
            paddingLeft={1}
            paddingRight={1}
            onMouse={
              onRowClick ? bind(rowId, (activate) => onRowClick(i, activate), true) : undefined
            }
          >
            <box flexDirection="row">
              <text fg={selected ? iconColor : t.dim} attributes={bold}>
                {num} {icon}
              </text>
              <text fg={titleColor} attributes={bold} truncate flexGrow={1}>
                {track.title}
              </text>
              {playing && (
                <text fg={t.green} attributes={TextAttributes.BOLD}>
                  {' '}
                  {p.icon('music')}{' '}
                </text>
              )}
              <text fg={t.dim}> {dur}</text>
              {selected && showRemoveHint && <text fg={t.red}> [x]</text>}
            </box>
            <box flexDirection="row">
              <text fg={metaColor}>
                {'      '}
                {track.artist}
                {track.album ? `${p.text(' — ')}${track.album}` : ''}
              </text>
              {rowNotes?.[i] && <text fg={t.accent} truncate>{`  ${rowNotes[i]}`}</text>}
            </box>
          </box>
        );
      })}
    </scrollbox>
  );
}
