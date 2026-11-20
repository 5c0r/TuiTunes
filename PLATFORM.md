# Cross-Platform Compatibility

## Platform Status

| Platform | Status | Notes |
|---|---|---|
| **Linux** | Works | Tested on Arch (pacman). Also Debian/Ubuntu (apt). |
| **WSL2** | Works | Requires WSLg (Win11 22H2+) or PulseAudio for audio. |
| **macOS** | Works | `brew install mpv yt-dlp bun`. Unix sockets work. `~/.config` is fine. |
| **Windows** | Blocked | mpv IPC uses Unix sockets. Needs TCP fallback (~20 lines). |

## System Dependencies

| Dependency | Linux | macOS | Windows |
|---|---|---|---|
| Bun >= 1.2 | `curl -fsSL https://bun.sh/install \| bash` | Same | `powershell -c "irm bun.sh/install.ps1\|iex"` |
| mpv >= 0.35 | `sudo pacman -S mpv` / `sudo apt install mpv` | `brew install mpv` | Download from mpv.io |
| yt-dlp | `sudo pacman -S yt-dlp` / `pip install yt-dlp` | `brew install yt-dlp` | `winget install yt-dlp` |
| PipeWire/PulseAudio | Pre-installed on most distros | CoreAudio (built-in) | WASAPI (built-in) |

## Process-only Audio Spectrum

Spectrum is opt-in (`spectrumEnabled: false` by default), uses the existing mpv process, and never opens a second media decoder, changes the output route, or falls back to a whole-system monitor. Reduced motion suspends capture and FFT while retaining the saved preference.

| Backend | Requirements | Isolation |
|---|---|---|
| Linux PipeWire, including PipeWire-Pulse | `pw-dump`, `pw-record`, `pw-link` 1.0+; Pulse discovery tools when using Pulse | Exact per-spawn mpv client/PID, explicit passive links to its output ports, graph attestation before forwarding PCM |
| Native PulseAudio / WSLg | `pactl` 16+ and `parec`; server protocol 13+ with sink-input monitoring | Exact mpv sink input; re-attested monitor-stream capture on moves, unavailable when the input disappears |
| macOS | macOS 14.2+, bundled `TuiTunesSpectrum.app`, OS audio-capture consent | Positive inclusion of the mpv process in a private, non-exclusive, unmuted CoreAudio tap |
| Other or unverifiable configuration | No supported capture | Unavailable status, no fallback recording; playback continues |

For a source checkout on macOS, run `bun run build:spectrum-helper`. The helper belongs at `native/bin/TuiTunesSpectrum.app/Contents/MacOS/tuitunes-spectrum-tap`; compiled distributions keep the app beside `tuimusic`. No helper is downloaded at runtime. Permission refusal or revocation must not break playback; silence alone is not diagnosed as permission denial.

The offline suite tests PCM/FFT and lifecycle ownership. `bun run test:spectrum:native` checks native protocol/buffer behavior, **not** TCC permission or real audio isolation. Private-server integration can be requested with:

```bash
TUITUNES_SPECTRUM_TEST_BACKEND=pipewire bun run test:spectrum
TUITUNES_SPECTRUM_TEST_BACKEND=pulse bun run test:spectrum
```

Local Linux acceptance uses private null-sink servers and real mpv, never the desktop mix. The PipeWire 1.6.10 and native PulseAudio 17.0 matrix covers mono, stereo and 5.1 inputs, target-versus-decoy tones, target silence and unchanged routing/volume. Both stereo cases exercise application-owned capture across pause, resume and mpv crash recovery with the decoy still playing. The native Pulse stereo case also checks sink-move reattachment and target-removal shutdown. This does not validate macOS or WSLg.

### Native acceptance and release approval

Real macOS and WSLg acceptance is attended, not inferred from Linux or a green helper build. Before approving a release, record the commit/artifact digest, OS/backend/tool versions and results for:

- Current-player tone appears in the expected FFT band; an unrelated process's different tone does not.
- Output route remains unchanged; process exit, sink moves/device changes, pause/resume and format changes clean up/restart safely.
- Capture disable, reduced motion, source switch, player recovery and quit drain all owned resources.
- macOS initial consent, refusal/revocation and helper-bundle behavior; WSLg's actual sink-input monitor support.

Attach that evidence to the release review. Publication must consume the same trusted CI artifacts and pass the protected `native-audio-release` environment's required maintainer approval. Missing native evidence remains a release blocker; compile, protocol and sanitizer checks do not replace it.

## Platform-Specific Issues

### WSL2 (Windows Subsystem for Linux 2)

**Status**: Works. All components (Bun, OpenTUI, mpv, yt-dlp, Unix sockets) run natively.

**Audio**: Requires WSLg (Win11 22H2+ with updated WSL) which provides a PulseAudio server.
TuiTunes auto-detects WSL2 and adds `--ao=pulse` to mpv args.

**If no sound**:
1. Verify WSLg: `ls /mnt/wslg/` should exist
2. Check PulseAudio: `pactl info` should show a server
3. Update WSL: `wsl --update` from PowerShell
4. Manual PulseAudio: install `pulseaudio` in WSL, configure to connect to Windows PulseAudio server

**Detection**: `isWSL()` in `src/utils/deps.ts` reads `/proc/version` for "microsoft" or "wsl".

### 1. mpv IPC Transport (BLOCKER on Windows)

**Current**: Unix domain socket at `$XDG_RUNTIME_DIR/tuimusic-mpv.sock`

**Problem**: Windows doesn't support Unix domain sockets for mpv IPC. mpv on Windows uses named pipes (`\\.\pipe\name`), and Bun's `Bun.connect()` doesn't support named pipes.

**Fix**: Use TCP IPC instead. mpv supports `--input-ipc-server=tcp://127.0.0.1:PORT`.

Files to change:
- `src/player/process.ts`: Switch `--input-ipc-server` arg from socket path to `tcp://127.0.0.1:PORT` on Windows
- `src/player/ipc.ts`: Use `Bun.connect({hostname, port})` instead of `Bun.connect({unix})` on Windows
- No protocol change needed - mpv uses the same JSON IPC protocol over TCP

Estimated effort: ~20 lines across 2 files.

### 2. Config Directory

**Current**: Hardcoded `~/.config/tuimusic/`

**Convention per platform**:
- Linux: `~/.config/tuimusic/` (XDG_CONFIG_HOME)
- macOS: `~/Library/Application Support/tuimusic/` (preferred) or `~/.config/` (works)
- Windows: `%APPDATA%\tuimusic\`

**Fix**: In `src/utils/config.ts`:
```typescript
function getConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'tuimusic');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'tuimusic');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'tuimusic');
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
| **Option = Esc** | macOS Terminal.app | Option key sends escape sequences. TuiTunes doesn't use Alt/Option, so no impact. |
| **Ctrl+B prefix** | tmux | Conflicts with any Ctrl+B binding. TuiTunes doesn't use Ctrl+B. |
| **Ctrl+L = clear** | Some shells | Only matters if running outside TuiTunes. Inside the app, we capture Ctrl+L for layout cycling. |
| **Meta key** | Varies | Some terminals don't send meta. TuiTunes doesn't use meta-based bindings. |

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
