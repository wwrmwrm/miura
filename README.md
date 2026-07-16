<div align="center">

![miura](docs/banner-detail.png)

# miura

**Local · SoundCloud · YouTube** — one queue, one player bar.

[![Electron](https://img.shields.io/badge/Electron-34-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](./LICENSE)
[![Platform](https://img.shields.io/badge/Windows-primary-0f172a?style=flat-square&logo=windows&logoColor=white)](#platforms)

```bash
git clone https://github.com/wwrmwrm/miura.git
cd miura && npm install && npm run dev
```

</div>

---

## Features

| | |
|--|--|
| **Local** | Folders, watch, ID3 covers, artists/albums/genres, smart lists, M3U |
| **SoundCloud** | Login, search, likes, playlists, progressive + HLS (open streams only) |
| **YouTube** | Search + play in the same queue |
| **Player** | Shuffle bag (no repeats until full cycle), repeat, queue, mini player |
| **Library** | Favorites, recents, miura playlists, text/M3U import |
| **Desktop** | Discord presence, media keys, themes, accent color |
| **Proxy** | SOCKS/HTTP — SC-only or all traffic |
| **i18n** | RU · EN · DE · ES · FR · IT · NL · PL · PT · SV |
| **Profiles** | Local accounts, scoped settings |

---

## Platforms

| OS | Status |
|----|--------|
| **Windows** | **Primary.** Developed and tested here. Installer / portable via `npm run dist:win`. |
| **macOS** | *Not packaged or tested.* Electron code may run with `npm run dev`, but no support promise and no official build. |
| **Linux** | Same as macOS — experimental only if you build from source yourself. |

There are **no** `dist:mac` / `dist:linux` scripts and no CI for those platforms yet.

---

## Run

**Node.js 18+** · recommended on **Windows**

| Command | |
|---------|--|
| `npm run dev` | Vite + Electron |
| `npm run build` | Renderer → `dist/` |
| `npm start` | Electron on `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dist:win` | Windows NSIS + portable |

---

## Stack

Electron · React · TypeScript · Vite · hls.js · youtubei.js · music-metadata · discord-rpc

```
src/          UI, player, SC API, i18n
electron/     main, preload, proxy, protocols
docs/         banners, Widevine notes
```

---

## Limits

- **Windows-first** — see [Platforms](#platforms)
- **SoundCloud DRM / Go+** — not supported by default ([details](docs/WIDEVINE.md))
- **YouTube** — network-sensitive; SOCKS «all traffic» may help
- Respect platform ToS and artists’ rights
- Local tag edits stay in-app; files on disk are not rewritten by default

---

## License

[MIT](./LICENSE)
