# AGENTS.md - TuiTunes Development Guide

## Project Summary

TuiTunes is a terminal music player + podcast client built on OpenTUI (Zig native rendering + React 19) with mpv as the playback engine. 45 source files, 92 tests, strict TypeScript.

**Runtime**: Bun 1.3+ | **TUI**: OpenTUI 0.1.96 | **Playback**: mpv + yt-dlp | **State**: Jotai v2 | **DB**: bun:sqlite

## Commands

```bash
bun run start        # Launch
bun run dev          # Watch mode
bun test             # 92 tests
bunx tsc --noEmit    # Type check
bun build --compile --minify src/index.tsx --outfile dist/tuimusic  # Binary
```

---

## Architecture

### Two-Level Section Model

TuiTunes has two top-level **sections**: `music` and `podcast` (Ctrl+1 / Ctrl+2). Each section has its own sidebar views and search routing.

```
Section: music                    Section: podcast
  Views: search, queue,             Views: search, feeds, episodes
         library, explore
  Search: YouTube Music             Search: iTunes podcast API
  Playback: yt-dlp URL             Playback: YouTube URL (if found)
                                              or RSS enclosure URL
  Lyrics: LRCLIB synced            Transcript: YouTube auto-captions
          + YouTube fallback                   (same source as audio)
```

### Single Keyboard Handler (CRITICAL)

**ALL keyboard logic lives in one `useKeyboard()` call in `app.tsx`**. No other component registers `useKeyboard`. This is intentional.

Why: OpenTUI's `useKeyboard` fires ALL registered handlers for every key press. Multiple handlers cause key leaks (typing 's' in a search input also toggles shuffle). The single handler has a strict priority chain:

```
1. Ctrl+key combos (Ctrl+P palette, Ctrl+L layout, Ctrl+T theme, Ctrl+1/2 section)
2. Quit confirm dialog visible → y/n/escape only, block all else
3. Command palette visible → up/down/enter/escape only, block all else
4. Seek input visible → enter/escape only, block all else
5. Transcript URL input visible → enter/escape only, block all else
6. Search input focused → Tab/Escape/Ctrl+Q only, block all else
7. Help overlay → ? toggles, Escape dismisses
8. List navigation (j/k/g/G/enter) → when main panel focused
9. Favorites (f), lyrics (l), seek (t), load more (L), speed ([/])
10. Sidebar navigation (j/k/enter) → when sidebar focused
11. Playback controls (space/n/p/+/-/m/s/r/>/</[/])
12. Focus management (Tab/slash/Escape)
13. Queue add (q), queue remove (x)
14. Quit (Ctrl+Q/C)
```

Every overlay block does `return;` — nothing leaks through.

### DO NOT use `useCallback` with `useKeyboard`

OpenTUI's `useKeyboard` uses `useEffectEvent` internally (ref-based, always calls latest handler). Wrapping the handler in `useCallback` **freezes the closure** and causes stale state bugs. Pass a plain function.

### Overlay Components Are Pure Renderers

`CommandPalette`, `QuitConfirm`, `SeekInput`, `TranscriptUrlInput` have NO `useKeyboard`. They receive state and callbacks as props. All their key handling is in app.tsx's single handler.

---

## File Map (45 files)

### Entry + Root
| File | Purpose |
|---|---|
| `src/index.tsx` | Bootstrap: dep check → spawn mpv → init providers → render app → cleanup |
| `src/app.tsx` | Root component: ALL keyboard handling, state wiring, layout rendering (~1000 lines) |
| `src/commands.ts` | Command registry for palette: 35 commands across 5 categories |

### Player (mpv IPC)
| File | Purpose |
|---|---|
| `src/player/types.ts` | MpvResponse, MpvEvent, MpvPropertyMap (13 properties), OBSERVED_PROPERTIES |
| `src/player/process.ts` | Spawn/kill mpv, socket path, lean audio flags (bestaudio, reduced cache) |
| `src/player/ipc.ts` | MpvIPC class: Unix socket connect, JSON protocol, command/response, property observation |
| `src/player/controller.ts` | PlayerController: play/pause/seek/volume/speed/mute, crash recovery, history logging |

### Providers
| File | Purpose |
|---|---|
| `src/providers/types.ts` | IProvider, Track, SearchResult, Playlist interfaces |
| `src/providers/youtube.ts` | YouTube Music search via youtubei.js + yt-dlp stream URLs |
| `src/providers/local.ts` | Local file scanning via Bun.Glob + music-metadata (registered but not primary) |
| `src/providers/registry.ts` | Provider registry, active provider |
| `src/providers/lyrics.ts` | LRCLIB synced lyrics (primary) + YouTube Music fallback (plain text) |
| `src/providers/podcast.ts` | PodcastProvider: iTunes search + RSS feed parsing |
| `src/providers/podcast-types.ts` | Podcast, Episode interfaces |
| `src/providers/podcast-youtube.ts` | Find YouTube video for podcast episode, extract captions |
| `src/providers/rss.ts` | RSS XML parser (regex-based, handles CDATA, HTML entities) |
| `src/providers/transcript.ts` | Podcast transcript: RSS tag → YouTube captions via yt-dlp |
| `src/providers/subtitle-parser.ts` | SRT + VTT parsers → LyricLine[] |

### Store (Jotai Atoms)
| File | Atoms |
|---|---|
| `src/store/player.ts` | position, duration, volume, mute, speed, state, track, progress (derived) |
| `src/store/queue.ts` | queue, queueIndex, repeat, shuffle, shuffledIndices, playingFromQueue, currentTrack (derived) |
| `src/store/queue-actions.ts` | Pure functions: shuffleIndices, nextIndex, prevIndex, addToQueue, removeFromQueue |
| `src/store/ui.ts` | section, musicView, podcastView, focusedPanel, search*, layout, theme |
| `src/store/library.ts` | favoritesSet, favorites, history |
| `src/store/lyrics.ts` | lyricsVisible, lyricsData, lyricsLoading, transcriptSource |
| `src/store/podcast.ts` | podcastSearchResults, selectedPodcast, episodes, subscribedFeeds |

### UI Components
| File | Purpose |
|---|---|
| `src/ui/Header.tsx` | Section tabs (Music/Podcast) + search input |
| `src/ui/Sidebar.tsx` | Section-aware navigation (music: 4 views, podcast: 3 views) |
| `src/ui/TrackList.tsx` | Track/episode list with playing indicator, page-based scroll |
| `src/ui/NowPlaying.tsx` | Animated equalizer, progress bar with knob, speed/volume/shuffle/repeat indicators |
| `src/ui/Lyrics.tsx` | Synced music lyrics with per-line gradient highlighting |
| `src/ui/Transcript.tsx` | Podcast transcript: flowing text, paragraph-level + inline phrase highlight |
| `src/ui/CommandPalette.tsx` | Fuzzy command search overlay (pure renderer, no useKeyboard) |
| `src/ui/QuitConfirm.tsx` | Quit confirmation dialog (pure renderer) |
| `src/ui/SeekInput.tsx` | Jump-to-time input with validation |
| `src/ui/TranscriptUrlInput.tsx` | Custom transcript URL input |
| `src/ui/HelpOverlay.tsx` | Keybinding reference |
| `src/ui/layouts.ts` | 6 layout presets: default, compact, minimal, split, wide, focus |
| `src/ui/themes.ts` | 8 color themes + Theme interface |
| `src/ui/useTheme.ts` | React hook: reads active theme from store |

### Database
| File | Purpose |
|---|---|
| `src/db/index.ts` | bun:sqlite setup, WAL mode, migrations (favorites, history, podcast_feeds) |
| `src/db/queries.ts` | CRUD: favorites, history, podcast subscriptions |

### Utilities
| File | Purpose |
|---|---|
| `src/utils/deps.ts` | checkDependencies(): mpv version check |
| `src/utils/config.ts` | Load/save ~/.config/tuimusic/config.json |
| `src/utils/format.ts` | formatTime(), truncateText(), padRight() |
| `src/utils/logger.ts` | Logger class → ~/.config/tuimusic/debug.log |

---

## All Keybindings

### Global (always work)
| Key | Action |
|---|---|
| `Ctrl+P` | Command palette |
| `Ctrl+L` | Cycle layout (6 presets) |
| `Ctrl+T` | Cycle theme (8 themes) |
| `Ctrl+1` | Switch to Music section |
| `Ctrl+2` | Switch to Podcast section |
| `Ctrl+Q` / `Ctrl+C` | Quit (with confirmation) |

### Playback (when not in search/overlay)
| Key | Action |
|---|---|
| `space` | Play / Pause |
| `n` | Next track (queue only) |
| `p` | Previous track (queue only) |
| `>` | Seek +10s |
| `<` | Seek -10s |
| `t` | Jump to time (opens input) |
| `+` / `=` | Volume up 5 |
| `-` | Volume down 5 |
| `m` | Toggle mute |
| `]` | Speed up (preset cycle) |
| `[` | Speed down (preset cycle) |
| `s` | Toggle shuffle |
| `r` | Cycle repeat (off → all → track) |

### Navigation
| Key | Action |
|---|---|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `g` | Go to top |
| `G` | Go to bottom |
| `Enter` | Play selected / browse podcast episodes |
| `Tab` | Cycle focus: main → sidebar → search |
| `/` | Focus search input |
| `Escape` | Back to main panel |
| `?` | Toggle help overlay |

### Actions
| Key | Action |
|---|---|
| `q` | Add selected track to queue |
| `x` | Remove from queue (in queue view) |
| `f` | Toggle favorite |
| `l` | Toggle lyrics / transcript panel |
| `L` | Load more results / episodes |

---

## Known Gotchas & Rules

### OpenTUI
1. **`<select>` is broken** — items invisible due to buffered rendering. Use `<text>` elements for all lists.
2. **`<scrollbox focused={true}>`** intercepts Enter key before useKeyboard. Never pass `focused` to scrollbox.
3. **`<input>` captures characters** — j/k/space etc. get inserted as text AND fire in useKeyboard. That's why the search gate blocks all single keys.
4. **`<input>` onSubmit type mismatch** — requires `onSubmit={handler as never}` cast.
5. **`<input>` Enter key** — maps to `newLine` action (returns false), NOT submit. Enter in input does nothing by default. All Enter handling must be in useKeyboard.

### mpv
6. **observe_property absent data** — when property unavailable, event has NO `data` field (not null). Check `'data' in event`.
7. **loadfile is async** — returns before file loads. Monitor `file-loaded` / `end-file` events.
8. **Stale socket** — always `unlinkSync(socketPath)` before spawning mpv.
9. **`Bun.file().exists()`** does NOT detect Unix sockets. Use `existsSync()`.
10. **MpvEvent index signature** — `[key: string]: unknown` for extra fields (reason, file_error).

### React / Jotai
11. **DO NOT wrap useKeyboard callback in useCallback** — causes stale closures. OpenTUI handles stability internally.
12. **Hooks before early return** — `useTheme()` and all hooks must be called before any `if (!visible) return null`.
13. **Store type import** — `import type { Store } from 'jotai/vanilla/store'` (not from 'jotai').

### Playback
14. **Queue is user-controlled** — playing from search does NOT add to queue. Only `q` key adds.
15. **playingFromQueueAtom** — tracks if current playback is from queue. n/p/auto-advance only work when true.
16. **Podcast YouTube-backed playback** — when possible, plays YouTube version of podcast for synced transcript.
17. **Speed presets** — 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0. mpv's scaletempo2 preserves pitch.

### Transcript
18. **YouTube auto-captions have no time gaps** — 99.9% of segment gaps are <0.5s. Paragraph splitting uses sentence-ending punctuation (. ? !) as primary signal, with 20-segment safety cap.
19. **Transcript sources** — user can switch via command palette: Auto, Custom URL, Reload.

---

## When Modifying — Checklist

Before any feature change, check these:

- [ ] Does it need a new keybinding? → Add to app.tsx handler + HelpOverlay + commands.ts
- [ ] Does it add state? → Add atom to correct store file, import in app.tsx
- [ ] Does it touch the search flow? → Test both music AND podcast sections
- [ ] Does it affect playback? → Test with queue playback AND one-off playback
- [ ] Does it add an overlay? → NO useKeyboard in the overlay. Handle keys in app.tsx's handler. Add a gate block.
- [ ] Does it change a list? → Test scroll behavior (page-based, not continuous)
- [ ] Does it change types/interfaces? → Run `bun test` — tests cover types, queue logic, IPC parsing, format utils, DB queries
- [ ] Does it add a new file? → Update this AGENTS.md file map
- [ ] Does it affect themes? → Use `useTheme()` hook, no hardcoded hex colors
- [ ] Does it affect NowPlaying? → Check all player states: playing, paused, buffering, stopped

---

## Testing

| Layer | What | File |
|---|---|---|
| Type guards | isMpvEvent, isMpvResponse | test/player/types.test.ts |
| IPC parsing | Buffer splitting, request matching, property changes | test/player/ipc.test.ts |
| Format utils | formatTime, truncateText, padRight | test/utils/format.test.ts |
| Player atoms | playerProgressAtom derivation | test/store/player.test.ts |
| Queue atoms | currentTrackAtom with shuffle | test/store/queue.test.ts |
| Queue actions | shuffle, next/prev, add/remove | test/store/queue-actions.test.ts |
| DB queries | Favorites CRUD, history, in-memory SQLite | test/db/queries.test.ts |

IPC tests use a real mock Unix socket server (`Bun.listen({unix:})`). DB tests use `:memory:`. No mocks for external APIs.
