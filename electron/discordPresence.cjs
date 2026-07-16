/**
 * Discord Rich Presence for miura.
 * Shows current track in Discord status (Listening to miura).
 *
 * Uses a shared Application ID shipped with the app so users only toggle on/off.
 * App name on Discord Developer Portal should be "miura" (appears as "Listening to miura").
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/** Shared Application ID (miura) — no per-user Discord app needed */
const BUILTIN_CLIENT_ID = '1526704290922758366';

let DiscordRPC = null;
try {
  DiscordRPC = require('discord-rpc');
} catch {
  console.warn('[discord] package discord-rpc not installed');
}

let client = null;
let ready = false;
let connecting = false;
let lastActivityKey = '';
let reconnectTimer = null;

function configPath() {
  return path.join(app.getPath('userData'), 'discord.json');
}

function isPlaceholderId(id) {
  const s = String(id || '').trim();
  return !s || s === '0' || s.startsWith('1390000000');
}

function resolveClientId(id) {
  const s = String(id || '').trim();
  if (isPlaceholderId(s)) return BUILTIN_CLIENT_ID;
  return s;
}

function readConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      enabled: data.enabled !== false,
      // Always prefer built-in app id; ignore stale placeholders from old installs
      clientId: resolveClientId(data.clientId),
    };
  } catch {
    return { enabled: true, clientId: BUILTIN_CLIENT_ID };
  }
}

function writeConfig(cfg) {
  const next = {
    enabled: Boolean(cfg.enabled),
    clientId: BUILTIN_CLIENT_ID,
  };
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function truncate(str, max) {
  const s = String(str || '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Discord only accepts https cover URLs (≤ ~256 chars) as large_image.
 * data:, blob:, miura-file: → empty (shows app icon otherwise).
 */
function normalizeDiscordArt(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('http://')) u = 'https://' + u.slice(7);
  if (!/^https:\/\//i.test(u)) return '';

  // Prefer a stable SoundCloud size that almost always exists
  // (t500x500 can 404 on older artworks → Discord falls back to app icon)
  u = u
    .replace(/-t67x67(\.\w+)?(\?|$)/i, '-large$1$2')
    .replace(/-t200x200(\.\w+)?(\?|$)/i, '-large$1$2')
    .replace(/-badge(\.\w+)?(\?|$)/i, '-large$1$2')
    .replace(/-crop(\.\w+)?(\?|$)/i, '-large$1$2')
    .replace(/-tiny(\.\w+)?(\?|$)/i, '-large$1$2');

  // Discord RPC limit on external image URLs (~256)
  if (u.length > 256) {
    u = u.replace(/-t500x500/i, '-large').replace(/-t300x300/i, '-large');
  }
  if (u.length > 256) return '';
  return u;
}

function destroyClient() {
  ready = false;
  connecting = false;
  lastActivityKey = '';
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (client) {
    try {
      client.removeAllListeners();
    } catch {
      /* ignore */
    }
    try {
      void client.clearActivity();
    } catch {
      /* ignore */
    }
    try {
      void client.destroy();
    } catch {
      /* ignore */
    }
    client = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const cfg = readConfig();
    if (cfg.enabled) void connect(cfg.clientId);
  }, 15000);
}

/**
 * @param {string} clientId
 */
async function connect(clientId) {
  if (!DiscordRPC) {
    return { ok: false, error: 'discord-rpc not installed' };
  }
  const id = resolveClientId(clientId);
  if (!id) {
    return { ok: false, error: 'Нет Discord Application ID' };
  }
  if (connecting) return { ok: false, error: 'connecting' };
  if (client && ready) return { ok: true, ready: true };

  destroyClient();
  connecting = true;

  try {
    try {
      DiscordRPC.register(id);
    } catch {
      /* register is optional on some platforms */
    }

    const rpc = new DiscordRPC.Client({ transport: 'ipc' });
    client = rpc;

    rpc.on('ready', () => {
      ready = true;
      connecting = false;
      console.log('[discord] rich presence ready as', rpc.user?.username || 'ok');
    });

    rpc.on('disconnected', () => {
      console.warn('[discord] disconnected');
      ready = false;
      connecting = false;
      client = null;
      scheduleReconnect();
    });

    await rpc.login({ clientId: id });
    ready = true;
    connecting = false;
    return { ok: true, ready: true };
  } catch (e) {
    connecting = false;
    ready = false;
    client = null;
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[discord] login failed:', msg);
    scheduleReconnect();
    return { ok: false, error: msg };
  }
}

/**
 * @param {null | {
 *   title: string;
 *   artist?: string;
 *   artworkUrl?: string;
 *   permalink?: string;
 *   duration?: number;
 *   progress?: number;
 *   playing?: boolean;
 * }} payload
 */
async function setPresence(payload) {
  const cfg = readConfig();
  if (!cfg.enabled) {
    if (client && ready) {
      try {
        await client.clearActivity();
      } catch {
        /* ignore */
      }
    }
    lastActivityKey = '';
    return { ok: true, cleared: true, reason: 'disabled' };
  }

  if (!client || !ready) {
    const r = await connect(cfg.clientId);
    if (!r.ok) return r;
  }

  if (!payload || !payload.title) {
    lastActivityKey = '';
    try {
      if (client && ready) await client.clearActivity();
    } catch {
      /* ignore */
    }
    return { ok: true, cleared: true };
  }

  const title = truncate(payload.title, 128);
  const artistRaw = truncate(payload.artist || 'miura', 128);
  const artist = artistRaw.startsWith('by ') ? artistRaw.slice(3).trim() : artistRaw;
  const duration = Number(payload.duration) || 0; // seconds
  const progress = Math.max(0, Number(payload.progress) || 0);
  const playing = payload.playing !== false;
  const art = normalizeDiscordArt(payload.artworkUrl);

  // Stable key — include cover so we refresh when art arrives later
  const key = [
    title,
    artist,
    playing ? '1' : '0',
    // While paused, ignore progress buckets so we don't thrash; while playing, 5s seeks
    playing ? Math.floor(progress / 5) : Math.floor(progress),
    Math.floor(duration),
    art || 'no-art',
  ].join('|');

  if (key === lastActivityKey) {
    return { ok: true, skipped: true };
  }
  lastActivityKey = key;

  /** @type {Record<string, unknown>} */
  const activity = {
    details: title,
    // Pause: Discord has no real “frozen” timer — only `start` keeps ticking as elapsed.
    // So we drop timestamps when paused and mark state clearly.
    state: playing
      ? truncate(`by ${artist}`, 128)
      : truncate(`Paused · ${artist}`, 128),
    // type 2 = LISTENING → "Listening to miura" (not "Playing")
    type: 2,
    instance: false,
  };

  // Progress bar only while actively playing (start+end → Discord fills by wall clock).
  // Do NOT set only `start` on pause — Discord will keep counting elapsed time.
  if (duration > 0 && playing) {
    const start = Date.now() - Math.floor(progress * 1000);
    activity.timestamps = {
      start,
      end: start + Math.floor(duration * 1000),
    };
  }

  // Track cover as large image (external HTTPS URL). Without this Discord shows app icon.
  if (art) {
    activity.assets = {
      large_image: art,
      large_text: truncate(
        playing ? `${title} — ${artist}` : `⏸ ${title} — ${artist}`,
        128
      ),
    };
  }

  // Optional track link only (no GitHub button for now)
  const link = String(payload.permalink || '').trim();
  if (link.startsWith('http')) {
    const label =
      /youtube|youtu\.be/i.test(link)
        ? 'Open on YouTube'
        : /soundcloud/i.test(link)
          ? 'Open on SoundCloud'
          : 'Open track';
    activity.buttons = [{ label: truncate(label, 32), url: link.slice(0, 512) }];
  }

  try {
    // discord-rpc's setActivity() drops `type` — call SET_ACTIVITY directly
    if (typeof client.request === 'function') {
      await client.request('SET_ACTIVITY', {
        pid: process.pid,
        activity,
      });
    } else {
      await client.setActivity({
        details: activity.details,
        state: activity.state,
        startTimestamp: activity.timestamps?.start,
        endTimestamp: activity.timestamps?.end,
        largeImageKey: activity.assets?.large_image,
        largeImageText: activity.assets?.large_text,
        buttons: activity.buttons,
        instance: false,
      });
    }
    if (!art) {
      console.log('[discord] no https cover for', title, '— app icon will show');
    }
    return { ok: true, art: Boolean(art) };
  } catch (e) {
    lastActivityKey = '';
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[discord] setActivity:', msg);
    // Retry once without assets if image URL rejected
    if (art && activity.assets) {
      try {
        delete activity.assets;
        if (typeof client.request === 'function') {
          await client.request('SET_ACTIVITY', { pid: process.pid, activity });
        }
        console.warn('[discord] retried without cover image');
        return { ok: true, art: false };
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: msg };
  }
}

async function clearPresence() {
  lastActivityKey = '';
  if (client && ready) {
    try {
      await client.clearActivity();
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

async function getStatus() {
  const cfg = readConfig();
  return {
    enabled: cfg.enabled,
    clientId: cfg.clientId,
    ready,
    connected: Boolean(client && ready),
    hasPackage: Boolean(DiscordRPC),
    /** Always false — Application ID is built into the app */
    needsClientId: false,
  };
}

/**
 * @param {{ enabled?: boolean; clientId?: string }} partial
 */
async function setConfig(partial) {
  const prev = readConfig();
  const next = writeConfig({
    enabled: partial.enabled !== undefined ? partial.enabled : prev.enabled,
    clientId: BUILTIN_CLIENT_ID,
  });

  destroyClient();

  if (next.enabled) {
    const r = await connect(next.clientId);
    return { config: next, connect: r };
  }

  return { config: next, connect: { ok: true, skipped: true } };
}

async function initOnStartup() {
  const cfg = readConfig();
  if (!cfg.enabled) {
    console.log('[discord] disabled');
    return;
  }
  await connect(cfg.clientId);
}

function shutdown() {
  destroyClient();
}

module.exports = {
  initOnStartup,
  setPresence,
  clearPresence,
  getStatus,
  setConfig,
  readConfig,
  shutdown,
  BUILTIN_CLIENT_ID,
};
