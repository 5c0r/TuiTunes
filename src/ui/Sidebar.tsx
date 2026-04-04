import type React from 'react';
import { TextAttributes } from '@opentui/core';
import { useTheme } from './useTheme';
import type { Section, MusicView, PodcastView } from '../store/ui';

export type View = MusicView | PodcastView;

const MUSIC_ITEMS: Array<{ label: string; icon: string; view: MusicView }> = [
  { label: 'Search', icon: '/', view: 'search' },
  { label: 'Queue', icon: 'Q', view: 'queue' },
  { label: 'Favorites', icon: '♥', view: 'library' },
  { label: 'History', icon: '⟲', view: 'explore' },
];

const PODCAST_ITEMS: Array<{ label: string; icon: string; view: PodcastView }> = [
  { label: 'Search', icon: '/', view: 'search' },
  { label: 'My Feeds', icon: '📋', view: 'feeds' },
  { label: 'Episodes', icon: '📜', view: 'episodes' },
];

interface SidebarProps {
  focused: boolean;
  section: Section;
  activeView: View;
  onViewChange: (view: View) => void;
}

export function Sidebar({ focused, section, activeView }: SidebarProps): React.ReactNode {
  const t = useTheme();
  const items = section === 'podcast' ? PODCAST_ITEMS : MUSIC_ITEMS;

  return (
    <box
      width={22}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={focused ? t.accent : t.border}
      backgroundColor={t.bg}
      paddingLeft={1}
    >
      <text attributes={TextAttributes.BOLD} fg={t.fg}>
        {section === 'podcast' ? '🎙 Podcasts' : '♪ Music'}
      </text>
      {items.map((item) => {
        const active = item.view === activeView;
        return (
          <text
            key={item.view}
            fg={active ? t.accent : focused ? t.fg : t.dim}
            bg={active ? t.selection : undefined}
            attributes={active ? TextAttributes.BOLD : 0}
          >
            {active ? ' ▸ ' : '   '}{item.icon} {item.label}
          </text>
        );
      })}
    </box>
  );
}
