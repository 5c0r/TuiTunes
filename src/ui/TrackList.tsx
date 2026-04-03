import React, { useEffect, useRef } from 'react';
import { TextAttributes } from '@opentui/core';
import type { ScrollBoxRenderable } from '@opentui/core';
import type { Track } from '../providers/types';
import { formatTime } from '../utils/format';
import { useTheme } from './useTheme';

export interface TrackListProps {
  tracks: Track[];
  focused: boolean;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onPlay: (track: Track) => void;
  /** ID of the currently playing track (highlights with ▶). */
  playingTrackId?: string;
  /** If true, show [x] remove hint on selected row. */
  showRemoveHint?: boolean;
}

export function TrackList({
  tracks,
  selectedIndex,
  onPlay,
  playingTrackId,
  showRemoveHint,
}: TrackListProps) {
  const t = useTheme();
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Smooth follow scroll: keep the selected row visible by scrolling
  // just enough to reveal it at the viewport edge. Moving down places
  // the row at the bottom; moving up places it at the top.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || tracks.length === 0) return;

    const child = sb.content.findDescendantById(`track-row-${selectedIndex}`);
    if (!child) return;

    const viewTop = sb.scrollTop;
    const viewHeight = sb.viewport.height;
    const viewBottom = viewTop + viewHeight;
    const childTop = child.y;
    const childBottom = child.y + child.height;

    // Selection below visible area → scroll to show at bottom edge
    if (childBottom > viewBottom) {
      sb.scrollTop = childBottom - viewHeight;
      return;
    }

    // Selection above visible area → scroll to show at top edge
    if (childTop < viewTop) {
      sb.scrollTop = childTop;
      return;
    }
  }, [selectedIndex, tracks.length]);

  if (tracks.length === 0) {
    return (
      <box paddingLeft={1} paddingTop={1}>
        <text fg={t.dim}>No tracks found</text>
      </box>
    );
  }

  return (
    <scrollbox ref={scrollRef} stickyScroll stickyStart="top">
      {tracks.map((track, i) => {
        const selected = i === selectedIndex;
        const playing = track.id === playingTrackId;
        const num = String(i + 1).padStart(2, ' ');
        const dur = formatTime(track.duration);

        const icon = playing ? '▶ ' : selected ? '▸ ' : '  ';
        const iconColor = playing ? t.green : t.accent;
        const titleColor = playing ? t.green : selected ? t.accent : t.fg;
        const metaColor = playing ? t.playingFg : selected ? t.dim : t.dim;
        const bg = selected ? t.selection : playing ? t.playing : undefined;
        const bold = selected || playing ? TextAttributes.BOLD : 0;

        return (
          <box
            key={track.id + i}
            id={`track-row-${i}`}
            flexDirection="column"
            backgroundColor={bg}
            paddingLeft={1}
            paddingRight={1}
          >
            <box flexDirection="row">
              <text fg={selected ? iconColor : t.dim} attributes={bold}>
                {num}  {icon}
              </text>
              <text fg={titleColor} attributes={bold} truncate flexGrow={1}>
                {track.title}
              </text>
              {playing && (
                <text fg={t.green} attributes={TextAttributes.BOLD}> ♪ </text>
              )}
              <text fg={t.dim}> {dur}</text>
              {selected && showRemoveHint && (
                <text fg={t.red}> [x]</text>
              )}
            </box>
            <box flexDirection="row">
              <text fg={metaColor}>
                {'      '}{track.artist}{track.album ? ` — ${track.album}` : ''}
              </text>
            </box>
          </box>
        );
      })}
    </scrollbox>
  );
}
