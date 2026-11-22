# [1.1.0](https://github.com/5c0r/TuiTunes/compare/v1.0.0...v1.1.0) (2026-11-22)


### Features

* add mouse controls and restore listening state ([b676e88](https://github.com/5c0r/TuiTunes/commit/b676e884b8dae452a165724eb19de846a7d4ec5b))

## Unreleased

- Preview and save source-specific offsets for synced music lyrics. Choose an upper-third follow position and resume follow after manual scrolling.

- Resume podcast episodes and save, jump to, rename, or delete bookmarks tied to the actual audio source.
- Restore the queue's entries, shuffle order, repeat mode, and selected row without autoplaying.
- Dismiss search suggestions on Enter, including late results, and keep the search bar visible after opening a podcast feed.
- Navigate tabs, sidebar, results, catalogs, and queues with the mouse. Select with a click, open or play with a double-click; dialogs block background input.
- Use clickable playback buttons and seek on the progress bar when the current audio supports it.
- Default to Nerd Font icons; opt into standard Unicode or override with ASCII chrome.

# 1.0.0 (2026-11-21)


### Bug Fixes

* block Ctrl shortcuts when input is active ([1dcac11](https://github.com/5c0r/TuiTunes/commit/1dcac11b37024c9e8117816181ed2db02e8ae72b))
* **ci:** build the native helper and isolate audio jobs ([c748633](https://github.com/5c0r/TuiTunes/commit/c7486337846304fd1134d9283806a4e0c20ffd5b))
* **ci:** compile the native helper against the macOS SDK ([b2cdcce](https://github.com/5c0r/TuiTunes/commit/b2cdcceaba0d7af677a27f123cfde2b9940f1db4))
* **ci:** keep macOS ASan and UBSan without unsupported leak checks ([1d8ad76](https://github.com/5c0r/TuiTunes/commit/1d8ad76172d1ff7d04c5c3145022bb3b9977c25f))
* **ci:** use declared CoreAudio tap APIs ([a956626](https://github.com/5c0r/TuiTunes/commit/a9566269b872db6fe6bd0040e3a45431e4ae21ff))
* ensure mpv is killed on exit ([3057258](https://github.com/5c0r/TuiTunes/commit/30572581c8fb37ef84eecedb769185c5ed549d7c))
* improve scroll behavior for track list, lyrics, and transcript ([12c8b9c](https://github.com/5c0r/TuiTunes/commit/12c8b9cbbbba4b94f3f6eb57a323327448bdf0e2))
* make Ctrl+1/2 section switch truly global ([9bdb054](https://github.com/5c0r/TuiTunes/commit/9bdb054a99815246b4213146abf5c5345498a8d0))
* make Ctrl+F find work without toggling lyrics panel first ([0dee99c](https://github.com/5c0r/TuiTunes/commit/0dee99c757b57cb241e084f368a08c14cd5db9ed))
* **player:** clamp progress fraction ([18bc3e8](https://github.com/5c0r/TuiTunes/commit/18bc3e8d8206269280abe2e84941d9a4069fbb35))
* prevent auto-fetch lyrics from overwriting podcast transcript ([ea42b3c](https://github.com/5c0r/TuiTunes/commit/ea42b3ca804b1e445fbbac56a2c0783414332163))
* repeat-one now works for non-queue playback ([89c8a8a](https://github.com/5c0r/TuiTunes/commit/89c8a8a57bc2fc7b6ff793a72529c42540b7f1ab))
* **search:** preserve pagination after rejection ([775b45d](https://github.com/5c0r/TuiTunes/commit/775b45d424591fead99a5f5797adc37e5c7b5784))
* **search:** prevent stale result updates ([a4cf3e5](https://github.com/5c0r/TuiTunes/commit/a4cf3e5872529e30577fe28b2483f302953acad3))
* sync keybindings across all sources, add responsive layout ([8d0a5fe](https://github.com/5c0r/TuiTunes/commit/8d0a5fe131df3bdc0174e50508a0d66260bf8aa8))
* use scrollChildIntoView for all scroll behavior ([90122bc](https://github.com/5c0r/TuiTunes/commit/90122bc882efdb3fc0541b9b086ad15c4d65b0b0))
* vertical layout stacks lyrics/playlist top-to-bottom ([85ef0f7](https://github.com/5c0r/TuiTunes/commit/85ef0f7b0493b5b7dc6d3cf3783ce94a29967bab))


### Features

* add lyrics translation with multi-provider support ([4c64fa8](https://github.com/5c0r/TuiTunes/commit/4c64fa8b481619651fcbf410a744177407b9044a))
* add podcast source selection, catalog browsing and audio spectrum ([4461466](https://github.com/5c0r/TuiTunes/commit/44614664486a8fa4c03fbdcbfb425636d264cded))
* add search suggestions, unlimited pagination, and transcript search ([1160450](https://github.com/5c0r/TuiTunes/commit/1160450a125125cf4bfe021784099cc6e2ea9379))
* add vertical layout preset for narrow terminals ([398d1fb](https://github.com/5c0r/TuiTunes/commit/398d1fb1a7e339b2173a4887d3727c4cec7e9b3a))
* **player:** track all spawned mpv processes for guaranteed cleanup ([7692a35](https://github.com/5c0r/TuiTunes/commit/7692a35a27d19bcf2f2953fdf5815db74f6e1e6c))

# Changelog

## 0.4.0-alpha.1 (2026-04-19)

### New
- **Lyrics translation**: interleaved original + translated display, multi-provider
  - YouTube tracks use native transcript translation (synced, free, no API key)
  - LRCLIB/other lyrics translated via Lingva (default), DeepL (premium), or MyMemory
  - Batch translation: all lines translated in a single API call per song
  - SQLite cache per (track, source, target_lang) — no re-translation on repeats
  - New `Toggle Translation` and `Set Translation Language` commands in Ctrl+P palette
  - Interactive language picker overlay with 20-language lookup table
  - Config: `translationLanguage`, `translationProvider`, `deeplApiKey`, `lingvaInstance`
- **Process registry for mpv**: guaranteed cleanup on exit
  - Every spawned mpv PID tracked in a registry
  - Safety net on `process.on('exit')` sends SIGKILL to all tracked processes
  - Normal exit path still uses graceful ipc.quit() + SIGTERM

### Fixes
- Block Ctrl+1/Ctrl+2 section switch when typing in search input
- Comprehensive debug logging across translation pipeline

### Internal
- 243 tests, 1074 expect() calls (up from 231 / 1015)
- New test fixture: "Unravel" Japanese synced lyrics for translation flow

### Files added
- `src/providers/translate.ts` — TranslationProvider interface + Lingva/DeepL/MyMemory
- `src/ui/TranslationLanguageInput.tsx` — interactive language picker overlay
- `test/providers/translate.test.ts`, `test/providers/translate-integration.test.ts`

## 0.3.1-alpha.1 (2026-04-04)

### New
- Vertical layout: 7th preset (Ctrl+L), stacked top-to-bottom for narrow terminals
- 46 command palette entries with complete shortcut coverage

### Fixes
- Keybinding sync across all sources (commands.ts, HelpOverlay, README)
- HelpOverlay: added g/G (go to top/bottom), fixed escape description
- Removed fragile isNarrow responsive hack in favor of explicit vertical layout

### Internal
- 205 tests, 942 expect() calls

## 0.3.0-alpha.1 (2026-04-04)

### New
- One-line installer: `curl -fsSL https://raw.githubusercontent.com/5c0r/TuiTunes/main/install.sh | bash`
- Biome linter with project-tuned config (0 errors, 0 warnings across 58 files)
- GitHub Actions CI/CD: lint + test on every push/PR, semantic-release for automated publishing
- Commitlint enforces conventional commits on PRs
- Responsive layout: sidebar stacks vertically when terminal < 80 columns
- 45 command palette entries (up from 37) with complete shortcut coverage

### Bug Fixes
- Fix shuffle: next/prev now correctly dereference through shuffledIndices
- Fix repeat: resolves wrong track lookup that broke repeat-track and repeat-all
- Fix Shift+L: handles both Kitty protocol (key.name='l' + shift) and legacy VT (key.name='L')
- Fix playback controls: each control returns immediately, preventing key leak to other handlers
- Fix Lyrics auto-scroll: hooks moved before early returns (was violating Rules of Hooks)
- Fix Lyrics scroll: wrap lines in `<box>` for reliable layout positions
- Fix Transcript scroll: intra-paragraph tracking follows active phrase, not just paragraph top

### Keybinding Sync
- HelpOverlay: added g/G (go to top/bottom), fixed escape description
- commands.ts: added 8 missing shortcuts (f, q, x, Shift+L, Ctrl+L/T/1/2)
- README: added Ctrl+C as alternative quit key

### Internal
- 204 tests, 929 expect() calls across 13 files
- Biome replaces manual lint; `bun run lint` now runs tsc + biome
- semantic-release config with changelog, npm, GitHub release, git plugins
- publishConfig.tag: alpha (npm install via @alpha until stable)

## 0.2.0-alpha.1 (2026-04-03)

First npm pre-release of TuiTunes (published as `tui-tunes`).

### New
- Published to npm as `tui-tunes` — install globally with `bun install -g tui-tunes@alpha`
- WSL2 compatibility: auto-detects WSL environment and configures PulseAudio output
- 196 tests across 13 test files (up from 92 across 7)
- Test coverage: 87% functions, 92% lines on tested files

### Test Coverage
- New: commands, config, seek-input parsing, subtitle-parser (SRT/VTT), RSS feed parser, layouts, themes
- Extended: database queries (podcast feed CRUD), IPC convenience methods

### WSL2 Support
- `isWSL()` detection via `/proc/version`
- Automatic `--ao=pulse` mpv flag for WSLg audio
- Audio troubleshooting guidance in startup logs

### Internal
- Package renamed from `tuimusic` to `tui-tunes` for npm
- Binary command: `tui-tunes` (internal paths unchanged)
- Added repository, homepage, keywords, engines, files metadata to package.json
