# miura

Multi-source desktop music player (**Electron + React + TypeScript**).

**Local files · SoundCloud · YouTube** — one queue, clean player shell.

## Sources

| Source | How it works |
|--------|----------------|
| **Local** | Add files/folders — plays on device via `miura-file://` |
| **SoundCloud** | Open progressive/HLS streams (api-v2). DRM-only tracks won’t play |
| **YouTube** | In-app search + stream (youtubei.js) |

## Setup

```bash
npm install
npm run dev
```

## Language

Settings → Language: **Русский / English / Українська**

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite + Electron |
| `npm run build` | Production renderer |
| `npm start` | Electron (after `build`) |

## License

MIT — use at your own risk. Respect each platform’s terms and artists’ rights.
