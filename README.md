# miura

Multi-source **desktop music player** — Electron + React + TypeScript.

**Local files · SoundCloud · YouTube** — one queue, one player bar, local profiles.

## Features

| Area | Details |
|------|---------|
| **Local** | Folders, watch, ID3 covers, artists/albums/genres, smart lists, M3U, tags (library-side) |
| **SoundCloud** | Open progressive/HLS streams (api-v2). DRM-only tracks won’t play — see [docs/WIDEVINE.md](docs/WIDEVINE.md) |
| **YouTube** | In-app search + stream (`youtubei.js`) |
| **Playlists** | Text/M3U import, resolve across sources, virtualized long lists |
| **Player** | Shuffle bag (no repeats until full cycle), queue, mini player control surface |
| **Discord** | Rich Presence (built-in app) |
| **i18n** | Русский, English (US), Deutsch, Español, Français, Italiano, Nederlands, Polski, Português, Svenska |

## Setup

```bash
npm install
npm run dev
```

Requires **Node.js 18+** and **Windows / macOS / Linux**.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite + Electron (development) |
| `npm run build` | Production renderer → `dist/` |
| `npm start` | Electron against `dist/` |
| `npm run typecheck` | TypeScript check |
| `npm run pack` | Package with electron-builder (dir) |
| `npm run dist:win` | Windows installer / portable (if builder configured) |

## Git

```bash
git clone https://github.com/wwrmwrm/miura.git
cd miura
npm install
npm run dev
```

## Notes

- Respect each platform’s terms and artists’ rights.
- SoundCloud DRM / Go+ only tracks need the official client — miura plays open streams only.
- Local tag edits stay in the miura library unless you re-export; files on disk are not rewritten.
- Mini player controls the **main** window (no second audio engine).

## License

MIT — use at your own risk.
