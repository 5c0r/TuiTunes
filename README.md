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
- Lyrics translation via Lingva, DeepL, or MyMemory — cached locally per track + language
- Queue restoration, favorites, and play history (SQLite)
- Contextual artist/release browsing with paged albums, singles/EPs and top songs; append or play complete albums
- Shuffle, repeat (off/track/all), playback speed (0.5x-2x)

**Podcasts**
- Podcast discovery via iTunes Search API
- RSS feed parsing with subscription management
- YouTube-backed playback for perfectly synced transcripts
- Remember an episode's Auto, RSS, matched YouTube, or custom YouTube source independently of transcript overrides
- Resume unfinished episodes and save timestamped bookmarks per audio source
- Flowing transcript display with inline phrase highlighting
- Smart paragraph splitting using sentence-ending punctuation

**Interface**
- 7 layout presets: Default, Compact, Minimal, Split, Wide, Focus, Vertical
- 8 color themes: Tokyo Night, Catppuccin, Dracula, Nord, Gruvbox, Solarized, Rose Pine, Kanagawa
- Command palette (Ctrl+P) with fuzzy-searchable commands
- Full Unicode support (CJK, Vietnamese, emoji)
- Vim-style navigation (j/k/g/G) and mouse navigation, playback controls, and click-to-seek
- Nerd Font icons by default, with Unicode and ASCII options; media text is unchanged
- Independent motion and spectrum settings
- Opt-in process-only audio spectrum, never a decorative equalizer or whole-system recording

## Getting Started

### Prerequisites

| Dependency | Version | Install |
|---|---|---|
| [Bun](https://bun.sh/) | >= 1.3.14 (pinned: 1.3.14) | `curl -fsSL https://bun.sh/install \| bash` |
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

**WSL2 (Windows Subsystem for Linux)**
```bash
# Works like native Linux. Requires WSLg (Win11 22H2+) for audio.
sudo apt install mpv
pip install yt-dlp
```

### Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/5c0r/TuiTunes/main/install.sh | bash
```

Installs Bun (if needed), tui-tunes, and checks for mpv + yt-dlp.

### Install via npm

```bash
bun install -g tui-tunes@alpha
tui-tunes
```

### Install from Source

```bash
git clone https://github.com/5c0r/TuiTunes.git
cd TuiTunes
bun install --frozen-lockfile
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
| `Ctrl+Q` / `Ctrl+C` | Quit |

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

### Mouse

Click section tabs, sidebar items, catalog tabs, or search suggestions to open them. Single-click a result, episode, album, or queue row to select it; double-click to open or play it. Wheel scrolling works on lists, and open dialogs block clicks and scrolling in the background.

Use the playback buttons for play/pause, mute, and queue navigation. Click the progress bar to seek when mpv confirms the current audio is seekable and reports its duration. Next and Previous are queue controls, not direct-play controls.

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
- **Queue** - User-controlled playlist (`q` to add, `x` to remove). Restart restores entries, shuffle order, repeat mode, and the selected row without starting playback. Press `Enter` on a row to start; Next/Previous do not start the restored queue on their own.
- **Favorites** - Saved tracks (f to toggle, persisted in SQLite)
- **History** - Recently played tracks

Use **Open Primary Artist** or **Open Album** in the command palette on a focused music row with provider browse metadata. Artist tabs use Left/Right; Escape goes back and restores the previous selection. **Add Album to Queue** collects all available pages before one atomic append. **Play Album** appends without clearing the existing queue, then starts the first new entry. Unsupported or incomplete collections are reported rather than silently treated as complete.

### Podcast (Ctrl+2)

- **Search** - iTunes podcast discovery
- **My Feeds** - Subscribed podcasts (subscribe via command palette)
- **Episodes** - Browse and play episodes from a feed

Podcast **Auto** prefers a matched YouTube video and falls back to RSS. **Source for Selected Episode** saves a future-play preference; **Source for Playing Episode** can switch the active episode. RSS and matched YouTube are strict choices; a missing match does not silently become RSS. Custom YouTube accepts a video ID or supported YouTube URL. A genuine switch restarts at zero while retaining queue origin, pause, volume, mute and speed; its preference is committed only after the replacement loads. Transcript source overrides remain separate.

Opening an episode resumes an eligible checkpoint for the audio source it actually loads. In `Ctrl+P`, **Resume Episode** requires a matching checkpoint, and **Play from Start** clears it for that audio source after the replacement loads. **Add Bookmark** saves the current confirmed position. In **Episode Bookmarks**, use `j`/`k` or the arrows to select, `Enter` to jump, `r` to rename, and `x` to delete with confirmation. An RSS bookmark cannot be used on the YouTube version, or vice versa.

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
| **Vertical** | Full-width stacked content for narrower terminals |

## Configuration

Config file: `~/.config/tuimusic/config.json`

```json
{
  "volume": 80,
  "translationLanguage": null,
  "translationProvider": "lingva",
  "deeplApiKey": null,
  "lingvaInstance": null,
  "ascii": false,
  "iconStyle": "nerd-font",
  "reducedMotion": false,
  "spectrumEnabled": false
}
```

mpv and yt-dlp are mandatory at startup. Legacy podcast library rows remain visible but cannot play until an episode with complete source metadata is saved again. Removing the current queue entry immediately advances in play order; only repeat-all wraps after the last entry.

**Nerd Font icons are the default.** Set your terminal to a [Nerd Font Mono font](https://www.nerdfonts.com/font-downloads); TuiTunes does not bundle or install fonts. If you see boxes or misaligned icons, use `Ctrl+P` → **Toggle ASCII Mode** for ASCII chrome, or **Toggle Icon Style** for standard Unicode icons. ASCII overrides the saved icon style without changing it. Titles, lyrics, transcripts, and input are unchanged. Help and the palette show the effective mode.

Use **Toggle Reduced Motion** and **Toggle Audio Spectrum** in the palette. Reduced motion suppresses decorative animation and spectrum capture/FFT without changing the saved spectrum preference. Spectrum defaults off, analyzes only this application's mpv audio, and fails closed when process isolation cannot be established. See [platform requirements and native validation](PLATFORM.md#process-only-audio-spectrum) before enabling it.

Data stored in:
- `~/.config/tuimusic/tuimusic.db` - Favorites, history, podcast subscriptions (SQLite)
- `~/.config/tuimusic/debug.log` - Debug log

## Building

### Development

```bash
bun run start     # Launch
bun run dev       # Watch mode (auto-restart on changes)
bun run typecheck       # Strict source and test types
bun run test:coverage   # Isolated suite; weighted line/function coverage >= 60%
bun run test:mpv        # Real mpv, local WAV, no audio/network
bun run build
bun run smoke:compiled # Compiled TUI under a PTY (requires util-linux script)
bun run test:spectrum:native # Native helper protocol/buffer checks; not an audio-permission proof
```

The coverage gate measures weighted source line/function totals and rejects missing runtime modules. Type-only modules are exempt; bootstrap is verified through the compiled TUI smoke test. Tests preload isolated HOME/XDG directories and use offline fixtures; real-mpv integration runs separately.

### Compiled Binary

```bash
bun build --compile --minify src/index.tsx --outfile dist/tuimusic
./dist/tuimusic
```

Produces a standalone ~105MB binary (includes Bun runtime). Still requires system mpv and yt-dlp.

On macOS, spectrum additionally needs the bundled `TuiTunesSpectrum.app` helper (macOS 14.2+). Build it with `bun run build:spectrum-helper` on macOS; distributable macOS archives place the app beside `tuimusic`. Native macOS/WSLg audio acceptance and maintainer approval remain release gates; a helper compile or protocol test is not evidence of successful process-only capture.

## Architecture

```
src/
  index.tsx          Entry point: bootstrap + cleanup
  app.tsx            Root component: keyboard handler + layout rendering
  commands.ts        Typed command registry

  application/       Playback, lyrics, search, catalog and spectrum owners; keyboard dispatch
  player/            mpv JSON IPC over Unix socket
  providers/         YouTube, podcast, lyrics, transcripts
  store/             Jotai atoms (player, queue, UI, library, podcast, catalog, spectrum)
  ui/                OpenTUI React components and presentation profiles
  db/                SQLite persistence (bun:sqlite)
  utils/             Config, logging, formatting
  spectrum/          Process-only capture backends and shared PCM/FFT analysis
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
