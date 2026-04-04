export interface Command {
  id: string;
  name: string;
  description: string;
  shortcut?: string;
  category: 'playback' | 'navigation' | 'queue' | 'view' | 'app';
}

export const COMMANDS: Command[] = [
  { id: 'play-pause', name: 'Play / Pause', description: 'Toggle playback', shortcut: 'space', category: 'playback' },
  { id: 'next', name: 'Next Track', description: 'Play next track in queue', shortcut: 'n', category: 'playback' },
  { id: 'prev', name: 'Previous Track', description: 'Play previous track', shortcut: 'p', category: 'playback' },
  { id: 'seek-forward', name: 'Seek Forward', description: 'Skip ahead 10 seconds', shortcut: '>', category: 'playback' },
  { id: 'seek-backward', name: 'Seek Backward', description: 'Go back 10 seconds', shortcut: '<', category: 'playback' },
  { id: 'seek-to', name: 'Jump to Time', description: 'Seek to a specific time', shortcut: 't', category: 'playback' },
  { id: 'volume-up', name: 'Volume Up', description: 'Increase volume by 5', shortcut: '+', category: 'playback' },
  { id: 'volume-down', name: 'Volume Down', description: 'Decrease volume by 5', shortcut: '-', category: 'playback' },
  { id: 'mute', name: 'Toggle Mute', description: 'Mute/unmute audio', shortcut: 'm', category: 'playback' },
  { id: 'speed-up', name: 'Speed Up', description: 'Increase playback speed', shortcut: ']', category: 'playback' },
  { id: 'speed-down', name: 'Speed Down', description: 'Decrease playback speed', shortcut: '[', category: 'playback' },
  { id: 'speed-reset', name: 'Speed: Normal (1x)', description: 'Reset to normal speed', category: 'playback' },
  { id: 'speed-1.5', name: 'Speed: 1.5x', description: 'Set playback to 1.5x', category: 'playback' },
  { id: 'speed-2', name: 'Speed: 2x', description: 'Set playback to 2x', category: 'playback' },
  { id: 'shuffle', name: 'Toggle Shuffle', description: 'Shuffle queue order', shortcut: 's', category: 'queue' },
  { id: 'repeat', name: 'Cycle Repeat', description: 'Off → All → Track', shortcut: 'r', category: 'queue' },
  { id: 'search', name: 'Search', description: 'Focus search input', shortcut: '/', category: 'navigation' },
  { id: 'view-search', name: 'Search View', description: 'Show search results', category: 'view' },
  { id: 'view-queue', name: 'Queue View', description: 'Show playback queue', category: 'view' },
  { id: 'view-favorites', name: 'Favorites View', description: 'Show saved tracks', category: 'view' },
  { id: 'view-history', name: 'History View', description: 'Show recently played', category: 'view' },
  { id: 'layout-default', name: 'Default Layout', description: 'Sidebar + main + footer', category: 'view' },
  { id: 'layout-compact', name: 'Compact Layout', description: 'No sidebar', category: 'view' },
  { id: 'layout-minimal', name: 'Minimal Layout', description: 'Mini player only', category: 'view' },
  { id: 'layout-split', name: 'Split Layout', description: 'Queue left, results right', category: 'view' },
  { id: 'layout-wide', name: 'Wide Layout', description: 'Extended now playing', category: 'view' },
  { id: 'layout-focus', name: 'Focus Layout', description: 'Distraction free', category: 'view' },
  { id: 'lyrics', name: 'Toggle Lyrics', description: 'Show/hide synced lyrics', shortcut: 'l', category: 'view' },
  { id: 'load-more', name: 'Load More', description: 'Load next page of results', shortcut: 'shift+l', category: 'navigation' },
  { id: 'favorite', name: 'Toggle Favorite', description: 'Save/unsave selected track', shortcut: 'f', category: 'queue' },
  { id: 'queue-add', name: 'Add to Queue', description: 'Queue selected track for playback', shortcut: 'q', category: 'queue' },
  { id: 'queue-remove', name: 'Remove from Queue', description: 'Remove selected track from queue', shortcut: 'x', category: 'queue' },
  { id: 'podcast-search', name: 'Search Podcasts', description: 'Find podcasts via iTunes', category: 'navigation' },
  { id: 'podcast-feeds', name: 'My Podcasts', description: 'Show subscribed feeds', category: 'view' },
  { id: 'podcast-subscribe', name: 'Subscribe', description: 'Subscribe to current podcast', category: 'queue' },
  { id: 'podcast-unsubscribe', name: 'Unsubscribe', description: 'Unsubscribe from current podcast', category: 'queue' },
  { id: 'transcript-url', name: 'Transcript: Custom URL', description: 'Load transcript from a SRT/VTT URL', category: 'view' },
  { id: 'transcript-auto', name: 'Transcript: Auto Source', description: 'Reset to automatic transcript detection', category: 'view' },
  { id: 'transcript-reload', name: 'Transcript: Reload', description: 'Re-fetch transcript for current episode', category: 'view' },
  { id: 'layout-cycle', name: 'Cycle Layout', description: 'Switch to next layout preset', shortcut: 'ctrl+l', category: 'view' },
  { id: 'theme-cycle', name: 'Cycle Theme', description: 'Switch to next color theme', shortcut: 'ctrl+t', category: 'view' },
  { id: 'section-music', name: 'Music Section', description: 'Switch to music section', shortcut: 'ctrl+1', category: 'navigation' },
  { id: 'section-podcast', name: 'Podcast Section', description: 'Switch to podcast section', shortcut: 'ctrl+2', category: 'navigation' },
  { id: 'help', name: 'Help', description: 'Show keybindings', shortcut: '?', category: 'app' },
  { id: 'quit', name: 'Quit', description: 'Exit TuiTunes', shortcut: 'ctrl+q', category: 'app' },
];

/** Fuzzy filter commands by query. Matches against name and description. */
export function filterCommands(query: string): Command[] {
  if (!query.trim()) return COMMANDS;
  const terms = query.toLowerCase().split(/\s+/);
  return COMMANDS.filter((cmd) => {
    const haystack = (cmd.name + ' ' + cmd.description + ' ' + (cmd.category ?? '')).toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
