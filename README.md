# Jumpscare Multiplayer

Scare your friends across multiple PCs. An admin syncs transparent jumpscare videos to a lobby, and every connected player gets a fullscreen, clickthrough overlay scare — with sound — right over whatever they're doing. No focus stolen, no input blocked.

## What it does

- **Lobbies** — create/join by encrypted share string (`JUMPCARE2:` + a share password you set in Settings).
- **Video library** — upload multiple videos per lobby, click one to switch instantly, per-video delete, random-video-each-scare mode.
- **Smart sync** — only uploads what changed (video, chance); never re-uploads the same file twice.
- **Video editor** — chroma-key any video (MP4/MKV/AVI/WebM/GIF/PNG) to transparent WebM, frame-accurate trimming (sliders + arrow keys), tolerance + click-to-pick color, live keyed preview, URL import (YouTube/links via yt-dlp), custom output names.
- **Overlay** — transparent, always-on-top, clickthrough, never steals focus; follows the focused monitor across multi-monitor setups; overlapping scares queue instead of freezing.
- **Force (button + F12) and Preview** — admin force-fires to everyone; preview plays only locally. Auto-scares roll against lobby chance with a 10s cooldown (manual triggers bypass it).
- **System integration** — tray icon (minimize/quit), start-with-Windows toggle (starts minimized), setup guide built in.

## Install (for players)

1. Get the portable `jumpscare-multiplayer.exe` (no installer — just run it). Windows 10/11 only (WebView2 ships with Windows).
2. Open **Settings**:
   - Install **FFmpeg** (video editor) — one click, terminal guided.
   - Install **yt-dlp** (URL downloads) — one click, silent.
   - Paste your **Supabase URL + anon key** (see the in-app Setup Guide, step by step) and set a **Share Password**.
   - Binaries live in `dependencies/` next to the exe (falls back to `%LOCALAPPDATA%\jumpscare-multiplayer\` when the exe folder isn't writable).
3. Create a lobby with **+ New**, share the `JUMPCARE2:` string **and** the password separately.
4. Exported videos land in `transparent_videos/` next to the exe.

## Modify & compile (for developers)

Prereqs: Rust stable (1.77.2+), Node 18+, Tauri CLI (`npx tauri --version`).

```sh
npx tauri dev      # run with hot reload
cargo build --release   # portable exe -> src-tauri/target/release/  (run inside src-tauri/)
```

Notes:
- Release profile is tuned for smallest exe (`lto`, single codegen unit, stripped) — builds take ~4 minutes. Frontend-only changes still require a rebuild (the UI is embedded in the binary).
- IPC contract: Rust `snake_case` command args arrive as `camelCase` in JS — keep them camelCase on the JS side (see the comment at the `convert_video` call).
- `debug/launch.bat` starts the app with a remote-debugging port for automated UI tests (`debug/*.cjs` scripts).
- Layout: `src/` (Tauri frontend: `index.html`, `main.js`, `overlay.*`, `guide.html`, `styles.css`), `src-tauri/src/` (Rust: `lib.rs` commands, `windows_api.rs` Win32 overlay work), `src-tauri/` (config, capabilities, icons), `supabase/` (reference schema — the in-app guide is the source of truth).

## Supabase

One free project per host. Run the SQL in the in-app Setup Guide (creates `lobbies`, `players`, `jumpscares`, the public `jumpscare-assets` bucket, open policies, realtime). Schema at a glance: `lobbies(room_code, host_id, admin_name, chance, video_url, random_mode)`.

## Controls

| Action | How |
|---|---|
| Force scare (admin) | Button, or **F12** anywhere |
| Preview (admin, local only) | Preview Jumpscare button |
| Minimize to tray | Close window / tray icon |
| Start with Windows | Settings checkbox (starts minimized) |
| Cooldown | 10s on auto-scares; manual triggers bypass |

## License

MIT — see [LICENSE](LICENSE).

App icon based on ["Death Note" by Lorc (game-icons.net)](https://game-icons.net/1x1/lorc/death-note.html), used under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), colors modified.

Video conversion by [FFmpeg](https://ffmpeg.org/) (GPL, downloaded at runtime — not bundled) and downloads by [yt-dlp](https://github.com/yt-dlp/yt-dlp) (public domain).
