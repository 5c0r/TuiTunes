# AGENTS.md - TuiTunes Development Guide

## Project Summary

TuiTunes is a terminal music player + podcast client built on OpenTUI (Zig native rendering + React 19) with mpv as the playback engine. Strict TypeScript; explicit application request owners.

**Runtime**: Bun 1.3.14 | **TUI**: OpenTUI 0.1.96 | **Playback**: mpv + yt-dlp | **State**: Jotai v2 | **DB**: bun:sqlite

## Commands

```bash
bun run start        # Launch
bun run dev          # Watch mode
bun run typecheck       # Source + tests
bun run test:coverage   # Sandboxed suite + weighted coverage gate
bun run test:mpv        # Real headless mpv lifecycle
bun run build          # Compiled production entrypoint
bun run smoke:compiled # Actual compiled TUI startup/quit under PTY
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

The sole plain-function useKeyboard registration stays in app.tsx; it delegates decisions to application/keyboard.ts and prevents default renderable handling for consumed keys. No component or request owner registers another handler.

Why: OpenTUI's `useKeyboard` fires ALL registered handlers for every key press. Multiple handlers cause key leaks (typing 's' in a search input also toggles shuffle). The single handler has a strict priority chain:

```
1. Ctrl+Q/C opens quit confirmation from any state.
2. Active overlay exclusively handles its keys; text inputs retain editing.
3. Ctrl+P opens/closes palette, never replaces another blocking overlay.
4. Actually focused search owns editing, suggestion arrows, Enter, Tab/Escape.
5. Outside inputs/overlays: Ctrl+L/T/1/2; Ctrl+F opens transcript search.
6. List/sidebar navigation, unmodified playback/actions, focus management.
```

Only one overlay is active. Dispatcher-owned Enter is exclusive; overlay inputs must not submit independently.

### DO NOT use `useCallback` with `useKeyboard`

OpenTUI's `useKeyboard` uses `useEffectEvent` internally (ref-based, always calls latest handler). Wrapping the handler in `useCallback` **freezes the closure** and causes stale state bugs. Pass a plain function.

### Overlay Components Are Pure Renderers

`CommandPalette`, `QuitConfirm`, `SeekInput`, `TranscriptUrlInput` have NO `useKeyboard`. They receive state and callbacks as props. All their key handling is in app.tsx's single handler.

---

## File Map

### Entry + Root
| File | Purpose |
|---|---|
| `src/index.tsx` | Composition root, mandatory dependency checks, awaited cleanup |
| `src/app.tsx` | Single keyboard adapter, UI actions, layouts |
| `src/commands.ts` | Literal registry with exhaustive CommandId handlers |

### Application owners
| File | Purpose |
|---|---|
| `src/application/playback.ts` | Latest-intent resolution; EOF/loaded callbacks match the committed playerPlaybackAtom request, not attempted generation. Pending resolution suppresses EOF; failed resolution retains current audio ownership. |
| `src/application/lyrics.ts` | Source/translation generations, immutable document identity, cache commits |
| `src/application/search.ts` | Music/podcast search, pagination, suggestions, episode request ownership |
| `src/application/keyboard.ts` | Exclusive overlay/input/shortcut dispatch |
| `src/application/runtime.ts` | Injected resource assembly and session disposal |
| `src/application/catalog.ts` | Abortable artist/album frame stack, paging, complete-album collection |
| `src/application/spectrum.ts` | Capture generation, playback/config eligibility, drain-before-replacement lifecycle |
| `src/application/queue-persistence.ts` | Versioned SQLite queue snapshot, compare-and-swap saves, no autoplay on restore |
| `src/application/episode-progress.ts` | Source-scoped podcast checkpoints, natural EOF completion, and bookmark CRUD |
| `src/application/lyric-timing.ts` | Source-scoped lyric offsets and deterministic cue timing; raw lyrics and translation cache stay immutable |

### Player (mpv IPC)
| File | Purpose |
|---|---|
| `src/player/types.ts` | Typed IPC responses/events, native playlist entry IDs and 15 observed properties |
| `src/player/process.ts` | Owned mpv process handle: PID, socket and per-spawn audio client identity |
| `src/player/ipc.ts` | MpvIPC class: Unix socket connect, JSON protocol, command/response, property observation |
| `src/player/controller.ts` | Source-aware mpv lifecycle, deterministic state, recovery; no DB policy |

### Providers
| File | Purpose |
|---|---|
| `src/providers/types.ts` | IProvider, Track, SearchResult, Playlist interfaces |
| `src/providers/youtube.ts` | YouTube Music search via youtubei.js + yt-dlp stream URLs |
| `src/providers/lyrics.ts` | LRCLIB synced lyrics (primary) + YouTube Music fallback (plain text) |
| `src/providers/translate.ts` | Explicit translation providers, bounded request batching, and connection validation |
| `src/providers/podcast.ts` | PodcastProvider: iTunes search + RSS feed parsing |
| `src/providers/podcast-types.ts` | Podcast, Episode interfaces |
| `src/providers/podcast-youtube.ts` | Find YouTube video for podcast episode, extract captions |
| `src/providers/media.ts` | Durable source codecs, feed-scoped media keys, playback source resolution |
| `src/providers/yt-dlp.ts` | Owned child processes with deadlines, cancellation, kill/reap cleanup |
| `src/providers/rss.ts` | RSS XML parser (regex-based, handles CDATA, HTML entities) |
| `src/providers/transcript.ts` | Abortable SRT/VTT URL fetch for selected RSS/custom transcript |
| `src/providers/subtitle-parser.ts` | SRT + VTT parsers → LyricLine[] |

### Store (Jotai Atoms)
| File | Atoms |
|---|---|
| `src/store/player.ts` | position, duration, volume, mute, speed, state, track, progress (derived) |
| `src/store/queue.ts` | Insertion entries, play order, cursor, shuffle/repeat, and a separate durable queue selection |
| `src/store/queue-actions.ts` | Pure identity-based enqueue/select/remove/navigation transitions |
| `src/store/ui.ts` | Views, focus, exclusive overlay union, search state, layout/theme |
| `src/store/library.ts` | favoritesSet, favorites, history |
| `src/store/lyrics.ts` | lyricsVisible, lyricsData, lyricsLoading, transcriptSource |
| `src/store/podcast.ts` | podcastSearchResults, selectedPodcast, episodes, subscribedFeeds |
| `src/store/config.ts` | Supported persisted configuration, initialized by bootstrap |
| `src/store/catalog.ts` | Browser frames, selections, indices and return destination |
| `src/store/spectrum.ts` | Capture status and latest real spectrum frame |

### UI Components
| File | Purpose |
|---|---|
| `src/ui/Header.tsx` | Section tabs and search input; fixed header height must survive scrolling content below it |
| `src/ui/Sidebar.tsx` | Section-aware navigation (music: 4 views, podcast: 3 views) |
| `src/ui/TrackList.tsx` | Track/episode list with playing indicator, page-based scroll |
| `src/ui/NowPlaying.tsx` | Playback controls/status, request-bound click-to-seek, source badge, optional real spectrum |
| `src/ui/Lyrics.tsx` | Synced lyric highlighting and follow, with document-scoped manual suspension |
| `src/ui/Transcript.tsx` | Podcast transcript: flowing text, paragraph-level + inline phrase highlight |
| `src/ui/CommandPalette.tsx` | Fuzzy command search overlay (pure renderer, no useKeyboard) |
| `src/ui/QuitConfirm.tsx` | Quit confirmation dialog (pure renderer) |
| `src/ui/SeekInput.tsx` | Jump-to-time input with validation |
| `src/ui/LyricTiming.tsx` | Signed live timing preview and undo/save controls rendered under the single keyboard dispatcher |
| `src/ui/useLyricFollow.ts` | Layout-based follow positioning and native scroll suspension for synced music |
| `src/ui/TranscriptUrlInput.tsx` | Custom transcript URL input |
| `src/ui/TranslationSettings.tsx` | Provider and language configuration with an explicit synthetic connection test |
| `src/ui/HelpOverlay.tsx` | Keybinding reference |
| `src/ui/layouts.ts` | 7 presets: default, compact, minimal, split, wide, focus, vertical |
| `src/ui/themes.ts` | 8 color themes + Theme interface |
| `src/ui/useTheme.ts` | React hook: reads active theme from store |
| `src/ui/{CatalogView,AlbumList}.tsx` | Contextual paged artist/release views |
| `src/ui/SourcePicker.tsx` | Pure per-episode playback-source overlay |
| `src/ui/EpisodeBookmarks.tsx` | Pure episode bookmark list and rename/delete overlay |
| `src/ui/{presentation,usePresentation}.ts` | Semantic icon profiles (default Nerd Font, Unicode, ASCII), motion policy and live setting labels |
| `src/ui/usePointerClicks.ts` | Per-surface press/release and double-click tracking; App owns actions and modal hit isolation |
| `src/ui/Spectrum.tsx` | Latest PCM-derived spectrum bars and capture diagnostics |

### Spectrum and native release
| File | Purpose |
|---|---|
| `src/spectrum/types.ts` | Backend/PCM/capture contracts |
| `src/spectrum/analyzer.ts` | Bounded PCM ingestion, shared FFT and logarithmic channel-power bands |
| `src/spectrum/{capture,pipewire,pulse,coreaudio}.ts` | Owned process-only capture; no system-mix fallback |
| `native/macos/{spectrum-tap.mm,pcm.hpp,Info.plist}` | Private CoreAudio process tap, bounded realtime transport, bundle metadata |
| `scripts/{build-spectrum-helper,test-spectrum-native}.ts` | Universal helper build and native protocol/buffer checks |
| `scripts/{package-native,check-native-release}.ts` | Artifact integrity, adjacent app packaging and protected release checks |


### Database
| File | Purpose |
|---|---|
| `src/db/index.ts` | bun:sqlite setup, WAL mode, migrations for library, episode progress/bookmarks and queue snapshots |
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

### Global shortcuts

Quit works from any state. Palette cannot replace another blocking overlay; layout/theme/section shortcuts apply outside overlays and text inputs.
| Key | Action |
|---|---|
| `Ctrl+P` | Command palette |
| `Ctrl+L` | Cycle layout (7 presets) |
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
4. **Input Enter does submit in pinned OpenTUI** — preventDefault in the central dispatcher; do not also pass onSubmit.
5. **Input focus is real renderable state** — synchronously focus/blur Header when changing panels; mouse focus must not leak shortcuts.

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
15. **Queue identity** — each duplicate has its own entryId. The cursor is an ID in play order, never an insertion/shuffle index. Direct playback clears traversal. A restored selection is visual only and never becomes the cursor until explicit play.
16. **Podcast YouTube-backed playback** — when possible, plays YouTube version of podcast for synced transcript.
17. **Speed presets** — 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0. mpv's scaletempo2 preserves pitch.

### Transcript
18. **YouTube auto-captions have no time gaps** — 99.9% of segment gaps are <0.5s. Paragraph splitting uses sentence-ending punctuation (. ? !) as primary signal, with 20-segment safety cap.
19. **Transcript sources** — user can switch via command palette: Auto, Custom URL, Reload.

---

## When Modifying — Checklist

Before any feature change, check these:

- [ ] Does it need a binding? → Add dispatcher binding + command registry; help derives from these.
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
| Queue projections | Entry identity and traversal ownership | test/store/queue.test.ts |
| Queue transitions | Shuffle, successor/removal, duplicates | test/store/queue-actions.test.ts |
| Listening state | Source-bound resume/bookmarks, queue restart and concurrent saves; actual App interaction | test/application/{episode-progress,queue-persistence}.test.ts, test/ui/listening-state.test.tsx |
| Lyric timing and follow | Source isolation, durable offsets, overlay preview, wrapped geometry and native scroll suspension | test/application/lyric-timing.test.ts, test/ui/{lyric-timing,lyric-follow}.test.tsx |
| DB queries | Favorites CRUD, history, in-memory SQLite | test/db/queries.test.ts |
| App search | Fresh and continuation stale results/loading | test/ui/app-search.test.tsx |
| Request owners | Playback/lyrics/search races and cancellation | test/application/{playback,lyrics,search}.test.ts |
| Translation settings | Real App keyboard overlay, saved provider configuration, stale connection-test handling | test/ui/translation-settings.test.tsx |
| Keyboard | Real App input/overlay exclusivity | test/ui/app-keyboard.test.tsx |
| Mouse | Real renderer hit tests, search focus, identity-based rows, queue panes, wheel and modal isolation | test/ui/app-mouse.test.tsx |
| Media persistence | Feed identity, legacy migrations, source codecs | test/db/media.test.ts |
| Process lifecycle | Fake IPC plus actual headless mpv | test/player/controller.test.ts, test/integration/player-lifecycle.test.ts |
| Provider boundaries | Real SDK nodes, translation alignment/cardinality, parser inputs, owned subprocesses | test/providers/{youtube,translate,translate-integration,rss,subtitle-parser,podcast,podcast-youtube,transcript,yt-dlp}.test.ts |
| Player surface | State/error rendering, measured seek bar and clickable playback controls | test/ui/now-playing.test.tsx |
| Isolation | Nested scratch-home sentinel probe | test/utils/isolation.test.ts, test/fixtures/isolation-child.test.ts |
| Test harness | Pre-import sandbox and typed UI/player fixtures | test/preload.ts, test/helpers/{app.tsx,player.ts} |
| Release proof | Weighted LCOV inventory gate and compiled PTY smoke | scripts/check-coverage.ts, scripts/smoke-compiled.ts |
| Feature workflows | Source overlay races, contextual browsing, seven-layout ASCII and setting persistence | test/ui/features.test.tsx |
| Catalog | Provider paging, frame ownership, album collection | test/application/catalog.test.ts |
| Presentation | ASCII chrome, static motion and live toggle labels | test/ui/presentation.test.tsx |
| Spectrum | PCM/FFT, backend isolation, generations, private-server capture | test/spectrum/*, test/application/spectrum.test.ts, test/integration/spectrum.test.ts |
| Native buffer | Realtime PCM bounds/protocol checks | test/native/spectrum-pcm.test.mm |
| Native packaging | Actual tar payload digests, modes, resource layout and release guards | test/scripts/package-native.test.ts |

Tests preload a unique HOME/XDG sandbox before application imports; never use os.homedir() for test setup (Bun caches the original home). IPC tests use real Unix sockets; DB tests close in-memory databases. External services use typed fixture boundaries, never live APIs.
