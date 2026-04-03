# TuiTunes

A terminal music player and podcast client with YouTube Music search, synced lyrics, podcast transcripts, and 8 color themes.

Built on [OpenTUI](https://github.com/mochji/opentui) (Zig native rendering + React 19) with [mpv](https://mpv.io/) as the audio engine.

## Screenshots

**Music Search (Tokyo Night theme)**
```
╭──────────────────────────────────────────────────────────────────────────────────╮
│ TuiTunes  ♪ Music │ 🎙 Podcast  Search music...                                 │
╰──────────────────────────────────────────────────────────────────────────────────╯
╭──────────────╮╭─Results (20)──────────────────────────────────────────────────────╮
│ ♪ Music      ││  1  ▸ Let Down                                             5:00 │
│  ▸ / Search  ││       Radiohead — OK Computer                                   │
│    Q Queue   ││  2    Creep                                                3:59 │
│    ♥ Favorites││       Radiohead — Creep                                        │
│    ⟲ History ││  3    No Surprises                                         3:49 │
│              ││       Radiohead — OK Computer                                   │
│              ││  4    Everything In Its Right Place                        4:12 │
│              ││       Radiohead — Kid A                                         │
╰──────────────╯╰──────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────╮
│ ▶ ▃▆▅▇▂ Let Down — Radiohead 🔀 🔁             🔊80% 1.25x  2:07 / 5:00        │
│ ━━━━━━━━━━━━━━━━━●───────────────────────                                       │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

**Podcast Section**
```
╭──────────────────────────────────────────────────────────────────────────────────╮
│ TuiTunes  ♪ Music │ 🎙 Podcast  Search podcasts...                               │
╰──────────────────────────────────────────────────────────────────────────────────╯
╭──────────────╮╭─Podcasts──────────────────────────────────────────────────────────╮
│ 🎙 Podcasts   ││  1  ▸ Lex Fridman Podcast                                    ✓ │
│  ▸ / Search  ││       Lex Fridman                                                │
│    📋 My Feeds││  2    Huberman Lab                                              │
│    📜 Episodes││       Scicomm Media                                              │
│              ││  3    All-In Podcast                                             │
│              ││       All-In Podcast, LLC                                         │
╰──────────────╯╰──────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────╮
│ ⏹ ▁▁▁▁▁ No track                                        🔊80%  0:00 / 0:00     │
│ ────────────────────────────────────────                                         │
╰──────────────────────────────────────────────────────────────────────────────────╯
```


## Features

**Music**
- YouTube Music search via [youtubei.js](https://github.com/LuanRT/YouTube.js) (no API key needed)
- Audio streaming via mpv + [yt-dlp](https://github.com/yt-dlp/yt-dlp) (audio-only, ~83MB RAM)
- Synced lyrics from [LRCLIB](https://lrclib.net/) with per-line highlighting
- Queue management, favorites, play history (SQLite)
- Shuffle, repeat (off/track/all), playback speed (0.5x-2x)

**Podcasts**
- Podcast discovery via iTunes Search API
- RSS feed parsing with subscription management
- YouTube-backed playback for perfectly synced transcripts
- Flowing transcript display with inline phrase highlighting
- Smart paragraph splitting using sentence-ending punctuation

**Interface**
- 6 layout presets: Default, Compact, Minimal, Split, Wide, Focus
- 8 color themes: Tokyo Night, Catppuccin, Dracula, Nord, Gruvbox, Solarized, Rose Pine, Kanagawa
- Command palette (Ctrl+P) with 35 fuzzy-searchable commands
- Full Unicode support (CJK, Vietnamese, emoji)
- Vim-style navigation (j/k/g/G)

## Getting Started

### Prerequisites

| Dependency | Version | Install |
|---|---|---|
| [Bun](https://bun.sh/) | >= 1.2 | `curl -fsSL https://bun.sh/install \| bash` |
| [mpv](https://mpv.io/) | >= 0.35 | See below |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | latest | See below |

**Linux (Arch)**
```bash
sudo pacman -S mpv yt-dlp
```

**Linux (Debian/Ubuntu)**
```bash
sudo apt install mpv
pip install yt-dlp
```

**macOS**
```bash
brew install mpv yt-dlp
```

**Windows** - See [PLATFORM.md](PLATFORM.md) for status. Currently requires Unix socket support (TCP fallback planned).

### Install & Run

```bash
git clone https://github.com/5c0r/TuiTunes.git
cd TuiTunes
bun install
bun run start
```

### Quick Start

1. Press `/` to focus the search bar
2. Type a song name, press `Enter`
3. Use `j`/`k` to navigate results
4. Press `Enter` to play
5. Press `Ctrl+2` to switch to Podcasts

## Keybindings

### Global

| Key | Action |
|---|---|
| `Ctrl+P` | Command palette |
| `Ctrl+L` | Cycle layout |
| `Ctrl+T` | Cycle theme |
| `Ctrl+1` | Music section |
| `Ctrl+2` | Podcast section |
| `Ctrl+Q` | Quit |

### Playback

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `n` / `p` | Next / Previous (queue) |
| `>` / `<` | Seek +/- 10 seconds |
| `t` | Jump to specific time |
| `+` / `-` | Volume up / down |
| `m` | Toggle mute |
| `]` / `[` | Speed up / down |
| `s` | Toggle shuffle |
| `r` | Cycle repeat (off / all / track) |

### Navigation

| Key | Action |
|---|---|
| `j` / `k` | Move down / up |
| `g` / `G` | Go to top / bottom |
| `Enter` | Play selected / Browse episodes |
| `Tab` | Cycle focus: main / sidebar / search |
| `/` | Focus search |
| `Escape` | Back to main |
| `?` | Help overlay |

### Actions

| Key | Action |
|---|---|
| `q` | Add to queue |
| `x` | Remove from queue |
| `f` | Toggle favorite |
| `l` | Toggle lyrics / transcript |
| `L` | Load more results |

## Sections

TuiTunes has two independent sections, each with its own sidebar and search routing:

### Music (Ctrl+1)

- **Search** - YouTube Music search with pagination (Shift+L for page 2)
- **Queue** - User-controlled playlist (q to add, x to remove)
- **Favorites** - Saved tracks (f to toggle, persisted in SQLite)
- **History** - Recently played tracks

### Podcast (Ctrl+2)

- **Search** - iTunes podcast discovery
- **My Feeds** - Subscribed podcasts (subscribe via command palette)
- **Episodes** - Browse and play episodes from a feed

Podcast episodes prefer YouTube-backed playback when available, giving perfectly synced auto-generated transcripts. Falls back to RSS audio when no YouTube match exists.

## Themes

Cycle with `Ctrl+T` or via command palette:

- **Tokyo Night** - Cool blues (default)
- **Catppuccin Mocha** - Soft pastels
- **Dracula** - Classic purple
- **Nord** - Arctic frost
- **Gruvbox** - Warm retro
- **Solarized Dark** - Low contrast
- **Rose Pine** - Muted elegant
- **Kanagawa** - Japanese ink

## Layouts

Cycle with `Ctrl+L` or via command palette:

| Layout | Description |
|---|---|
| **Default** | Sidebar + main content + now-playing footer |
| **Compact** | No sidebar, full-width content |
| **Minimal** | Search + track list + footer only |
| **Split** | Queue on left, results on right |
| **Wide** | Extended now-playing with queue preview |
| **Focus** | Distraction-free, now-playing only |

## Configuration

Config file: `~/.config/tuimusic/config.json`

```json
{
  "defaultProvider": "youtube",
  "volume": 80,
  "localMusicDirs": ["~/Music"],
  "theme": "dark",
  "poToken": null,
  "visitorData": null
}
```

Data stored in:
- `~/.config/tuimusic/tuimusic.db` - Favorites, history, podcast subscriptions (SQLite)
- `~/.config/tuimusic/debug.log` - Debug log

## Building

### Development

```bash
bun run start     # Launch
bun run dev       # Watch mode (auto-restart on changes)
bun test          # Run 92 tests
bunx tsc --noEmit # Type check
```

### Compiled Binary

```bash
bun build --compile --minify src/index.tsx --outfile dist/tuimusic
./dist/tuimusic
```

Produces a standalone ~105MB binary (includes Bun runtime). Still requires system mpv and yt-dlp.

## Architecture

```
src/
  index.tsx          Entry point: bootstrap + cleanup
  app.tsx            Root component: keyboard handler + layout rendering
  commands.ts        35 commands for the command palette

  player/            mpv JSON IPC over Unix socket
  providers/         YouTube, podcast, lyrics, transcripts
  store/             Jotai atoms (player, queue, UI, library, podcast)
  ui/                OpenTUI React components (12 components)
  db/                SQLite persistence (bun:sqlite)
  utils/             Config, logging, formatting
```

See [AGENTS.md](AGENTS.md) for the full development guide, and [PLATFORM.md](PLATFORM.md) for cross-platform details.

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh/) |
| TUI Framework | [OpenTUI](https://github.com/mochji/opentui) (Zig + React 19) |
| Audio Engine | [mpv](https://mpv.io/) via JSON IPC |
| Streaming | [yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| YouTube Search | [youtubei.js](https://github.com/LuanRT/YouTube.js) |
| State Management | [Jotai](https://jotai.org/) v2 |
| Database | bun:sqlite (WAL mode) |
| Lyrics | [LRCLIB](https://lrclib.net/) |
| Podcast Search | iTunes Search API |

## License

MIT
