import { type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef } from 'react';
import type { Overlay } from '../store/ui';
import { formatTime } from '../utils/format';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

interface EpisodeBookmarksProps {
  overlay: Extract<Overlay, { kind: 'episode-bookmarks' }>;
  onInput(value: string): void;
}

/** Keyboard dispatch and bookmark operations stay in the app. */
export function EpisodeBookmarks({ overlay, onInput }: EpisodeBookmarksProps) {
  const t = useTheme();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const p = usePresentation(scrollRef);
  const { width, height } = useTerminalDimensions();
  const selected = overlay.bookmarks[overlay.selectedIdx];
  useEffect(() => {
    if (selected && height > 2) scrollRef.current?.scrollChildIntoView(selected.id);
  }, [selected, height]);

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={Math.min(66, Math.max(1, width - 2))}
        height={Math.min(16, Math.max(1, height - 2))}
        border
        borderStyle="double"
        {...p.borderProps}
        borderColor={t.accent}
        backgroundColor={t.bg}
        title="Episode Bookmarks"
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={t.fg} truncate>
          {overlay.track.title}
        </text>
        <scrollbox ref={scrollRef} flexGrow={1} minHeight={0} {...p.scrollbarProps}>
          {overlay.bookmarks.length === 0 ? (
            <text fg={t.dim}>No bookmarks. Use Add Bookmark while listening.</text>
          ) : (
            overlay.bookmarks.map((bookmark, i) => (
              <text
                key={bookmark.id}
                id={bookmark.id}
                fg={i === overlay.selectedIdx ? t.accent : t.fg}
                attributes={i === overlay.selectedIdx ? TextAttributes.BOLD : 0}
                truncate
              >
                {i === overlay.selectedIdx ? `${p.icon('selected')} ` : '  '}[
                {formatTime(bookmark.positionMs / 1000)}] {bookmark.label}
                {bookmark.audioKey.startsWith('youtube:') ? ' [YT]' : ' [RSS]'}
              </text>
            ))
          )}
        </scrollbox>
        {overlay.editing === 'rename' && (
          <input focused value={overlay.value} placeholder="New bookmark name" onInput={onInput} />
        )}
        {overlay.editing === 'delete' && (
          <text fg={t.yellow} truncate>
            Delete {selected?.label}?
          </text>
        )}
        {overlay.error && (
          <text fg={t.red} truncate>
            {overlay.error}
          </text>
        )}
        <text fg={t.dim} truncate>
          {overlay.editing === 'rename'
            ? '[enter] save [esc] cancel'
            : overlay.editing === 'delete'
              ? '[enter] delete [esc] cancel'
              : selected
                ? '[j/k] select [enter] jump [r] rename [x] delete [esc] close'
                : '[esc] close'}
        </text>
      </box>
    </box>
  );
}
