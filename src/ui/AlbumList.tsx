import type { ScrollBoxRenderable } from '@opentui/core';
import { TextAttributes } from '@opentui/core';
import { useEffect, useRef } from 'react';
import type { AlbumSummary } from '../providers/types';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

export interface AlbumListProps {
  albums: AlbumSummary[];
  selectedIndex: number;
  /** Parity with TrackList; the catalog controller owns the selection. */
  focused: boolean;
}

/**
 * Presentation-only list of album/release cards (Albums and Singles & EPs
 * tabs). Provider order is preserved; selection chrome follows TrackList.
 */
export function AlbumList({ albums, selectedIndex }: AlbumListProps) {
  const t = useTheme();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const p = usePresentation(scrollRef);

  // Let OpenTUI handle scroll, page-turn style like TrackList.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || albums.length === 0) return;
    sb.scrollChildIntoView(`album-row-${selectedIndex}`);
  }, [selectedIndex, albums.length]);

  if (albums.length === 0) {
    return (
      <box paddingLeft={1} paddingTop={1}>
        <text fg={t.dim}>No releases found</text>
      </box>
    );
  }

  return (
    <scrollbox ref={scrollRef} {...p.scrollbarProps}>
      {albums.map((album, i) => {
        const selected = i === selectedIndex;
        const num = String(i + 1).padStart(2, ' ');
        const bold = selected ? TextAttributes.BOLD : 0;

        return (
          <box
            key={`${album.id}-${i}`}
            id={`album-row-${i}`}
            flexDirection="column"
            backgroundColor={selected ? t.selection : undefined}
            paddingLeft={1}
            paddingRight={1}
          >
            <box flexDirection="row">
              <text fg={selected ? t.accent : t.dim} attributes={bold}>
                {num} {selected ? `${p.text('▸')} ` : '  '}
              </text>
              <text fg={selected ? t.accent : t.fg} attributes={bold} truncate flexGrow={1}>
                {album.title}
              </text>
            </box>
            <box flexDirection="row">
              <text fg={t.dim}>
                {'      '}
                {album.artist}
              </text>
            </box>
          </box>
        );
      })}
    </scrollbox>
  );
}
