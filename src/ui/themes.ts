export interface Theme {
  name: string;
  accent: string;
  bg: string;
  fg: string;
  dim: string;
  green: string;
  red: string;
  yellow: string;
  selection: string;     // bg for selected row
  border: string;        // inactive border
  borderActive: string;  // focused border (usually === accent)
  playing: string;       // bg for playing row
  playingFg: string;     // secondary text in playing row
}

export type ThemeName =
  | 'tokyo-night'
  | 'catppuccin'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'solarized'
  | 'rose-pine'
  | 'kanagawa';

export const THEMES: Record<ThemeName, Theme> = {
  'tokyo-night': {
    name: 'Tokyo Night',
    accent: '#7aa2f7',
    bg: '#1a1b26',
    fg: '#c0caf5',
    dim: '#565f89',
    green: '#9ece6a',
    red: '#f7768e',
    yellow: '#e0af68',
    selection: '#292e42',
    border: '#3b4261',
    borderActive: '#7aa2f7',
    playing: '#1e2718',
    playingFg: '#6a8a3a',
  },
  catppuccin: {
    name: 'Catppuccin Mocha',
    accent: '#cba6f7',
    bg: '#1e1e2e',
    fg: '#cdd6f4',
    dim: '#6c7086',
    green: '#a6e3a1',
    red: '#f38ba8',
    yellow: '#f9e2af',
    selection: '#313244',
    border: '#45475a',
    borderActive: '#cba6f7',
    playing: '#1e2e1e',
    playingFg: '#6e8a6e',
  },
  dracula: {
    name: 'Dracula',
    accent: '#bd93f9',
    bg: '#282a36',
    fg: '#f8f8f2',
    dim: '#6272a4',
    green: '#50fa7b',
    red: '#ff5555',
    yellow: '#f1fa8c',
    selection: '#44475a',
    border: '#6272a4',
    borderActive: '#bd93f9',
    playing: '#1a2e1a',
    playingFg: '#3a8a3a',
  },
  nord: {
    name: 'Nord',
    accent: '#88c0d0',
    bg: '#2e3440',
    fg: '#eceff4',
    dim: '#4c566a',
    green: '#a3be8c',
    red: '#bf616a',
    yellow: '#ebcb8b',
    selection: '#3b4252',
    border: '#4c566a',
    borderActive: '#88c0d0',
    playing: '#2e3e2e',
    playingFg: '#6a8a5a',
  },
  gruvbox: {
    name: 'Gruvbox',
    accent: '#fabd2f',
    bg: '#282828',
    fg: '#ebdbb2',
    dim: '#665c54',
    green: '#b8bb26',
    red: '#fb4934',
    yellow: '#fabd2f',
    selection: '#3c3836',
    border: '#504945',
    borderActive: '#fabd2f',
    playing: '#2e2e1a',
    playingFg: '#8a8a3a',
  },
  solarized: {
    name: 'Solarized Dark',
    accent: '#268bd2',
    bg: '#002b36',
    fg: '#839496',
    dim: '#586e75',
    green: '#859900',
    red: '#dc322f',
    yellow: '#b58900',
    selection: '#073642',
    border: '#586e75',
    borderActive: '#268bd2',
    playing: '#002e1a',
    playingFg: '#4a7a3a',
  },
  'rose-pine': {
    name: 'Rosé Pine',
    accent: '#c4a7e7',
    bg: '#191724',
    fg: '#e0def4',
    dim: '#6e6a86',
    green: '#9ccfd8',
    red: '#eb6f92',
    yellow: '#f6c177',
    selection: '#26233a',
    border: '#403d52',
    borderActive: '#c4a7e7',
    playing: '#1a2424',
    playingFg: '#5a8a8a',
  },
  kanagawa: {
    name: 'Kanagawa',
    accent: '#7e9cd8',
    bg: '#1f1f28',
    fg: '#dcd7ba',
    dim: '#54546d',
    green: '#98bb6c',
    red: '#e82424',
    yellow: '#e6c384',
    selection: '#2a2a37',
    border: '#54546d',
    borderActive: '#7e9cd8',
    playing: '#1f281f',
    playingFg: '#5a7a4a',
  },
};

export const THEME_ORDER: ThemeName[] = [
  'tokyo-night', 'catppuccin', 'dracula', 'nord',
  'gruvbox', 'solarized', 'rose-pine', 'kanagawa',
];

export function nextTheme(current: ThemeName): ThemeName {
  const idx = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(idx + 1) % THEME_ORDER.length];
}

export function getTheme(name: ThemeName): Theme {
  return THEMES[name];
}
