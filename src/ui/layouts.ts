export type LayoutPreset = 'default' | 'compact' | 'minimal' | 'split' | 'wide' | 'focus';

export const LAYOUT_ORDER: LayoutPreset[] = [
  'default', 'compact', 'minimal', 'split', 'wide', 'focus',
];

export function nextLayout(current: LayoutPreset): LayoutPreset {
  const idx = LAYOUT_ORDER.indexOf(current);
  return LAYOUT_ORDER[(idx + 1) % LAYOUT_ORDER.length];
}

export const LAYOUT_LABELS: Record<LayoutPreset, string> = {
  default: 'Default',
  compact: 'Compact',
  minimal: 'Minimal',
  split: 'Split',
  wide: 'Wide',
  focus: 'Focus',
};

export const LAYOUT_DESCRIPTIONS: Record<LayoutPreset, string> = {
  default: 'Sidebar + main + footer',
  compact: 'No sidebar, full-width',
  minimal: 'Mini player only',
  split: 'Queue left, results right',
  wide: 'Extended now playing',
  focus: 'Distraction free',
};
