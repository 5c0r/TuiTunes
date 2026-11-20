import { TextAttributes } from '@opentui/core';
import type React from 'react';
import type { MusicView, PodcastView, Section } from '../store/ui';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

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
}

export function Sidebar({ focused, section, activeView }: SidebarProps): React.ReactNode {
  const t = useTheme();
  const p = usePresentation();
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
        {section === 'podcast' ? `${p.text('🎙')} Podcasts` : `${p.text('♪')} Music`}
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
            {active ? ` ${p.text('▸')} ` : '   '}
            {p.text(item.icon)} {item.label}
          </text>
        );
      })}
    </box>
  );
}
