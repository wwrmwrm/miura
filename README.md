<div align="center">

![miura — multi-source desktop music player](docs/banner-detail.png)

<br/>

# miura

### One player. Every source you already use.

Local library · **SoundCloud** · **YouTube**  
One queue · one transport bar · profiles that stay on your machine

<br/>

[![Electron](https://img.shields.io/badge/Electron-34-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](./LICENSE)

[![GitHub stars](https://img.shields.io/github/stars/wwrmwrm/miura?style=flat-square&color=fbbf24)](https://github.com/wwrmwrm/miura/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/wwrmwrm/miura?style=flat-square)](https://github.com/wwrmwrm/miura/issues)
[![Platform](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-0f172a?style=flat-square)](#quick-start)
[![Node](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)

<br/>

```bash
git clone https://github.com/wwrmwrm/miura.git && cd miura && npm install && npm run dev
```

<sub>v1.0.0 · Node.js 18+ · MIT · use at your own risk</sub>

</div>

---

## Table of contents

- [Philosophy](#philosophy)
- [Features at a glance](#features-at-a-glance)
- [Music sources](#music-sources)
- [Player core](#player-core)
- [Library & playlists](#library--playlists)
- [Profiles & privacy](#profiles--privacy)
- [Desktop shell](#desktop-shell)
- [Settings & proxy](#settings--proxy)
- [Internationalization](#internationalization)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Scripts](#scripts)
- [Build & package](#build--package)
- [Project layout](#project-layout)
- [Limits & honesty](#limits--honesty)
- [Roadmap-friendly notes](#roadmap-friendly-notes)
- [Contributing](#contributing)
- [License](#license)

---

## Philosophy

| Typical apps | **miura** |
|--------------|-----------|
| Local *or* one streaming brand | **Local + SoundCloud + YouTube** in one shell |
| Three windows, three queues | **One queue**, one shuffle bag, one bar |
| Account lock-in to the cloud | **Local profiles** — favorites & settings on your PC |
| “Everything DRM, always online” | **Open streams first**, honest limits where DRM blocks |

**miura** (音の余白 — *the silence between sounds*) is a **personal hub**: folders on disk, SoundCloud likes, YouTube finds — mixed without juggling three apps.

Built with **Electron + React + TypeScript** for a fast, keyboard-friendly UI and a real desktop shell (media keys, tray-friendly window, Discord presence).

---

## Features at a glance

| Area | Highlights |
|------|------------|
| **Local** | Folders, watch, ID3 covers, artists / albums / genres, smart lists, M3U, library tags |
| **SoundCloud** | Login, home, search, likes, playlists, open progressive & HLS |
| **YouTube** | In-app search, same queue as everything else |
| **Player** | Shuffle bag, repeat modes, seek, volume, mini player, queue drawer |
| **Library** | Favorites, recents, miura playlists, text/M3U import |
| **Profiles** | Multiple local users, scoped data, avatars & banners |
| **Desktop** | Discord RPC, media hotkeys, optional SOCKS/HTTP proxy |
| **i18n** | 10 languages (RU, EN-US, DE, ES, FR, IT, NL, PL, PT, SV) |
| **Themes** | Black / gray / white + custom accent |

---

## Music sources

### Local files

Bring your own library — no account required.

- Add **files** or **folders**; optional **folder watch**
- **ID3 / embedded covers** via `music-metadata`
- Browse by **artists, albums, genres**
- **Smart lists** (library-side rules)
- **M3U** import / export
- Tags edited in miura stay in the app library (disk files are not rewritten by default)
- Playback through a custom `miura-file://` protocol (reliable paths on Windows)

### SoundCloud

Full desktop shell around open streams.

- Browser / in-app style **login** (OAuth token capture)
- **Home**, charts-style surfaces, **search** (tracks, playlists, users)
- **Likes**, **playlists**, **related / station** flows
- Progressive + **HLS** (`hls.js`) where available
- **DRM / Go+-only** tracks are not cracked — see [docs/WIDEVINE.md](docs/WIDEVINE.md)

### YouTube

Search and play in the **same player bar** as local and SoundCloud.

- In-app **search** (via main-process network / Innertube-friendly path)
- Tracks join the **unified queue** with source badges
- Favorites & playlists can store YouTube items with recoverable video ids
- Network-sensitive: a stable path (and sometimes SOCKS with **all traffic**) helps

> Respect YouTube and SoundCloud terms. miura is a personal player, not a rehosting service.

---

## Player core

The heart of miura is one transport — every source ends up here.

| Control | Behavior |
|---------|----------|
| **Play / pause** | Main control; media keys supported |
| **Prev / next** | Queue-aware; shuffle uses history stack |
| **Seek** | Continuous scrubber with time labels |
| **Volume / mute** | Persistent per profile |
| **Shuffle bag** | No track repeats until the full cycle is done |
| **Repeat** | Off → whole queue → one track |
| **Queue drawer** | Inspect and jump the upcoming list |
| **Mini player** | Controls the **main** window (one audio engine) |
| **Station** | Extend listening from a seed track (SC-related flow) |

**Session restore:** last track, queue slice, volume, shuffle/repeat — restored in the UI; streams are fetched fresh on play (CDN URLs expire).

---

## Library & playlists

### miura-native

- **Favorites** (★) — multi-source, scoped to profile  
- **Recent** plays  
- **miura playlists** — local collections that can mix sources  
- **Import** — paste text lists or open **M3U**; resolve across local / SC / YT when possible  
- **Search history** — quick re-run of past queries  
- **Virtualized lists** — long libraries stay smooth  

### SoundCloud library

- Liked tracks & playlists  
- Your playlists, create / edit / delete  
- Follow / unfollow users  
- Comments on track pages (where API allows)  

### Source clarity

Every row can show a **source badge** (local · SoundCloud · YouTube) so you always know where a track came from.

---

## Profiles & privacy

- **Local profiles** (gate on launch) — name, avatar, banner  
- Data is **scoped** per profile (favorites, playlists, player state, etc.)  
- No miura cloud account required  
- Tokens for SoundCloud live in Electron **userData** (app-local storage)  

You control the machine; miura does not sell a “sync subscription.”

---

## Desktop shell

| Feature | Detail |
|---------|--------|
| **Discord Rich Presence** | Built-in app id; show current track when enabled |
| **Media hotkeys** | Play/pause, next, previous at OS level |
| **Window** | Standard Electron desktop app; works alongside system volume |
| **Proxy** | SOCKS5 / HTTP(S), optional auth; **SC-only** or **all traffic** |
| **Packaging** | NSIS installer + portable (Windows targets configured) |

---

## Settings & proxy

Useful when a source needs a tunnel (region, network policy, etc.).

| Mode | Meaning |
|------|---------|
| **Off / direct** | No app proxy |
| **SoundCloud only** | PAC routes SC hosts via proxy |
| **All traffic** | Fixed proxy rules for the whole Electron session (recommended when YouTube needs the same SOCKS as your VPN client) |

Supports local clients such as **Clash / Hiddify / v2rayN**-style `socks5://127.0.0.1:…` endpoints. Localhost is bypassed so the Vite dev UI is not sent through SOCKS.

Also in settings: **theme** (black / gray / white), **accent color**, **language**, Discord toggles.

---

## Internationalization

Ten locales ship in-tree:

| Code | Language |
|------|----------|
| `ru` | Русский |
| `en` | English (US) |
| `de` | Deutsch |
| `es` | Español |
| `fr` | Français |
| `it` | Italiano |
| `nl` | Nederlands |
| `pl` | Polski |
| `pt` | Português |
| `sv` | Svenska |

UI strings live under `src/i18n/locales/`.

---

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│  Renderer (React + Vite + TypeScript)                   │
│  pages · components · hooks/usePlayer · i18n · themes   │
└───────────────────────────┬─────────────────────────────┘
                            │ preload (contextBridge)
┌───────────────────────────▼─────────────────────────────┐
│  Main (Electron)                                        │
│  window · proxy · protocols · Discord · SC/YT network   │
│  miura-file:// · miura-yt:// · local metadata           │
└─────────────────────────────────────────────────────────┘
```

| Layer | Role |
|-------|------|
| **`src/`** | UI, player state, SoundCloud API client, YouTube search helpers, local library UX |
| **`electron/main.cjs`** | App lifecycle, proxy, IPC, protocols, packaging entry |
| **`electron/preload.cjs`** | Safe API surface to the renderer |
| **`electron/ytAudio.cjs`** | YouTube playback helpers (main-process) |
| **`electron/discordPresence.cjs`** | Rich Presence |
| **`docs/`** | Extra docs (Widevine notes, banners) |

**Stack:** Electron 34 · React 18 · TypeScript 5 · Vite 6 · hls.js · youtubei.js · music-metadata · discord-rpc · electron-builder  

---

## Quick start

### Requirements

| | |
|--|--|
| **Node.js** | 18 or newer |
| **OS** | Windows, macOS, or Linux |
| **Optional** | SOCKS/HTTP proxy client if you need one for SC/YT |

### Install & run (development)

```bash
git clone https://github.com/wwrmwrm/miura.git
cd miura
npm install
npm run dev
```

This starts **Vite** (renderer) and **Electron** (main) together.

### First launch tips

1. Create or pick a **local profile**  
2. For SoundCloud: open **Settings → login** and complete auth  
3. For local music: add a folder from the **Local** section  
4. For YouTube: use the **YouTube** page search  
5. If streams fail in a restricted network: Settings → proxy → **all traffic** + your local SOCKS port  

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development: Vite + Electron |
| `npm run build` | Production build of the renderer → `dist/` |
| `npm start` | Run Electron against built `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run preview` | Vite preview server |
| `npm run pack` | `electron-builder --dir` (unpacked app) |
| `npm run dist:win` | Windows **NSIS** installer + **portable** build |

---

## Build & package

```bash
npm run build
npm run dist:win
```

Configured product:

| Field | Value |
|-------|--------|
| **App id** | `com.miura.player` |
| **Product name** | `miura` |
| **Windows targets** | NSIS (x64), portable (x64) |
| **Output** | `release/` |

NSIS is non–one-click (user can choose install directory) and creates a desktop shortcut.

---

## Project layout

```text
miura/
├── docs/                 # README assets, Widevine notes
├── electron/             # Main process, preload, Discord, YT helpers
├── src/
│   ├── api/              # SoundCloud client & stream logic
│   ├── components/       # UI primitives
│   ├── hooks/            # usePlayer, media hotkeys, …
│   ├── i18n/             # locales
│   ├── lib/              # favorites, playlists, profiles, proxy, import
│   ├── pages/            # Local, YouTube, Profile, Track, Playlists, …
│   ├── player/           # Playable bridge & types
│   ├── sources/          # YouTube search / helpers
│   ├── App.tsx           # Shell: nav, bar, settings
│   └── styles.css        # Themes & layout
├── package.json
└── LICENSE
```

---

## Limits & honesty

miura is open source and aims to stay **honest** about what it can play.

| Topic | Reality |
|-------|---------|
| **SoundCloud DRM** | Encrypted HLS needs Widevine CDM — **not** the default GitHub path. Details: [docs/WIDEVINE.md](docs/WIDEVINE.md) |
| **YouTube** | Depends on network / region / platform changes; proxy **all traffic** may be required |
| **Terms of service** | You must respect SC, YT, and artists’ rights |
| **Local tags** | Edits live in miura’s library unless you export; files on disk are not rewritten by default |
| **Mini player** | Controls the main window only — no second audio pipeline |
| **Warranty** | MIT — **as is**, no guarantees |

We do **not** ship Castlabs/Widevine as a required dependency for contributors cloning the MIT repo.

---

## Roadmap-friendly notes

Ideas that fit the product direction (not promises):

- Richer local smart playlists  
- Better multi-source playlist editing  
- Packaging for macOS / Linux CI artifacts  
- Optional plugins for extra sources  

PRs that keep the **player core** stable (queue, shuffle bag, multi-source) are especially welcome.

---

## Contributing

1. Fork & clone  
2. `npm install` · `npm run dev`  
3. Prefer **small, focused** PRs  
4. Run `npm run typecheck` when you touch TypeScript  
5. Do not commit secrets, tokens, or personal `userData`  

Issues: [github.com/wwrmwrm/miura/issues](https://github.com/wwrmwrm/miura/issues)

---

## License

Released under the **[MIT License](./LICENSE)**.

```text
Copyright (c) miura contributors
Permission is granted free of charge, subject to the MIT terms.
```

Free to use, fork, and remix. **You** are responsible for how you access third-party services.

---

<div align="center">

**miura** — listen the way you already live.

[⭐ Star](https://github.com/wwrmwrm/miura) · [Issues](https://github.com/wwrmwrm/miura/issues) · [Clone](https://github.com/wwrmwrm/miura.git) · [Widevine notes](docs/WIDEVINE.md)

<br/>

<sub>音の余白 — the silence between sounds</sub>

</div>
