# Changelog

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
