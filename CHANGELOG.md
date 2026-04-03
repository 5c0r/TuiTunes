# Changelog

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
