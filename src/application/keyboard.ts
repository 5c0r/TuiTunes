import type { KeyEvent } from '@opentui/core';
import { clampLyricDelay } from './lyric-timing';
import type { CommandId } from '../commands';
import { filterCommands } from '../commands';
import type {
  FocusedPanel,
  MusicView,
  Overlay,
  PodcastView,
  Section,
  TranslationProviderId,
} from '../store/ui';
import { TRANSLATION_PROVIDER_ORDER, TRANSLATION_SETTINGS_FIELDS } from '../store/ui';

/** Snapshot of the UI state the keyboard dispatcher decides against. */
export interface KeyboardState {
  overlay: Overlay | null;
  focusedPanel: FocusedPanel;
  /** The sidebar focus slot belongs to the queue in split and wide layouts. */
  queuePane?: boolean;
  section: Section;
  musicView: MusicView;
  podcastView: PodcastView;
  catalogKind: 'artist' | 'album' | null;
  hasSelection: boolean;
  hasTranscript: boolean;
  transcriptMatchCount: number;
  suggestions: string[];
  suggestionIndex: number;
  searchQuery: string;
  searchInputFocused: boolean;
}

/** Side effects the dispatcher may invoke. */
export interface KeyboardActions {
  command(id: CommandId): void;
  setOverlay(overlay: Overlay | null): void;
  setFocus(panel: FocusedPanel): void;
  navigate(direction: 'up' | 'down' | 'first' | 'last'): void;
  activateSelection(): void;
  changeCatalogTab(direction: 'next' | 'previous'): void;
  setSuggestionIndex(index: number): void;
  clearSuggestions(): void;
  submitSearch(query: string): void;
  submitOverlay(overlay: Overlay): void;
}

const PALETTE_MAX_VISIBLE = 15;

function isEnter(name: string): boolean {
  return name === 'return' || name === 'enter';
}

/** Accept both the shifted-name form ('?') and plain-name+shift ('/' + shift). */
function shifted(key: KeyEvent, plain: string, shiftedName: string): boolean {
  return key.name === shiftedName || (key.name === plain && key.shift === true);
}

function cycleTranslationProvider(
  overlay: Extract<Overlay, { kind: 'translation-settings' }>,
  delta: 1 | -1,
): Overlay {
  const order: readonly TranslationProviderId[] = TRANSLATION_PROVIDER_ORDER;
  const index = order.indexOf(overlay.provider);
  const next = order[(Math.max(index, 0) + delta + order.length) % order.length];
  return { ...overlay, provider: next, error: null };
}

/**
 * Exclusive keyboard dispatcher. Returns true when the key is fully handled
 * (the caller must preventDefault); returns false for unhandled printable and
 * editing keys inside text inputs so the input can keep processing them.
 */
export function dispatchKey(
  key: KeyEvent,
  state: KeyboardState,
  actions: KeyboardActions,
): boolean {
  const name = key.name ?? '';
  const ctrlOnly = key.ctrl === true && key.meta !== true && key.option !== true;
  const hasModifier = key.ctrl === true || key.meta === true || key.option === true;

  // Priority 1: quit confirmation is reachable from any state and consumed.
  if (ctrlOnly && (name === 'q' || name === 'c')) {
    if (state.overlay?.kind !== 'quit-confirm') actions.setOverlay({ kind: 'quit-confirm' });
    return true;
  }

  // Priority 2: quit confirmation accepts only y/enter and n/escape.
  if (state.overlay?.kind === 'quit-confirm') {
    if (name === 'y' || isEnter(name)) actions.command('quit');
    else if (name === 'n' || name === 'escape') actions.setOverlay(null);
    return true;
  }

  // Priority 3: Ctrl+P toggles the palette but never replaces another overlay.
  if (ctrlOnly && name === 'p') {
    if (state.overlay?.kind === 'command-palette') actions.setOverlay(null);
    else if (!state.overlay) {
      actions.setOverlay({ kind: 'command-palette', filter: '', selectedIdx: 0 });
    }
    return true;
  }

  // Priority 4: an active overlay handles only its own navigation/Enter/Escape.
  const overlay = state.overlay;
  if (overlay) {
    switch (overlay.kind) {
      case 'command-palette': {
        if (name === 'escape') {
          actions.setOverlay(null);
          return true;
        }
        if (name === 'down') {
          const maxIdx = Math.min(filterCommands(overlay.filter).length, PALETTE_MAX_VISIBLE) - 1;
          actions.setOverlay({
            ...overlay,
            selectedIdx: Math.min(overlay.selectedIdx + 1, maxIdx),
          });
          return true;
        }
        if (name === 'up') {
          actions.setOverlay({ ...overlay, selectedIdx: Math.max(overlay.selectedIdx - 1, 0) });
          return true;
        }
        if (isEnter(name)) {
          actions.submitOverlay(overlay);
          return true;
        }
        return false;
      }
      case 'source-picker': {
        if (name === 'escape') {
          actions.setOverlay(null);
          return true;
        }
        if (overlay.busy) return true;
        if (overlay.editing) {
          if (isEnter(name)) {
            actions.submitOverlay(overlay);
            return true;
          }
          return false;
        }
        if (name === 'down' || name === 'j') {
          actions.setOverlay({
            ...overlay,
            selectedIdx: Math.min(3, overlay.selectedIdx + 1),
            error: null,
          });
        } else if (name === 'up' || name === 'k') {
          actions.setOverlay({
            ...overlay,
            selectedIdx: Math.max(0, overlay.selectedIdx - 1),
            error: null,
          });
        } else if (isEnter(name)) {
          if (overlay.selectedIdx === 3)
            actions.setOverlay({ ...overlay, editing: true, error: null });
          else actions.submitOverlay(overlay);
        }
        return true;
      }
      case 'lyric-timing': {
        if (name === 'escape') actions.setOverlay(null);
        else if (isEnter(name)) actions.submitOverlay(overlay);
        else if (!hasModifier) {
          const step = key.shift ? 500 : 100;
          const delayMs =
            name === 'left'
              ? overlay.delayMs - step
              : name === 'right'
                ? overlay.delayMs + step
                : name === 'r'
                  ? 0
                  : overlay.delayMs;
          if (delayMs !== overlay.delayMs) {
            actions.setOverlay({ ...overlay, delayMs: clampLyricDelay(delayMs), error: null });
          }
        }
        return true;
      }
      case 'episode-bookmarks': {
        if (name === 'escape') {
          actions.setOverlay(
            overlay.editing ? { ...overlay, editing: null, value: '', error: null } : null,
          );
          return true;
        }
        if (isEnter(name)) {
          actions.submitOverlay(overlay);
          return true;
        }
        if (overlay.editing === 'rename') return false;
        if (overlay.editing === 'delete') return true;
        if (name === 'up' || name === 'k' || name === 'down' || name === 'j') {
          const step = name === 'up' || name === 'k' ? -1 : 1;
          actions.setOverlay({
            ...overlay,
            selectedIdx: Math.max(
              0,
              Math.min(overlay.bookmarks.length - 1, overlay.selectedIdx + step),
            ),
            error: null,
          });
        } else if (!key.ctrl && !key.meta && !key.option && (name === 'r' || name === 'x')) {
          const bookmark = overlay.bookmarks[overlay.selectedIdx];
          if (bookmark)
            actions.setOverlay({
              ...overlay,
              editing: name === 'r' ? 'rename' : 'delete',
              value: name === 'r' ? bookmark.label : '',
              error: null,
            });
        }
        return true;
      }
      case 'seek':
      case 'transcript-url':
        if (name === 'escape') {
          actions.setOverlay(null);
          return true;
        }
        if (isEnter(name)) {
          actions.submitOverlay(overlay);
          return true;
        }
        return false;
      case 'translation-settings': {
        if (name === 'escape') {
          // Escape first leaves an active text edit, then closes the form.
          actions.setOverlay(overlay.editing ? { ...overlay, editing: false } : null);
          return true;
        }
        if (overlay.editing) {
          // Enter commits the edit; every other key reaches the focused input.
          if (isEnter(name)) actions.setOverlay({ ...overlay, editing: false });
          return isEnter(name);
        }
        const fields = TRANSLATION_SETTINGS_FIELDS;
        const index = fields.indexOf(overlay.field);
        if (name === 'down' || name === 'j') {
          actions.setOverlay({
            ...overlay,
            field: fields[Math.min(index + 1, fields.length - 1)] ?? overlay.field,
            error: null,
          });
          return true;
        }
        if (name === 'up' || name === 'k') {
          actions.setOverlay({
            ...overlay,
            field: fields[Math.max(index - 1, 0)] ?? overlay.field,
            error: null,
          });
          return true;
        }
        if (isEnter(name)) {
          if (overlay.field === 'provider') {
            actions.setOverlay(cycleTranslationProvider(overlay, 1));
          } else if (
            overlay.field === 'test' ||
            overlay.field === 'save' ||
            overlay.field === 'cancel'
          ) {
            actions.submitOverlay(overlay);
          } else {
            actions.setOverlay({ ...overlay, editing: true, error: null });
          }
          return true;
        }
        if (overlay.field === 'provider' && (name === 'left' || name === 'right')) {
          actions.setOverlay(cycleTranslationProvider(overlay, name === 'right' ? 1 : -1));
          return true;
        }
        // While the form is open it owns every remaining key, so application
        // shortcuts (playback, library) cannot leak through it.
        return true;
      }
      case 'transcript-search': {
        if (name === 'escape') {
          actions.setOverlay(null);
          return true;
        }
        if (name === 'down') {
          actions.setOverlay({
            ...overlay,
            selectedIdx: Math.min(
              overlay.selectedIdx + 1,
              Math.max(0, state.transcriptMatchCount - 1),
            ),
          });
          return true;
        }
        if (name === 'up') {
          actions.setOverlay({ ...overlay, selectedIdx: Math.max(overlay.selectedIdx - 1, 0) });
          return true;
        }
        if (isEnter(name)) {
          actions.submitOverlay(overlay);
          return true;
        }
        return false;
      }
      case 'help':
        if (name === 'escape' || shifted(key, '/', '?')) {
          actions.setOverlay(null);
          return true;
        }
        return true;
    }
  }

  // Focused search input: allow text editing, suggestion navigation, Enter,
  // Tab/Escape, and the quit/palette shortcuts handled above — nothing else.
  const searchActive = state.focusedPanel === 'search' || state.searchInputFocused;
  if (searchActive) {
    if (state.suggestions.length > 0) {
      if (name === 'down') {
        actions.setSuggestionIndex(
          Math.min(state.suggestionIndex + 1, state.suggestions.length - 1),
        );
        return true;
      }
      if (name === 'up') {
        actions.setSuggestionIndex(Math.max(state.suggestionIndex - 1, -1));
        return true;
      }
      if (isEnter(name)) {
        const highlighted =
          state.suggestionIndex >= 0 ? state.suggestions[state.suggestionIndex] : undefined;
        const chosen = highlighted ?? state.searchQuery;
        if (chosen.trim()) actions.submitSearch(chosen);
        return true;
      }
    }
    if (isEnter(name)) {
      if (state.searchQuery.trim()) actions.submitSearch(state.searchQuery);
      return true;
    }
    if (name === 'escape') {
      if (state.suggestions.length > 0) actions.clearSuggestions();
      else actions.setFocus('main');
      return true;
    }
    if (name === 'tab') {
      actions.clearSuggestions();
      actions.setFocus('main');
      return true;
    }
    return false;
  }

  // '?' toggles help only outside overlays and the search input.
  if (shifted(key, '/', '?')) {
    actions.setOverlay({ kind: 'help' });
    return true;
  }

  // Ctrl+L/T/1/2 apply only outside overlays and the search input.
  if (ctrlOnly && name === 'l') {
    actions.command('layout-cycle');
    return true;
  }
  if (ctrlOnly && name === 't') {
    actions.command('theme-cycle');
    return true;
  }
  if (ctrlOnly && name === '1') {
    actions.command('section-music');
    return true;
  }
  if (ctrlOnly && name === '2') {
    actions.command('section-podcast');
    return true;
  }

  // Ctrl+F opens transcript search when data exists; it never falls through to
  // the plain 'f' favorite binding.
  if (ctrlOnly && name === 'f') {
    if (state.hasTranscript) actions.command('transcript-search');
    return true;
  }

  // Remaining shortcuts are plain keys; any other modifier combination is left
  // unhandled.
  if (hasModifier) return false;

  // Sidebar navigation.
  if (state.focusedPanel === 'sidebar' && !state.queuePane) {
    if (name === 'j' || name === 'down') {
      actions.navigate('down');
      return true;
    }
    if (name === 'k' || name === 'up') {
      actions.navigate('up');
      return true;
    }
    if (isEnter(name)) {
      actions.setFocus('main');
      return true;
    }
  }

  // Catalog navigation remains available on empty/error pages.
  if (state.focusedPanel === 'main' && state.catalogKind) {
    if (name === 'escape') {
      actions.command('catalog-back');
      return true;
    }
    if (state.catalogKind === 'artist' && (name === 'left' || name === 'right')) {
      actions.changeCatalogTab(name === 'right' ? 'next' : 'previous');
      return true;
    }
  }

  // Main panel navigation and selection commands.
  if ((state.focusedPanel === 'main' || state.queuePane) && state.hasSelection) {
    if (name === 'j' || name === 'down') {
      actions.navigate('down');
      return true;
    }
    if (name === 'k' || name === 'up') {
      actions.navigate('up');
      return true;
    }
    if (shifted(key, 'g', 'G')) {
      actions.navigate('last');
      return true;
    }
    if (name === 'g') {
      actions.navigate('first');
      return true;
    }
    if (isEnter(name)) {
      actions.activateSelection();
      return true;
    }
    if (name === 'f') {
      actions.command('favorite');
      return true;
    }
    if (name === 'q') {
      actions.command('queue-add');
      return true;
    }
    if (
      name === 'x' &&
      (state.queuePane || (state.section === 'music' && state.musicView === 'queue'))
    ) {
      actions.command('queue-remove');
      return true;
    }
  }

  // Shift+L (both encodings) loads more; must precede plain 'l' (lyrics).
  if (shifted(key, 'l', 'L')) {
    actions.command('load-more');
    return true;
  }

  switch (name) {
    case 'space':
      actions.command('play-pause');
      return true;
    case 'n':
      actions.command('next');
      return true;
    case 'p':
      actions.command('prev');
      return true;
    case '>':
    case '.':
      if (name === '.' && key.shift !== true) break;
      actions.command('seek-forward');
      return true;
    case '<':
    case ',':
      if (name === ',' && key.shift !== true) break;
      actions.command('seek-backward');
      return true;
    case '=':
    case '+':
      actions.command('volume-up');
      return true;
    case '-':
      actions.command('volume-down');
      return true;
    case 'm':
      actions.command('mute');
      return true;
    case ']':
      actions.command('speed-up');
      return true;
    case '[':
      actions.command('speed-down');
      return true;
    case 's':
      actions.command('shuffle');
      return true;
    case 'r':
      actions.command('repeat');
      return true;
    case 'l':
      actions.command('lyrics');
      return true;
    case 't':
      actions.command('seek-to');
      return true;
  }

  // Focus management.
  if (name === 'tab') {
    const current = state.focusedPanel;
    actions.setFocus(current === 'main' ? 'sidebar' : current === 'sidebar' ? 'search' : 'main');
    return true;
  }
  if (name === '/') {
    actions.setFocus('search');
    return true;
  }
  if (name === 'escape') {
    actions.setFocus('main');
    return true;
  }
  return false;
}
