# CLAUDE.md - TuiTunes

See **AGENTS.md** for the comprehensive development guide (file map, architecture, gotchas, keybindings).

## Quick Reference

```bash
bun run start        # Launch
bun test             # 92 tests
bunx tsc --noEmit    # Type check
```

## Critical Rules

1. **Single `useKeyboard` in app.tsx** — no other component registers key handlers. See AGENTS.md "Single Keyboard Handler".
2. **No `useCallback` with `useKeyboard`** — causes stale closures. OpenTUI handles stability via useEffectEvent.
3. **Overlay components are pure renderers** — CommandPalette, QuitConfirm, SeekInput, TranscriptUrlInput have NO useKeyboard. Keys handled in app.tsx.
4. **Hooks before early return** — `useTheme()` must be called before `if (!visible) return null`.
5. **`<select>` is broken** — use `<text>` elements for all lists.
6. **`<scrollbox>`** never gets `focused` prop — it intercepts Enter.
7. **Search gate** — when focusedPanel==='search', only Tab/Escape/Ctrl pass. All other keys are for typing.
8. **Queue is user-controlled** — playing from search doesn't add to queue.
9. **Section model** — music vs podcast are separate sections (Ctrl+1/2) with independent views and search routing.
10. **All colors via `useTheme()`** — no hardcoded hex values in components.

## Architecture

Two-level: **Section** (music/podcast) → **View** (search/queue/library/explore or search/feeds/episodes).

Playback: mpv with JSON IPC over Unix socket. YouTube via yt-dlp. Podcasts prefer YouTube version for synced transcripts.

State: Jotai atoms in `src/store/`. UI in `src/ui/`. Providers in `src/providers/`. Player in `src/player/`.

## When Modifying

See AGENTS.md "When Modifying — Checklist" for the full pre-flight list. Key points:

- New keybinding → app.tsx handler + HelpOverlay + commands.ts
- New overlay → pure renderer, key handling in app.tsx with gate block
- New state → atom in store/, import in app.tsx
- Touches search → test BOTH music and podcast sections
- Touches playback → test queue AND one-off modes
