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
let lastError = '';
let reconnectTimer = null;
/** Last successful payload — re-applied after reconnect */
let lastPayload = null;

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
 * Public HTTPS logo for Discord assets (must be on the internet — Discord fetches it).
 * Prefer compact square icon; length must stay ≤ ~256 chars.
 */
const APP_ICON_URL =
  'https://raw.githubusercontent.com/wwrmwrm/miura/main/docs/discord-icon.png';
const APP_ICON_URL_SM =
  'https://raw.githubusercontent.com/wwrmwrm/miura/main/docs/discord-icon-128.png';

/**
 * Discord accepts https image URLs (≤ ~256 chars) as large_image / small_image.
 * data:, blob:, miura-file: → empty.
 */
function normalizeDiscordArt(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('http://')) u = 'https://' + u.slice(7);
  if (!/^https:\/\//i.test(u)) return '';

  // Strip query (can blow past length limit / confuse Discord proxy)
  try {
    const parsed = new URL(u);
    u = parsed.origin + parsed.pathname;
  } catch {
    u = u.split('?')[0];
  }

  u = u
    .replace(/-t67x67(\.\w+)?$/i, '-large$1')
    .replace(/-t200x200(\.\w+)?$/i, '-large$1')
    .replace(/-badge(\.\w+)?$/i, '-large$1')
    .replace(/-crop(\.\w+)?$/i, '-large$1')
    .replace(/-tiny(\.\w+)?$/i, '-large$1')
    .replace(/-small(\.\w+)?$/i, '-large$1');

  if (u.length > 256) {
    u = u.replace(/-t500x500/i, '-large').replace(/-t300x300/i, '-large');
  }
  if (u.length > 256) return '';
  return u;
}

/** Build assets block: big cover + small miura badge (or logo alone). */
function buildAssets(art, title, artist, playing) {
  const tip = truncate(
    playing ? `${title} — ${artist}` : `Paused · ${title} — ${artist}`,
    128
  );
  if (art) {
    return {
      large_image: art,
      large_text: tip,
      // Corner badge — enlarged light MIURA mark (no hover caption)
      small_image: APP_ICON_URL_SM.length <= 256 ? APP_ICON_URL_SM : APP_ICON_URL,
    };
  }
  // No track art → full card is the app icon
  return {
    large_image: APP_ICON_URL.length <= 256 ? APP_ICON_URL : APP_ICON_URL_SM,
    large_text: tip || 'miura',
  };
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
    if (cfg.enabled) {
      void connect(cfg.clientId).then((r) => {
        if (r.ok && lastPayload) {
          lastActivityKey = '';
          void setPresence(lastPayload);
        }
      });
    }
  }, 8000);
}

/**
 * @param {string} clientId
 */
async function connect(clientId) {
  if (!DiscordRPC) {
    lastError = 'discord-rpc not installed';
    return { ok: false, error: lastError };
  }
  const id = resolveClientId(clientId);
  if (!id) {
    lastError = 'Нет Discord Application ID';
    return { ok: false, error: lastError };
  }
  if (connecting) return { ok: false, error: 'connecting' };
  if (client && ready) return { ok: true, ready: true };

  destroyClient();
  connecting = true;

  try {
    try {
      DiscordRPC.register(id);
    } catch {
      /* optional */
    }

    const rpc = new DiscordRPC.Client({ transport: 'ipc' });
    client = rpc;

    rpc.on('ready', () => {
      ready = true;
      connecting = false;
      lastError = '';
      console.log('[discord] rich presence ready as', rpc.user?.username || 'ok');
      // Re-push after Discord restarts mid-session
      if (lastPayload) {
        lastActivityKey = '';
        void setPresence(lastPayload);
      }
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
    lastError = '';
    return { ok: true, ready: true };
  } catch (e) {
    connecting = false;
    ready = false;
    client = null;
    const msg = e instanceof Error ? e.message : String(e);
    lastError = msg;
    console.warn('[discord] login failed:', msg);
    scheduleReconnect();
    return { ok: false, error: msg };
  }
}

/**
 * Apply activity with progressive fallbacks.
 * Discord often rejects: type, external art URLs, or buttons — not the whole presence.
 */
async function applyActivity(base) {
  const withAppOnly = (() => {
    const a = { ...base };
    delete a.buttons;
    a.assets = {
      large_image: APP_ICON_URL,
      large_text: 'miura',
    };
    return a;
  })();

  const variants = [
    { ...base },
    // no buttons (common reject)
    (() => {
      const a = { ...base };
      delete a.buttons;
      return a;
    })(),
    // cover only, drop small badge (some clients choke on dual external images)
    (() => {
      const a = { ...base };
      delete a.buttons;
      if (a.assets && a.assets.large_image) {
        a.assets = {
          large_image: a.assets.large_image,
          large_text: a.assets.large_text,
        };
      }
      return a;
    })(),
    // app icon as large image only
    withAppOnly,
    // no type (defaults to Playing)
    (() => {
      const a = { ...withAppOnly };
      delete a.type;
      return a;
    })(),
    // absolute minimal
    {
      details: base.details,
      state: base.state,
      instance: false,
    },
  ];

  let lastMsg = '';
  for (let i = 0; i < variants.length; i++) {
    const activity = variants[i];
    try {
      if (client && typeof client.request === 'function') {
        await client.request('SET_ACTIVITY', {
          pid: process.pid,
          activity,
        });
      } else if (client) {
        await client.setActivity({
          details: activity.details,
          state: activity.state,
          startTimestamp: activity.timestamps?.start,
          endTimestamp: activity.timestamps?.end,
          largeImageKey: activity.assets?.large_image,
          largeImageText: activity.assets?.large_text,
          smallImageKey: activity.assets?.small_image,
          smallImageText: activity.assets?.small_text,
          buttons: activity.buttons,
          instance: false,
        });
      }
      if (i > 0) {
        console.log('[discord] setActivity ok with fallback #' + i);
      }
      lastError = '';
      return {
        ok: true,
        fallback: i,
        art: Boolean(activity.assets?.large_image),
        badge: Boolean(activity.assets?.small_image),
      };
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
      console.warn('[discord] setActivity try', i, lastMsg);
    }
  }
  lastError = lastMsg || 'setActivity failed';
  return { ok: false, error: lastError };
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
    lastPayload = null;
    return { ok: true, cleared: true, reason: 'disabled' };
  }

  if (!client || !ready) {
    const r = await connect(cfg.clientId);
    if (!r.ok) return r;
  }

  if (!payload || !payload.title) {
    lastActivityKey = '';
    lastPayload = null;
    try {
      if (client && ready) await client.clearActivity();
    } catch {
      /* ignore */
    }
    return { ok: true, cleared: true };
  }

  lastPayload = { ...payload };

  const title = truncate(payload.title, 128);
  const artistRaw = truncate(payload.artist || 'miura', 128);
  const artist = artistRaw.startsWith('by ') ? artistRaw.slice(3).trim() : artistRaw;
  const duration = Number(payload.duration) || 0;
  const progress = Math.max(0, Number(payload.progress) || 0);
  const playing = payload.playing !== false;
  const art = normalizeDiscordArt(payload.artworkUrl);

  // Coarse key — progress bucket 15s so we don't spam IPC
  const key = [
    title,
    artist,
    playing ? '1' : '0',
    playing ? Math.floor(progress / 15) : Math.floor(progress),
    Math.floor(duration),
    art ? 'art' : 'no-art',
  ].join('|');

  if (key === lastActivityKey) {
    return { ok: true, skipped: true };
  }

  /** @type {Record<string, unknown>} */
  const activity = {
    // Line 1 (bold-ish in profile): track title
    details: title,
    // Line 2: artist + source tag
    state: playing
      ? truncate(`${artist} · miura`, 128)
      : truncate(`Paused · ${artist}`, 128),
    // type 2 = LISTENING → "Listening to miura"
    type: 2,
    instance: false,
    // Always show images: cover + miura badge, or logo alone
    assets: buildAssets(art, title, artist, playing),
  };

  if (duration > 1 && playing) {
    const start = Date.now() - Math.floor(progress * 1000);
    activity.timestamps = {
      start,
      end: start + Math.floor(duration * 1000),
    };
  }

  // Buttons often rejected for unverified apps — still try, fallback strips them
  const link = String(payload.permalink || '').trim();
  if (/^https:\/\//i.test(link)) {
    const label = /soundcloud/i.test(link)
      ? 'SoundCloud'
      : /youtube|youtu\.be/i.test(link)
        ? 'YouTube'
        : 'Open track';
    activity.buttons = [{ label: truncate(label, 32), url: link.slice(0, 512) }];
  }

  const result = await applyActivity(activity);
  if (result.ok) {
    lastActivityKey = key;
  } else {
    lastActivityKey = '';
  }
  return result;
}

async function clearPresence() {
  lastActivityKey = '';
  lastPayload = null;
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
    needsClientId: false,
    lastError: lastError || null,
    hasLastTrack: Boolean(lastPayload?.title),
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
    if (r.ok && lastPayload) {
      lastActivityKey = '';
      await setPresence(lastPayload);
    }
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
  // Delay slightly so Discord IPC is up if both start together
  await new Promise((r) => setTimeout(r, 1500));
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
