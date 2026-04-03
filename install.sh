#!/bin/sh
# TuiTunes installer — curl -fsSL https://raw.githubusercontent.com/5c0r/TuiTunes/main/install.sh | bash
#
# Installs bun (if missing), tui-tunes, and checks for mpv + yt-dlp.
# Works on Linux (Arch, Debian/Ubuntu, Fedora), macOS, and WSL2.

set -e

# --- Colors (disabled if not a terminal) ---
if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[32m'
  YELLOW='\033[33m'
  RED='\033[31m'
  CYAN='\033[36m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' CYAN='' DIM='' RESET=''
fi

info()  { printf "${CYAN}::${RESET} %s\n" "$1"; }
ok()    { printf "${GREEN}OK${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}!!${RESET} %s\n" "$1"; }
err()   { printf "${RED}ERR${RESET} %s\n" "$1" >&2; }
step()  { printf "\n${BOLD}%s${RESET}\n" "$1"; }

# --- Help ---
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<EOF
TuiTunes installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/5c0r/TuiTunes/main/install.sh | bash
  ./install.sh [--help]

What it does:
  1. Installs Bun (if not found)
  2. Installs tui-tunes globally via bun
  3. Checks for mpv and yt-dlp (prints install commands if missing)

Prerequisites (installed separately — may need sudo):
  mpv   >= 0.35   Audio engine
  yt-dlp           YouTube stream extraction
EOF
  exit 0
fi

# --- Detect platform ---
OS="$(uname -s)"
ARCH="$(uname -m)"
IS_WSL=false

case "$OS" in
  Linux)
    if [ -f /proc/version ] && grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
      IS_WSL=true
      PLATFORM="WSL2 (Linux)"
    else
      PLATFORM="Linux"
    fi
    ;;
  Darwin)
    PLATFORM="macOS"
    ;;
  *)
    err "Unsupported OS: $OS"
    err "TuiTunes requires Linux, macOS, or WSL2."
    exit 1
    ;;
esac

step "TuiTunes installer"
info "Platform: $PLATFORM ($ARCH)"

# --- Detect package manager ---
detect_pkg_manager() {
  if command -v pacman >/dev/null 2>&1; then echo "pacman"
  elif command -v apt >/dev/null 2>&1; then echo "apt"
  elif command -v dnf >/dev/null 2>&1; then echo "dnf"
  elif command -v brew >/dev/null 2>&1; then echo "brew"
  else echo "unknown"
  fi
}

PKG_MANAGER="$(detect_pkg_manager)"

# --- Helper: install command for a package per distro ---
pkg_install_hint() {
  pkg="$1"
  case "$PKG_MANAGER" in
    pacman) echo "sudo pacman -S $pkg" ;;
    apt)    echo "sudo apt install $pkg" ;;
    dnf)    echo "sudo dnf install $pkg" ;;
    brew)   echo "brew install $pkg" ;;
    *)      echo "# Install $pkg from your package manager or https://mpv.io" ;;
  esac
}

# --- Step 1: Bun ---
step "[1/3] Checking Bun"

BUN_OK=false
if command -v bun >/dev/null 2>&1; then
  BUN_VERSION="$(bun --version 2>/dev/null || echo "0.0.0")"
  BUN_MAJOR="$(echo "$BUN_VERSION" | cut -d. -f1)"
  BUN_MINOR="$(echo "$BUN_VERSION" | cut -d. -f2)"
  if [ "$BUN_MAJOR" -ge 2 ] 2>/dev/null || { [ "$BUN_MAJOR" -ge 1 ] && [ "$BUN_MINOR" -ge 2 ]; } 2>/dev/null; then
    ok "Bun $BUN_VERSION"
    BUN_OK=true
  else
    warn "Bun $BUN_VERSION is too old (need >= 1.2). Upgrading..."
  fi
else
  info "Bun not found. Installing..."
fi

if [ "$BUN_OK" = false ]; then
  curl -fsSL https://bun.sh/install | bash
  # Source the updated PATH
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if command -v bun >/dev/null 2>&1; then
    ok "Bun $(bun --version) installed"
  else
    err "Bun installation failed. Install manually: https://bun.sh"
    exit 1
  fi
fi

# --- Step 2: tui-tunes ---
step "[2/3] Installing tui-tunes"

bun install -g tui-tunes@alpha
if command -v tui-tunes >/dev/null 2>&1; then
  ok "tui-tunes installed"
else
  # bun global bin may not be in PATH
  BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
  if [ -x "$BUN_BIN/tui-tunes" ]; then
    warn "tui-tunes installed but not in PATH"
    warn "Add to your shell config:"
    echo "  export PATH=\"$BUN_BIN:\$PATH\""
  else
    err "tui-tunes installation failed"
    exit 1
  fi
fi

# --- Step 3: System dependencies ---
step "[3/3] Checking system dependencies"

MISSING=""

# mpv
if command -v mpv >/dev/null 2>&1; then
  MPV_OUT="$(mpv --version 2>/dev/null | head -1)"
  ok "mpv: $MPV_OUT"
else
  MISSING="$MISSING mpv"
  warn "mpv not found"
fi

# yt-dlp
if command -v yt-dlp >/dev/null 2>&1; then
  YTDLP_OUT="$(yt-dlp --version 2>/dev/null)"
  ok "yt-dlp: $YTDLP_OUT"
else
  MISSING="$MISSING yt-dlp"
  warn "yt-dlp not found"
fi

# --- Print install instructions for missing deps ---
if [ -n "$MISSING" ]; then
  echo ""
  warn "Missing system dependencies:${BOLD}$MISSING${RESET}"
  echo ""
  info "Install them with:"
  for dep in $MISSING; do
    case "$dep" in
      yt-dlp)
        if [ "$PKG_MANAGER" = "apt" ]; then
          echo "  pip install yt-dlp"
        else
          echo "  $(pkg_install_hint yt-dlp)"
        fi
        ;;
      *)
        echo "  $(pkg_install_hint "$dep")"
        ;;
    esac
  done

  if [ "$IS_WSL" = true ]; then
    echo ""
    info "WSL2 audio: requires WSLg (Win11 22H2+) or manual PulseAudio setup."
    info "Verify WSLg: ls /mnt/wslg/"
  fi
fi

# --- Done ---
echo ""
step "Done!"

if [ -n "$MISSING" ]; then
  info "Install the missing dependencies above, then run:"
else
  info "Run:"
fi
printf "  ${GREEN}${BOLD}tui-tunes${RESET}\n"
echo ""
printf "${DIM}Press / to search, j/k to navigate, Enter to play, ? for help${RESET}\n"
