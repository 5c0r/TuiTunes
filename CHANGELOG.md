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
