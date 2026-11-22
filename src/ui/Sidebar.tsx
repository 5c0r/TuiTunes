import { TextAttributes } from '@opentui/core';
import type React from 'react';
import type { MusicView, PodcastView, Section } from '../store/ui';
import type { IconName } from './presentation';
import { usePresentation } from './usePresentation';
import { usePointerClicks } from './usePointerClicks';
import { useTheme } from './useTheme';

export type View = MusicView | PodcastView;

const MUSIC_ITEMS: Array<{ label: string; icon: IconName; view: MusicView }> = [
  { label: 'Search', icon: 'search', view: 'search' },
  { label: 'Queue', icon: 'queue', view: 'queue' },
  { label: 'Favorites', icon: 'favorite', view: 'library' },
  { label: 'History', icon: 'history', view: 'explore' },
];

const PODCAST_ITEMS: Array<{ label: string; icon: IconName; view: PodcastView }> = [
  { label: 'Search', icon: 'search', view: 'search' },
  { label: 'My Feeds', icon: 'feeds', view: 'feeds' },
  { label: 'Episodes', icon: 'episodes', view: 'episodes' },
];

interface SidebarProps {
  focused: boolean;
  section: Section;
  activeView: View;
  onViewClick?: (view: View) => void;
}

export function Sidebar({
  focused,
  section,
  activeView,
  onViewClick,
}: SidebarProps): React.ReactNode {
  const t = useTheme();
  const p = usePresentation();
  const { bind } = usePointerClicks(section, { context: activeView });
  const items = section === 'podcast' ? PODCAST_ITEMS : MUSIC_ITEMS;

  return (
    <box
      width={22}
      flexDirection="column"
      border
      borderStyle="rounded"
      {...p.borderProps}
      borderColor={focused ? t.accent : t.border}
      backgroundColor={t.bg}
      paddingLeft={1}
    >
      <text attributes={TextAttributes.BOLD} fg={t.fg}>
        {section === 'podcast' ? `${p.icon('podcast')} Podcasts` : `${p.icon('music')} Music`}
      </text>
      {items.map((item) => {
        const active = item.view === activeView;
        return (
          <text
            key={item.view}
            fg={active ? t.accent : focused ? t.fg : t.dim}
            bg={active ? t.selection : undefined}
            attributes={active ? TextAttributes.BOLD : 0}
            selectable={false}
            onMouse={onViewClick ? bind(item.view, () => onViewClick(item.view)) : undefined}
          >
            {active ? ` ${p.icon('selected')} ` : '   '}
            {p.icon(item.icon)} {item.label}
          </text>
        );
      })}
    </box>
  );
}
