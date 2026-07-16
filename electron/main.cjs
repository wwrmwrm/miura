const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  session,
  safeStorage,
  net,
  protocol,
  dialog,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL, fileURLToPath } = require('url');
const discordPresence = require('./discordPresence.cjs');

let tray = null;

// Look less like automation before app ready (helps Cloudflare / bot walls)
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
// Allow SC widget / embed autoplay without a gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Local audio files inside the renderer (miura-file:///C:/Music/track.mp3)
// Also keep legacy miu-file: for libraries saved before rebrand.
const localFileSchemePrivs = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  bypassCSP: true,
  corsEnabled: true,
};
protocol.registerSchemesAsPrivileged([
  { scheme: 'miura-file', privileges: { ...localFileSchemePrivs } },
  { scheme: 'miu-file', privileges: { ...localFileSchemePrivs } },
  // Proxied YouTube/googlevideo audio for <audio> (headers + session proxy)
  {
    scheme: 'miura-yt',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

const isDev = !app.isPackaged;
let mainWindow = null;
/** Always-on-top control surface — no second audio engine */
let miniPlayerWin = null;
let loginWindow = null;
let authServer = null;
let authServerPort = 0;
let pendingBrowserLogin = null; // { resolve, reject, timer }
/** Hidden SoundCloud embed player (DRM tracks) */
let scEmbedWin = null;

// Realistic Chrome UA (match installed Chromium major roughly)
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Shared capture state for login / client_id interceptors */
const capture = {
  token: null,
  clientId: null,
  loginActive: false,
};

const TOKEN_FILE = () => path.join(app.getPath('userData'), 'auth.json');
const PROXY_FILE = () => path.join(app.getPath('userData'), 'proxy.json');
const CLIENT_ID_FILE = () => path.join(app.getPath('userData'), 'client_id.json');

/**
 * Proxy config for geo-bypass (e.g. RU → exit in EU/US).
 * mode: 'off' | 'sc' (SoundCloud only) | 'all'
 * url examples:
 *   socks5://127.0.0.1:1080
 *   socks5://user:pass@host:1080
 *   http://127.0.0.1:7890
 *   http://user:pass@host:8080
 */
// Local proxy (user's client on 127.0.0.1:12334) — on by default for RU access
// mode "all" = весь трафик Electron (включая окно sign-in) через прокси — надёжнее PAC
const DEFAULT_PROXY = {
  enabled: true,
  mode: 'all',
  url: 'socks5://127.0.0.1:12334',
};

function readProxyConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(PROXY_FILE(), 'utf8'));
    return {
      enabled: data.enabled !== undefined ? Boolean(data.enabled) : DEFAULT_PROXY.enabled,
      mode: data.mode === 'all' ? 'all' : 'sc',
      url: String(data.url || DEFAULT_PROXY.url).trim() || DEFAULT_PROXY.url,
    };
  } catch {
    return { ...DEFAULT_PROXY };
  }
}

function writeProxyConfig(cfg) {
  const next = {
    enabled: Boolean(cfg.enabled),
    mode: cfg.mode === 'all' ? 'all' : 'sc',
    url: String(cfg.url || '').trim(),
  };
  fs.writeFileSync(PROXY_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function parseProxyForPac(proxyUrl) {
  // PAC expects: PROXY host:port | SOCKS5 host:port | SOCKS host:port
  let raw = proxyUrl.trim();
  if (!/^[a-z0-9]+:\/\//i.test(raw)) {
    raw = `socks5://${raw}`;
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Некорректный URL прокси. Пример: socks5://127.0.0.1:1080');
  }
  const host = u.hostname;
  const port = u.port || (u.protocol.startsWith('socks') ? '1080' : '8080');
  const auth =
    u.username || u.password
      ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}@`
      : '';
  const proto = u.protocol.replace(':', '').toLowerCase();

  if (proto === 'socks5' || proto === 'socks') {
    // Chromium PAC: SOCKS5 does not embed user:pass well; use proxyRules for auth
    return {
      pacType: `SOCKS5 ${host}:${port}`,
      proxyRules: `socks5://${auth}${host}:${port}`,
      scheme: 'socks5',
    };
  }
  if (proto === 'socks4') {
    return {
      pacType: `SOCKS ${host}:${port}`,
      proxyRules: `socks4://${auth}${host}:${port}`,
      scheme: 'socks4',
    };
  }
  // http / https
  return {
    pacType: `PROXY ${host}:${port}`,
    proxyRules: `http://${auth}${host}:${port}`,
    scheme: 'http',
  };
}

function buildScOnlyPac(pacProxyLine) {
  // Route only SoundCloud CDN/API hosts through proxy
  return `
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (
    dnsDomainIs(host, "soundcloud.com") ||
    shExpMatch(host, "*.soundcloud.com") ||
    dnsDomainIs(host, "sndcdn.com") ||
    shExpMatch(host, "*.sndcdn.com") ||
    dnsDomainIs(host, "soundcloud.cloud") ||
    shExpMatch(host, "*.soundcloud.cloud") ||
    shExpMatch(host, "*.soundcloudms.com") ||
    dnsDomainIs(host, "stratus.sc") ||
    shExpMatch(host, "*.stratus.sc")
  ) {
    return "${pacProxyLine}";
  }
  return "DIRECT";
}
`.trim();
}

async function applyProxyToSession(ses, cfg) {
  if (!cfg.enabled || !cfg.url) {
    await ses.setProxy({ mode: 'system' });
    await ses.setProxy({ mode: 'direct' });
    try {
      await ses.closeAllConnections();
    } catch {
      /* ignore */
    }
    return { ok: true, applied: 'direct' };
  }

  const parsed = parseProxyForPac(cfg.url);

  // fixed_servers works for ALL BrowserWindows on this session (main + sign-in).
  // PAC is flaky on Windows and often skips login popup — avoid for local proxies.
  const useFixed =
    cfg.mode === 'all' ||
    /127\.0\.0\.1|localhost/i.test(cfg.url) ||
    /\/\/[^/]+@/.test(parsed.proxyRules);

  if (useFixed) {
    // IMPORTANT: bypass localhost so Vite/dev UI is not sent through SOCKS
    // Do NOT use <-loopback> — that forces 127.0.0.1 THROUGH the proxy
    await ses.setProxy({
      proxyRules: parsed.proxyRules,
      proxyBypassRules: 'localhost;127.0.0.1;<local>',
    });
    try {
      await ses.closeAllConnections();
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      applied: 'fixed',
      rules: parsed.proxyRules.replace(/\/\/[^@]+@/, '//***@'),
    };
  }

  const pac = buildScOnlyPac(parsed.pacType);
  const pacDataUrl =
    'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(pac, 'utf8').toString('base64');
  await ses.setProxy({ pacScript: pacDataUrl });
  try {
    await ses.closeAllConnections();
  } catch {
    /* ignore */
  }
  return { ok: true, applied: 'sc-only', pac: parsed.pacType };
}

async function applyProxyConfig(cfg) {
  // Apply to default session + dedicated login partition so sign-in always goes via proxy
  const targets = [session.defaultSession, session.fromPartition('persist:sc-login')];
  let last = { ok: true, applied: 'direct' };
  for (const ses of targets) {
    last = await applyProxyToSession(ses, cfg);
  }
  return last;
}

function installCaptureHooksOnSession(ses) {
  const filter = {
    urls: [
      '*://*.soundcloud.com/*',
      '*://*.sndcdn.com/*',
      '*://api-v2.soundcloud.com/*',
      '*://api.soundcloud.com/*',
      '*://secure.soundcloud.com/*',
      '*://api-auth.soundcloud.com/*',
      '*://*.soundcloud.cloud/*',
      // YouTube media in <audio> needs YT referer or googlevideo 403s
      '*://*.googlevideo.com/*',
      '*://*.youtube.com/*',
      '*://*.ytimg.com/*',
    ],
  };

  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const u = String(details.url || '');
    const isYtMedia =
      /googlevideo\.com/i.test(u) ||
      (/youtube\.com/i.test(u) && /videoplayback|\/api\/timedtext/i.test(u));

    // During login: only OBSERVE headers — don't rewrite Origin/Referer (triggers bot walls)
    if (capture.loginActive && !isYtMedia) {
      const auth = details.requestHeaders?.Authorization || details.requestHeaders?.authorization;
      if (auth) {
        const m = String(auth).match(/OAuth\s+([A-Za-z0-9._~\-+/=]+)/i);
        if (m) capture.token = m[1];
      }
      const cid = details.url.match(/[?&]client_id=([a-zA-Z0-9]{16,40})/);
      if (cid) capture.clientId = cid[1];
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    if (isYtMedia) {
      details.requestHeaders['Referer'] = 'https://www.youtube.com/';
      details.requestHeaders['Origin'] = 'https://www.youtube.com';
      if (!details.requestHeaders['User-Agent'] && !details.requestHeaders['user-agent']) {
        details.requestHeaders['User-Agent'] = CHROME_UA;
      }
    } else if (!details.requestHeaders['Referer'] && !details.requestHeaders['referer']) {
      // Normal SC playback: soft referer only if missing
      details.requestHeaders['Referer'] = 'https://soundcloud.com/';
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  ses.webRequest.onBeforeRequest(filter, (details, callback) => {
    const cid = details.url.match(/[?&]client_id=([a-zA-Z0-9]{16,40})/);
    if (cid) capture.clientId = cid[1];
    if (capture.loginActive) {
      const tok = details.url.match(/[?&]oauth_token=([A-Za-z0-9._~\-+/=]+)/);
      if (tok) capture.token = tok[1];
    }
    callback({});
  });
}

/** Make a BrowserWindow look like normal Chrome (reduce bot score). */
function hardenBrowserFingerprint(wc) {
  try {
    wc.setUserAgent(CHROME_UA);
  } catch {
    /* ignore */
  }

  wc.on('dom-ready', () => {
    void wc
      .executeJavaScript(
        `
        (() => {
          try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            window.chrome = window.chrome || { runtime: {} };
          } catch (e) {}
        })();
      `,
        true
      )
      .catch(() => {});
  });
}

async function validateAndSaveToken(accessToken, clientId, fetchImpl) {
  const headers = {
    Accept: 'application/json',
    Authorization: `OAuth ${accessToken}`,
    'User-Agent': CHROME_UA,
  };
  let url = 'https://api-v2.soundcloud.com/me';
  if (clientId) url += `?client_id=${encodeURIComponent(clientId)}`;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`Токен не принят (HTTP ${res.status})`);
  const user = await res.json();
  saveAuth({
    accessToken,
    clientId: clientId || capture.clientId || null,
    user: {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      permalink_url: user.permalink_url,
      full_name: user.full_name,
      followers_count: user.followers_count,
      followings_count: user.followings_count,
      track_count: user.track_count,
      playlist_count: user.playlist_count,
    },
  });
  return getStoredAuth();
}

/** Probe common local proxy ports (quick TCP connect). */
function probeLocalProxyPorts() {
  const net = require('net');
  const candidates = [
    { port: 7890, scheme: 'http', hint: 'Clash / Mihomo HTTP' },
    { port: 7891, scheme: 'socks5', hint: 'Clash SOCKS' },
    { port: 7897, scheme: 'http', hint: 'Clash mixed' },
    { port: 10808, scheme: 'socks5', hint: 'v2rayN' },
    { port: 10809, scheme: 'http', hint: 'v2rayN HTTP' },
    { port: 12334, scheme: 'socks5', hint: 'Hiddify / custom' },
    { port: 1080, scheme: 'socks5', hint: 'SOCKS' },
    { port: 1081, scheme: 'socks5', hint: 'SOCKS alt' },
    { port: 2080, scheme: 'socks5', hint: 'Nekoray' },
    { port: 20170, scheme: 'socks5', hint: 'NekoBox' },
    { port: 20171, scheme: 'socks5', hint: 'NekoBox' },
    { port: 20172, scheme: 'http', hint: 'NekoBox HTTP' },
    { port: 6152, scheme: 'socks5', hint: 'Surge' },
    { port: 6153, scheme: 'http', hint: 'Surge HTTP' },
    { port: 9090, scheme: 'http', hint: 'Clash external' },
    { port: 7893, scheme: 'socks5', hint: 'Clash SOCKS alt' },
  ];
  const hosts = ['127.0.0.1', 'localhost'];
  const timeoutMs = 400;

  function tryConnect(host, port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        resolve(ok);
      };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
      try {
        sock.connect({ port, host, family: 4 });
      } catch {
        finish(false);
      }
    });
  }

  return Promise.all(
    candidates.map(async (c) => {
      for (const host of hosts) {
        // eslint-disable-next-line no-await-in-loop
        const open = await tryConnect(host, c.port);
        if (open) {
          return {
            port: c.port,
            scheme: c.scheme,
            hint: c.hint,
            url: `${c.scheme}://127.0.0.1:${c.port}`,
          };
        }
      }
      return null;
    })
  ).then((list) => {
    const open = list.filter(Boolean);
    console.log('[proxy-probe] open ports:', open.map((x) => x.port).join(', ') || '(none)');
    return open;
  });
}

async function testProxyReachability() {
  const url = 'https://api-v2.soundcloud.com/search/tracks?q=test&limit=1&client_id=a';
  try {
    // net.fetch uses Chromium network stack → respects session proxy
    const res = await net.fetch(url, { method: 'GET' });
    // 401/403 still means we reached SC (good); network error means blocked
    return {
      ok: true,
      status: res.status,
      reachable: res.status > 0,
      message:
        res.status === 401 || res.status === 403 || res.status === 400 || res.status === 200
          ? `SoundCloud отвечает (HTTP ${res.status}) — маршрут ок`
          : `Ответ HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      reachable: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

function readAuthFile() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

function writeAuthFile(data) {
  fs.writeFileSync(TOKEN_FILE(), JSON.stringify(data, null, 2), 'utf8');
}

function encryptToken(token) {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encrypted: true,
      value: safeStorage.encryptString(token).toString('base64'),
    };
  }
  return { encrypted: false, value: token };
}

function decryptToken(payload) {
  if (!payload?.value) return null;
  if (payload.encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(payload.value, 'base64'));
    } catch {
      return null;
    }
  }
  return payload.value;
}

function getStoredAuth() {
  const data = readAuthFile();
  if (!data) return null;
  const token = decryptToken(data.token);
  if (!token) return null;
  return {
    accessToken: token,
    clientId: data.clientId || null,
    user: data.user || null,
    savedAt: data.savedAt || null,
  };
}

function saveAuth({ accessToken, clientId, user }) {
  writeAuthFile({
    token: encryptToken(accessToken),
    clientId: clientId || null,
    user: user || null,
    savedAt: Date.now(),
  });
}

function clearAuth() {
  try {
    fs.unlinkSync(TOKEN_FILE());
  } catch {
    /* ignore */
  }
}

function installWebRequestHooks() {
  installCaptureHooksOnSession(session.defaultSession);
  installCaptureHooksOnSession(session.fromPartition('persist:sc-login'));

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['*://*.soundcloud.com/*', '*://*.sndcdn.com/*', '*://*/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      headers['Access-Control-Allow-Origin'] = ['*'];
      headers['Access-Control-Allow-Headers'] = ['*'];
      callback({ responseHeaders: headers });
    }
  );
}

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.webm']);
const crypto = require('crypto');

function scanAudioFiles(dir, out = [], depth = 0) {
  if (depth > 8 || out.length > 5000) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!ent.name.startsWith('.')) scanAudioFiles(full, out, depth + 1);
    } else if (ent.isFile() && AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) {
      let size;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = undefined;
      }
      out.push({ path: full, name: ent.name, size });
    }
  }
  return out;
}

function coversDir() {
  const dir = path.join(app.getPath('userData'), 'covers');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

/* ─── miura local profiles (no server) ─── */
const PROFILES_FILE = () => path.join(app.getPath('userData'), 'profiles.json');

function avatarsDir() {
  const dir = path.join(app.getPath('userData'), 'avatars');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

function emptyProfilesStore() {
  return { version: 1, activeId: null, profiles: [] };
}

function readProfilesStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROFILES_FILE(), 'utf8'));
    const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
    return {
      version: 1,
      activeId: raw.activeId ? String(raw.activeId) : null,
      profiles: profiles
        .filter((p) => p && p.id && p.displayName)
        .map((p) => ({
          id: String(p.id),
          displayName: String(p.displayName).trim().slice(0, 48) || 'User',
          avatarFile: p.avatarFile ? String(p.avatarFile) : null,
          bannerFile: p.bannerFile ? String(p.bannerFile) : null,
          bannerPosX: clampPct(p.bannerPosX, 50),
          bannerPosY: clampPct(p.bannerPosY, 50),
          bio: p.bio != null ? String(p.bio).trim().slice(0, 160) : '',
          accent: p.accent ? String(p.accent).trim().slice(0, 32) : null,
          createdAt: Number(p.createdAt) || Date.now(),
          lastUsedAt: Number(p.lastUsedAt) || Number(p.createdAt) || Date.now(),
        })),
    };
  } catch {
    return emptyProfilesStore();
  }
}

function writeProfilesStore(store) {
  const next = {
    version: 1,
    activeId: store.activeId ? String(store.activeId) : null,
    profiles: Array.isArray(store.profiles) ? store.profiles : [],
  };
  fs.writeFileSync(PROFILES_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function avatarMime(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function loadAvatarDataUrl(avatarFile, maxBytes = 2.5 * 1024 * 1024) {
  if (!avatarFile) return null;
  try {
    const full = path.join(avatarsDir(), path.basename(avatarFile));
    if (!fs.existsSync(full)) return null;
    const buf = fs.readFileSync(full);
    if (buf.length > maxBytes) return null;
    return `data:${avatarMime(full)};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function clampPct(v, fallback = 50) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function publicProfile(p) {
  return {
    id: p.id,
    displayName: p.displayName,
    avatarUrl: loadAvatarDataUrl(p.avatarFile),
    bannerUrl: loadAvatarDataUrl(p.bannerFile, 6 * 1024 * 1024),
    bannerPosX: clampPct(p.bannerPosX, 50),
    bannerPosY: clampPct(p.bannerPosY, 50),
    bio: p.bio ? String(p.bio) : '',
    accent: p.accent || null,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
  };
}

function profilesState() {
  const store = readProfilesStore();
  const profiles = store.profiles
    .slice()
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .map(publicProfile);
  const active = store.activeId
    ? profiles.find((p) => p.id === store.activeId) || null
    : null;
  return { active, profiles };
}

function copyAvatarForProfile(profileId, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
  const destName = `${profileId}${safeExt === '.jpeg' ? '.jpg' : safeExt}`;
  const dest = path.join(avatarsDir(), destName);
  // remove old avatars only (not banner-*)
  try {
    for (const f of fs.readdirSync(avatarsDir())) {
      if (f.startsWith(profileId + '.') && !f.startsWith('banner-')) {
        try {
          fs.unlinkSync(path.join(avatarsDir(), f));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  fs.copyFileSync(sourcePath, dest);
  return destName;
}

function copyBannerForProfile(profileId, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
  const destName = `banner-${profileId}${safeExt === '.jpeg' ? '.jpg' : safeExt}`;
  const dest = path.join(avatarsDir(), destName);
  try {
    for (const f of fs.readdirSync(avatarsDir())) {
      if (f.startsWith(`banner-${profileId}.`)) {
        try {
          fs.unlinkSync(path.join(avatarsDir(), f));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  fs.copyFileSync(sourcePath, dest);
  return destName;
}

/**
 * Clean "01_track_name_final" → "track name final"
 * and "Artist - Title_here" → { artist, title }.
 */
function parseFileNameMeta(fileName) {
  let base = String(fileName || '').replace(/\.[^.]+$/i, '');
  base = base.replace(/^\s*[(\[]?\d{1,3}[)\]]?\s*[.\-–—_)\]\s]+\s*/u, '');
  base = base.replace(/[_]+/g, ' ');
  base = base.replace(/\s*[-–—]\s*/g, ' - ');
  base = base.replace(/\s+/g, ' ').trim();
  if (!base) return { title: fileName, artist: null };
  const m = base.match(/^(.{1,80}?)\s+-\s+(.+)$/);
  if (m && m[2].trim()) {
    return { title: m[2].trim(), artist: m[1].trim() };
  }
  return { title: base, artist: null };
}

function prettyFileTitle(fileName) {
  return parseFileNameMeta(fileName).title;
}

function coverCachePath(filePath, ext) {
  const hash = crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 20);
  return path.join(coversDir(), hash + ext);
}

/** Re-load previously extracted cover as data: URL (no need to re-parse audio). */
function loadCachedCoverDataUrl(filePath) {
  try {
    for (const [ext, mime] of [
      ['.jpg', 'image/jpeg'],
      ['.png', 'image/png'],
      ['.webp', 'image/webp'],
    ]) {
      const out = coverCachePath(filePath, ext);
      if (!fs.existsSync(out)) continue;
      const data = fs.readFileSync(out);
      if (!data.length || data.length > 4 * 1024 * 1024) continue;
      if (data.length <= 900 * 1024) {
        return `data:${mime};base64,${data.toString('base64')}`;
      }
      return toMiuraFileUrl(out);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveCoverForTrack(filePath, picture) {
  if (!picture?.data) return null;
  try {
    const fmt = String(picture.format || 'image/jpeg').toLowerCase();
    const ext = fmt.includes('png') ? '.png' : fmt.includes('webp') ? '.webp' : '.jpg';
    const mime = fmt.includes('png')
      ? 'image/png'
      : fmt.includes('webp')
        ? 'image/webp'
        : fmt.includes('gif')
          ? 'image/gif'
          : 'image/jpeg';
    const out = coverCachePath(filePath, ext);
    const data = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data);
    // Skip absurdly large embeds
    if (data.length > 4 * 1024 * 1024) return null;
    fs.writeFileSync(out, data);
    // data: URL always works in <img> (miura-file can be flaky on Windows)
    if (data.length <= 900 * 1024) {
      return `data:${mime};base64,${data.toString('base64')}`;
    }
    return toMiuraFileUrl(out);
  } catch (e) {
    console.warn('[cover]', e);
    return null;
  }
}

/**
 * Read ID3/Vorbis/MP4 tags → title, artist, album, duration, cover.
 * music-metadata is ESM — load via dynamic import.
 */
let mmPromise = null;
async function getMusicMetadata() {
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}

function parentFolder(filePath) {
  try {
    return path.dirname(filePath);
  } catch {
    return null;
  }
}

function extractReplayGainDb(common, native) {
  // music-metadata: common.replaygain_track_gain.dB or ratio
  try {
    const rg = common?.replaygain_track_gain;
    if (rg && typeof rg.dB === 'number' && Number.isFinite(rg.dB)) return rg.dB;
    if (rg && typeof rg.ratio === 'number' && rg.ratio > 0) {
      return 20 * Math.log10(rg.ratio);
    }
  } catch {
    /* ignore */
  }
  // fallback: scan native tags for REPLAYGAIN_TRACK_GAIN
  try {
    const blobs = [];
    if (native && typeof native === 'object') {
      for (const k of Object.keys(native)) {
        const arr = native[k];
        if (Array.isArray(arr)) {
          for (const item of arr) {
            const id = String(item?.id || item?.key || k).toUpperCase();
            const val = String(item?.value ?? item?.data ?? '');
            if (id.includes('REPLAYGAIN_TRACK_GAIN') || id === 'TXXX:REPLAYGAIN_TRACK_GAIN') {
              const m = val.match(/([+-]?\d+(?:\.\d+)?)/);
              if (m) return parseFloat(m[1]);
            }
            blobs.push(val);
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractLyrics(common, native) {
  try {
    if (common?.lyrics) {
      if (typeof common.lyrics === 'string') return common.lyrics;
      if (Array.isArray(common.lyrics)) {
        return common.lyrics
          .map((x) => (typeof x === 'string' ? x : x?.text || ''))
          .filter(Boolean)
          .join('\n');
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (native && typeof native === 'object') {
      for (const k of Object.keys(native)) {
        const arr = native[k];
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          const id = String(item?.id || item?.key || k).toUpperCase();
          if (id === 'USLT' || id.includes('LYRICS') || id === '©LYR') {
            const v = item?.value ?? item?.text ?? item?.data;
            if (typeof v === 'string' && v.trim()) return v;
            if (v && typeof v === 'object' && v.text) return String(v.text);
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function enrichLocalTrack(entry) {
  const filePath = entry.path;
  const fileName = entry.name || path.basename(filePath);
  const fromFile = parseFileNameMeta(fileName);
  const folder = parentFolder(filePath);
  const base = {
    path: filePath,
    name: fileName,
    size: entry.size,
    url: entry.url || (typeof toMiuraFileUrl === 'function' ? toMiuraFileUrl(filePath) : undefined),
    title: fromFile.title,
    artist: fromFile.artist || 'Unknown',
    album: null,
    albumArtist: null,
    genre: null,
    year: null,
    trackNo: null,
    discNo: null,
    durationMs: null,
    artworkUrl: null,
    folder,
    rootFolder: entry.rootFolder || null,
    replayGainDb: null,
    lyrics: null,
    enriched: true,
  };
  try {
    const mm = await getMusicMetadata();
    const meta = await mm.parseFile(filePath, {
      duration: true,
      skipCovers: false,
      includeChapters: false,
    });
    const c = meta.common || {};
    const title = (c.title && String(c.title).trim()) || base.title;
    const artist =
      (c.artist && String(c.artist).trim()) ||
      (Array.isArray(c.artists) && c.artists.filter(Boolean).join(', ')) ||
      (c.albumartist && String(c.albumartist).trim()) ||
      base.artist;
    const album = c.album ? String(c.album).trim() : null;
    const albumArtist = c.albumartist ? String(c.albumartist).trim() : null;
    const genreRaw = Array.isArray(c.genre) ? c.genre.filter(Boolean).join(', ') : c.genre;
    const genre = genreRaw ? String(genreRaw).trim() : null;
    const year =
      typeof c.year === 'number' && Number.isFinite(c.year)
        ? c.year
        : c.date
          ? parseInt(String(c.date).slice(0, 4), 10) || null
          : null;
    const trackNo =
      c.track && typeof c.track.no === 'number' && Number.isFinite(c.track.no) ? c.track.no : null;
    const discNo =
      c.disk && typeof c.disk.no === 'number' && Number.isFinite(c.disk.no) ? c.disk.no : null;
    const durationMs =
      meta.format?.duration && Number.isFinite(meta.format.duration)
        ? Math.round(meta.format.duration * 1000)
        : null;
    let artworkUrl = null;
    const pic = Array.isArray(c.picture) && c.picture.length ? c.picture[0] : null;
    if (pic) artworkUrl = saveCoverForTrack(filePath, pic);
    const replayGainDb = extractReplayGainDb(c, meta.native);
    let lyrics = extractLyrics(c, meta.native);
    // Sidecar .lrc / .txt next to file
    if (!lyrics) {
      try {
        const stem = filePath.replace(/\.[^.]+$/, '');
        for (const ext of ['.lrc', '.txt', '.LRC', '.TXT']) {
          const lp = stem + ext;
          if (fs.existsSync(lp) && fs.statSync(lp).size < 200000) {
            lyrics = fs.readFileSync(lp, 'utf8');
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
    return {
      ...base,
      title,
      artist: artist || 'Unknown',
      album,
      albumArtist,
      genre,
      year: year && year > 1000 && year < 3000 ? year : null,
      trackNo,
      discNo,
      durationMs,
      artworkUrl,
      replayGainDb,
      lyrics: lyrics && String(lyrics).length < 20000 ? String(lyrics) : lyrics ? String(lyrics).slice(0, 20000) : null,
      enriched: true,
    };
  } catch (e) {
    console.warn('[meta]', fileName, e instanceof Error ? e.message : e);
    return base;
  }
}

async function enrichLocalTracks(list) {
  const out = [];
  // sequential is safer on large folders; small batches if needed
  for (const item of list) {
    out.push(await enrichLocalTrack(item));
  }
  return out;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#0a0a0b',
    title: 'miura',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Keep Google / Apple / SC OAuth popups usable
    if (/accounts\.google|apple\.com|soundcloud\.com/i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 740,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function broadcastMedia(cmd) {
  try {
    // Always the main player window only (mini is control surface, no audio)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('media-command', cmd);
    }
  } catch {
    /* ignore */
  }
}

/** Shared now-playing for mini player window */
let lastPlayerState = {
  title: 'miura',
  artist: '—',
  playing: false,
  artworkUrl: null,
};

function broadcastPlayerState(state) {
  lastPlayerState = { ...lastPlayerState, ...state };
  try {
    if (miniPlayerWin && !miniPlayerWin.isDestroyed()) {
      miniPlayerWin.webContents.send('player-state', lastPlayerState);
    }
  } catch {
    /* ignore */
  }
}

function setupMediaShortcuts() {
  const bind = (accel, cmd) => {
    try {
      globalShortcut.register(accel, () => broadcastMedia(cmd));
    } catch (e) {
      console.warn('[media] shortcut', accel, e);
    }
  };
  // Global media-style + common hotkeys when app not focused
  bind('MediaPlayPause', 'toggle');
  bind('MediaNextTrack', 'next');
  bind('MediaPreviousTrack', 'prev');
  bind('CommandOrControl+Shift+Space', 'toggle');
  bind('CommandOrControl+Shift+Right', 'next');
  bind('CommandOrControl+Shift+Left', 'prev');
}

function setupTray() {
  try {
    // 16x16 red circle PNG (minimal)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVQ4T2NkYGD4z0ABYBzVMKoBBgwMDIz/GUgFjIyM/0c1jGoAAMuoBQZqX7c0AAAAAElFTkSuQmCC',
      'base64'
    );
    const img = nativeImage.createFromBuffer(png);
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('miura');
    const menu = Menu.buildFromTemplate([
      {
        label: 'Play / Pause',
        click: () => broadcastMedia('toggle'),
      },
      {
        label: 'Next',
        click: () => broadcastMedia('next'),
      },
      {
        label: 'Previous',
        click: () => broadcastMedia('prev'),
      },
      { type: 'separator' },
      {
        label: 'Show miura',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (e) {
    console.warn('[tray]', e);
  }
}

function readCachedClientId() {
  try {
    const data = JSON.parse(fs.readFileSync(CLIENT_ID_FILE(), 'utf8'));
    const id = String(data.clientId || '').trim();
    return id.length >= 16 ? id : null;
  } catch {
    return null;
  }
}

function writeCachedClientId(id) {
  try {
    const clean = String(id || '').trim();
    if (clean.length < 16) return;
    fs.writeFileSync(
      CLIENT_ID_FILE(),
      JSON.stringify({ clientId: clean, savedAt: Date.now() }, null, 2),
      'utf8'
    );
    capture.clientId = clean;
  } catch {
    /* ignore */
  }
}

function getSessionFetch() {
  if (typeof session.defaultSession.fetch === 'function') {
    return session.defaultSession.fetch.bind(session.defaultSession);
  }
  return net.fetch.bind(net);
}

async function validateClientIdNet(id, fetchImpl) {
  if (!id || String(id).length < 16) return false;
  try {
    const url = `https://api-v2.soundcloud.com/search/tracks?q=test&client_id=${encodeURIComponent(id)}&limit=1`;
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': CHROME_UA,
        Referer: 'https://soundcloud.com/',
        Origin: 'https://soundcloud.com',
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function extractClientIdsFromText(text) {
  const out = new Set();
  if (!text) return out;
  const patterns = [
    /client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,40})["']/gi,
    /clientId["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,40})["']/gi,
    /["']client_id["']\s*:\s*["']([a-zA-Z0-9]{16,40})["']/gi,
    /[?&]client_id=([a-zA-Z0-9]{16,40})/gi,
  ];
  for (const re of patterns) {
    for (const m of String(text).matchAll(re)) {
      if (m[1]) out.add(m[1]);
    }
  }
  return out;
}

/** Scrape client_id from SC web assets using Chromium net (respects proxy). */
async function scrapeClientIdFromAssets(fetchImpl) {
  const pages = [
    'https://soundcloud.com/discover',
    'https://soundcloud.com/',
    'https://m.soundcloud.com/',
  ];
  const candidates = new Set();

  for (const page of pages) {
    try {
      const res = await fetchImpl(page, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': CHROME_UA,
        },
      });
      if (!res.ok) {
        console.warn('[client_id] page', page, res.status);
        continue;
      }
      const html = await res.text();
      for (const id of extractClientIdsFromText(html)) candidates.add(id);

      const scripts = [
        ...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
        ...html.matchAll(/src="(https:\/\/[^"]+\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
      ].map((m) => m[1]);

      for (const url of [...new Set(scripts)].slice(0, 28)) {
        try {
          const jsRes = await fetchImpl(url, {
            headers: { 'User-Agent': CHROME_UA, Accept: '*/*' },
          });
          if (!jsRes.ok) continue;
          const js = await jsRes.text();
          for (const id of extractClientIdsFromText(js)) candidates.add(id);
          if (candidates.size >= 8) break;
        } catch {
          /* skip asset */
        }
      }
      if (candidates.size) break;
    } catch (e) {
      console.warn('[client_id] scrape', page, e instanceof Error ? e.message : e);
    }
  }

  return [...candidates];
}

function captureClientIdViaHiddenWindow(timeoutMs = 22000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let win = null;
    const finish = (err, id) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(id);
    };

    win = new BrowserWindow({
      show: false,
      width: 420,
      height: 320,
      webPreferences: {
        session: session.defaultSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const poll = setInterval(() => {
      if (capture.clientId) finish(null, capture.clientId);
    }, 300);

    const timer = setTimeout(() => {
      finish(new Error('timeout-window'));
    }, timeoutMs);

    win.webContents.setUserAgent(CHROME_UA);
    win.loadURL('https://soundcloud.com/discover').catch((e) => finish(e));
  });
}

/**
 * Resolve a working SoundCloud client_id:
 * cache → auth.json → network capture → asset scrape → hidden window.
 */
async function resolveClientIdFromSoundCloud() {
  const fetchImpl = getSessionFetch();

  // 1) Live capture from any SC request already made
  if (capture.clientId && (await validateClientIdNet(capture.clientId, fetchImpl))) {
    writeCachedClientId(capture.clientId);
    return capture.clientId;
  }

  // 2) Disk cache
  const cached = readCachedClientId();
  if (cached && (await validateClientIdNet(cached, fetchImpl))) {
    capture.clientId = cached;
    return cached;
  }

  // 3) Saved next to OAuth session
  const auth = getStoredAuth();
  if (auth?.clientId && (await validateClientIdNet(auth.clientId, fetchImpl))) {
    writeCachedClientId(auth.clientId);
    return auth.clientId;
  }

  // 4) Scrape JS bundles via Chromium (proxy-aware)
  try {
    const scraped = await scrapeClientIdFromAssets(fetchImpl);
    console.log('[client_id] scraped candidates', scraped.length);
    for (const id of scraped) {
      if (await validateClientIdNet(id, fetchImpl)) {
        writeCachedClientId(id);
        console.log('[client_id] ok via scrape', id.slice(0, 8) + '…');
        return id;
      }
    }
  } catch (e) {
    console.warn('[client_id] scrape failed', e instanceof Error ? e.message : e);
  }

  // 5) Hidden window — last resort (network intercept)
  try {
    const id = await captureClientIdViaHiddenWindow(20000);
    if (id && (await validateClientIdNet(id, fetchImpl))) {
      writeCachedClientId(id);
      console.log('[client_id] ok via window', id.slice(0, 8) + '…');
      return id;
    }
    if (id) {
      // even if validation flaky, return captured (SC sometimes rate-limits search)
      writeCachedClientId(id);
      return id;
    }
  } catch (e) {
    console.warn('[client_id] window', e instanceof Error ? e.message : e);
  }

  // 6) Stale cache / capture as last hope
  if (capture.clientId) return capture.clientId;
  if (cached) return cached;
  if (auth?.clientId) return auth.clientId;

  throw new Error(
    'Не удалось получить client_id SoundCloud. Проверь прокси (Настройки → Сеть) или вставь client_id вручную в Настройки → Дополнительно.'
  );
}

function notifyRendererAuth(sessionData) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth-changed', sessionData);
      mainWindow.show();
      mainWindow.focus();
    }
  } catch {
    /* ignore */
  }
}

function buildAuthPageHtml(port) {
  const bookmarklet = `javascript:void((async()=>{try{let t=null;const dump=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);dump.push(localStorage.getItem(k)||'')}const blob=dump.join('\\n');const m=blob.match(/"access_token"\\s*:\\s*"([^"]+)"/)||blob.match(/oauth_token=([A-Za-z0-9._~\\-+/=]+)/)||blob.match(/"token"\\s*:\\s*"([0-9]+-[0-9A-Za-z-]+)"/);if(m)t=m[1];if(!t){const c=document.cookie||'';const cm=c.match(/(?:^|;\\\\s*)oauth_token=([^;]+)/);if(cm)t=decodeURIComponent(cm[1])}if(!t)t=prompt('Токен не найден сам.\\nСмотри инструкцию на странице входа miura (F12 → Network).\\nВставь сюда токен БЕЗ слова OAuth:');if(!t)return;t=String(t).replace(/^OAuth\\\\s+/i,'').trim();const r=await fetch('http://127.0.0.1:${port}/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})});const j=await r.json();alert(j.ok?('Готово! Вошли как '+(j.user||'')+' — вернись в miura'):('Ошибка: '+(j.error||r.status)))}catch(e){alert('Ошибка: '+e)}})();`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>miura · как войти</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; background: #0c0c0c; color: #e8e4dc;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      line-height: 1.5; padding: 28px 16px 48px;
    }
    .wrap { max-width: 640px; margin: 0 auto; }
    h1 {
      font-family: Georgia, serif; font-weight: 500; font-style: italic;
      font-size: 1.9rem; margin: 0 0 8px; letter-spacing: -0.03em;
    }
    .lead { color: #8a8680; margin: 0 0 28px; font-size: 1.05rem; }
    .step {
      border: 1px solid #2a2a2a; padding: 18px 18px 16px; margin-bottom: 14px;
      background: #111;
    }
    .step h2 {
      margin: 0 0 10px; font-size: 1rem; font-weight: 650;
      display: flex; align-items: center; gap: 10px;
    }
    .n {
      display: inline-grid; place-items: center; width: 28px; height: 28px;
      border-radius: 50%; background: #c8f06c; color: #0c0c0c;
      font-size: 0.85rem; font-weight: 700; flex-shrink: 0;
    }
    .step p, .step li { color: #c8c4bc; margin: 0 0 8px; font-size: 0.98rem; }
    .step ul, .step ol { margin: 8px 0 0; padding-left: 1.2em; color: #c8c4bc; }
    .step li { margin-bottom: 6px; }
    .hl {
      background: #1a1a12; border-left: 3px solid #c8f06c;
      padding: 10px 12px; margin: 10px 0; font-size: 0.95rem; color: #e8e4dc;
    }
    .fake {
      font-family: ui-monospace, Consolas, monospace; font-size: 0.82rem;
      background: #0a0a0a; border: 1px solid #333; padding: 12px; margin: 10px 0;
      color: #9ab; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
    }
    .fake b { color: #c8f06c; }
    a.btn, button.btn {
      display: inline-block; font-family: ui-monospace, Consolas, monospace;
      font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase;
      text-decoration: none; border: 1px solid #c8f06c; background: #c8f06c;
      color: #0c0c0c; padding: 12px 16px; cursor: pointer; margin: 4px 8px 4px 0;
      font-weight: 700;
    }
    a.btn.ghost, button.btn.ghost {
      background: transparent; color: #e8e4dc; border-color: #444; font-weight: 500;
    }
    label {
      display: block; font-size: 0.75rem; letter-spacing: 0.08em;
      text-transform: uppercase; color: #666; margin: 8px 0;
    }
    input {
      width: 100%; background: #0a0a0a; border: 1px solid #333; color: #e8e4dc;
      padding: 14px 12px; font-size: 1rem; outline: none;
    }
    input:focus { border-color: #c8f06c; }
    .msg { margin-top: 12px; font-size: 0.95rem; min-height: 1.3em; }
    .msg.ok { color: #c8f06c; } .msg.err { color: #e07070; }
    .warn {
      margin-top: 20px; padding: 14px; border: 1px solid #443; background: #16140e;
      color: #c8b88a; font-size: 0.9rem;
    }
    kbd {
      font-family: ui-monospace, Consolas, monospace; font-size: 0.85rem;
      background: #222; border: 1px solid #444; border-bottom-width: 2px;
      padding: 1px 6px; border-radius: 4px; color: #eee;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>как войти — очень просто</h1>
    <p class="lead">Нужно скопировать «ключ входа» из Chrome и вставить сюда. Ниже — по шагам, как для полного новичка.</p>

    <div class="step">
      <h2><span class="n">1</span> Открой SoundCloud и войди</h2>
      <p>Нажми кнопку. Если попросит логин — войди как обычно. VPN/прокси должны быть включены.</p>
      <a class="btn" href="https://soundcloud.com" target="_blank" rel="noreferrer">открыть soundcloud.com</a>
    </div>

    <div class="step">
      <h2><span class="n">2</span> Открой инструменты разработчика (F12)</h2>
      <p>На странице SoundCloud нажми клавишу <kbd>F12</kbd>.</p>
      <p>Если не сработало:</p>
      <ul>
        <li><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd></li>
        <li>или правой кнопкой по странице → «Просмотреть код» / Inspect</li>
      </ul>
      <p>Справа или снизу появится тёмная панель. Это нормально.</p>
    </div>

    <div class="step">
      <h2><span class="n">3</span> Вкладка Network (Сеть)</h2>
      <p>В этой панели вверху есть вкладки: Elements, Console, <b>Network</b>, …</p>
      <p>Нажми на <b>Network</b> (по-русски часто «Сеть»).</p>
      <div class="hl">Если список пустой — просто обнови страницу SoundCloud клавишей <kbd>F5</kbd>, список заполнится.</div>
    </div>

    <div class="step">
      <h2><span class="n">4</span> Найди строку с api-v2</h2>
      <p>Вверху у Network есть поле фильтра (Filter). Впиши туда:</p>
      <div class="fake">api-v2</div>
      <p>В списке появятся запросы. Кликни <b>любой</b> из них (один раз левой кнопкой).</p>
      <p>Если ничего нет — нажми <kbd>F5</kbd> ещё раз, потом кликни любой трек «play» на сайте и снова смотри список.</p>
    </div>

    <div class="step">
      <h2><span class="n">5</span> Найди слово Authorization</h2>
      <p>После клика справа откроются детали. Пролистай до раздела <b>Request Headers</b> (Заголовки запроса).</p>
      <p>Ищи строку примерно такую:</p>
      <div class="fake">authorization: <b>OAuth 2-123456-9876543210-abcdef…</b></div>
      <p><b>Что копировать:</b></p>
      <ul>
        <li>можно всю строку после <code>OAuth</code></li>
        <li>или вместе с <code>OAuth</code> — приложение само обрежет</li>
        <li>обычно токен начинается с цифры и дефисов, например <code>2-351234-…</code></li>
      </ul>
      <p>Выдели токен мышью → <kbd>Ctrl</kbd>+<kbd>C</kbd>.</p>
    </div>

    <div class="step">
      <h2><span class="n">6</span> Вставь сюда и отправь</h2>
      <label for="tok">поле для токена</label>
      <input id="tok" type="text" placeholder="вставь сюда (Ctrl+V)" spellcheck="false" autocomplete="off" />
      <div style="margin-top:12px">
        <button class="btn" type="button" id="send">отправить в miura</button>
      </div>
      <p class="msg" id="msg"></p>
      <p style="margin-top:12px;color:#8a8680;font-size:0.9rem">
        Если написало «готово» — просто вернись в окно miura. Ты уже должен быть в аккаунте.
      </p>
    </div>

    <div class="warn">
      <b>Не получается найти Authorization?</b><br/>
      1) Убедись, что ты <b>залогинен</b> на SoundCloud (аватарка видна).<br/>
      2) В Network включи фильтр <code>api-v2</code> и нажми <kbd>F5</kbd>.<br/>
      3) Кликни именно запрос, где в колонке Name есть <code>me</code> или <code>tracks</code> или <code>stream</code>.<br/>
      4) Смотри блок <b>Request Headers</b>, не Response.
    </div>
  </div>
  <script>
    const msg = document.getElementById('msg');
    async function sendToken(raw) {
      msg.className = 'msg';
      msg.textContent = 'проверяю токен…';
      try {
        const token = String(raw || '').replace(/^OAuth\\s+/i, '').trim();
        if (!token) throw new Error('Сначала вставь токен в поле выше');
        if (token.length < 15) throw new Error('Слишком короткий — похоже, скопировал не всё');
        const r = await fetch('/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'ошибка сервера');
        msg.className = 'msg ok';
        msg.textContent = '✓ Готово! Вошли как ' + (j.user || 'ok') + '. Вернись в miura.';
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = '✗ ' + (e.message || String(e));
      }
    }
    document.getElementById('send').onclick = () => sendToken(document.getElementById('tok').value);
    document.getElementById('tok').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendToken(e.target.value);
    });
  </script>
</body>
</html>`;
}

function ensureAuthServer() {
  return new Promise((resolve, reject) => {
    if (authServer && authServerPort) {
      resolve(authServerPort);
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);

      // CORS for bookmarklet from soundcloud.com
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildAuthPageHtml(authServerPort));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 50_000) req.destroy();
        });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const token = String(data.token || data.accessToken || '')
              .replace(/^OAuth\s+/i, '')
              .trim();
            if (!token) throw new Error('token required');

            const cfg = readProxyConfig();
            await applyProxyConfig({
              enabled: cfg.enabled !== false,
              mode: 'all',
              url: (cfg.url || DEFAULT_PROXY.url).trim() || DEFAULT_PROXY.url,
            });

            const doFetch =
              typeof session.defaultSession.fetch === 'function'
                ? session.defaultSession.fetch.bind(session.defaultSession)
                : net.fetch.bind(net);

            const auth = await validateAndSaveToken(token, data.clientId || capture.clientId, doFetch);
            notifyRendererAuth(auth);

            if (pendingBrowserLogin) {
              const p = pendingBrowserLogin;
              pendingBrowserLogin = null;
              clearTimeout(p.timer);
              p.resolve(auth);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, user: auth?.user?.username || null }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      authServerPort = typeof addr === 'object' && addr ? addr.port : 0;
      authServer = server;
      console.log('[auth] local server http://127.0.0.1:' + authServerPort);
      resolve(authServerPort);
    });
    server.on('error', reject);
  });
}

/** Ensure proxy is applied before SC login / token validation. */
async function ensureLoginProxy() {
  const cfg = readProxyConfig();
  try {
    await applyProxyConfig({
      enabled: cfg.enabled !== false,
      mode: 'all',
      url: (cfg.url || DEFAULT_PROXY.url).trim() || DEFAULT_PROXY.url,
    });
  } catch (e) {
    console.warn('[login] proxy', e);
  }
}

function cancelPendingLogin(reason) {
  if (!pendingBrowserLogin) return;
  clearTimeout(pendingBrowserLogin.timer);
  if (pendingBrowserLogin.cleanup) {
    try {
      pendingBrowserLogin.cleanup();
    } catch {
      /* ignore */
    }
  }
  pendingBrowserLogin.reject(new Error(reason || 'Новый запрос входа'));
  pendingBrowserLogin = null;
}

/**
 * Try to pull OAuth token from a BrowserWindow page (cookies / storage).
 */
async function scrapeTokenFromWebContents(wc) {
  if (!wc || wc.isDestroyed()) return null;
  try {
    const token = await wc.executeJavaScript(
      `(() => {
        try {
          const fromCookie = (document.cookie || '').match(/(?:^|;\\s*)oauth_token=([^;]+)/);
          if (fromCookie) return decodeURIComponent(fromCookie[1]);

          const dig = (store) => {
            try {
              for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                const v = store.getItem(k) || '';
                const m =
                  v.match(/"access_token"\\s*:\\s*"([^"]+)"/) ||
                  v.match(/"oauth_token"\\s*:\\s*"([^"]+)"/) ||
                  v.match(/oauth_token[=:]["']?([0-9]+-[0-9A-Za-z._~\\-+/=-]+)/) ||
                  v.match(/"token"\\s*:\\s*"([0-9]+-[0-9A-Za-z-]+)"/);
                if (m && m[1] && m[1].length > 12) return m[1];
                if (k && /oauth|access.?token|auth/i.test(k) && v.length > 20 && v.length < 400) {
                  const bare = v.replace(/^OAuth\\s+/i, '').replace(/^"|"$/g, '');
                  if (/^[0-9]+-[0-9A-Za-z-]+/.test(bare)) return bare;
                }
              }
            } catch (e) {}
            return null;
          };

          return dig(localStorage) || dig(sessionStorage) || null;
        } catch (e) {
          return null;
        }
      })()`,
      true
    );
    if (token && typeof token === 'string' && token.length > 12) {
      return token.replace(/^OAuth\s+/i, '').trim();
    }
  } catch {
    /* cross-origin / destroyed */
  }
  return null;
}

async function scrapeTokenFromCookies(ses) {
  try {
    const names = ['oauth_token', 'oauth_token_refresh'];
    for (const domain of ['.soundcloud.com', 'soundcloud.com', 'api-v2.soundcloud.com', 'api.soundcloud.com']) {
      for (const name of names) {
        const list = await ses.cookies.get({ domain, name });
        for (const c of list) {
          if (c?.value && c.value.length > 12 && name === 'oauth_token') {
            return c.value.replace(/^OAuth\s+/i, '').trim();
          }
        }
      }
    }
    // broader scan
    const all = await ses.cookies.get({ domain: '.soundcloud.com' });
    for (const c of all) {
      if (c.name === 'oauth_token' && c.value && c.value.length > 12) {
        return c.value.replace(/^OAuth\s+/i, '').trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function getAuthFetch() {
  return typeof session.defaultSession.fetch === 'function'
    ? session.defaultSession.fetch.bind(session.defaultSession)
    : net.fetch.bind(net);
}

const SC_BLOCK_RE =
  /временно ограничен|access is temporarily|temporarily (limited|blocked|restricted)|too many requests|rate.?limit|unusual activity|подозрительн|доступ ограничен|try again later|cloudflare|cf-browser-verification|just a moment/i;

async function pageLooksBlocked(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    return await wc.executeJavaScript(
      `(() => {
        try {
          const t = (document.body && document.body.innerText) || '';
          const title = document.title || '';
          const re = /временно ограничен|access is temporarily|temporarily (limited|blocked|restricted)|too many requests|rate.?limit|unusual activity|подозрительн|доступ ограничен|try again later|just a moment|attention required/i;
          return re.test(t) || re.test(title);
        } catch (e) { return false; }
      })()`,
      true
    );
  } catch {
    return false;
  }
}

async function injectLoginHelpBanner(wc, port) {
  if (!wc || wc.isDestroyed()) return;
  const helper = port ? `http://127.0.0.1:${port}/login` : '';
  try {
    await wc.executeJavaScript(
      `(() => {
        if (document.getElementById('miura-login-help')) return;
        const bar = document.createElement('div');
        bar.id = 'miura-login-help';
        bar.style.cssText = 'position:fixed;z-index:2147483647;left:0;right:0;bottom:0;padding:12px 14px;background:#111;color:#eee;font:13px/1.4 system-ui,sans-serif;border-top:1px solid #333;display:flex;flex-wrap:wrap;gap:8px;align-items:center;';
        bar.innerHTML = '<span style="flex:1;min-width:180px">miura: если «доступ ограничен» — очисти cookies или войди через Chrome.</span>';
        const mk = (label, id) => {
          const b = document.createElement('button');
          b.id = id;
          b.textContent = label;
          b.style.cssText = 'border:0;border-radius:999px;padding:8px 12px;font-weight:600;cursor:pointer;background:#fc3c44;color:#fff';
          return b;
        };
        const b1 = mk('Очистить cookies', 'miura-clear');
        const b2 = mk('Браузер', 'miura-browser');
        bar.appendChild(b1);
        bar.appendChild(b2);
        document.documentElement.appendChild(bar);
        b1.onclick = () => { location.href = 'miura-login://clear'; };
        b2.onclick = () => { location.href = 'miura-login://browser'; };
      })()`,
      true
    );
    void helper;
  } catch {
    /* ignore */
  }
}

/**
 * In-app SoundCloud sign-in: BrowserWindow + automatic token capture.
 * Google/Apple open as real popups (same partition). On SC block → clear cookies / browser fallback.
 */
async function openInAppLogin() {
  try {
    await ensureLoginProxy();
  } catch (e) {
    console.warn('[login] proxy ensure failed, continue', e);
  }
  cancelPendingLogin('Новый запрос входа');

  capture.loginActive = true;
  capture.token = null;

  const loginSes = session.fromPartition('persist:sc-login');
  // Re-apply proxy to login partition (sometimes drops after clear)
  try {
    const cfg = readProxyConfig();
    await applyProxyToSession(loginSes, {
      enabled: cfg.enabled !== false,
      mode: 'all',
      url: (cfg.url || DEFAULT_PROXY.url).trim() || DEFAULT_PROXY.url,
    });
  } catch {
    /* ignore */
  }

  if (loginWindow && !loginWindow.isDestroyed()) {
    try {
      loginWindow.close();
    } catch {
      /* ignore */
    }
    loginWindow = null;
  }

  loginWindow = new BrowserWindow({
    width: 540,
    height: 780,
    minWidth: 400,
    minHeight: 560,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    title: 'miura — вход в SoundCloud',
    webPreferences: {
      session: loginSes,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  hardenBrowserFingerprint(loginWindow.webContents);

  // Google/Apple/Facebook MUST be real popups — same-window loadURL breaks OAuth & triggers blocks
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/accounts\.google|appleid\.apple|facebook\.com|fb\.com|login\.live|oauth/i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 740,
          autoHideMenuBar: true,
          parent: loginWindow || undefined,
          webPreferences: {
            session: loginSes,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    }
    if (/soundcloud\.com/i.test(url)) {
      void loginWindow.loadURL(url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  loginWindow.once('ready-to-show', () => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.show();
      loginWindow.focus();
    }
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let finishing = false;
    let blockedNotified = false;
    const childWindows = new Set();

    const cleanup = () => {
      capture.loginActive = false;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        loginSes.cookies.removeListener('changed', onCookieChanged);
      } catch {
        /* ignore */
      }
      for (const w of childWindows) {
        try {
          if (w && !w.isDestroyed()) w.close();
        } catch {
          /* ignore */
        }
      }
      childWindows.clear();
      if (loginWindow && !loginWindow.isDestroyed()) {
        try {
          loginWindow.removeAllListeners('closed');
          loginWindow.close();
        } catch {
          /* ignore */
        }
      }
      loginWindow = null;
    };

    const finishOk = async (token, source) => {
      if (settled || finishing) return;
      finishing = true;
      const clean = String(token || '')
        .replace(/^OAuth\s+/i, '')
        .trim();
      if (!clean || clean.length < 12) {
        finishing = false;
        return;
      }
      console.log('[login] token captured via', source);
      try {
        const auth = await validateAndSaveToken(clean, capture.clientId, getAuthFetch());
        settled = true;
        cleanup();
        if (pendingBrowserLogin === handle) pendingBrowserLogin = null;
        notifyRendererAuth(auth);
        resolve(auth);
      } catch (e) {
        finishing = false;
        console.warn('[login] validate failed', e);
        // keep window open so user can retry / re-login
      }
    };

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pendingBrowserLogin === handle) pendingBrowserLogin = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const tryHarvest = async (source) => {
      if (settled || finishing) return;
      if (capture.token) {
        await finishOk(capture.token, source || 'network');
        return;
      }
      const fromCookies = await scrapeTokenFromCookies(loginSes);
      if (fromCookies) {
        await finishOk(fromCookies, 'cookies');
        return;
      }
      if (loginWindow && !loginWindow.isDestroyed()) {
        const fromPage = await scrapeTokenFromWebContents(loginWindow.webContents);
        if (fromPage) {
          await finishOk(fromPage, 'page-storage');
        }
      }
    };

    const onCookieChanged = (_event, cookie, _cause, removed) => {
      if (removed || settled) return;
      if (cookie?.name === 'oauth_token' && cookie.value) {
        capture.token = cookie.value;
        void tryHarvest('cookie-event');
      }
    };
    loginSes.cookies.on('changed', onCookieChanged);

    const poll = setInterval(() => {
      void tryHarvest('poll');
    }, 700);

    const timer = setTimeout(() => {
      finishErr(
        new Error(
          'Время входа истекло (10 мин). SoundCloud часто режет встроенное окно — используй «вход через браузер» в Настройках (запасной вход).'
        )
      );
    }, 10 * 60 * 1000);

    const handle = { resolve, reject, timer, cleanup };
    pendingBrowserLogin = handle;

    const clearLoginStorage = async () => {
      try {
        await loginSes.clearStorageData({
          storages: ['cookies', 'localstorage', 'cachestorage', 'indexdb', 'serviceworkers'],
        });
        capture.token = null;
        console.log('[login] cleared sc-login partition');
      } catch (e) {
        console.warn('[login] clear storage', e);
      }
    };

    const switchToBrowser = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pendingBrowserLogin === handle) pendingBrowserLogin = null;
      try {
        const auth = await openBrowserLogin();
        resolve(auth);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };

    loginWindow.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('miura-login://clear')) {
        event.preventDefault();
        void (async () => {
          await clearLoginStorage();
          if (loginWindow && !loginWindow.isDestroyed()) {
            await loginWindow.loadURL('https://soundcloud.com/signin?miura=1');
          }
        })();
      } else if (url.startsWith('miura-login://browser')) {
        event.preventDefault();
        void switchToBrowser();
      }
    });

    // Track OAuth child windows (Google/Apple) for harvest + fingerprint
    loginWindow.webContents.on('did-create-window', (child) => {
      if (settled) return;
      try {
        childWindows.add(child);
        hardenBrowserFingerprint(child.webContents);
        child.on('closed', () => childWindows.delete(child));
        child.webContents.on('did-finish-load', () => {
          void tryHarvest('child-load');
        });
      } catch {
        /* ignore */
      }
    });

    loginWindow.on('closed', () => {
      loginWindow = null;
      if (!settled) {
        settled = true;
        capture.loginActive = false;
        clearInterval(poll);
        clearTimeout(timer);
        try {
          loginSes.cookies.removeListener('changed', onCookieChanged);
        } catch {
          /* ignore */
        }
        if (pendingBrowserLogin === handle) pendingBrowserLogin = null;
        reject(
          new Error(
            'Окно входа закрыто. Если SC писал «доступ ограничен» — Настройки → запасной вход через браузер.'
          )
        );
      }
    });

    const onLoaded = async () => {
      void tryHarvest('load');
      if (!loginWindow || loginWindow.isDestroyed()) return;
      const blocked = await pageLooksBlocked(loginWindow.webContents);
      if (blocked && !blockedNotified) {
        blockedNotified = true;
        console.warn('[login] SC block page detected');
        try {
          const port = await ensureAuthServer();
          await injectLoginHelpBanner(loginWindow.webContents, port);
        } catch {
          /* ignore */
        }
      } else {
        try {
          const port = await ensureAuthServer();
          await injectLoginHelpBanner(loginWindow.webContents, port);
        } catch {
          /* ignore */
        }
      }
    };

    loginWindow.webContents.on('did-navigate', () => {
      void tryHarvest('navigate');
    });
    loginWindow.webContents.on('did-navigate-in-page', () => {
      void tryHarvest('navigate-in-page');
    });
    loginWindow.webContents.on('did-finish-load', () => {
      void onLoaded();
    });

    void loginWindow.loadURL('https://soundcloud.com/signin').catch((e) => {
      finishErr(e);
    });
  });
}

/**
 * Fallback: system browser + local helper page (manual token paste).
 */
async function openBrowserLogin() {
  const port = await ensureAuthServer();
  const helperUrl = `http://127.0.0.1:${port}/login`;

  await ensureLoginProxy();
  cancelPendingLogin('Новый запрос входа');

  await shell.openExternal(helperUrl);
  setTimeout(() => {
    void shell.openExternal('https://soundcloud.com/signin');
  }, 600);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingBrowserLogin) {
        pendingBrowserLogin = null;
        reject(
          new Error(
            'Время входа истекло (10 мин). Вставь токен на странице http://127.0.0.1:' +
              port +
              '/login или попробуй вход внутри приложения.'
          )
        );
      }
    }, 10 * 60 * 1000);

    pendingBrowserLogin = { resolve, reject, timer, cleanup: null };
  });
}

function mimeForAudio(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mp3': 'audio/mpeg',
    '.mpeg': 'audio/mpeg',
    '.mpga': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.wave': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
    // wma often unsupported in Chromium — still serve with a type
    '.wma': 'audio/x-ms-wma',
  };
  return map[ext] || 'application/octet-stream';
}

/** miura-file:// (or legacy miu-file://) → absolute filesystem path */
function filePathFromMiuraUrl(requestUrl) {
  const raw = String(requestUrl || '');
  // Convert custom scheme → file: so Node can parse Windows drives & encoding
  const asFile = raw.replace(/^miura-file:/i, 'file:').replace(/^miu-file:/i, 'file:');
  try {
    return fileURLToPath(asFile);
  } catch {
    /* fall through */
  }
  let s = raw.replace(/^miura-file:/i, '').replace(/^miu-file:/i, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }
  // ///C:/Users/... or //C:/Users or /C:/Users
  s = s.replace(/^\/+/, '');
  if (process.platform === 'win32') {
    s = s.replace(/\//g, path.sep);
  } else if (!s.startsWith('/')) {
    s = '/' + s;
  }
  return s;
}

function registerLocalFileProtocol(scheme) {
  try {
    const ok = protocol.registerFileProtocol(scheme, (request, callback) => {
      try {
        const filePath = filePathFromMiuraUrl(request.url);
        if (!filePath || !fs.existsSync(filePath)) {
          console.warn(`[${scheme}] missing`, filePath, '←', request.url);
          callback({ error: -6 });
          return;
        }
        callback({ path: path.normalize(filePath) });
      } catch (e) {
        console.warn(`[${scheme}]`, request.url, e);
        callback({ error: -2 });
      }
    });
    if (!ok) {
      protocol.handle(scheme, (request) => {
        const filePath = filePathFromMiuraUrl(request.url);
        if (!fs.existsSync(filePath)) {
          return new Response('not found', { status: 404 });
        }
        return net.fetch(pathToFileURL(filePath).href);
      });
    }
    console.log(`[${scheme}] protocol ready`);
  } catch (e) {
    console.warn(`[${scheme}] protocol`, e);
  }
}

/** Absolute path → miura-file URL (same encoding as pathToFileURL) */
function toMiuraFileUrl(absPath) {
  const resolved = path.resolve(String(absPath));
  return pathToFileURL(resolved).href.replace(/^file:/i, 'miura-file:');
}

/** Same partition as the hidden YT browser — cookies + proxy for googlevideo. */
const YT_RESOLVE_PARTITION = 'persist:miura-yt-resolve';

function getYtResolveSession() {
  return session.fromPartition(YT_RESOLVE_PARTITION);
}

/**
 * googlevideo often 403s from defaultSession. Proxy through the YT resolve
 * partition (cookies from the hidden browser) via miura-yt://.
 */
function wrapYtStreamForPlayer(url, mime) {
  const u = String(url || '');
  if (!/^https:\/\//i.test(u)) return u;
  if (/miura-yt:/i.test(u)) return u;
  // HLS playlists need segment fetches — leave for hls.js / yt-fetch path
  if (/\.m3u8(\?|$)/i.test(u) || /mpegURL|application\/vnd\.apple/i.test(String(mime || ''))) {
    return u;
  }
  const q = new URLSearchParams();
  q.set('u', u);
  if (mime) q.set('m', String(mime).split(';')[0].trim());
  return `miura-yt://play/?${q.toString()}`;
}

/** Quick Range probe so we don't hand the player a 403 URL. */
async function probeYtMediaUrl(url, ses) {
  try {
    const doFetch =
      typeof ses.fetch === 'function' ? ses.fetch.bind(ses) : net.fetch.bind(net);
    const res = await doFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': CHROME_UA,
        Referer: 'https://www.youtube.com/',
        Origin: 'https://www.youtube.com',
        Accept: '*/*',
        Range: 'bytes=0-2047',
      },
      bypassCustomProtocolHandlers: true,
    });
    if (res.ok || res.status === 206) {
      try {
        // drain a bit so connection isn't left hanging
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      return true;
    }
    console.warn('[yt-resolve] probe fail', res.status, url.slice(0, 72));
    return false;
  } catch (e) {
    console.warn('[yt-resolve] probe err', e?.message || e);
    return false;
  }
}

function registerYtMediaProtocol() {
  try {
    protocol.handle('miura-yt', async (request) => {
      try {
        const parsed = new URL(request.url);
        const target = parsed.searchParams.get('u');
        if (!target || !/^https:\/\//i.test(target)) {
          return new Response('bad yt url', { status: 400 });
        }
        const mimeHint = parsed.searchParams.get('m') || '';
        const headers = {
          'User-Agent': CHROME_UA,
          Referer: 'https://www.youtube.com/',
          Origin: 'https://www.youtube.com',
          Accept: '*/*',
        };
        try {
          const range =
            request.headers?.get?.('Range') ||
            request.headers?.get?.('range') ||
            null;
          if (range) headers.Range = range;
        } catch {
          /* ignore */
        }

        // MUST use the same partition as the hidden browser (not defaultSession)
        const ses = getYtResolveSession();
        try {
          const cfg = readProxyConfig();
          await applyProxyToSession(ses, cfg);
        } catch {
          /* already applied */
        }

        const doFetch =
          typeof ses.fetch === 'function' ? ses.fetch.bind(ses) : net.fetch.bind(net);
        let res = await doFetch(target, {
          method: 'GET',
          headers,
          bypassCustomProtocolHandlers: true,
        });

        // Fallback: defaultSession (sometimes CDN is happier there)
        if (!res.ok && res.status !== 206) {
          console.warn('[miura-yt] yt-ses', res.status, '→ try defaultSession');
          try {
            await res.arrayBuffer();
          } catch {
            /* ignore */
          }
          const def = session.defaultSession;
          res = await (typeof def.fetch === 'function' ? def.fetch.bind(def) : net.fetch.bind(net))(
            target,
            { method: 'GET', headers, bypassCustomProtocolHandlers: true }
          );
        }

        const out = new Headers();
        const ct =
          res.headers.get('Content-Type') ||
          res.headers.get('content-type') ||
          mimeHint ||
          'audio/mp4';
        out.set('Content-Type', ct);
        const cl = res.headers.get('Content-Length') || res.headers.get('content-length');
        if (cl) out.set('Content-Length', cl);
        const cr = res.headers.get('Content-Range') || res.headers.get('content-range');
        if (cr) out.set('Content-Range', cr);
        const ar = res.headers.get('Accept-Ranges') || res.headers.get('accept-ranges');
        out.set('Accept-Ranges', ar || 'bytes');
        out.set('Access-Control-Allow-Origin', '*');

        if (!res.ok && res.status !== 206) {
          const preview = await res.text().catch(() => '');
          console.warn(
            '[miura-yt] upstream',
            res.status,
            target.slice(0, 80),
            preview.slice(0, 120)
          );
          return new Response(preview || `upstream ${res.status}`, { status: res.status });
        }

        return new Response(res.body, { status: res.status, headers: out });
      } catch (e) {
        console.error('[miura-yt]', e);
        return new Response(e instanceof Error ? e.message : String(e), { status: 502 });
      }
    });
    console.log('[miura-yt] protocol ready');
  } catch (e) {
    console.warn('[miura-yt] protocol', e);
  }
}

app.whenReady().then(async () => {
  // Local files for <audio src="miura-file://..."> (+ legacy miu-file)
  registerLocalFileProtocol('miura-file');
  registerLocalFileProtocol('miu-file');
  registerYtMediaProtocol();

  // Optional Castlabs Widevine (only if someone swaps electron for ECS).
  // Default GitHub build uses stock Electron — open streams only.
  try {
    const { components } = require('electron');
    if (components && typeof components.whenReady === 'function') {
      console.log('[widevine] optional CDM present, waiting…');
      await components.whenReady();
      console.log('[widevine] ready');
    }
  } catch {
    /* stock electron — expected */
  }

  // Ensure default local proxy is saved + applied before any SoundCloud traffic
  try {
    let cfg = readProxyConfig();
    // First run / empty config → force local 127.0.0.1:12334
    if (!cfg.url) {
      cfg = { ...DEFAULT_PROXY };
    }
    // Persist so UI shows the same values
    if (!fs.existsSync(PROXY_FILE())) {
      writeProxyConfig(cfg);
    }
    await applyProxyConfig(cfg);
    console.log('[proxy] applied', cfg.enabled ? cfg.url : 'direct');
  } catch (e) {
    console.warn('proxy apply failed', e);
  }

  installWebRequestHooks();

  ipcMain.handle('resolve-client-id', async () => resolveClientIdFromSoundCloud());
  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.handle('local-pick-files', async () => {
    try {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const r = await dialog.showOpenDialog(win, {
        title: 'miura — add audio files',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Audio',
            extensions: ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'aiff', 'aif', 'webm'],
          },
          { name: 'All', extensions: ['*'] },
        ],
      });
      if (r.canceled) return [];
      const basic = r.filePaths.map((p) => {
        let size;
        try {
          size = fs.statSync(p).size;
        } catch {
          size = undefined;
        }
        let url;
        try {
          url = toMiuraFileUrl(p);
        } catch {
          url = undefined;
        }
        return { path: p, name: path.basename(p), size, url };
      });
      // ID3 title/artist/cover
      return await enrichLocalTracks(basic);
    } catch (e) {
      console.error('[local-pick-files]', e);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('local-pick-folder', async () => {
    try {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const r = await dialog.showOpenDialog(win, {
        title: 'miura — add music folder',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return [];
      const root = r.filePaths[0];
      const basic = scanAudioFiles(root).map((f) => {
        let url;
        try {
          url = toMiuraFileUrl(f.path);
        } catch {
          url = undefined;
        }
        return { ...f, url, rootFolder: root, folder: path.dirname(f.path) };
      });
      return await enrichLocalTracks(basic);
    } catch (e) {
      console.error('[local-pick-folder]', e);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Re-read tags for paths already in the library */
  ipcMain.handle('local-enrich-meta', async (_e, paths) => {
    try {
      const list = (Array.isArray(paths) ? paths : [])
        .filter(Boolean)
        .map((p) => ({ path: String(p), name: path.basename(String(p)) }));
      return await enrichLocalTracks(list);
    } catch (e) {
      console.error('[local-enrich-meta]', e);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Fast cover re-hydrate from disk cache (by audio file path). */
  ipcMain.handle('local-cover-for-path', async (_e, filePath) => {
    try {
      const p = String(filePath || '');
      if (!p) return { ok: false, error: 'empty' };
      const dataUrl = loadCachedCoverDataUrl(p);
      if (!dataUrl) return { ok: false, error: 'no cover' };
      return { ok: true, dataUrl };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Show file in OS file manager */
  ipcMain.handle('local-reveal-in-folder', async (_e, filePath) => {
    try {
      const p = path.resolve(String(filePath || ''));
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'not found' };
      shell.showItemInFolder(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Check which paths are missing on disk */
  ipcMain.handle('local-check-missing', async (_e, paths) => {
    try {
      const list = Array.isArray(paths) ? paths : [];
      const missing = [];
      const present = [];
      for (const raw of list) {
        const p = String(raw || '');
        if (!p) continue;
        try {
          if (fs.existsSync(path.resolve(p))) present.push(p);
          else missing.push(p);
        } catch {
          missing.push(p);
        }
      }
      return { ok: true, missing, present };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), missing: [], present: [] };
    }
  });

  /** Rescan a folder for audio files (for watched library roots) */
  ipcMain.handle('local-scan-folder', async (_e, folderPath) => {
    try {
      const root = path.resolve(String(folderPath || ''));
      if (!root || !fs.existsSync(root)) return { error: 'folder not found' };
      const basic = scanAudioFiles(root).map((f) => {
        let url;
        try {
          url = toMiuraFileUrl(f.path);
        } catch {
          url = undefined;
        }
        return { ...f, url, rootFolder: root, folder: path.dirname(f.path) };
      });
      // Don't fully enrich thousands at once — basic first; caller may enrich
      if (basic.length <= 200) return await enrichLocalTracks(basic);
      // Large: enrich in main sequentially still, but return meta
      return await enrichLocalTracks(basic);
    } catch (e) {
      console.error('[local-scan-folder]', e);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Watch folders for new/removed audio; push events to renderer */
  const folderWatchers = new Map();
  function broadcastLocalLibrary(evt) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('local-library-event', evt);
      }
    } catch {
      /* ignore */
    }
  }
  ipcMain.handle('local-watch-folders', async (_e, folders) => {
    try {
      const list = (Array.isArray(folders) ? folders : []).map((f) => path.resolve(String(f)));
      // Stop removed
      for (const [dir, w] of folderWatchers) {
        if (!list.includes(dir)) {
          try {
            w.close();
          } catch {
            /* ignore */
          }
          folderWatchers.delete(dir);
        }
      }
      for (const dir of list) {
        if (folderWatchers.has(dir)) continue;
        if (!fs.existsSync(dir)) continue;
        try {
          let timer = null;
          const w = fs.watch(dir, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const name = String(filename);
            if (!AUDIO_EXTS.has(path.extname(name).toLowerCase()) && eventType !== 'rename') {
              // still notify on renames of unknown — debounce full rescan signal
            }
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              broadcastLocalLibrary({ type: 'folder-changed', folder: dir, file: name, eventType });
            }, 800);
          });
          folderWatchers.set(dir, w);
        } catch (e) {
          console.warn('[watch]', dir, e);
        }
      }
      return { ok: true, watching: [...folderWatchers.keys()] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('local-read-lyrics-file', async (_e, filePath) => {
    try {
      const p = path.resolve(String(filePath || ''));
      if (!p) return { ok: false, error: 'empty' };
      const stem = p.replace(/\.[^.]+$/, '');
      for (const ext of ['.lrc', '.txt', '.LRC', '.TXT']) {
        const lp = stem + ext;
        if (fs.existsSync(lp) && fs.statSync(lp).size < 200000) {
          return { ok: true, text: fs.readFileSync(lp, 'utf8'), path: lp };
        }
      }
      return { ok: false, error: 'no lyrics file' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('local-import-m3u', async () => {
    try {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const r = await dialog.showOpenDialog(win, {
        title: 'miura — import M3U playlist',
        properties: ['openFile'],
        filters: [
          { name: 'Playlist', extensions: ['m3u', 'm3u8', 'txt'] },
          { name: 'All', extensions: ['*'] },
        ],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      const p = r.filePaths[0];
      const text = fs.readFileSync(p, 'utf8');
      return { ok: true, text, path: p, baseDir: path.dirname(p) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('local-export-m3u', async (_e, content) => {
    try {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const r = await dialog.showSaveDialog(win, {
        title: 'miura — export M3U',
        defaultPath: 'miura-library.m3u',
        filters: [{ name: 'M3U', extensions: ['m3u'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, String(content || ''), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Library-side tag edit only (no binary rewrite) — optional future: write ID3 */
  ipcMain.handle('local-write-tags', async (_e, payload) => {
    // Reserved: return ok so UI can persist in library; binary write needs per-format libs
    try {
      const p = path.resolve(String(payload?.path || ''));
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'file not found' };
      return { ok: true, path: p, written: false, note: 'library-only' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Mini player — UI only; media commands route to main window */
  ipcMain.handle('local-open-mini-player', async () => {
    try {
      if (miniPlayerWin && !miniPlayerWin.isDestroyed()) {
        miniPlayerWin.show();
        miniPlayerWin.focus();
        try {
          miniPlayerWin.webContents.send('player-state', lastPlayerState);
        } catch {
          /* ignore */
        }
        return { ok: true };
      }
      miniPlayerWin = new BrowserWindow({
        width: 380,
        height: 128,
        minWidth: 300,
        minHeight: 110,
        maxHeight: 180,
        frame: true,
        alwaysOnTop: true,
        skipTaskbar: false,
        resizable: true,
        backgroundColor: '#0a0a0b',
        title: 'miura · mini',
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      miniPlayerWin.setAlwaysOnTop(true, 'floating');
      miniPlayerWin.setMenuBarVisibility(false);
      miniPlayerWin.on('closed', () => {
        miniPlayerWin = null;
      });
      miniPlayerWin.webContents.on('did-finish-load', () => {
        try {
          miniPlayerWin.webContents.send('player-state', lastPlayerState);
        } catch {
          /* ignore */
        }
      });
      if (isDev) {
        await miniPlayerWin.loadURL('http://localhost:5173/#mini');
      } else {
        await miniPlayerWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
          hash: 'mini',
        });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('player-push-state', (_e, state) => {
    try {
      broadcastPlayerState(state && typeof state === 'object' ? state : {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('player-get-state', () => ({ ok: true, ...lastPlayerState }));

  ipcMain.handle('media-command', (_e, cmd) => {
    const c = String(cmd || '');
    if (c === 'toggle' || c === 'next' || c === 'prev') {
      broadcastMedia(c);
      return { ok: true };
    }
    return { ok: false, error: 'unknown command' };
  });

  ipcMain.handle('local-pick-folder-watch', async () => {
    try {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const r = await dialog.showOpenDialog(win, {
        title: 'miura — watch music folder',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * Build a playable miura-file:// URL.
   * Never throw across IPC (avoids opaque "Error invoking remote method").
   */
  ipcMain.handle('local-file-url', async (_e, filePath) => {
    try {
      const resolved = path.resolve(String(filePath || ''));
      if (!filePath || !resolved) {
        return { ok: false, error: 'Пустой путь к файлу' };
      }
      if (!fs.existsSync(resolved)) {
        return { ok: false, error: 'Файл не найден:\n' + resolved };
      }
      const st = fs.statSync(resolved);
      if (!st.isFile()) {
        return { ok: false, error: 'Это не файл:\n' + resolved };
      }
      const ext = path.extname(resolved).toLowerCase();
      if (ext === '.wma') {
        return {
          ok: false,
          error: 'WMA не поддерживается. Сохрани как MP3 / M4A / FLAC / WAV / OGG.',
        };
      }
      const url = toMiuraFileUrl(resolved);
      return {
        ok: true,
        url,
        path: resolved,
        mime: mimeForAudio(resolved),
        size: st.size,
      };
    } catch (e) {
      console.error('[local-file-url]', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * Read local audio into a Buffer for blob playback in renderer.
   * Most reliable path for MP3 on Windows (bypasses custom protocol quirks).
   */
  ipcMain.handle('local-read-audio', async (_e, filePath) => {
    try {
      const resolved = path.resolve(String(filePath || ''));
      if (!resolved || !fs.existsSync(resolved)) {
        return { ok: false, error: 'Файл не найден:\n' + resolved };
      }
      const st = fs.statSync(resolved);
      if (!st.isFile()) {
        return { ok: false, error: 'Это не файл' };
      }
      const ext = path.extname(resolved).toLowerCase();
      if (ext === '.wma') {
        return {
          ok: false,
          error: 'WMA не поддерживается. Нужен MP3 / M4A / FLAC / WAV / OGG.',
        };
      }
      // ~150 MB hard stop — keeps IPC memory reasonable
      if (st.size > 150 * 1024 * 1024) {
        return {
          ok: false,
          error: 'Файл слишком большой (>150MB). Разбей или используй меньший файл.',
        };
      }
      const buf = await fs.promises.readFile(resolved);
      // Electron clones Buffer over IPC → Uint8Array in renderer
      return {
        ok: true,
        buffer: buf,
        mime: mimeForAudio(resolved),
        size: st.size,
        path: resolved,
      };
    } catch (e) {
      console.error('[local-read-audio]', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ─── Local miura profiles ───
  ipcMain.handle('profile-state', () => profilesState());

  ipcMain.handle('profile-create', async (_e, payload) => {
    const displayName = String(payload?.displayName || '').trim().slice(0, 48);
    if (!displayName) throw new Error('Введите имя профиля');
    const store = readProfilesStore();
    const id = crypto.randomUUID();
    const now = Date.now();
    let avatarFile = null;
    if (payload?.avatarPath) {
      avatarFile = copyAvatarForProfile(id, String(payload.avatarPath));
    }
    const bio = payload?.bio != null ? String(payload.bio).trim().slice(0, 160) : '';
    const accent = payload?.accent ? String(payload.accent).trim().slice(0, 32) : null;
    const profile = {
      id,
      displayName,
      avatarFile,
      bannerFile: null,
      bannerPosX: 50,
      bannerPosY: 50,
      bio,
      accent,
      createdAt: now,
      lastUsedAt: now,
    };
    store.profiles.push(profile);
    store.activeId = id;
    writeProfilesStore(store);
    return profilesState();
  });

  ipcMain.handle('profile-update', async (_e, payload) => {
    const id = String(payload?.id || '');
    const store = readProfilesStore();
    const idx = store.profiles.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('Профиль не найден');
    if (payload?.displayName != null) {
      const name = String(payload.displayName).trim().slice(0, 48);
      if (!name) throw new Error('Введите имя профиля');
      store.profiles[idx].displayName = name;
    }
    if (payload?.bio != null) {
      store.profiles[idx].bio = String(payload.bio).trim().slice(0, 160);
    }
    if (payload?.accent !== undefined) {
      const a = payload.accent ? String(payload.accent).trim().slice(0, 32) : null;
      store.profiles[idx].accent = a || null;
    }
    if (payload?.avatarPath) {
      store.profiles[idx].avatarFile = copyAvatarForProfile(id, String(payload.avatarPath));
    }
    if (payload?.bannerPath) {
      store.profiles[idx].bannerFile = copyBannerForProfile(id, String(payload.bannerPath));
      // new image — center by default unless client sends position
      if (payload?.bannerPosX == null && payload?.bannerPosY == null) {
        store.profiles[idx].bannerPosX = 50;
        store.profiles[idx].bannerPosY = 50;
      }
    }
    if (payload?.bannerPosX != null) {
      store.profiles[idx].bannerPosX = clampPct(payload.bannerPosX, 50);
    }
    if (payload?.bannerPosY != null) {
      store.profiles[idx].bannerPosY = clampPct(payload.bannerPosY, 50);
    }
    if (payload?.clearAvatar) {
      const old = store.profiles[idx].avatarFile;
      if (old) {
        try {
          fs.unlinkSync(path.join(avatarsDir(), path.basename(old)));
        } catch {
          /* ignore */
        }
      }
      store.profiles[idx].avatarFile = null;
    }
    if (payload?.clearBanner) {
      const oldB = store.profiles[idx].bannerFile;
      if (oldB) {
        try {
          fs.unlinkSync(path.join(avatarsDir(), path.basename(oldB)));
        } catch {
          /* ignore */
        }
      }
      store.profiles[idx].bannerFile = null;
      store.profiles[idx].bannerPosX = 50;
      store.profiles[idx].bannerPosY = 50;
    }
    store.profiles[idx].lastUsedAt = Date.now();
    writeProfilesStore(store);
    return profilesState();
  });

  ipcMain.handle('profile-switch', (_e, profileId) => {
    const id = String(profileId || '');
    const store = readProfilesStore();
    const p = store.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Профиль не найден');
    p.lastUsedAt = Date.now();
    store.activeId = id;
    writeProfilesStore(store);
    return profilesState();
  });

  ipcMain.handle('profile-logout', () => {
    const store = readProfilesStore();
    store.activeId = null;
    writeProfilesStore(store);
    return profilesState();
  });

  ipcMain.handle('profile-delete', (_e, profileId) => {
    const id = String(profileId || '');
    const store = readProfilesStore();
    const victim = store.profiles.find((p) => p.id === id);
    if (!victim) throw new Error('Профиль не найден');
    if (victim.avatarFile) {
      try {
        fs.unlinkSync(path.join(avatarsDir(), path.basename(victim.avatarFile)));
      } catch {
        /* ignore */
      }
    }
    if (victim.bannerFile) {
      try {
        fs.unlinkSync(path.join(avatarsDir(), path.basename(victim.bannerFile)));
      } catch {
        /* ignore */
      }
    }
    store.profiles = store.profiles.filter((p) => p.id !== id);
    if (store.activeId === id) store.activeId = null;
    writeProfilesStore(store);
    return profilesState();
  });

  ipcMain.handle('profile-pick-avatar', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win || undefined, {
      title: 'miura — аватар',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    });
    if (res.canceled || !res.filePaths?.[0]) return { canceled: true };
    const filePath = res.filePaths[0];
    try {
      const st = fs.statSync(filePath);
      if (st.size > 4 * 1024 * 1024) throw new Error('Файл больше 4 МБ');
      const buf = fs.readFileSync(filePath);
      const dataUrl = `data:${avatarMime(filePath)};base64,${buf.toString('base64')}`;
      return { canceled: false, path: filePath, dataUrl };
    } catch (e) {
      return { canceled: true, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('profile-pick-banner', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win || undefined, {
      title: 'miura — фон профиля',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    });
    if (res.canceled || !res.filePaths?.[0]) return { canceled: true };
    const filePath = res.filePaths[0];
    try {
      const st = fs.statSync(filePath);
      if (st.size > 8 * 1024 * 1024) throw new Error('Файл больше 8 МБ');
      const buf = fs.readFileSync(filePath);
      const dataUrl = `data:${avatarMime(filePath)};base64,${buf.toString('base64')}`;
      return { canceled: false, path: filePath, dataUrl };
    } catch (e) {
      return { canceled: true, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('auth-get', () => getStoredAuth());
  ipcMain.handle('auth-login', async (_e, opts) => {
    try {
      // Browser-first (more reliable vs Cloudflare); mode:'app' for embedded window
      const mode = opts && opts.mode === 'app' ? 'app' : 'browser';
      if (mode === 'app') return await openInAppLogin();
      return await openBrowserLogin();
    } catch (e) {
      console.error('[login]', e);
      throw e;
    }
  });
  ipcMain.handle('auth-logout', () => {
    clearAuth();
    return true;
  });
  ipcMain.handle('auth-save', (_e, payload) => {
    if (payload?.accessToken) {
      saveAuth(payload);
      return getStoredAuth();
    }
    return null;
  });

  // Manual token paste (when embedded login hits Cloudflare bot wall)
  ipcMain.handle('auth-import-token', async (_e, payload) => {
    const token = String(payload?.accessToken || '')
      .replace(/^OAuth\s+/i, '')
      .trim();
    if (!token || token.length < 10) {
      throw new Error('Пустой или слишком короткий токен');
    }
    const clientId = payload?.clientId ? String(payload.clientId).trim() : capture.clientId;
    const cfg = readProxyConfig();
    await applyProxyConfig({
      enabled: cfg.enabled !== false,
      mode: 'all',
      url: (cfg.url || DEFAULT_PROXY.url).trim() || DEFAULT_PROXY.url,
    });
    const doFetch =
      typeof session.defaultSession.fetch === 'function'
        ? session.defaultSession.fetch.bind(session.defaultSession)
        : net.fetch.bind(net);
    return validateAndSaveToken(token, clientId, doFetch);
  });

  ipcMain.handle('open-external-sc', async () => {
    const port = await ensureAuthServer();
    await shell.openExternal(`http://127.0.0.1:${port}/login`);
    setTimeout(() => {
      void shell.openExternal('https://soundcloud.com/signin');
    }, 500);
    return true;
  });

  ipcMain.handle('auth-helper-url', async () => {
    const port = await ensureAuthServer();
    return `http://127.0.0.1:${port}/login`;
  });

  ipcMain.handle('proxy-get', () => readProxyConfig());
  ipcMain.handle('proxy-probe-local', async () => {
    try {
      const open = await probeLocalProxyPorts();
      return { ok: true, open: open || [] };
    } catch (e) {
      console.error('[proxy-probe]', e);
      return { ok: false, open: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('proxy-set', async (_e, cfg) => {
    const next = writeProxyConfig(cfg || {});
    const applied = await applyProxyConfig(next);
    return { config: next, applied };
  });
  ipcMain.handle('proxy-test', async () => testProxyReachability());

  // Discord Rich Presence
  ipcMain.handle('discord-get', () => discordPresence.getStatus());
  ipcMain.handle('discord-set-config', async (_e, cfg) => discordPresence.setConfig(cfg || {}));
  ipcMain.handle('discord-set-presence', async (_e, payload) => discordPresence.setPresence(payload));
  ipcMain.handle('discord-clear-presence', async () => discordPresence.clearPresence());

  /**
   * Authenticated API fetch.
   * 1) Prefer fetch() inside a real soundcloud.com page (correct Origin + cookies + less WAF)
   * 2) Fallback to session.net fetch
   */
  let scPageWin = null;
  let scPageReady = null;

  async function ensureScPageWindow() {
    if (scPageWin && !scPageWin.isDestroyed()) {
      await scPageReady;
      return scPageWin;
    }
    scPageWin = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {
        partition: 'persist:sc-login',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    try {
      scPageWin.webContents.setUserAgent(CHROME_UA);
    } catch {
      /* ignore */
    }
    scPageReady = scPageWin
      .loadURL('https://soundcloud.com/')
      .catch((e) => console.warn('[sc-page] load', e));
    await scPageReady;
    // give JS a moment
    await new Promise((r) => setTimeout(r, 800));
    return scPageWin;
  }

  async function fetchViaScPage(url, method, headers, body, credentialsMode) {
    const win = await ensureScPageWindow();
    const hdrs = headers || {};
    const creds = credentialsMode === 'omit' ? 'omit' : 'include';
    // Mirror OAuth into cookies — SC web often relies on both
    // Skip for media exchange (credentials omit): stale oauth_token cookie → 401 on /media/*
    const auth = String(hdrs.Authorization || hdrs.authorization || '');
    const tok = auth.replace(/^OAuth\s+/i, '').trim();
    if (tok && creds !== 'omit') {
      const ses = session.fromPartition('persist:sc-login');
      const cookieOpts = [
        { url: 'https://api-v2.soundcloud.com', name: 'oauth_token', value: tok, secure: true, httpOnly: false },
        { url: 'https://soundcloud.com', name: 'oauth_token', value: tok, secure: true, httpOnly: false },
        { url: 'https://api-v2.soundcloud.com', name: 'sc_anonymous_id', value: '0', secure: true },
      ];
      for (const c of cookieOpts) {
        try {
          await ses.cookies.set(c);
        } catch {
          /* ignore */
        }
      }
    }

    const payload = {
      url,
      method,
      headers: hdrs,
      body: body === undefined ? null : body,
      credentials: creds,
    };
    const code = `
      (async () => {
        const p = ${JSON.stringify(payload)};
        const init = { method: p.method, headers: p.headers, credentials: p.credentials || 'include', mode: 'cors' };
        if (p.body !== null && p.method !== 'GET' && p.method !== 'HEAD') {
          init.body = p.body;
        }
        const res = await fetch(p.url, init);
        const text = await res.text();
        return { status: res.status, ok: res.ok, body: text };
      })()
    `;
    return win.webContents.executeJavaScript(code, true);
  }

  async function fetchViaNet(url, method, headers, body) {
    const doFetch =
      typeof session.defaultSession.fetch === 'function'
        ? session.defaultSession.fetch.bind(session.defaultSession)
        : net.fetch.bind(net);
    const init = { method, headers: headers || {} };
    if (method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null) {
      init.body = body;
    }
    const res = await doFetch(url, init);
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text };
  }

  /**
   * Media/stream exchange often 404s through SOCKS even when direct works.
   * Dedicated session with mode:direct — bypass app proxy only for /media/*.
   */
  let directMediaSession = null;
  function getDirectMediaSession() {
    if (directMediaSession) return directMediaSession;
    directMediaSession = session.fromPartition('persist:sc-media-direct');
    try {
      directMediaSession.setProxy({ mode: 'direct' });
    } catch (e) {
      console.warn('[media-direct] setProxy', e);
    }
    try {
      directMediaSession.setUserAgent(CHROME_UA);
    } catch {
      /* ignore */
    }
    return directMediaSession;
  }

  async function fetchMediaViaDirect(url, method, headers) {
    const ses = getDirectMediaSession();
    const doFetch =
      typeof ses.fetch === 'function' ? ses.fetch.bind(ses) : net.fetch.bind(net);
    const hdrs = {
      Accept: 'application/json',
      Origin: 'https://soundcloud.com',
      Referer: 'https://soundcloud.com/',
      'User-Agent': CHROME_UA,
      ...(headers || {}),
    };
    const res = await doFetch(url, { method: method || 'GET', headers: hdrs });
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text };
  }

  /** Build raw multipart body as Node Buffer */
  function buildMultipartBuffer(fields, fileField, fileName, mimeType, fileBuffer) {
    const boundary = '----miuraForm' + Date.now().toString(16);
    const chunks = [];
    const push = (s) => chunks.push(Buffer.from(s, 'utf8'));

    for (const [k, v] of Object.entries(fields || {})) {
      if (v == null) continue;
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="${String(k).replace(/"/g, '')}"\r\n\r\n`);
      push(`${String(v)}\r\n`);
    }

    const safeName = String(fileName || 'cover.jpg').replace(/[^\w.\-]+/g, '_');
    const safeField = String(fileField || 'playlist[artwork_data]');
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${safeField}"; filename="${safeName}"\r\n`);
    push(`Content-Type: ${mimeType || 'image/jpeg'}\r\n\r\n`);
    chunks.push(Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer));
    push(`\r\n--${boundary}--\r\n`);

    return {
      body: Buffer.concat(chunks),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  function netRequestBuffer({ url, method, headers, bodyBuffer }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(result);
      };

      let req;
      try {
        req = net.request({
          method: method || 'PUT',
          url,
          redirect: 'follow',
        });
      } catch (e) {
        finish(e);
        return;
      }

      for (const [k, v] of Object.entries(headers || {})) {
        if (v == null || v === '') continue;
        try {
          req.setHeader(k, String(v));
        } catch {
          /* ignore */
        }
      }

      const chunks = [];
      req.on('response', (response) => {
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          finish(null, {
            status: response.statusCode || 0,
            ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', (e) => finish(e));
      });
      req.on('error', (e) => finish(e));

      try {
        if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
        req.end();
      } catch (e) {
        finish(e);
      }
    });
  }

  /**
   * Multipart upload (playlist artwork).
   * 1) FormData from a real soundcloud.com page (best chance vs WAF/403)
   * 2) net.request raw multipart fallback
   */
  ipcMain.handle('api-upload', async (_e, payload) => {
    const url = String(payload?.url || '');
    if (!url.startsWith('https://api.soundcloud.com') && !url.startsWith('https://api-v2.soundcloud.com')) {
      throw new Error('api-upload: only SoundCloud API hosts allowed');
    }
    const method = String(payload?.method || 'PUT').toUpperCase();
    const headersIn =
      payload?.headers && typeof payload.headers === 'object' ? { ...payload.headers } : {};

    const fileBase64 = String(payload?.fileBase64 || '');
    const fileName = String(payload?.fileName || 'cover.jpg');
    const fileField = String(payload?.fileField || 'playlist[artwork_data]');
    const mimeType = String(payload?.mimeType || 'image/jpeg');
    const fields = payload?.fields && typeof payload.fields === 'object' ? payload.fields : {};

    if (!fileBase64) throw new Error('api-upload: empty file');

    let fileBuffer;
    try {
      fileBuffer = Buffer.from(fileBase64, 'base64');
    } catch {
      throw new Error('api-upload: bad base64');
    }
    if (!fileBuffer.length) throw new Error('api-upload: empty decoded file');

    const auth = String(headersIn.Authorization || headersIn.authorization || '').trim();
    const tok = auth.replace(/^OAuth\s+/i, '').trim();

    // Seed oauth cookie for page partition (same as likes)
    if (tok) {
      const ses = session.fromPartition('persist:sc-login');
      for (const c of [
        { url: 'https://api-v2.soundcloud.com', name: 'oauth_token', value: tok, secure: true },
        { url: 'https://soundcloud.com', name: 'oauth_token', value: tok, secure: true },
        { url: 'https://api.soundcloud.com', name: 'oauth_token', value: tok, secure: true },
      ]) {
        try {
          await ses.cookies.set(c);
        } catch {
          /* ignore */
        }
      }
    }

    // --- 1) Page-context FormData (Origin: soundcloud.com, like real browser) ---
    try {
      const win = await ensureScPageWindow();
      const pagePayload = {
        url,
        method,
        auth,
        fileBase64,
        fileName,
        fileField,
        mimeType,
        fields,
      };
      const code = `
        (async () => {
          const p = ${JSON.stringify(pagePayload)};
          const bin = atob(p.fileBase64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: p.mimeType || 'image/jpeg' });
          const form = new FormData();
          if (p.fields) {
            for (const [k, v] of Object.entries(p.fields)) {
              if (v != null && v !== '') form.append(k, String(v));
            }
          }
          form.append(p.fileField, blob, p.fileName || 'cover.jpg');
          const headers = { Accept: 'application/json, text/javascript, */*; q=0.01' };
          if (p.auth) headers.Authorization = p.auth;
          const res = await fetch(p.url, {
            method: p.method || 'PUT',
            headers,
            body: form,
            credentials: 'include',
            mode: 'cors',
          });
          const text = await res.text();
          return { status: res.status, ok: res.ok, body: text };
        })()
      `;
      const r = await win.webContents.executeJavaScript(code, true);
      console.warn(
        '[api-upload page]',
        method,
        url.replace(/\?.*/, ''),
        fileField,
        '→',
        r?.status,
        String(r?.body || '').slice(0, 120)
      );
      if (r && (r.status === 200 || r.status === 201 || r.status === 204)) {
        return r;
      }
      // keep r for return if net also fails with same class of error
      if (r && r.status > 0 && r.status !== 403 && r.status !== 401) {
        // still try net, but prefer non-auth errors later
      }
    } catch (e) {
      console.warn('[api-upload page fail]', e);
    }

    // --- 2) net.request raw multipart ---
    const { body, contentType } = buildMultipartBuffer(
      fields,
      fileField,
      fileName,
      mimeType,
      fileBuffer
    );

    const headers = {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': contentType,
      'User-Agent': CHROME_UA,
      Referer: 'https://soundcloud.com/',
    };
    // Intentionally NO Origin — some SC edges 403 when Origin is present on net.request
    if (auth) headers.Authorization = auth;

    try {
      const result = await netRequestBuffer({
        url,
        method,
        headers,
        bodyBuffer: body,
      });
      console.warn(
        '[api-upload net]',
        method,
        url.replace(/\?.*/, ''),
        fileField,
        '→',
        result.status,
        (result.body || '').slice(0, 120)
      );
      return result;
    } catch (e) {
      console.error('[api-upload]', e);
      throw e;
    }
  });

  // ── In-app SoundCloud mini-player (official widget, login session) ──
  // Never open the system browser — keep playback inside miura.
  function positionScEmbed(win) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const [mx, my] = mainWindow.getPosition();
        const [mw, mh] = mainWindow.getSize();
        const ww = 380;
        const wh = 200;
        win.setSize(ww, wh);
        win.setPosition(Math.max(0, mx + mw - ww - 16), Math.max(0, my + mh - wh - 24));
      }
    } catch {
      /* ignore */
    }
  }

  function getScEmbedWindow() {
    if (scEmbedWin && !scEmbedWin.isDestroyed()) return scEmbedWin;
    scEmbedWin = new BrowserWindow({
      width: 380,
      height: 200,
      show: false,
      skipTaskbar: true,
      // Mini player chrome — stays inside the app, not the system browser
      frame: true,
      title: 'miura · плеер',
      backgroundColor: '#111111',
      autoHideMenuBar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: false,
      webPreferences: {
        partition: 'persist:sc-login',
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    try {
      scEmbedWin.webContents.setUserAgent(CHROME_UA);
      scEmbedWin.webContents.setBackgroundThrottling(false);
      scEmbedWin.webContents.setAudioMuted(false);
      scEmbedWin.setMenuBarVisibility(false);
    } catch {
      /* ignore */
    }
    // Block navigations that would escape to a full browser tab UX
    scEmbedWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    scEmbedWin.on('closed', () => {
      scEmbedWin = null;
    });
    return scEmbedWin;
  }

  async function scEmbedExec(code) {
    const win = getScEmbedWindow();
    if (!win || win.isDestroyed()) throw new Error('embed window gone');
    return win.webContents.executeJavaScript(code, true);
  }

  ipcMain.handle('sc-embed-play', async (_e, payload) => {
    const resource = String(payload?.url || payload?.permalink || '').trim();
    if (!resource) throw new Error('sc-embed-play: url required');
    const volume = Math.max(0, Math.min(1, Number(payload?.volume ?? 0.85)));
    const win = getScEmbedWindow();
    positionScEmbed(win);

    const playerUrl =
      'https://w.soundcloud.com/player/?' +
      new URLSearchParams({
        url: resource,
        auto_play: 'true',
        hide_related: 'true',
        show_comments: 'false',
        show_user: 'true',
        show_reposts: 'false',
        show_teaser: 'false',
        visual: 'true',
        buying: 'false',
        sharing: 'false',
        download: 'false',
        color: '%23ff5500',
      }).toString();

    // Show mini-player inside the app (not system browser)
    if (!win.isVisible()) win.showInactive();
    positionScEmbed(win);

    await win.loadURL(playerUrl, { userAgent: CHROME_UA });
    await new Promise((r) => setTimeout(r, 1000));

    const result = await win.webContents.executeJavaScript(
      `
      (async () => {
        const vol = ${volume};
        const deadline = Date.now() + 20000;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        const tryPlayMedia = async () => {
          const nodes = [...document.querySelectorAll('audio, video')];
          for (const m of nodes) {
            try {
              m.muted = false;
              m.volume = vol;
              if (m.paused) await m.play();
              return {
                ok: true,
                duration: Number(m.duration) || 0,
                currentTime: Number(m.currentTime) || 0,
                via: 'media',
              };
            } catch (e) {
              /* try next */
            }
          }
          return null;
        };

        const clickPlay = () => {
          const sels = [
            '.playButton',
            '.playControl',
            'button.playControl',
            'button[title="Play"]',
            'button[aria-label="Play"]',
            '.sc-button-play',
            '.playControls__play',
            'button.playButton',
            '.playButton__playIcon',
          ];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el) {
              el.click();
              return true;
            }
          }
          for (const b of document.querySelectorAll('button, div[role="button"]')) {
            const t = (b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
            if (t.includes('play') && !t.includes('pause')) {
              b.click();
              return true;
            }
          }
          return false;
        };

        while (Date.now() < deadline) {
          let hit = await tryPlayMedia();
          if (hit) return hit;
          clickPlay();
          await sleep(250);
          hit = await tryPlayMedia();
          if (hit) return hit;
          await sleep(200);
        }
        // Player UI is loaded — user can press Play in the mini-window (still in-app)
        return {
          ok: true,
          via: 'mini-ui',
          needsClick: true,
          duration: 0,
          currentTime: 0,
        };
      })()
      `,
      true
    );

    // Keep mini-player visible for DRM / manual play; hide only if fully auto-playing
    if (result?.via === 'media' && result?.ok) {
      // optional: leave visible so user sees artwork — keep shown
      try {
        win.showInactive();
      } catch {
        /* ignore */
      }
    } else {
      try {
        win.show();
        win.focus();
      } catch {
        /* ignore */
      }
    }

    console.log('[sc-embed-play]', result?.via || result?.error || result);
    return result || { ok: true, via: 'mini-ui', needsClick: true };
  });

  ipcMain.handle('sc-embed-command', async (_e, payload) => {
    const cmd = String(payload?.cmd || '');
    const value = payload?.value;
    try {
      if (cmd === 'pause') {
        return await scEmbedExec(`
          (() => {
            document.querySelectorAll('audio, video').forEach((m) => m.pause());
            const b = document.querySelector('button[title="Pause"], button[aria-label="Pause"], .playControls__play.playing');
            if (b) b.click();
            return { ok: true };
          })()
        `);
      }
      if (cmd === 'play') {
        return await scEmbedExec(`
          (async () => {
            const m = document.querySelector('audio, video');
            if (m) {
              try { await m.play(); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
            }
            const b = document.querySelector('button[title="Play"], button[aria-label="Play"], .playControls__play');
            if (b) b.click();
            return { ok: true };
          })()
        `);
      }
      if (cmd === 'seek') {
        const t = Number(value) || 0;
        return await scEmbedExec(`
          (() => {
            const m = document.querySelector('audio, video');
            if (m && Number.isFinite(m.duration)) {
              m.currentTime = Math.max(0, Math.min(${t}, m.duration || ${t}));
              return { ok: true, currentTime: m.currentTime };
            }
            return { ok: false };
          })()
        `);
      }
      if (cmd === 'volume') {
        const v = Math.max(0, Math.min(1, Number(value) || 0));
        return await scEmbedExec(`
          (() => {
            document.querySelectorAll('audio, video').forEach((m) => { m.volume = ${v}; m.muted = ${v} <= 0; });
            return { ok: true };
          })()
        `);
      }
      if (cmd === 'status') {
        return await scEmbedExec(`
          (() => {
            const m = document.querySelector('audio, video');
            if (!m) return { ok: true, hasMedia: false, paused: true, currentTime: 0, duration: 0 };
            return {
              ok: true,
              hasMedia: true,
              paused: m.paused,
              ended: m.ended,
              currentTime: Number(m.currentTime) || 0,
              duration: Number(m.duration) || 0,
            };
          })()
        `);
      }
      if (cmd === 'stop') {
        if (scEmbedWin && !scEmbedWin.isDestroyed()) {
          try {
            await scEmbedWin.loadURL('about:blank');
            scEmbedWin.hide();
          } catch {
            /* ignore */
          }
        }
        return { ok: true };
      }
      return { ok: false, error: 'unknown cmd' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * Binary-capable fetch for Shaka DRM (m3u8, segments, license).
   * Bypasses renderer CORS; uses Chromium net + optional direct session.
   */
  ipcMain.handle('media-fetch', async (_e, payload) => {
    const url = String(payload?.url || '');
    if (!/^https:\/\//i.test(url)) {
      throw new Error('media-fetch: only https');
    }
    // SC media CDN + license + api + classic sndcdn
    const allowed =
      /soundcloud\.com|soundcloud\.cloud|sndcdn\.com/i.test(url) ||
      url.includes('media-streaming.soundcloud');
    if (!allowed) {
      throw new Error('media-fetch: host not allowed: ' + url.slice(0, 80));
    }

    const method = String(payload?.method || 'GET').toUpperCase();
    const headersIn =
      payload?.headers && typeof payload.headers === 'object' ? { ...payload.headers } : {};
    const headers = {
      ...headersIn,
      // Ensure web-like context for SC license / CDN
      Origin: headersIn.Origin || headersIn.origin || 'https://soundcloud.com',
      Referer: headersIn.Referer || headersIn.referer || 'https://soundcloud.com/',
      'User-Agent': CHROME_UA,
    };
    delete headers['user-agent'];
    delete headers['User-Agent'];
    headers['User-Agent'] = CHROME_UA;

    let body;
    if (payload?.bodyBase64) {
      body = Buffer.from(String(payload.bodyBase64), 'base64');
    }

    const doOnce = async (ses, label) => {
      const doFetch =
        typeof ses.fetch === 'function' ? ses.fetch.bind(ses) : net.fetch.bind(net);
      const init = { method, headers };
      if (body && method !== 'GET' && method !== 'HEAD') init.body = body;
      const res = await doFetch(url, init);
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      const outHeaders = {};
      try {
        res.headers.forEach((v, k) => {
          outHeaders[String(k).toLowerCase()] = String(v);
        });
      } catch {
        /* ignore */
      }
      return {
        status: res.status,
        ok: res.ok,
        headers: outHeaders,
        bodyBase64: buf.toString('base64'),
        _via: label,
      };
    };

    // Prefer direct for CloudFront-signed playback (proxy often breaks it)
    const preferDirect =
      url.includes('playback.media-streaming') ||
      url.includes('license.media-streaming') ||
      url.includes('sndcdn.com');

    if (preferDirect) {
      try {
        const r = await doOnce(getDirectMediaSession(), 'direct');
        if (r.status < 400) return r;
        console.warn('[media-fetch direct]', method, url.replace(/\?.*/, ''), '→', r.status);
      } catch (e) {
        console.warn('[media-fetch direct fail]', e);
      }
    }

    try {
      const r = await doOnce(session.defaultSession, 'proxy');
      if (r.status >= 400) {
        console.warn('[media-fetch proxy]', method, url.replace(/\?.*/, ''), '→', r.status);
      }
      return r;
    } catch (e) {
      console.error('[media-fetch]', method, url, e);
      throw e;
    }
  });

  function isYtAllowedHost(host) {
    const h = String(host || '').toLowerCase();
    return (
      /(^|\.)youtube\.com$/.test(h) ||
      /(^|\.)youtu\.be$/.test(h) ||
      /(^|\.)googlevideo\.com$/.test(h) ||
      /(^|\.)ytimg\.com$/.test(h) ||
      /(^|\.)ggpht\.com$/.test(h) ||
      /(^|\.)googleusercontent\.com$/.test(h) ||
      /(^|\.)googleapis\.com$/.test(h) ||
      /(^|\.)gstatic\.com$/.test(h) ||
      /(^|\.)youtube-nocookie\.com$/.test(h) ||
      /(^|\.)yt\.be$/.test(h) ||
      /(^|\.)google\.com$/.test(h) ||
      /(^|\.)youtubei\.googleapis\.com$/.test(h) ||
      /(^|\.)youtube-ui\.l\.google\.com$/.test(h)
    );
  }

  /** Dedupe parallel IPC resolves for the same video id */
  const ytResolveInflight = new Map();
  /** Short-lived successful resolves (avoid re-browser on replay) */
  const ytResolveCache = new Map();
  /** Serialize hidden-browser resolves (parallel windows → ERR_ABORTED) */
  let ytBrowserQueue = Promise.resolve();

  /**
   * Resolve a playable audio URL in main process.
   * Browser intercept (primary) ∥ quick ANDROID → Piped → HTML scrape.
   */
  async function ytResolveAudioMain(videoId) {
    const id = String(videoId || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,}$/.test(id)) {
      return { ok: false, error: 'bad video id' };
    }
    if (ytResolveInflight.has(id)) {
      return ytResolveInflight.get(id);
    }
    const p = ytResolveAudioMainImpl(id)
      .then(async (r) => {
        if (!r?.ok || !r.url || !/^https:\/\//i.test(r.url)) return r;
        // Probe with the YT partition before handing URL to the player
        const ytSes = getYtResolveSession();
        try {
          const cfg = readProxyConfig();
          await applyProxyToSession(ytSes, cfg);
        } catch {
          /* ignore */
        }
        const ok = await probeYtMediaUrl(r.url, ytSes);
        if (!ok) {
          // Try defaultSession probe — sometimes works without wrap
          const okDef = await probeYtMediaUrl(r.url, session.defaultSession);
          if (okDef) {
            console.log('[yt-resolve] use direct URL (defaultSession ok)', r.client);
            return r;
          }
          console.warn('[yt-resolve] probe failed both sessions', r.client);
          // still wrap — player may get a different CDN path via Range
        }
        const wrapped = wrapYtStreamForPlayer(r.url, r.mime);
        if (wrapped !== r.url) {
          console.log('[yt-resolve] wrap miura-yt', (r.mime || '').slice(0, 40), r.client);
          return { ...r, url: wrapped, sourceUrl: r.url };
        }
        return r;
      })
      .finally(() => {
        ytResolveInflight.delete(id);
      });
    ytResolveInflight.set(id, p);
    return p;
  }

  async function ytResolveAudioMainImpl(id) {

    const pickUrl = (data, label) => {
      const sd = data?.streamingData || data?.streaming_data;
      if (!sd) return null;
      const formats = [
        ...(sd.adaptiveFormats || sd.adaptive_formats || []),
        ...(sd.formats || []),
      ];
      const scored = [];
      for (const f of formats) {
        const mime = String(f.mimeType || f.mime_type || '');
        let url = f.url ? String(f.url) : '';
        // signatureCipher: s=…&sp=sig&url=https%3A%2F%2F…  — url alone is useless without sig
        // but some clients put a ready URL in .url
        if (!url && (f.signatureCipher || f.signature_cipher || f.cipher)) {
          try {
            const raw = String(f.signatureCipher || f.signature_cipher || f.cipher);
            const p = new URLSearchParams(raw);
            // Only use if no `s` param (already signed) — rare
            if (!p.get('s') && p.get('url')) url = decodeURIComponent(p.get('url'));
          } catch {
            /* ignore */
          }
        }
        if (!url.startsWith('http')) continue;
        const hasAudio =
          /audio|mp4a|opus|vorbis|webm/i.test(mime) ||
          f.audioQuality ||
          f.audioSampleRate ||
          f.audio_quality;
        const hasVideo = /^video\//i.test(mime) || (f.width && f.height);
        // Prefer pure audio m4a for <audio>; video-only is unusable
        if (!hasAudio && hasVideo && !/itag=(18|22)/i.test(url)) continue;
        let score = Number(f.bitrate || f.averageBitrate || f.average_bitrate || 0);
        if (hasAudio && !hasVideo) score += 1e12;
        else if (hasAudio) score += 1e11;
        else score += 1e9;
        // Chromium <audio> is happiest with mp4/mp4a; webm/opus often fails as "not supported"
        if (/mp4a|audio\/mp4|m4a/i.test(mime)) score += 5e9;
        else if (/mp4/i.test(mime) && hasAudio) score += 3e9;
        else if (/opus|audio\/webm/i.test(mime)) score += 5e7;
        else if (/webm/i.test(mime)) score += 1e7;
        scored.push({ url, score, mime });
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored[0]?.url) {
        return {
          url: scored[0].url,
          mime: scored[0].mime,
          protocol: 'progressive',
          via: label,
        };
      }
      const hls = sd.hlsManifestUrl || sd.hls_manifest_url;
      if (hls && String(hls).startsWith('http')) {
        return {
          url: String(hls),
          mime: 'application/x-mpegURL',
          protocol: 'hls',
          via: label,
        };
      }
      return null;
    };

    const sessions = [
      { label: 'proxy', ses: session.defaultSession },
      { label: 'direct', ses: getDirectMediaSession() },
    ];

    // yt-dlp-style clients that often return plaintext googlevideo URLs
    const clients = [
      {
        key: 'ANDROID',
        clientName: 'ANDROID',
        clientVersion: '19.44.38',
        clientId: '3',
        ua: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip',
        extra: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
      },
      {
        key: 'ANDROID_TESTSUITE',
        clientName: 'ANDROID_TESTSUITE',
        clientVersion: '1.9',
        clientId: '30',
        ua: 'com.google.android.youtube/1.9 (Linux; U; Android 12) gzip',
        extra: { androidSdkVersion: 31, osName: 'Android', osVersion: '12' },
      },
      {
        key: 'IOS',
        clientName: 'IOS',
        clientVersion: '19.45.4',
        clientId: '5',
        ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
        extra: { deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '17.5.1.21F90' },
      },
      {
        key: 'ANDROID_MUSIC',
        clientName: 'ANDROID_MUSIC',
        clientVersion: '7.27.52',
        clientId: '21',
        ua: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 11) gzip',
        extra: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
      },
      {
        key: 'TVHTML5_SIMPLY',
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        clientId: '85',
        ua: CHROME_UA,
        extra: {},
      },
    ];

    const endpoints = [
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      'https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false',
      'https://www.youtube.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w&prettyPrint=false',
    ];

    const errors = [];

    async function fetchJson(ses, url, init, timeoutMs = 9000) {
      const doFetch =
        typeof ses.fetch === 'function' ? ses.fetch.bind(ses) : net.fetch.bind(net);
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const res = await doFetch(url, ctrl ? { ...init, signal: ctrl.signal } : init);
        const text = await res.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          /* ignore */
        }
        return { status: res.status, data, len: text.length };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Short cache — same track replayed while seeking / double-click
    const cached = ytResolveCache.get(id);
    if (cached && cached.exp > Date.now() && cached.result?.ok && cached.result.url) {
      console.log('[yt-resolve] cache hit', id);
      return { ...cached.result, client: `${cached.result.client || 'cache'}/cached` };
    }

    const proxySes = sessions[0];

    // One quick ANDROID try (4s) in parallel with browser — rarely works, never blocks browser
    const androidPromise = (async () => {
      const c = clients.find((x) => x.key === 'ANDROID');
      if (!c) return null;
      try {
        const body = {
          context: {
            client: {
              clientName: c.clientName,
              clientVersion: c.clientVersion,
              hl: 'en',
              gl: 'US',
              timeZone: 'UTC',
              utcOffsetMinutes: 0,
              ...c.extra,
            },
          },
          videoId: id,
          contentCheckOk: true,
          racyCheckOk: true,
          playbackContext: {
            contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
          },
        };
        const { data, len } = await fetchJson(
          proxySes.ses,
          endpoints[0],
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': c.ua,
              'X-YouTube-Client-Name': c.clientId,
              'X-YouTube-Client-Version': c.clientVersion,
              Origin: 'https://www.youtube.com',
              Referer: `https://www.youtube.com/watch?v=${id}`,
            },
            body: JSON.stringify(body),
          },
          4000
        );
        if (!data) return null;
        const picked = pickUrl(data, 'proxy/ANDROID');
        if (picked) {
          console.log('[yt-resolve] ok ANDROID', picked.protocol, 'len', len);
          return { ok: true, ...picked, client: 'proxy/ANDROID' };
        }
        const pstat = data.playabilityStatus?.status || '?';
        const n =
          (data.streamingData?.adaptiveFormats || []).length +
          (data.streamingData?.formats || []).length;
        errors.push(`proxy/ANDROID:${pstat}/fmt${n}`);
        return null;
      } catch (e) {
        errors.push(`proxy/ANDROID:${e?.message || e}`);
        return null;
      }
    })();

    // Primary path: real Chromium (serial queue + one retry on abort)
    const browserPromise = (async () => {
      let browserHit = await ytResolveViaHiddenBrowser(id);
      if (
        !browserHit?.ok &&
        /ERR_ABORTED|timeout|aborted/i.test(String(browserHit?.error || ''))
      ) {
        console.log('[yt-resolve] browser retry after', browserHit?.error);
        browserHit = await ytResolveViaHiddenBrowser(id);
      }
      return browserHit;
    })();

    // Whoever wins first with a URL
    try {
      const raced = await new Promise((resolve) => {
        let done = false;
        const finishRace = (r, via) => {
          if (done || !r?.ok || !r.url) return;
          done = true;
          console.log('[yt-resolve] race win', via, r.client || r.protocol);
          resolve(r);
        };
        androidPromise.then((r) => finishRace(r, 'android')).catch(() => {});
        browserPromise.then((r) => finishRace(r, 'browser')).catch(() => {});
        Promise.allSettled([androidPromise, browserPromise]).then(() => {
          if (!done) resolve(null);
        });
      });
      if (raced?.ok && raced.url) {
        ytResolveCache.set(id, { exp: Date.now() + 8 * 60_000, result: raced });
        return raced;
      }
    } catch (e) {
      errors.push(`race:${e?.message || e}`);
    }

    // Collect browser error if race lost
    try {
      const browserHit = await browserPromise;
      if (browserHit?.ok && browserHit.url) {
        ytResolveCache.set(id, { exp: Date.now() + 8 * 60_000, result: browserHit });
        return browserHit;
      }
      if (browserHit?.error) errors.push(`browser:${browserHit.error}`);
    } catch (e) {
      errors.push(`browser:${e?.message || e}`);
    }

    // Piped — few instances in parallel (proxy only)
    const pipedBases = [
      'https://pipedapi.kavin.rocks',
      'https://api.piped.private.coffee',
      'https://pipedapi.adminforge.de',
      'https://pipedapi.r4fo.com',
    ];
    const pipedHit = await new Promise((resolve) => {
      let left = pipedBases.length;
      let resolved = false;
      for (const base of pipedBases) {
        void (async () => {
          try {
            const { data, len } = await fetchJson(
              proxySes.ses,
              `${base}/streams/${id}`,
              {
                method: 'GET',
                headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
              },
              7000
            );
            if (resolved) return;
            if (!data) {
              errors.push(`piped:${new URL(base).hostname}:empty`);
              return;
            }
            const audio = Array.isArray(data.audioStreams) ? data.audioStreams : [];
            const scored = audio
              .filter((s) => s && typeof s.url === 'string' && s.url.startsWith('http'))
              .map((s) => {
                const mime = String(s.mimeType || s.format || '');
                let score = Number(s.bitrate || 0) || 0;
                if (/mp4|m4a|mp4a/i.test(mime) || /m4a/i.test(String(s.format || ''))) {
                  score += 1e6;
                }
                return { url: String(s.url), mime, score };
              })
              .sort((a, b) => b.score - a.score);
            if (scored[0]?.url) {
              resolved = true;
              console.log('[yt-resolve] ok piped', base, scored[0].mime, 'len', len);
              resolve({
                ok: true,
                url: scored[0].url,
                mime: scored[0].mime || 'audio/mp4',
                protocol: 'progressive',
                client: 'proxy/piped',
                via: base,
              });
              return;
            }
            if (data.hls && String(data.hls).startsWith('http')) {
              resolved = true;
              resolve({
                ok: true,
                url: String(data.hls),
                mime: 'application/x-mpegURL',
                protocol: 'hls',
                client: 'proxy/piped-hls',
                via: base,
              });
              return;
            }
            errors.push(`piped:${new URL(base).hostname}:0`);
          } catch (e) {
            errors.push(`piped:${e?.message || e}`);
          } finally {
            left -= 1;
            if (left <= 0 && !resolved) resolve(null);
          }
        })();
      }
    });
    if (pipedHit?.ok) {
      ytResolveCache.set(id, { exp: Date.now() + 8 * 60_000, result: pipedHit });
      return pipedHit;
    }

    // Last resort: scrape watch HTML (proxy only, one page)
    try {
      const pageUrl = `https://www.youtube.com/watch?v=${id}&bpctr=9999999999&has_verified=1`;
      const doFetch =
        typeof proxySes.ses.fetch === 'function'
          ? proxySes.ses.fetch.bind(proxySes.ses)
          : net.fetch.bind(net);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      let html = '';
      try {
        const res = await doFetch(pageUrl, {
          method: 'GET',
          headers: {
            'User-Agent': CHROME_UA,
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.youtube.com/',
          },
          signal: ctrl.signal,
        });
        html = await res.text();
      } finally {
        clearTimeout(timer);
      }
      let data = null;
      const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
      if (m) {
        try {
          data = JSON.parse(m[1]);
        } catch {
          /* ignore */
        }
      }
      if (data) {
        const picked = pickUrl(data, 'proxy/html');
        if (picked) {
          console.log('[yt-resolve] ok scrape', picked.via, picked.protocol);
          const hit = { ok: true, ...picked, client: 'proxy/html' };
          ytResolveCache.set(id, { exp: Date.now() + 8 * 60_000, result: hit });
          return hit;
        }
        const n =
          (data.streamingData?.adaptiveFormats || []).length +
          (data.streamingData?.formats || []).length;
        errors.push(`html:${data.playabilityStatus?.status || '?'}/fmt${n}`);
      } else {
        errors.push('html:no-player-json');
      }
    } catch (e) {
      errors.push(`html:${e?.message || e}`);
    }

    const summary = errors.slice(0, 5).join(' · ') || 'no stream';
    console.warn('[yt-resolve] failed', id, errors.slice(0, 8).join(' | '));
    return {
      ok: false,
      error: /ERR_ABORTED|timeout|бот|LOGIN|browser:/i.test(summary)
        ? `YouTube: не удалось открыть поток. Нажми play ещё раз. (${summary.slice(0, 120)})`
        : `YouTube: нет потока. ${summary.slice(0, 160)}`,
    };
  }

  function ytResolveViaHiddenBrowser(videoId) {
    const run = () => ytResolveViaHiddenBrowserImpl(videoId);
    const p = ytBrowserQueue.then(run, run);
    ytBrowserQueue = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  /**
   * Load watch page in a real Chromium window (same proxy as app),
   * extract player JSON and/or intercept googlevideo audio requests.
   */
  function ytResolveViaHiddenBrowserImpl(videoId) {
    const id = String(videoId || '').trim();
    return new Promise(async (resolve) => {
      let settled = false;
      let win = null;
      // Warm cookies across resolves (same partition as miura-yt protocol)
      const ses = getYtResolveSession();
      try {
        const cfg = readProxyConfig();
        await applyProxyToSession(ses, cfg);
      } catch (e) {
        console.warn('[yt-resolve] browser proxy', e);
      }
      try {
        ses.setUserAgent(CHROME_UA);
      } catch {
        /* ignore */
      }

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ses.webRequest.onBeforeRequest(null);
        } catch {
          /* ignore */
        }
        try {
          if (win && !win.isDestroyed()) win.destroy();
        } catch {
          /* ignore */
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        // Prefer best collected stream over hard fail if we saw any
        if (candidates.length) {
          const best = pickBestCandidate(candidates);
          console.log('[yt-resolve] browser intercept timeout-pick', best.mime, best.url.slice(0, 72));
          finish({
            ok: true,
            url: best.url,
            mime: best.mime,
            protocol: 'progressive',
            client: 'browser-intercept',
          });
          return;
        }
        finish({ ok: false, error: 'timeout 28s (бот-стена или прокси медленный)' });
      }, 28000);

      const candidates = [];
      let settleTimer = null;

      const scoreAudioUrl = (u) => {
        let s = 0;
        // Prefer m4a / mp4 audio for <audio>
        if (/[/&?]itag=141(?:[&/]|$)/.test(u)) s += 1200;
        else if (/[/&?]itag=140(?:[&/]|$)/.test(u)) s += 1100;
        else if (/[/&?]itag=139(?:[&/]|$)/.test(u)) s += 900;
        else if (/[/&?]itag=18(?:[&/]|$)/.test(u)) s += 850; // muxed mp4
        else if (/[/&?]itag=22(?:[&/]|$)/.test(u)) s += 700;
        else if (/[/&?]itag=251(?:[&/]|$)/.test(u)) s += 400; // webm opus
        else if (/[/&?]itag=250(?:[&/]|$)/.test(u)) s += 300;
        else if (/[/&?]itag=249(?:[&/]|$)/.test(u)) s += 200;
        if (/mime=audio%2Fmp4|mime=audio\/mp4/i.test(u)) s += 500;
        if (/mime=audio%2Fwebm|mime=audio\/webm/i.test(u)) s += 80;
        // Pure video adaptive — almost never playable in <audio>
        if (/mime=video%2F|mime=video\//i.test(u) && !/[/&?]itag=(18|22)(?:[&/]|$)/.test(u)) s -= 2000;
        return s;
      };

      const looksLikeAudio = (u) => {
        if (!u || !/googlevideo\.com/i.test(u)) return false;
        if (scoreAudioUrl(u) < 0) return false;
        if (/mime=audio/i.test(u)) return true;
        if (/[/&?]itag=(139|140|141|249|250|251|256|258|18|22)(?:[&/]|$)/.test(u)) return true;
        return false;
      };

      const cleanMediaUrl = (u) => {
        try {
          const url = new URL(u);
          // Keep signature params; drop range chunks so full track can play
          url.searchParams.delete('range');
          url.searchParams.delete('rn');
          url.searchParams.delete('rbuf');
          return url.toString();
        } catch {
          return String(u).replace(/&range=\d+-\d+/g, '').replace(/&rn=\d+/g, '');
        }
      };

      const pickBestCandidate = (list) => {
        const ranked = list
          .map((c) => ({ ...c, score: scoreAudioUrl(c.url) }))
          .filter((c) => c.score >= 0)
          .sort((a, b) => b.score - a.score);
        return ranked[0] || list[0];
      };

      const mimeFromUrl = (u) => {
        if (/mime=audio%2Fwebm|mime=audio\/webm/i.test(u)) return 'audio/webm';
        if (/mime=audio%2Fmp4|mime=audio\/mp4|itag=(139|140|141)/i.test(u)) return 'audio/mp4';
        if (/itag=(18|22)/i.test(u)) return 'video/mp4';
        return 'audio/mp4';
      };

      let probing = false;
      const maybeFinishFromCandidates = (force) => {
        if (settled || !candidates.length || probing) return;
        const ranked = candidates
          .map((c) => ({ ...c, score: scoreAudioUrl(c.url) }))
          .filter((c) => c.score >= 0)
          .sort((a, b) => b.score - a.score);
        if (!ranked.length) return;
        const great = ranked[0].score >= 900; // m4a / good mp4
        if (!force && !great && candidates.length < 3) return;
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        probing = true;
        void (async () => {
          try {
            for (const c of ranked.slice(0, 6)) {
              if (settled) return;
              const ok = await probeYtMediaUrl(c.url, ses);
              if (!ok) continue;
              console.log(
                '[yt-resolve] browser intercept',
                c.mime || mimeFromUrl(c.url),
                c.url.slice(0, 80)
              );
              finish({
                ok: true,
                url: c.url,
                mime: c.mime || mimeFromUrl(c.url),
                protocol: 'progressive',
                client: 'browser-intercept',
              });
              return;
            }
            // Nothing probed OK — still return best raw (outer wrap may retry sessions)
            if (force && ranked[0] && !settled) {
              console.log(
                '[yt-resolve] browser intercept unprobed',
                ranked[0].url.slice(0, 80)
              );
              finish({
                ok: true,
                url: ranked[0].url,
                mime: ranked[0].mime || mimeFromUrl(ranked[0].url),
                protocol: 'progressive',
                client: 'browser-intercept',
              });
            }
          } finally {
            probing = false;
          }
        })();
      };

      try {
        ses.webRequest.onBeforeRequest({ urls: ['*://*.googlevideo.com/*'] }, (details, cb) => {
          try {
            if (!settled && looksLikeAudio(details.url)) {
              const url = cleanMediaUrl(details.url);
              if (!candidates.some((c) => c.url === url)) {
                candidates.push({ url, mime: mimeFromUrl(url) });
              }
              // Prefer waiting briefly for m4a (itag 140) instead of first webm
              if (scoreAudioUrl(url) >= 900) {
                maybeFinishFromCandidates(true);
              } else if (!settleTimer) {
                settleTimer = setTimeout(() => maybeFinishFromCandidates(true), 2500);
              } else {
                maybeFinishFromCandidates(false);
              }
            }
          } catch {
            /* ignore */
          }
          cb({});
        });
      } catch (e) {
        finish({ ok: false, error: `webRequest:${e?.message || e}` });
        return;
      }

      try {
        win = new BrowserWindow({
          show: false,
          width: 1280,
          height: 720,
          webPreferences: {
            session: ses,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
            sandbox: true,
          },
        });
        try {
          win.webContents.setAudioMuted(true);
        } catch {
          /* ignore */
        }

        win.webContents.on('did-fail-load', (_e, code, desc) => {
          if (!settled && code !== -3) {
            // -3 = aborted
            console.warn('[yt-resolve] browser fail-load', code, desc);
          }
        });

        win.webContents.on('did-finish-load', () => {
          void (async () => {
            if (settled) return;
            try {
              const extracted = await win.webContents.executeJavaScript(`
                (function () {
                  try {
                    var pr = window.ytInitialPlayerResponse;
                    if (!pr && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
                      try {
                        pr = JSON.parse(window.ytplayer.config.args.player_response || 'null');
                      } catch (e) {}
                    }
                    if (!pr) return { ok: false, err: 'no-pr' };
                    var sd = pr.streamingData || {};
                    var formats = [].concat(sd.adaptiveFormats || [], sd.formats || []);
                    var withUrl = formats.filter(function (f) { return f && f.url; });
                    var audio = withUrl.filter(function (f) {
                      var m = String(f.mimeType || '');
                      return /audio/i.test(m) && !/^video\\//i.test(m);
                    });
                    audio.sort(function (a, b) {
                      var ma = String(a.mimeType || '');
                      var mb = String(b.mimeType || '');
                      var sa = /mp4a|audio\\/mp4/i.test(ma) ? 1e9 : /webm|opus/i.test(ma) ? 1e6 : 0;
                      var sb = /mp4a|audio\\/mp4/i.test(mb) ? 1e9 : /webm|opus/i.test(mb) ? 1e6 : 0;
                      sa += Number(a.bitrate) || 0;
                      sb += Number(b.bitrate) || 0;
                      return sb - sa;
                    });
                    // Prefer pure audio; muxed mp4 (itag 18) as fallback — not raw video-only
                    var muxed = withUrl.filter(function (f) {
                      var m = String(f.mimeType || '');
                      return /^video\\/mp4/i.test(m) && /mp4a|audio/i.test(m);
                    });
                    var pick = audio[0] || muxed[0] || null;
                    var hls = sd.hlsManifestUrl || sd.hls_manifest_url || null;
                    return {
                      ok: !!(pick && pick.url) || !!(hls && String(hls).indexOf('http') === 0),
                      url: pick && pick.url ? pick.url : hls,
                      mime: pick && pick.mimeType ? pick.mimeType : (hls ? 'application/x-mpegURL' : ''),
                      status: pr.playabilityStatus && pr.playabilityStatus.status,
                      reason: pr.playabilityStatus && (pr.playabilityStatus.reason || (pr.playabilityStatus.errorScreen && pr.playabilityStatus.status)),
                      n: formats.length,
                      nUrl: withUrl.length,
                      hls: !!hls,
                    };
                  } catch (e) {
                    return { ok: false, err: String(e && e.message || e) };
                  }
                })()
              `);
              if (extracted?.ok && extracted.url && String(extracted.url).startsWith('http')) {
                finish({
                  ok: true,
                  url: String(extracted.url),
                  mime: extracted.mime || 'audio/mp4',
                  protocol: /m3u8|mpegURL/i.test(extracted.mime || extracted.url)
                    ? 'hls'
                    : 'progressive',
                  client: 'browser-pr',
                });
                return;
              }
              if (extracted?.status) {
                console.log(
                  '[yt-resolve] browser pr',
                  extracted.status,
                  extracted.reason || '',
                  'fmt',
                  extracted.n,
                  'url',
                  extracted.nUrl
                );
              }
              // Trigger media requests
              await win.webContents.executeJavaScript(`
                (function () {
                  try {
                    var v = document.querySelector('video');
                    if (v) {
                      v.muted = true;
                      v.currentTime = 0;
                      var p = v.play();
                      if (p && p.catch) p.catch(function () {});
                      return 'video';
                    }
                    var btn = document.querySelector('button.ytp-large-play-button, button.ytp-play-button, button[aria-label*="Play"]');
                    if (btn) { btn.click(); return 'click'; }
                    return 'none';
                  } catch (e) { return 'err'; }
                })()
              `);
            } catch (e) {
              console.warn('[yt-resolve] browser extract', e?.message || e);
            }
          })();
        });

        await win.loadURL(`https://www.youtube.com/watch?v=${id}&bpctr=9999999999&has_verified=1`, {
          userAgent: CHROME_UA,
          httpReferrer: 'https://www.youtube.com/',
        });
      } catch (e) {
        finish({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  ipcMain.handle('yt-resolve-audio', async (_e, videoId) => {
    try {
      return await ytResolveAudioMain(videoId);
    } catch (e) {
      console.error('[yt-resolve]', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * YouTube / Innertube fetch for renderer (youtubei.js).
   * Renderer window.fetch dies with CORS / "Failed to fetch".
   * Uses Chromium session (SOCKS when mode=all) + direct fallback.
   */
  ipcMain.handle('yt-fetch', async (_e, payload) => {
    const url = String(payload?.url || '');
    if (!/^https:\/\//i.test(url)) {
      throw new Error('yt-fetch: only https — got: ' + url.slice(0, 60));
    }
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error('yt-fetch: bad url: ' + url.slice(0, 80));
    }
    if (!isYtAllowedHost(host)) {
      throw new Error('yt-fetch: host not allowed: ' + host);
    }

    const method = String(payload?.method || 'GET').toUpperCase();
    const headersIn =
      payload?.headers && typeof payload.headers === 'object' ? { ...payload.headers } : {};
    const headers = { ...headersIn };
    // Drop hop-by-hop / forbidden
    for (const k of Object.keys(headers)) {
      if (/^(host|connection|content-length|transfer-encoding|keep-alive|user-agent)$/i.test(k)) {
        delete headers[k];
      }
    }
    headers['User-Agent'] = CHROME_UA;
    if (!headers.Origin && !headers.origin) headers.Origin = 'https://www.youtube.com';
    if (!headers.Referer && !headers.referer) headers.Referer = 'https://www.youtube.com/';

    let body;
    if (payload?.bodyBase64) {
      body = Buffer.from(String(payload.bodyBase64), 'base64');
    } else if (typeof payload?.body === 'string') {
      body = Buffer.from(String(payload.body), 'utf8');
    }

    const doOnce = async (ses, label) => {
      const doFetch =
        typeof ses.fetch === 'function' ? ses.fetch.bind(ses) : net.fetch.bind(net);
      const init = { method, headers };
      if (body != null && method !== 'GET' && method !== 'HEAD') init.body = body;
      const res = await doFetch(url, init);
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      const outHeaders = {};
      try {
        res.headers.forEach((v, k) => {
          outHeaders[String(k).toLowerCase()] = String(v);
        });
      } catch {
        /* ignore */
      }
      console.log(
        '[yt-fetch]',
        label,
        method,
        host,
        '→',
        res.status,
        buf.length,
        'b',
        url.replace(/\?.*/, '').slice(0, 90)
      );
      return {
        status: res.status,
        ok: res.ok,
        url: res.url || url,
        headers: outHeaders,
        bodyBase64: buf.toString('base64'),
        _via: label,
      };
    };

    const attempts = [];
    // Prefer app session first (user SOCKS for all traffic)
    try {
      const r = await doOnce(session.defaultSession, 'proxy');
      attempts.push(`proxy:${r.status}`);
      // Accept any completed HTTP response (incl. 4xx) — youtubei handles status
      return { ...r, _attempts: attempts };
    } catch (e) {
      attempts.push(`proxy-err:${e.message || e}`);
      console.warn('[yt-fetch proxy fail]', method, host, e?.message || e);
    }

    try {
      const r = await doOnce(getDirectMediaSession(), 'direct');
      attempts.push(`direct:${r.status}`);
      return { ...r, _attempts: attempts };
    } catch (e) {
      console.error('[yt-fetch]', method, url.slice(0, 120), e);
      throw new Error(
        `YouTube network failed (${attempts.join(', ') || 'no attempts'}): ${e.message || e}`
      );
    }
  });

  // Quick probe so user/logs show YouTube path is alive after restart
  setTimeout(() => {
    void (async () => {
      try {
        const doFetch =
          typeof session.defaultSession.fetch === 'function'
            ? session.defaultSession.fetch.bind(session.defaultSession)
            : net.fetch.bind(net);
        const res = await doFetch('https://www.youtube.com/', {
          method: 'GET',
          headers: { 'User-Agent': CHROME_UA },
        });
        console.log('[yt-probe] youtube.com →', res.status, 'via session');
      } catch (e) {
        console.warn('[yt-probe] failed', e?.message || e);
      }
    })();
  }, 2500);

  ipcMain.handle('api-fetch', async (_e, payload) => {
    const url = String(payload?.url || '');
    if (!url.startsWith('https://api.soundcloud.com') && !url.startsWith('https://api-v2.soundcloud.com')) {
      throw new Error('api-fetch: only SoundCloud API hosts allowed');
    }
    const method = String(payload?.method || 'GET').toUpperCase();
    const headers =
      payload?.headers && typeof payload.headers === 'object' ? { ...payload.headers } : {};
    let body = null;
    if (payload?.body === '' || typeof payload?.body === 'string') {
      body = String(payload.body);
    }

    // Media / stream exchange: ONE net request only.
    // Page cookies + multi-retry cause 401 / 404 spam / 429 rate-limit.
    const isMedia = url.includes('/media/') || /\/stream\/(progressive|hls)/.test(url);
    const credentialsMode = payload?.credentials === 'omit' || isMedia ? 'omit' : 'include';
    const preferNet = payload?.preferNet === true || isMedia;

    const attempts = [];

    // Media: try proxy session first, then DIRECT (no SOCKS).
    // Many SOCKS setups return empty 404 for /media/* while direct works.
    if (isMedia) {
      const hdrs = {
        Accept: 'application/json',
        Origin: 'https://soundcloud.com',
        Referer: 'https://soundcloud.com/',
        'User-Agent': typeof CHROME_UA !== 'undefined' ? CHROME_UA : 'Mozilla/5.0',
        ...(headers || {}),
      };
      // Prefer direct first when we already know proxy breaks media
      try {
        const rDirect = await fetchMediaViaDirect(url, method, hdrs);
        attempts.push(`direct:${rDirect.status}`);
        if (rDirect.status >= 200 && rDirect.status < 300) {
          return { ...rDirect, _attempts: attempts };
        }
        console.warn('[api-fetch media direct]', method, url.replace(/\?.*/, ''), '→', rDirect.status);
      } catch (e) {
        attempts.push(`direct-err:${e.message || e}`);
        console.warn('[api-fetch media direct fail]', e);
      }
      try {
        const rProxy = await fetchViaNet(url, method, hdrs, body === '' ? undefined : body);
        attempts.push(`proxy:${rProxy.status}`);
        if (rProxy.status >= 400) {
          console.warn('[api-fetch media proxy]', method, url.replace(/\?.*/, ''), '→', rProxy.status);
        }
        return { ...rProxy, _attempts: attempts };
      } catch (e) {
        console.error('[api-fetch media proxy]', method, url, e);
        throw e;
      }
    }

    // Net-first when explicitly requested
    if (preferNet) {
      try {
        const r = await fetchViaNet(url, method, headers, body === '' ? undefined : body);
        attempts.push(`net:${r.status}`);
        if (r.status < 400) {
          return { ...r, _attempts: attempts };
        }
        console.warn('[api-fetch net-first]', method, url.replace(/\?.*/, ''), '→', r.status, (r.body || '').slice(0, 100));
      } catch (e) {
        attempts.push(`net-err:${e.message || e}`);
        console.warn('[api-fetch net-first fail]', e);
      }
    }

    // Page-context fetch (best for likes/reposts / writes)
    try {
      const r = await fetchViaScPage(url, method, headers, body, credentialsMode);
      attempts.push(`page:${r.status}`);
      if (r.status < 400 || r.status === 409 || r.status === 422) {
        return { ...r, _attempts: attempts };
      }
      console.warn('[api-fetch page]', method, url.replace(/\?.*/, ''), '→', r.status, (r.body || '').slice(0, 100));
    } catch (e) {
      attempts.push(`page-err:${e.message || e}`);
      console.warn('[api-fetch page fail]', e);
    }

    // Net fallback
    try {
      const r = await fetchViaNet(url, method, headers, body === '' ? undefined : body);
      attempts.push(`net:${r.status}`);
      if (r.status >= 400) {
        console.warn('[api-fetch net]', method, url.replace(/\?.*/, ''), '→', r.status, (r.body || '').slice(0, 100));
      }
      return { ...r, _attempts: attempts };
    } catch (e) {
      console.error('[api-fetch]', method, url, e);
      throw e;
    }
  });

  // Start local auth helper early (browser login page)
  void ensureAuthServer().catch((e) => console.warn('[auth] server', e));

  // Connect Discord RPC if enabled + client id set
  void discordPresence.initOnStartup().catch((e) => console.warn('[discord]', e));

  createWindow();
  setupMediaShortcuts();
  setupTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  try {
    if (tray) tray.destroy();
  } catch {
    /* ignore */
  }
});

app.on('window-all-closed', () => {
  try {
    if (authServer) authServer.close();
  } catch {
    /* ignore */
  }
  try {
    discordPresence.shutdown();
  } catch {
    /* ignore */
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    discordPresence.shutdown();
  } catch {
    /* ignore */
  }
});
