# TuiTunes Roadmap

## Current State (v0.2.0)

### Working Features
- YouTube Music search (youtubei.js) with pagination (2 pages, 40 results)
- Audio playback via mpv + yt-dlp (bestaudio, ~83MB RSS)
- Podcast: iTunes search, RSS feed parsing, subscriptions (SQLite)
- Podcast: YouTube-backed playback for synced transcripts
- Two-section model: Music (Ctrl+1) / Podcast (Ctrl+2)
- 6 layout presets (Ctrl+L): default, compact, minimal, split, wide, focus
- 8 color themes (Ctrl+T): Tokyo Night, Catppuccin, Dracula, Nord, Gruvbox, Solarized, Rose Pine, Kanagawa
- Command palette (Ctrl+P) with 35 fuzzy-filterable commands
- Queue: user-controlled (q to add, x to remove, n/p to navigate)
- Favorites + History persisted in SQLite
- Synced lyrics (LRCLIB) + YouTube Music fallback
- Podcast transcripts: flowing text with inline phrase highlighting
- Smart paragraph splitting (sentence-ending punctuation + 20-segment cap)
- Custom transcript URL loading (SRT/VTT)
- Animated equalizer visualization in NowPlaying
- Playback speed control (0.5x-2x, preserves pitch)
- Jump-to-time (t key) with validation
- mpv crash recovery with resume
- Quit confirmation dialog
- Full Unicode support (CJK, Vietnamese, emoji)
- Page-based list scrolling
- Compiled binary (bun build --compile)
- 45 source files, 92 tests passing, strict TypeScript

## Priority 1: Polish

### Mouse Controls
- [ ] Click track row to select
- [ ] Double-click to play
- [ ] Click sidebar items
- [ ] Scroll wheel in lists
- [ ] Click progress bar to seek
- [ ] Click section tabs to switch

### Responsive Design
- [ ] useTerminalDimensions() for breakpoints
- [ ] Auto-switch layout by terminal width
- [ ] Collapse NowPlaying at small heights
- [ ] Dynamic title/artist truncation

### Search Suggestions
- [ ] Debounced onInput in Header
- [ ] YouTube Music search suggestions as-you-type
- [ ] Dropdown below search bar

### Transcript Animation
- [ ] Smooth color fade when phrase changes (300ms interpolation)
- [ ] Brief pulse on new phrase activation
- [ ] Smooth scroll interpolation

## Priority 2: Platform

### Windows TCP IPC
- [ ] Detect process.platform === 'win32'
- [ ] Use --input-ipc-server=tcp://127.0.0.1:PORT
- [ ] Use Bun.connect({hostname, port})
- [ ] ~20 lines across process.ts + ipc.ts

### Platform Config Paths
- [ ] Windows: %APPDATA%\tuimusic\
- [ ] macOS: ~/Library/Application Support/tuimusic/
- [ ] Linux: $XDG_CONFIG_HOME/tuimusic/

## Priority 3: Features

### Album / Artist Browsing
- [ ] Artist detail view (top tracks, albums)
- [ ] Album detail view (track listing)
- [ ] Navigate from search results to detail views

### Scrobbling (Last.fm)
- [ ] Track scrobble on 50% playback
- [ ] "Now Playing" notification
- [ ] Config option

### Discord Rich Presence
- [ ] IPC to Discord client
- [ ] Show currently playing track

### Streaming Radio
- [ ] Curated station list (SomaFM, etc.)
- [ ] Custom URL input

## Known Issues

### OpenTUI
- `<select>` items invisible (buffered rendering bug)
- `<scrollbox focused={true}>` intercepts Enter
- `<input>` captures j/k/space as typed characters

### YouTube
- PO tokens may be required for direct URL access in future
- yt-dlp adds ~15s to first podcast episode play (YouTube search)
- Some podcast episodes have no YouTube match

### mpv
- Crash recovery sometimes double-spawns (race in spawnMpv)
- "database is locked" during rapid recovery (concurrent SQLite)
