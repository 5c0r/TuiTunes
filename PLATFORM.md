# Cross-Platform Compatibility

## Platform Status

| Platform | Status | Notes |
|---|---|---|
| **Linux** | Works | Tested on Arch (pacman). Also Debian/Ubuntu (apt). |
| **macOS** | Works | `brew install mpv yt-dlp bun`. Unix sockets work. `~/.config` is fine. |
| **Windows** | Blocked | mpv IPC uses Unix sockets. Needs TCP fallback (~20 lines). |

## System Dependencies

| Dependency | Linux | macOS | Windows |
|---|---|---|---|
| Bun >= 1.2 | `curl -fsSL https://bun.sh/install \| bash` | Same | `powershell -c "irm bun.sh/install.ps1\|iex"` |
| mpv >= 0.35 | `sudo pacman -S mpv` / `sudo apt install mpv` | `brew install mpv` | Download from mpv.io |
| yt-dlp | `sudo pacman -S yt-dlp` / `pip install yt-dlp` | `brew install yt-dlp` | `winget install yt-dlp` |
| PipeWire/PulseAudio | Pre-installed on most distros | CoreAudio (built-in) | WASAPI (built-in) |

## Platform-Specific Issues

### 1. mpv IPC Transport (BLOCKER on Windows)

**Current**: Unix domain socket at `$XDG_RUNTIME_DIR/tunefork-mpv.sock`

**Problem**: Windows doesn't support Unix domain sockets for mpv IPC. mpv on Windows uses named pipes (`\\.\pipe\name`), and Bun's `Bun.connect()` doesn't support named pipes.

**Fix**: Use TCP IPC instead. mpv supports `--input-ipc-server=tcp://127.0.0.1:PORT`.

Files to change:
- `src/player/process.ts`: Switch `--input-ipc-server` arg from socket path to `tcp://127.0.0.1:PORT` on Windows
- `src/player/ipc.ts`: Use `Bun.connect({hostname, port})` instead of `Bun.connect({unix})` on Windows
- No protocol change needed - mpv uses the same JSON IPC protocol over TCP

Estimated effort: ~20 lines across 2 files.

### 2. Config Directory

**Current**: Hardcoded `~/.config/tunefork/`

**Convention per platform**:
- Linux: `~/.config/tunefork/` (XDG_CONFIG_HOME)
- macOS: `~/Library/Application Support/tunefork/` (preferred) or `~/.config/` (works)
- Windows: `%APPDATA%\tunefork\`

**Fix**: In `src/utils/config.ts`:
```typescript
function getConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'tunefork');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'tunefork');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'tunefork');
}
```

### 3. `which` Command

**Current**: `Bun.spawnSync(['which', 'mpv'])` in `src/utils/deps.ts`

**Problem**: Windows doesn't have `which`. Has `where` instead.

**Fix**: Just run `mpv --version` directly and check exit code. If mpv isn't in PATH, it fails with a clear error. Remove the `which` call entirely.

### 4. Signal Handling

**Current**: `process.on('SIGINT', ...)` and `process.on('SIGTERM', ...)`

**Behavior**:
- Linux/macOS: Both signals work
- Windows: SIGINT works (Ctrl+C), SIGTERM is ignored

**Impact**: Low. We handle Ctrl+Q in the keyboard handler as the primary quit mechanism. SIGTERM is mainly for system-level process management.

### 5. Local Music Directory Default

**Current**: `~/Music`

**Convention per platform**:
- Linux: `~/Music`
- macOS: `~/Music`
- Windows: `%USERPROFILE%\Music` (same as `os.homedir() + '/Music'`)

**Status**: Already correct - `path.join(os.homedir(), 'Music')` works on all platforms.

### 6. Socket Cleanup (unlinkSync)

**Current**: `unlinkSync(SOCKET_PATH)` before spawning mpv

**Problem**: Named pipes on Windows don't need cleanup. TCP sockets don't leave files.

**Fix**: Guard with platform check, or switch to TCP which eliminates the issue entirely.

## Terminal Compatibility

### Keyboard Protocol

OpenTUI supports two keyboard input modes:
1. **Legacy VT sequences**: Works everywhere (xterm, Terminal.app, Windows Terminal, etc.)
2. **Kitty keyboard protocol**: Enhanced key reporting (press/release, disambiguated). Auto-detected.

| Terminal | Legacy | Kitty Protocol | Notes |
|---|---|---|---|
| Ghostty | Yes | Yes | Full support |
| Kitty | Yes | Yes | Full support |
| iTerm2 (macOS) | Yes | Yes | Full support |
| Alacritty | Yes | No | Legacy works fine |
| WezTerm | Yes | Yes | Full support |
| Terminal.app (macOS) | Yes | No | Limited but functional |
| Windows Terminal | Yes | No | Works with legacy mode |
| GNOME Terminal | Yes | No | Works fine |
| tmux | Yes | Partial | May intercept Ctrl+B (tmux prefix) |
| PowerShell (raw) | Partial | No | Windows Terminal wrapper required |
| cmd.exe | Partial | No | Windows Terminal wrapper required |

### Keybinding Caveats

| Issue | Platform | Details |
|---|---|---|
| **Ctrl+C = Copy** | Windows Terminal | Default setting. Users can change in settings or use Ctrl+Q to quit. |
| **Option = Esc** | macOS Terminal.app | Option key sends escape sequences. TuneFork doesn't use Alt/Option, so no impact. |
| **Ctrl+B prefix** | tmux | Conflicts with any Ctrl+B binding. TuneFork doesn't use Ctrl+B. |
| **Ctrl+L = clear** | Some shells | Only matters if running outside TuneFork. Inside the app, we capture Ctrl+L for layout cycling. |
| **Meta key** | Varies | Some terminals don't send meta. TuneFork doesn't use meta-based bindings. |

### Unicode / Emoji Support

Tested and working:
- Vietnamese diacritics and tones (ă â ê ô ơ ư đ, à á ả ã ạ)
- Chinese characters (汉字)
- Japanese (漢字 ひらがな カタカナ)
- Korean (한글)
- Thai, Hindi, Arabic
- Emoji (🎵 🎶 🎧 ❤️)
- Box drawing, block elements, braille patterns

Requires a terminal with a font that covers the needed Unicode blocks. Most modern terminals (Ghostty, Kitty, iTerm2, Windows Terminal) handle this out of the box. Fallback: characters render as replacement glyphs.

### Minimum Terminal Requirements

- **Size**: 80x24 minimum. Responsive layouts adapt at smaller sizes.
- **Color**: True color (24-bit) support. All themes use hex colors. Terminals without true color will approximate.
- **Alternate screen**: Required. OpenTUI uses alternate screen buffer for clean rendering.
- **UTF-8**: Required for Unicode characters, box drawing, and visualizer animations.

## Bun Platform Support

| API | Linux | macOS | Windows | Notes |
|---|---|---|---|---|
| `Bun.spawn()` | Yes | Yes | Yes | |
| `Bun.connect({unix:})` | Yes | Yes | No | Use TCP fallback |
| `Bun.connect({hostname, port})` | Yes | Yes | Yes | TCP works everywhere |
| `bun:sqlite` | Yes | Yes | Yes | |
| `Bun.file()` | Yes | Yes | Yes | |
| `Bun.Glob` | Yes | Yes | Yes | |
| `bun build --compile` | Yes | Yes | Yes | Produces platform-native binary |

## OpenTUI Platform Support

OpenTUI uses Zig native rendering via bun-ffi. It compiles platform-specific binaries.

| Feature | Linux | macOS | Windows |
|---|---|---|---|
| Zig FFI rendering | Yes | Yes | Yes (Bun FFI works) |
| Yoga flexbox | Yes | Yes | Yes |
| Alternate screen | Yes | Yes | Yes (Windows Terminal) |
| Mouse support | Yes | Yes | Yes (Windows Terminal) |
| True color | Yes | Yes | Yes (Windows Terminal) |
