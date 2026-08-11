import type {
  AuthSession,
  AuthUser,
  LikeItem,
  Playlist,
  SearchResponse,
  SoundCloudUser,
  SubscriptionTier,
  Track,
  TrackComment,
  Transcoding,
} from '../types';

const API = 'https://api-v2.soundcloud.com';
const CLIENT_ID_KEY = 'sc_client_id';
const THEME_KEY = 'sc_theme_accent';
/** Fixed brand accent — sakura ink (not user-customizable). */
export const BRAND_ACCENT = '#c85a8e';

let clientId: string | null = localStorage.getItem(CLIENT_ID_KEY);
let accessToken: string | null = null;
let meUserId: number | null = null;
let resolveInFlight: Promise<string> | null = null;
/** Cached listener tier (free / go / go_plus) for stream quality. */
let subscriptionTier: SubscriptionTier = 'unknown';
let subscriptionLabel: string | null = null;

export function getStoredClientId(): string | null {
  return clientId;
}

export function setClientId(id: string) {
  clientId = id.trim();
  localStorage.setItem(CLIENT_ID_KEY, clientId);
}

export function setAccessToken(token: string | null) {
  if (token) {
    // never store the "OAuth " prefix in memory
    accessToken = token.replace(/^OAuth\s+/i, '').trim();
  } else {
    accessToken = null;
    meUserId = null;
    subscriptionTier = 'unknown';
    subscriptionLabel = null;
  }
}

export function getSubscriptionTier(): SubscriptionTier {
  return subscriptionTier;
}

export function getSubscriptionLabel(): string | null {
  return subscriptionLabel;
}

export function isGoPlus(): boolean {
  return subscriptionTier === 'go_plus' || subscriptionTier === 'go';
}

function parseSubscriptionFromMe(raw: Record<string, unknown>): {
  tier: SubscriptionTier;
  label: string;
} {
  // Heuristics — SC shapes change often
  const badges = (raw.badges || {}) as Record<string, unknown>;
  const subs = (raw.subscriptions || raw.consumer_subscriptions || []) as Array<
    Record<string, unknown>
  >;
  const consumer = (raw.consumer_subscription || raw.subscription || null) as Record<
    string,
    unknown
  > | null;

  const blob = JSON.stringify({ badges, subs, consumer, raw: {
    quota: raw.quota,
    monization: raw.monetization,
  }}).toLowerCase();

  if (
    blob.includes('go_plus') ||
    blob.includes('go-plus') ||
    blob.includes('goplus') ||
    blob.includes('high_tier') ||
    blob.includes('high-tier') ||
    blob.includes('consumer-high') ||
    blob.includes('consumer_high') ||
    blob.includes('"tier":"high"') ||
    blob.includes('tier":"high"')
  ) {
    return { tier: 'go_plus', label: 'SoundCloud Go+' };
  }
  if (
    blob.includes('consumer-mid') ||
    blob.includes('mid_tier') ||
    blob.includes('"go"') ||
    (blob.includes('subscription') && blob.includes('"tier":"mid"'))
  ) {
    return { tier: 'go', label: 'SoundCloud Go' };
  }

  // Active package names
  for (const s of Array.isArray(subs) ? subs : []) {
    const name = String(s.name || s.package || s.product || s.plan || '').toLowerCase();
    const tier = String(s.tier || s.level || '').toLowerCase();
    if (name.includes('go+') || name.includes('go plus') || tier === 'high') {
      return { tier: 'go_plus', label: String(s.name || 'SoundCloud Go+') };
    }
    if (name.includes('go') || tier === 'mid') {
      return { tier: 'go', label: String(s.name || 'SoundCloud Go') };
    }
  }
  if (consumer) {
    const name = String(consumer.name || consumer.product || consumer.plan || '').toLowerCase();
    const tier = String(consumer.tier || '').toLowerCase();
    if (name.includes('go+') || name.includes('plus') || tier === 'high') {
      return { tier: 'go_plus', label: String(consumer.name || 'SoundCloud Go+') };
    }
    if (name.includes('go') || tier === 'mid') {
      return { tier: 'go', label: String(consumer.name || 'SoundCloud Go') };
    }
  }

  return { tier: 'free', label: 'Бесплатный' };
}

/**
 * Detect listener plan (needed for full Go+ catalog + HQ).
 * Uses /me extras and payments endpoints when available.
 */
export async function refreshSubscription(meRaw?: Record<string, unknown>): Promise<{
  tier: SubscriptionTier;
  label: string;
}> {
  if (!accessToken) {
    subscriptionTier = 'free';
    subscriptionLabel = 'Не вошёл';
    return { tier: 'free', label: subscriptionLabel };
  }

  let tier: SubscriptionTier = 'free';
  let label = 'Бесплатный';

  try {
    const me = meRaw || (await apiGet<Record<string, unknown>>('/me'));
    const parsed = parseSubscriptionFromMe(me || {});
    tier = parsed.tier;
    label = parsed.label;
  } catch {
    /* continue */
  }

  // payments endpoints used by web client
  if (tier === 'free') {
    const paths = [
      '/payments/customer',
      '/payments/subscriptions',
      '/me/subscriptions',
    ];
    for (const path of paths) {
      try {
        const data = await apiGet<Record<string, unknown> | Array<Record<string, unknown>>>(path);
        const parsed = parseSubscriptionFromMe(
          Array.isArray(data) ? { subscriptions: data } : (data as Record<string, unknown>) || {}
        );
        if (parsed.tier !== 'free') {
          tier = parsed.tier;
          label = parsed.label;
          break;
        }
      } catch {
        /* next */
      }
    }
  }

  subscriptionTier = tier;
  subscriptionLabel = label;
  return { tier, label };
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setMeUserId(id: number | null) {
  meUserId = id;
}

/** Restore OAuth token from Electron storage if memory is empty. */
export async function ensureAccessToken(): Promise<string> {
  if (accessToken) return accessToken;
  const stored = await loadStoredSession();
  if (stored?.accessToken) {
    setAccessToken(stored.accessToken);
    if (stored.clientId) setClientId(stored.clientId);
    if (stored.user?.id) meUserId = stored.user.id;
    return stored.accessToken;
  }
  throw new Error('Нужен вход — нажми «войти»');
}

export function getThemeAccent(): string {
  return BRAND_ACCENT;
}

/** Text/icon color on solid accent surfaces (black on light yellow/white, white on red/purple). */
function contrastOnAccent(hex: string): string {
  try {
    const { r, g, b } = hexToRgb(hex);
    // WCAG relative luminance
    const lin = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.55 ? '#0a0a0c' : '#ffffff';
  } catch {
    return '#ffffff';
  }
}

/** Apply brand accent CSS vars. Argument ignored — brand color is fixed. */
export function setThemeAccent(_color?: string) {
  const color = BRAND_ACCENT;
  try {
    localStorage.setItem(THEME_KEY, color);
  } catch {
    /* ignore */
  }
  const hover = lighten(color, 14);
  const ink = contrastOnAccent(color);
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-hover', hover);
  document.documentElement.style.setProperty('--accent-ink', ink);
  document.documentElement.style.setProperty('--accent-hover-ink', contrastOnAccent(hover));
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(color, 0.14));
  document.documentElement.style.setProperty('--accent-dim', hexToRgba(color, 0.18));
  // Soft tint for “now playing” rows / focus rings (must not be fully transparent)
  document.documentElement.style.setProperty('--accent-mist', hexToRgba(color, 0.1));
  document.documentElement.style.setProperty('--accent-glow', hexToRgba(color, 0.22));
  document.documentElement.style.setProperty('--accent-2', shiftHue(color, 48));
  document.documentElement.style.setProperty('--accent-2-soft', hexToRgba(shiftHue(color, 48), 0.12));
  document.documentElement.style.setProperty('--accent-3', shiftHue(color, -36));
  document.documentElement.style.setProperty('--accent-3-soft', hexToRgba(shiftHue(color, -36), 0.1));
}

/** Rotate hue of a hex color (degrees). */
function shiftHue(hex: string, deg: number): string {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    switch (max) {
      case rr:
        h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
        break;
      case gg:
        h = ((bb - rr) / d + 2) / 6;
        break;
      default:
        h = ((rr - gg) / d + 4) / 6;
    }
  }
  h = (h * 360 + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) {
    rp = c;
    gp = x;
  } else if (h < 120) {
    rp = x;
    gp = c;
  } else if (h < 180) {
    gp = c;
    bp = x;
  } else if (h < 240) {
    gp = x;
    bp = c;
  } else if (h < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }
  const to = (v: number) => Math.round((v + m) * 255);
  return rgbToHex(to(rp), to(gp), to(bp));
}

function lighten(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const n = (v: number) => Math.min(255, Math.round(v + (255 - v) * (amount / 100)));
  return rgbToHex(n(r), n(g), n(b));
}

function hexToRgb(hex: string) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgba(hex: string, a: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export async function resolveClientId(): Promise<string> {
  if (clientId) {
    const ok = await validateClientId(clientId);
    if (ok) return clientId;
  }
  if (resolveInFlight) return resolveInFlight;
  resolveInFlight = doResolveClientId().finally(() => {
    resolveInFlight = null;
  });
  return resolveInFlight;
}

async function doResolveClientId(): Promise<string> {
  // Prefer Electron main (uses system proxy + asset scrape + cache)
  if (window.electronAPI?.resolveClientId) {
    try {
      const id = await window.electronAPI.resolveClientId();
      if (id) {
        // Accept ID from main even if renderer can't validate (CORS/proxy differ)
        if (await validateClientId(id)) {
          setClientId(id);
          return id;
        }
        setClientId(id);
        return id;
      }
    } catch (e) {
      console.warn('[client_id] electron resolve failed', e);
    }
  }

  const candidates: string[] = [];
  try {
    const html = await fetch('https://soundcloud.com/', {
      headers: {
        Accept: 'text/html',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    }).then((r) => r.text());
    const scriptUrls = [
      ...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
      ...html.matchAll(/src="(https:\/\/[^"]+sndcdn\.com\/assets\/[^"]+\.js)"/g),
    ].map((m) => m[1]);
    for (const url of [...new Set(scriptUrls)].slice(0, 20)) {
      try {
        const js = await fetch(url).then((r) => r.text());
        for (const m of js.matchAll(/client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,40})["']/gi)) {
          candidates.push(m[1]);
        }
        for (const m of js.matchAll(/clientId["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,40})["']/gi)) {
          candidates.push(m[1]);
        }
      } catch {
        /* skip */
      }
      if (candidates.length) break;
    }
  } catch {
    /* network */
  }

  for (const id of [...new Set(candidates)]) {
    if (await validateClientId(id)) {
      setClientId(id);
      return id;
    }
  }

  if (clientId) return clientId;
  throw new Error(
    'Не удалось получить client_id. Проверь прокси или вставь client_id в Настройки → Дополнительно (soundcloud.com → F12 → Network → client_id).'
  );
}

async function validateClientId(id: string): Promise<boolean> {
  try {
    // Prefer Electron net (proxy-aware, no CORS)
    if (window.electronAPI?.apiFetch) {
      const r = await window.electronAPI.apiFetch({
        url: `${API}/search/tracks?q=test&client_id=${encodeURIComponent(id)}&limit=1`,
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      return Boolean(r?.ok);
    }
    const res = await fetch(
      `${API}/search/tracks?q=test&client_id=${encodeURIComponent(id)}&limit=1`,
      { headers: { Accept: 'application/json' } }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureClientId(): Promise<string> {
  if (clientId && (await validateClientId(clientId))) return clientId;
  return resolveClientId();
}

function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  return sp.toString();
}

function authHeaders(): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (accessToken) h.Authorization = `OAuth ${accessToken}`;
  return h;
}

async function apiGet<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined | null> = {},
  opts?: { noAuth?: boolean }
): Promise<T> {
  const id = await ensureClientId();
  const query = qs({ ...params, client_id: id });
  const url = path.startsWith('http')
    ? `${path}${path.includes('?') ? '&' : '?'}${qs({ client_id: id })}`
    : `${API}${path}?${query}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/',
  };
  // OAuth on track metadata can return media paths that 404 without the same session —
  // stream refresh uses noAuth when possible.
  if (!opts?.noAuth && accessToken) {
    headers.Authorization = `OAuth ${accessToken}`;
  }

  const res = await fetch(url, { headers, credentials: 'omit' });
  if (!res.ok) {
    if (res.status === 401 && !opts?.noAuth) {
      throw new Error('Сессия истекла. Войди в аккаунт заново.');
    }
    if (res.status === 403) {
      throw new Error('Нет доступа (403). Возможно, нужен вход в аккаунт.');
    }
    throw new Error(`API ${res.status}: ${path}`);
  }
  return res.json();
}

export async function fetchNext<T>(nextHref: string): Promise<SearchResponse<T>> {
  return apiGet<SearchResponse<T>>(nextHref);
}

/* ---------- Auth helpers ---------- */

export async function loadStoredSession(): Promise<AuthSession | null> {
  if (!window.electronAPI?.authGet) return null;
  const session = await window.electronAPI.authGet();
  if (!session?.accessToken) return null;
  setAccessToken(session.accessToken);
  if (session.clientId) setClientId(session.clientId);
  if (session.user?.id) setMeUserId(session.user.id);
  return session;
}

/** In-app SoundCloud window (default) or external browser helper (`mode: 'browser'`). */
export async function loginWithSoundCloud(
  opts?: { mode?: 'app' | 'browser' }
): Promise<AuthSession> {
  if (!window.electronAPI?.authLogin) {
    throw new Error('Вход доступен только в Electron-приложении');
  }
  const session = await window.electronAPI.authLogin(opts);
  if (!session?.accessToken) throw new Error('Не удалось войти');
  setAccessToken(session.accessToken);
  if (session.clientId) setClientId(session.clientId);
  return session;
}

export async function logout(): Promise<void> {
  setAccessToken(null);
  await window.electronAPI?.authLogout?.();
}

export async function getMe(): Promise<AuthUser> {
  const me = await apiGet<AuthUser & Record<string, unknown>>('/me');
  if (me?.id) meUserId = me.id;
  try {
    const sub = await refreshSubscription(me as Record<string, unknown>);
    me.subscription_tier = sub.tier;
    me.subscription_label = sub.label;
  } catch {
    me.subscription_tier = subscriptionTier;
    me.subscription_label = subscriptionLabel || undefined;
  }
  return me;
}

/* ---------- Search ---------- */

export async function searchTracks(query: string, limit = 24, offset = 0): Promise<SearchResponse<Track>> {
  return apiGet('/search/tracks', { q: query, limit, offset, app_locale: 'en' });
}

export async function searchPlaylists(query: string, limit = 24, offset = 0): Promise<SearchResponse<Playlist>> {
  return apiGet('/search/playlists', { q: query, limit, offset, app_locale: 'en' });
}

export async function searchUsers(query: string, limit = 24, offset = 0): Promise<SearchResponse<SoundCloudUser>> {
  return apiGet('/search/users', { q: query, limit, offset, app_locale: 'en' });
}

export async function searchAll(query: string, limit = 12) {
  const [tracks, playlists, users] = await Promise.all([
    searchTracks(query, limit),
    searchPlaylists(query, limit),
    searchUsers(query, limit),
  ]);
  return { tracks, playlists, users };
}

/* ---------- Tracks / stream ---------- */

/** Batch fetch tracks by id — often works when single `/tracks/:id` returns 404. */
export async function getTracksByIds(ids: Array<number | string>): Promise<Track[]> {
  const clean = [...new Set(ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!clean.length) return [];
  const map = new Map<number, Track>();
  const chunkSize = 50;
  for (let i = 0; i < clean.length; i += chunkSize) {
    const batch = clean.slice(i, i + chunkSize);
    try {
      const res = await apiGet<Track[] | { collection?: Track[] }>('/tracks', {
        ids: batch.join(','),
      });
      const list = Array.isArray(res) ? res : res.collection || [];
      for (const t of list) {
        if (t?.id) map.set(Number(t.id), t);
      }
    } catch {
      /* try one-by-one soft */
      await Promise.all(
        batch.map(async (id) => {
          try {
            const t = await apiGet<Track>(`/tracks/${id}`);
            if (t?.id) map.set(Number(t.id), t);
          } catch {
            /* dead */
          }
        })
      );
    }
  }
  return clean.map((id) => map.get(id)).filter(Boolean) as Track[];
}

function trackHasMedia(t: Track | null | undefined): t is Track {
  return Boolean(t?.id && t.media?.transcodings?.length);
}

function trackHasMeta(t: Track | null | undefined): t is Track {
  return Boolean(t?.id && (t.title || t.media?.transcodings?.length));
}

/**
 * Full track object with fallbacks.
 * Some chart / mix / geo-gated tracks 404 on `/tracks/:id` but work via
 * `?ids=` batch, URN, secret_token, widget, or permalink resolve.
 * Prefers responses that include media.transcodings (needed for playback).
 */
export async function getTrack(
  trackId: number | string,
  opts?: {
    urn?: string;
    permalink_url?: string;
    secret_token?: string | null;
    track_authorization?: string | null;
    /** Prefer throwing if no media rather than returning meta-only */
    requireMedia?: boolean;
  }
): Promise<Track> {
  const id = Number(trackId);
  const secret = opts?.secret_token || undefined;
  const trackAuth = opts?.track_authorization || undefined;
  const errors: string[] = [];
  let best: Track | null = null;

  const consider = (t: Track | null | undefined) => {
    if (!trackHasMeta(t)) return null;
    if (trackHasMedia(t)) return t;
    if (!best) best = t;
    else if (!best.title && t.title) best = t;
    return null; // keep searching for media
  };

  const tryGet = async (label: string, fn: () => Promise<Track | null | undefined>): Promise<Track | null> => {
    try {
      return consider(await fn());
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const baseParams: Record<string, string | number | boolean | undefined | null> = {};
  if (secret) baseParams.secret_token = secret;
  if (trackAuth) baseParams.track_authorization = trackAuth;

  // 1) Classic single-track (+ auth params)
  if (Number.isFinite(id) && id > 0) {
    const t = await tryGet('single', () => apiGet<Track>(`/tracks/${id}`, baseParams));
    if (t) return t;
  }

  // 2) Batch ids (works for many “404 singles” and mini playlist entries)
  if (Number.isFinite(id) && id > 0) {
    const t = await tryGet('batch', async () => {
      const list = await getTracksByIds([id]);
      return list[0] || null;
    });
    if (t) return t;
  }

  // 3) URN path
  const urn =
    opts?.urn ||
    (Number.isFinite(id) && id > 0 ? `soundcloud:tracks:${id}` : undefined);
  if (urn) {
    const t = await tryGet('urn', () =>
      apiGet<Track>(`/tracks/${encodeURIComponent(urn)}`, baseParams)
    );
    if (t) return t;
  }

  // 4) Permalink resolve (api-v2)
  if (opts?.permalink_url) {
    const t = await tryGet('resolve', async () => {
      const resolved = await resolveUrl(opts.permalink_url!);
      if (resolved && typeof resolved === 'object' && 'id' in resolved) {
        return resolved as Track;
      }
      return null;
    });
    if (t) return t;
  }

  // 5) Widget resolve — often returns full media when api-v2 track is sparse
  if (opts?.permalink_url || (Number.isFinite(id) && id > 0)) {
    const t = await tryGet('widget', async () => {
      const permalink =
        opts?.permalink_url ||
        (best as Track | null)?.permalink_url ||
        undefined;
      return fetchTrackViaWidget(id, permalink);
    });
    if (t) return t;
  }

  // 6) Electron page-context fetch (same cookies/OAuth as browser when available)
  if (Number.isFinite(id) && id > 0 && window.electronAPI?.apiFetch) {
    const t = await tryGet('page', async () => fetchTrackViaPage(id, baseParams));
    if (t) return t;
  }

  if (best && !opts?.requireMedia) return best;

  throw new Error(
    `Трек #${trackId} недоступен (удалён, регион, Go+ или приватный). ${errors[0] || ''}`.trim()
  );
}

/** Widget API often still exposes media.transcodings when tracks endpoint is sparse. */
async function fetchTrackViaWidget(trackId: number, permalink?: string): Promise<Track | null> {
  const cid = await ensureClientId();
  const urls: string[] = [];
  if (permalink) {
    urls.push(
      `https://api-widget.soundcloud.com/resolve?url=${encodeURIComponent(permalink)}&format=json&client_id=${encodeURIComponent(cid)}`
    );
  }
  if (Number.isFinite(trackId) && trackId > 0) {
    urls.push(
      `https://api-widget.soundcloud.com/resolve?url=${encodeURIComponent(`https://api.soundcloud.com/tracks/${trackId}`)}&format=json&client_id=${encodeURIComponent(cid)}`
    );
    urls.push(
      `https://api-widget.soundcloud.com/resolve?url=${encodeURIComponent(`https://soundcloud.com/tracks/${trackId}`)}&format=json&client_id=${encodeURIComponent(cid)}`
    );
  }

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Origin: 'https://soundcloud.com',
          Referer: 'https://soundcloud.com/',
          ...authHeaders(),
        },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Track & { kind?: string };
      if (data?.id && (data.kind === 'track' || data.title || data.media)) {
        return data as Track;
      }
    } catch {
      /* next */
    }
  }
  return null;
}

/** Fetch track via Electron net/page context (helps with session-bound tracks). */
async function fetchTrackViaPage(
  trackId: number,
  params: Record<string, string | number | boolean | undefined | null>
): Promise<Track | null> {
  if (!window.electronAPI?.apiFetch) return null;
  const cid = await ensureClientId();
  const query = qs({ ...params, client_id: cid });
  const url = `${API}/tracks/${trackId}?${query}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/',
  };
  if (accessToken) headers.Authorization = `OAuth ${accessToken}`;
  const r = await window.electronAPI.apiFetch({ url, method: 'GET', headers });
  if (r.status < 200 || r.status >= 300 || !r.body) return null;
  try {
    const data = JSON.parse(r.body) as Track;
    return data?.id ? data : null;
  } catch {
    return null;
  }
}

/** Merge a partial list-item track with a full API track, keeping auth fields. */
export function mergeTrack(base: Track, full: Track): Track {
  const b = base as Track & { policy?: string; monetization_model?: string | null };
  const f = full as Track & { policy?: string; monetization_model?: string | null };
  return {
    ...base,
    ...full,
    // Prefer richer media
    media: full.media?.transcodings?.length ? full.media : base.media || full.media,
    track_authorization: full.track_authorization || base.track_authorization,
    user: full.user || base.user,
    artwork_url: full.artwork_url || base.artwork_url,
    title: full.title || base.title,
    permalink_url: full.permalink_url || base.permalink_url,
    // Keep SNIP/Go+ markers if either side has them
    policy: f.policy || b.policy,
    monetization_model: f.monetization_model ?? b.monetization_model,
  };
}

/**
 * Ensure track has playable media.transcodings.
 * Keeps track_authorization from the original list item when present.
 */
export async function ensureTrackForStream(track: Track): Promise<Track> {
  if (trackHasMedia(track)) return track;

  const partial = track as Track & { secret_token?: string | null };
  const mergedOpts = {
    urn: track.urn,
    permalink_url: track.permalink_url,
    secret_token: partial.secret_token,
    track_authorization: track.track_authorization,
    requireMedia: true as const,
  };

  try {
    const full = await getTrack(track.id, mergedOpts);
    const merged = mergeTrack(track, full);
    if (trackHasMedia(merged)) return merged;
  } catch {
    /* try softer path */
  }

  // Soft: accept meta + any later stream strategy
  try {
    const full = await getTrack(track.id, { ...mergedOpts, requireMedia: false });
    return mergeTrack(track, full);
  } catch (e) {
    try {
      const list = await getTracksByIds([track.id]);
      if (list[0]) return mergeTrack(track, list[0]);
    } catch {
      /* fall through */
    }
    throw e;
  }
}

export async function resolveUrl(url: string): Promise<Track | Playlist | SoundCloudUser> {
  return apiGet('/resolve', { url });
}

export async function getRelatedTracks(trackId: number, limit = 40, offset = 0): Promise<SearchResponse<Track>> {
  const raw = await apiGet<{ collection?: Array<Track | { track?: Track }>; next_href?: string | null }>(
    `/tracks/${trackId}/related`,
    { limit, offset }
  );
  const collection = normalizeTrackList(raw.collection || []);
  return { collection, next_href: raw.next_href ?? null };
}

/** Build a radio-style station from a seed track (like SC “Start station”). */
export async function getStationTracks(seed: Track, limit = 40): Promise<Track[]> {
  const seen = new Set<number>([seed.id]);
  const out: Track[] = [seed];

  const pushMany = (list: Track[]) => {
    for (const t of list) {
      if (!t?.id || !t.title || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= limit + 1) break;
    }
  };

  // 1) Official related (closest to browser “station”)
  try {
    const related = await getRelatedTracks(seed.id, limit);
    pushMany(related.collection);
  } catch {
    /* try fallbacks */
  }

  // 2) Track-station playlist used by the web app
  if (out.length < 8) {
    const stationKeys = [
      `soundcloud:system-playlists:track-stations:${seed.id}`,
      `soundcloud:track-stations:${seed.id}`,
    ];
    for (const key of stationKeys) {
      try {
        const raw = await apiGet<{ collection?: Array<Track | { track?: Track }> }>(
          `/stations/${encodeURIComponent(key)}/tracks`,
          { limit, offset: 0 }
        );
        pushMany(normalizeTrackList(raw.collection || []));
        if (out.length >= 8) break;
      } catch {
        /* next key */
      }
    }
  }

  // 3) Same artist as soft fallback
  if (out.length < 5 && seed.user?.id) {
    try {
      const more = await getUserTracks(seed.user.id, 20);
      pushMany((more.collection || []).filter((t) => t.id !== seed.id));
    } catch {
      /* ignore */
    }
  }

  if (out.length < 2) {
    throw new Error('Не удалось собрать станцию по этому треку');
  }

  return out;
}

/** More related tracks to keep a station going. */
export async function extendStation(fromTrack: Track, excludeIds: Set<number>, limit = 20): Promise<Track[]> {
  try {
    const related = await getRelatedTracks(fromTrack.id, limit + 10);
    return related.collection.filter((t) => t?.id && t.title && !excludeIds.has(t.id)).slice(0, limit);
  } catch {
    return [];
  }
}

function normalizeTrackList(collection: Array<Track | { track?: Track }>): Track[] {
  const out: Track[] = [];
  for (const item of collection) {
    if (!item) continue;
    if ('title' in item && (item as Track).id && (item as Track).title) {
      out.push(item as Track);
    } else if ('track' in item && item.track?.id && item.track.title) {
      out.push(item.track);
    }
  }
  return out;
}

function onlySnipped(track: Track): boolean {
  const list = track.media?.transcodings ?? [];
  if (!list.length) return true;
  return list.every((t) => t.snipped);
}

export type StreamPrefs = {
  /** Prefer HQ when Go+ (still progressive-first for reliability). */
  preferHq?: boolean;
  /** Only progressive HTTP MP3 — skip HLS (used after hls.js failure). */
  forceProgressive?: boolean;
  /** Only HLS (rare). */
  forceHls?: boolean;
};

function isEncryptedProtocol(proto: string): boolean {
  const p = proto.toLowerCase();
  return p.includes('encrypted') || p.includes('cbcs') || p.includes('sample-aes');
}

/**
 * Order media formats for Electron:
 * 1) progressive MP3 (classic, no DRM)
 * 2) plain HLS (mp3/aac) — works with hls.js
 * 3) encrypted HLS last — often FairPlay (skd://) and unplayable in Electron
 *
 * Note: many 2024–2026 SC tracks list progressive/mp3 that 404; real stream is encrypted-only.
 */
function orderedTranscodings(track: Track, prefs: StreamPrefs = {}): Transcoding[] {
  let list = (track.media?.transcodings ?? []).filter((t) => t?.url);
  if (!list.length) return [];

  if (prefs.forceProgressive) {
    list = list.filter((t) => (t.format?.protocol || '') === 'progressive');
  } else if (prefs.forceHls) {
    list = list.filter((t) => {
      const p = t.format?.protocol || '';
      return p === 'hls' || isEncryptedProtocol(p);
    });
  }

  const hasFull = list.some((t) => !t.snipped);

  const score = (t: Transcoding): number => {
    const proto = (t.format?.protocol || '').toLowerCase();
    const mime = (t.format?.mime_type || '').toLowerCase();
    const preset = (t.preset || '').toLowerCase();
    let s = 0;
    if (!t.snipped) s += 50;
    else if (hasFull) s -= 80;

    if (proto === 'progressive') s += 200; // try first; may 404 on new catalog
    else if (proto === 'hls' && !isEncryptedProtocol(proto)) s += 180; // plain HLS
    // Encrypted: prefer CTR/CENC (Widevine+PlayReady) over CBC/FairPlay (Apple)
    else if (proto.includes('ctr-encrypted') || proto.includes('cenc')) s += 50;
    else if (isEncryptedProtocol(proto)) s += 25;
    else s += 40;

    // Within HLS, prefer simple mp3 over abr packages that 404
    if (preset.includes('mp3')) s += 30;
    if (preset.includes('aac_160')) s += 20;
    if (preset.includes('aac_96')) s += 12;
    if (preset.includes('abr')) s -= 40;
    if (mime.includes('mpeg') && !mime.includes('mpegurl')) s += 10;
    return s;
  };

  return [...list].sort((a, b) => score(b) - score(a));
}

function trackHasPlayableFormat(track: Track): boolean {
  const list = track.media?.transcodings ?? [];
  return list.some((t) => {
    const p = (t.format?.protocol || '').toLowerCase();
    return p === 'progressive' || p === 'hls';
  });
}

/** DRM license servers for Shaka / EME (Widevine path via Castlabs Electron). */
export type DrmConfig = {
  servers: Record<string, string>;
  /** Prefer audio-only robustness for music */
  audioRobustness?: string;
};

export interface StreamInfo {
  url: string;
  protocol: string;
  mimeType: string;
  /** True when only 30s preview was available */
  snipped?: boolean;
  /** Which SC media preset was used */
  preset?: string;
  /** Set when stream is encrypted HLS (needs Widevine CDM + license) */
  drm?: DrmConfig;
}

/** SoundCloud multi-DRM license endpoints (from PlayReady LA_URL / SC web). */
export const SC_DRM_SERVERS: Record<string, string> = {
  'com.widevine.alpha': 'https://license.media-streaming.soundcloud.cloud/playback/widevine',
  'com.microsoft.playready': 'https://license.media-streaming.soundcloud.cloud/playback/playready',
};

/** Last media-exchange diagnostics (for user-facing errors). */
let lastStreamExchangeError: string | null = null;

function buildMediaExchangeUrl(
  baseUrl: string,
  params: Record<string, string | undefined | null>
): string {
  // Manual query append — avoid URL() re-encoding path colons in edge cases
  const base = String(baseUrl || '').split('#')[0] || '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  if (!parts.length) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${parts.join('&')}`;
}

function parseStreamJson(body: string, tc: Transcoding): StreamInfo | null {
  try {
    const data = JSON.parse(body) as { url?: string; redirectUri?: string };
    const url = data?.url || data?.redirectUri;
    if (!url || typeof url !== 'string') return null;
    return {
      url,
      protocol: tc.format?.protocol || 'progressive',
      mimeType: tc.format?.mime_type || 'audio/mpeg',
      preset: tc.preset,
    };
  } catch {
    return null;
  }
}

/**
 * Exchange one media/transcoding URL → signed CDN URL.
 * Prefer Electron direct session (bypasses SOCKS that 404s /media/*).
 */
async function exchangeTranscodingUrl(
  tc: Transcoding,
  track: Track
): Promise<StreamInfo | null> {
  if (!tc?.url) return null;
  const clientId = await ensureClientId();
  const trackAuth = track.track_authorization || undefined;
  const token = accessToken || undefined;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/',
  };

  const urls: Array<{ label: string; url: string }> = [];
  // Plain client_id first (works for free catalog; matches PowerShell probe)
  urls.push({
    label: 'cid',
    url: buildMediaExchangeUrl(tc.url, { client_id: clientId }),
  });
  if (trackAuth) {
    urls.push({
      label: 'cid+ta',
      url: buildMediaExchangeUrl(tc.url, {
        client_id: clientId,
        track_authorization: trackAuth,
      }),
    });
  }
  // OAuth only if needed (Go+) — after plain fails
  if (token) {
    urls.push({
      label: 'cid+oauth',
      url: buildMediaExchangeUrl(tc.url, {
        client_id: clientId,
        oauth_token: token,
        ...(trackAuth ? { track_authorization: trackAuth } : {}),
      }),
    });
  }

  const statuses: string[] = [];

  for (const v of urls) {
    // Electron first: main process can bypass SOCKS for /media/*
    if (window.electronAPI?.apiFetch && v.url.startsWith('https://api-v2.soundcloud.com')) {
      try {
        const r = await window.electronAPI.apiFetch({
          url: v.url,
          method: 'GET',
          headers,
          preferNet: true,
          credentials: 'omit',
        });
        statuses.push(`e/${v.label}:${r.status}`);
        if (r.status === 429) {
          lastStreamExchangeError = statuses.join(', ') + ' (rate limit)';
          return null;
        }
        if (r.status >= 200 && r.status < 300 && r.body) {
          const info = parseStreamJson(r.body, tc);
          if (info) {
            lastStreamExchangeError = null;
            return info;
          }
        }
      } catch {
        statuses.push(`e/${v.label}:err`);
      }
    }

    // Renderer fallback (also proxied — may 404)
    try {
      const res = await fetch(v.url, { headers, credentials: 'omit' });
      statuses.push(`r/${v.label}:${res.status}`);
      if (res.status === 429) {
        lastStreamExchangeError = statuses.join(', ') + ' (rate limit)';
        return null;
      }
      if (res.ok) {
        const info = parseStreamJson(await res.text(), tc);
        if (info) {
          lastStreamExchangeError = null;
          return info;
        }
      }
    } catch {
      statuses.push(`r/${v.label}:net`);
    }
  }

  lastStreamExchangeError = statuses.slice(0, 8).join(', ') || 'no attempts';
  return null;
}

/** Load fresh track + media without OAuth (public client_id) so media URLs exchange cleanly. */
async function refreshTrackForStream(track: Track): Promise<Track> {
  const id = Number(track.id);
  if (!Number.isFinite(id) || id <= 0) return track;

  // 1) Public batch (no OAuth) — same path as working PowerShell probe
  try {
    const res = await apiGet<Track[] | { collection?: Track[] }>(
      '/tracks',
      { ids: String(id) },
      { noAuth: true }
    );
    const list = Array.isArray(res) ? res : res.collection || [];
    if (list[0] && trackHasMedia(list[0])) return mergeTrack(track, list[0]);
    if (list[0]) track = mergeTrack(track, list[0]);
  } catch {
    /* continue */
  }

  // 2) Public single
  try {
    const fresh = await apiGet<Track>(`/tracks/${id}`, {}, { noAuth: true });
    if (trackHasMedia(fresh)) return mergeTrack(track, fresh);
    if (fresh?.id) track = mergeTrack(track, fresh);
  } catch {
    /* continue */
  }

  // 3) Authenticated getTrack (Go+ / private)
  try {
    const authed = await getTrack(id, {
      urn: track.urn,
      permalink_url: track.permalink_url,
      track_authorization: track.track_authorization,
      requireMedia: false,
    });
    if (trackHasMedia(authed)) return mergeTrack(track, authed);
    if (authed?.id) track = mergeTrack(track, authed);
  } catch {
    /* continue */
  }

  // 4) Widget
  try {
    const w = await fetchTrackViaWidget(id, track.permalink_url);
    if (w && trackHasMedia(w)) return mergeTrack(track, w);
    if (w) track = mergeTrack(track, w);
  } catch {
    /* continue */
  }

  return track;
}

/**
 * Resolve a playable stream URL for a track.
 * Progressive first; refresh media URLs before exchange (list cards go stale → 404).
 */
export async function getStreamInfo(track: Track, prefs: StreamPrefs = {}): Promise<StreamInfo> {
  try {
    await ensureAccessToken();
  } catch {
    /* guest */
  }

  // ALWAYS refresh media before exchange — shelf/mix UUIDs frequently 404
  let full = await refreshTrackForStream(track);

  if (!trackHasMedia(full)) {
    full = await ensureTrackForStream(full);
  }

  const policy = (full as Track & { policy?: string }).policy;
  if (policy === 'BLOCK') {
    throw new Error('Трек заблокирован в вашем регионе');
  }
  if (full.streamable === false && !trackHasMedia(full)) {
    throw new Error('Трек помечен как недоступный для стрима');
  }
  if (!trackHasMedia(full)) {
    throw new Error('Нет media у трека — SC не отдал поток (регион / удалён / Go+)');
  }

  const streamPrefs: StreamPrefs = {
    preferHq: false, // progressive reliability over HQ HLS
    forceProgressive: prefs.forceProgressive,
    forceHls: prefs.forceHls,
  };

  // Pass 1: progressive + plain HLS only (playable in Electron)
  // Pass 2: encrypted formats (may be FairPlay — often unusable here)
  const all = orderedTranscodings(full, streamPrefs);
  const clear = all.filter((t) => !isEncryptedProtocol(t.format?.protocol || ''));
  const encrypted = all.filter((t) => isEncryptedProtocol(t.format?.protocol || ''));
  let candidates = (prefs.forceProgressive ? clear.filter((t) => t.format?.protocol === 'progressive') : clear).slice(
    0,
    6
  );
  if (!candidates.length && prefs.forceProgressive) {
    throw new Error('Нет progressive-потока');
  }
  if (!candidates.length) {
    candidates = all.slice(0, 6);
  }

  const errors: string[] = [];

  const tryList = async (list: Transcoding[]) => {
    for (const tc of list) {
      const info = await exchangeTranscodingUrl(tc, full);
      if (info) {
        info.preset = tc.preset;
        if (tc.snipped && onlySnipped(full)) info.snipped = true;
        return info;
      }
      if ((lastStreamExchangeError || '').includes('429') || (lastStreamExchangeError || '').includes('rate limit')) {
        throw new Error(
          'SoundCloud временно ограничил запросы (429). Подожди 20–30 сек и попробуй снова.'
        );
      }
      errors.push(`${tc.format?.protocol || '?'}/${tc.preset || '?'}`);
    }
    return null;
  };

  const clearHit = await tryList(candidates);
  if (clearHit) return clearHit;

  // Encrypted-only catalog — not playable without Widevine CDM.
  // Open-source / GitHub build intentionally does NOT ship DRM (see docs/WIDEVINE.md).
  if (encrypted.length > 0) {
    const title = full.title ? `«${full.title}»` : 'Этот трек';
    throw new Error(
      `${title} только с DRM (encrypted HLS). В miura без Widevine не играет — ` +
        `так устроен каталог SC. Обычные треки с MP3/HLS работают. ` +
        `На soundcloud.com этот трек откроется в их плеере.`
    );
  }

  const diag = lastStreamExchangeError ? ` [${lastStreamExchangeError}]` : '';
  throw new Error(
    `Нет открытого аудиопотока (${errors.slice(0, 4).join(', ') || 'empty'}).${diag}`
  );
}

/** OAuth token for DRM license requests (optional but helps Go+). */
export function getOAuthTokenForDrm(): string | null {
  return accessToken;
}

/* ---------- Playlists / mixes ---------- */

/** Fetch full track objects for mini/partial entries (common in mixes & playlists). */
export async function hydrateTracks(tracks: Track[] | undefined | null): Promise<Track[]> {
  if (!tracks?.length) return [];
  const withId = tracks.filter((t) => t && t.id);
  // Need full media for playback, not only title/user
  const needIds = withId
    .filter((t) => !t.title || !t.user || !t.media?.transcodings?.length)
    .map((t) => t.id);
  if (!needIds.length) {
    return withId.filter((t) => t.title);
  }

  const fetched = await getTracksByIds(needIds);
  const map = new Map<number, Track>();
  for (const t of fetched) {
    if (t?.id) map.set(Number(t.id), t);
  }

  const out: Track[] = [];
  const seen = new Set<number>();
  for (const t of withId) {
    const full = map.get(Number(t.id));
    const merged = full ? mergeTrack(t, full) : t;
    if (!merged?.id || !merged.title || seen.has(Number(merged.id))) continue;
    seen.add(Number(merged.id));
    out.push(merged);
  }
  return out;
}

function isSystemPlaylistRef(pl: {
  id?: number | string;
  urn?: string;
  kind?: string;
  is_system?: boolean;
}): boolean {
  if (pl.is_system) return true;
  if (pl.kind === 'system-playlist' || pl.kind === 'system_playlist') return true;
  const urn = String(pl.urn || '');
  if (urn.includes('system-playlists')) return true;
  const id = String(pl.id ?? '');
  if (id.includes('system-playlists') || id.includes(':')) return true;
  return false;
}

function systemPlaylistKey(pl: { id?: number | string; urn?: string }): string {
  if (pl.urn) return pl.urn;
  const id = String(pl.id ?? '');
  if (id.startsWith('soundcloud:')) return id;
  return `soundcloud:system-playlists:${id}`;
}

export async function getSystemPlaylist(urnOrId: string): Promise<Playlist> {
  const key = urnOrId.startsWith('soundcloud:')
    ? urnOrId
    : urnOrId.includes('system-playlists')
      ? urnOrId
      : `soundcloud:system-playlists:${urnOrId}`;

  const attempts = [
    `/system-playlists/${encodeURIComponent(key)}`,
    `/system-playlists/${encodeURIComponent(key.replace(/^soundcloud:system-playlists:/, ''))}`,
  ];

  let lastErr: Error | null = null;
  for (const path of attempts) {
    try {
      const full = await apiGet<Playlist>(path, { representation: 'full' });
      let tracks = await hydrateTracks(full.tracks || []);
      // Drop dead / non-streamable entries so mixes don't half-fail on play
      tracks = tracks.filter(
        (t) =>
          t?.id &&
          t?.title &&
          t.streamable !== false &&
          (t.media?.transcodings?.length || t.policy !== 'BLOCK')
      );
      // Prefer tracks that already have media (full stream resolved)
      const withMedia = tracks.filter((t) => t.media?.transcodings?.length);
      if (withMedia.length >= Math.min(5, tracks.length) && withMedia.length < tracks.length) {
        // Keep media-first order: playable first, rest after
        const ids = new Set(withMedia.map((t) => t.id));
        tracks = [...withMedia, ...tracks.filter((t) => !ids.has(t.id))];
      }
      return {
        ...full,
        tracks,
        track_count: tracks.length || full.track_count,
        is_system: true,
        kind: full.kind || 'system-playlist',
        urn: full.urn || key,
        user:
          full.user ||
          ({
            id: 0,
            username: 'SoundCloud',
            avatar_url: '',
            permalink_url: 'https://soundcloud.com',
          } as SoundCloudUser),
      };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error('Не удалось загрузить микс');
}

/** Load a regular playlist or a Discover mix (system playlist). */
export async function getPlaylist(
  playlistId: number | string,
  opts?: { urn?: string; kind?: string; is_system?: boolean }
): Promise<Playlist> {
  const ref = {
    id: playlistId,
    urn: opts?.urn,
    kind: opts?.kind,
    is_system: opts?.is_system,
  };

  if (isSystemPlaylistRef(ref)) {
    return getSystemPlaylist(systemPlaylistKey(ref));
  }

  try {
    const full = await apiGet<Playlist>(`/playlists/${playlistId}`, { representation: 'full' });
    const tracks = await hydrateTracks(full.tracks || []);
    return {
      ...full,
      tracks,
      track_count: tracks.length || full.track_count,
    };
  } catch (e) {
    // maybe it was a system mix mis-detected as regular playlist
    if (opts?.urn || typeof playlistId === 'string') {
      return getSystemPlaylist(systemPlaylistKey(ref));
    }
    throw e;
  }
}

/** Convenience: open whatever came from home shelves. */
export async function resolvePlaylist(pl: Playlist): Promise<Playlist> {
  return getPlaylist(pl.id, {
    urn: pl.urn,
    kind: pl.kind,
    is_system: pl.is_system,
  });
}

export async function getUserPlaylists(userId: number, limit = 50, offset = 0): Promise<SearchResponse<Playlist>> {
  return apiGet(`/users/${userId}/playlists`, { limit, offset, representation: 'mini' });
}

export async function getMyPlaylists(limit = 50, offset = 0): Promise<SearchResponse<Playlist>> {
  return apiGet('/me/playlists', { limit, offset, representation: 'mini' });
}

/* ---------- Playlist CRUD (own sets) ---------- */

async function playlistWrite(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  jsonBody?: unknown
): Promise<{ status: number; body: string }> {
  await ensureAccessToken();
  const token = cleanToken();
  const headers: Record<string, string> = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Authorization: `OAuth ${token}`,
  };
  let body: string | null = null;
  if (jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(jsonBody);
  }
  return commentFetch(url, method, headers, body);
}

function parsePlaylistPayload(raw: unknown): Playlist | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.playlist && typeof o.playlist === 'object') {
    return parsePlaylistPayload(o.playlist);
  }
  if (o.id && o.title) return o as unknown as Playlist;
  return null;
}

export async function createPlaylist(opts: {
  title: string;
  description?: string;
  sharing?: 'public' | 'private';
  trackIds?: number[];
}): Promise<Playlist> {
  const title = opts.title.trim();
  if (!title) throw new Error('Введите название плейлиста');
  const cid = await ensureClientId();
  const token = cleanToken();
  const tracks = (opts.trackIds || []).filter((id) => Number.isFinite(id)).map((id) => ({ id }));
  const playlistPayload = {
    title,
    description: opts.description || '',
    sharing: opts.sharing || 'public',
    tracks,
  };

  const attempts: Array<{ url: string; body: unknown }> = [
    {
      url: `${API}/playlists?client_id=${encodeURIComponent(cid)}`,
      body: { playlist: playlistPayload },
    },
    {
      url: `${API}/playlists?client_id=${encodeURIComponent(cid)}`,
      body: playlistPayload,
    },
    {
      url: `${API}/playlists?client_id=${encodeURIComponent(cid)}&oauth_token=${encodeURIComponent(token)}`,
      body: { playlist: playlistPayload },
    },
    {
      url: `https://api.soundcloud.com/playlists`,
      body: { playlist: playlistPayload },
    },
  ];

  const log: string[] = [];
  let lastStatus = 0;
  for (const a of attempts) {
    try {
      const r = await playlistWrite(a.url, 'POST', a.body);
      lastStatus = r.status;
      log.push(`→ ${r.status}`);
      if (r.status === 200 || r.status === 201) {
        try {
          const pl = parsePlaylistPayload(JSON.parse(r.body));
          if (pl) return pl;
        } catch {
          /* fallthrough */
        }
        // minimal playlist object
        return {
          id: Date.now(),
          title,
          permalink_url: '',
          artwork_url: null,
          duration: 0,
          track_count: tracks.length,
          user: { id: meUserId || 0, username: 'you', avatar_url: '', permalink_url: '' },
          tracks: [],
        };
      }
    } catch {
      /* next */
    }
  }
  throw new Error(`Не удалось создать плейлист (HTTP ${lastStatus || 'сеть'}). ${log.slice(0, 4).join('; ')}`);
}

function normalizeTrackIds(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export async function updatePlaylist(
  playlistId: number | string,
  opts: { title?: string; description?: string; sharing?: 'public' | 'private'; trackIds?: number[] }
): Promise<Playlist> {
  const cid = await ensureClientId();
  const token = cleanToken();
  const id = String(playlistId).replace(/^soundcloud:playlists:/, '');

  const trackIds =
    opts.trackIds !== undefined ? normalizeTrackIds(opts.trackIds) : undefined;

  // Different body shapes SC has accepted over time
  const bodies: unknown[] = [];
  if (trackIds !== undefined) {
    const asObjects = trackIds.map((tid) => ({ id: tid }));
    bodies.push({ playlist: { tracks: asObjects } });
    bodies.push({ playlist: { tracks: trackIds } });
    bodies.push({ tracks: asObjects });
    // with title if provided
    if (opts.title !== undefined) {
      bodies.push({
        playlist: { title: opts.title.trim(), tracks: asObjects },
      });
    }
  } else {
    const playlist: Record<string, unknown> = {};
    if (opts.title !== undefined) playlist.title = opts.title.trim();
    if (opts.description !== undefined) playlist.description = opts.description;
    if (opts.sharing !== undefined) playlist.sharing = opts.sharing;
    bodies.push({ playlist });
    bodies.push(playlist);
  }

  const urls = [
    `${API}/playlists/${id}?client_id=${encodeURIComponent(cid)}`,
    `${API}/playlists/${id}?client_id=${encodeURIComponent(cid)}&representation=full`,
    `${API}/playlists/${id}?client_id=${encodeURIComponent(cid)}&oauth_token=${encodeURIComponent(token)}`,
    `${API}/playlists/${id}`,
  ];

  const log: string[] = [];
  let lastStatus = 0;
  let lastBody = '';

  for (const url of urls) {
    for (const body of bodies) {
      try {
        const r = await playlistWrite(url, 'PUT', body);
        lastStatus = r.status;
        lastBody = (r.body || '').slice(0, 120);
        log.push(`→ ${r.status}`);
        if (r.status === 200 || r.status === 201 || r.status === 204) {
          if (r.body) {
            try {
              const pl = parsePlaylistPayload(JSON.parse(r.body));
              if (pl) {
                // always re-fetch full tracks for UI
                const full = await getPlaylist(id).catch(() => pl);
                return { ...pl, ...full, tracks: full.tracks || pl.tracks };
              }
            } catch {
              /* */
            }
          }
          return getPlaylist(id);
        }
      } catch {
        /* next */
      }
    }
  }

  // Single-track append endpoints (some clients)
  if (trackIds !== undefined && trackIds.length > 0) {
    const lastId = trackIds[trackIds.length - 1]!;
    const appendAttempts: Array<{ url: string; body: unknown; method: 'POST' | 'PUT' }> = [
      {
        method: 'POST',
        url: `${API}/playlists/${id}/tracks?client_id=${encodeURIComponent(cid)}`,
        body: { track_id: lastId },
      },
      {
        method: 'POST',
        url: `${API}/playlists/${id}/tracks?client_id=${encodeURIComponent(cid)}`,
        body: { tracks: [{ id: lastId }] },
      },
      {
        method: 'PUT',
        url: `${API}/playlists/${id}/tracks?client_id=${encodeURIComponent(cid)}`,
        body: { tracks: trackIds.map((tid) => ({ id: tid })) },
      },
    ];
    for (const a of appendAttempts) {
      try {
        const r = await playlistWrite(a.url, a.method, a.body);
        lastStatus = r.status;
        log.push(`append → ${r.status}`);
        if (r.status === 200 || r.status === 201 || r.status === 204) {
          return getPlaylist(id);
        }
      } catch {
        /* next */
      }
    }
  }

  throw new Error(
    `Не удалось обновить плейлист (HTTP ${lastStatus || 'сеть'}). ${log.slice(0, 6).join('; ')}${
      lastBody ? ' ' + lastBody.replace(/\s+/g, ' ').slice(0, 80) : ''
    }`
  );
}

export async function deletePlaylist(playlistId: number | string): Promise<void> {
  const cid = await ensureClientId();
  const token = cleanToken();
  const id = playlistId;
  const urls = [
    `${API}/playlists/${id}?client_id=${encodeURIComponent(cid)}`,
    `${API}/playlists/${id}?client_id=${encodeURIComponent(cid)}&oauth_token=${encodeURIComponent(token)}`,
    `${API}/playlists/${id}`,
  ];
  const log: string[] = [];
  let lastStatus = 0;
  for (const url of urls) {
    try {
      const r = await playlistWrite(url, 'DELETE');
      lastStatus = r.status;
      log.push(`→ ${r.status}`);
      if (r.status === 200 || r.status === 204) return;
    } catch {
      /* next */
    }
  }
  throw new Error(`Не удалось удалить плейлист (HTTP ${lastStatus || 'сеть'}). ${log.join('; ')}`);
}

/** Read File/Blob → base64 (no data: prefix). */
async function fileToBase64(file: Blob & { name?: string; type?: string }): Promise<{
  base64: string;
  mime: string;
  name: string;
}> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    base64: btoa(binary),
    mime: file.type || 'image/jpeg',
    name: (file as File).name || 'cover.jpg',
  };
}

/** Convert any image to JPEG ≤1000px (SC is picky about formats). */
async function prepareCoverJpeg(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const max = 1000;
    let w = bmp.width;
    let h = bmp.height;
    if (w > max || h > max) {
      const scale = Math.min(max / w, max / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9)
    );
    if (!blob) return file;
    return new File([blob], 'cover.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/**
 * Upload playlist cover.
 * Renderer FormData is blocked by CORS from localhost — use Electron IPC only.
 */
export async function updatePlaylistArtwork(
  playlistId: number | string,
  file: File
): Promise<Playlist> {
  if (!file || !file.size) throw new Error('Файл не выбран');
  if (file.size > 12 * 1024 * 1024) throw new Error('Картинка больше 12 МБ');
  const okType =
    /image\/(jpeg|jpg|png|gif|webp)/i.test(file.type) || /\.(jpe?g|png|gif|webp)$/i.test(file.name);
  if (!okType) throw new Error('Нужен JPEG или PNG');

  if (!window.electronAPI?.apiUpload) {
    throw new Error('Перезапусти приложение (miura / npm run dev) — нужен новый preload');
  }

  await ensureAccessToken();
  await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const token = cleanToken();
  const id = String(playlistId).replace(/^soundcloud:playlists:/, '');

  const prepared = await prepareCoverJpeg(file);
  const { base64, mime, name } = await fileToBase64(prepared);

  const authHeaders: Record<string, string> = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Authorization: `OAuth ${token}`,
  };

  // Field names / methods SC has used historically
  // Resolve current title if we can (some SC builds want title+artwork together)
  let titleHint = '';
  try {
    const cur = await getPlaylist(id);
    titleHint = cur.title || '';
  } catch {
    /* optional */
  }

  const fieldNames = ['playlist[artwork_data]', 'artwork_data'];
  const methods: Array<'PUT' | 'POST'> = ['PUT', 'POST'];
  const urls = [
    `${API}/playlists/${id}?client_id=${encodeURIComponent(cid)}`,
    `${API}/playlists/${id}?client_id=${encodeURIComponent(cid)}&oauth_token=${encodeURIComponent(token)}`,
    `https://api.soundcloud.com/playlists/${id}`,
  ];

  const fieldSets: Array<Record<string, string>> = [
    {},
    titleHint ? { 'playlist[title]': titleHint } : {},
  ].filter((f, i, arr) => i === 0 || Object.keys(f).length > 0);

  const log: string[] = [];
  let lastStatus = 0;
  let lastBody = '';

  const accept = (status: number) => status === 200 || status === 201 || status === 204;

  const finishOk = async (body?: string) => {
    if (body) {
      try {
        const pl = parsePlaylistPayload(JSON.parse(body));
        if (pl) {
          const full = await getPlaylist(id).catch(() => pl);
          const art = pl.artwork_url || full.artwork_url;
          const bust = art ? `${art}${art.includes('?') ? '&' : '?'}t=${Date.now()}` : art;
          return {
            ...full,
            artwork_url: bust || full.artwork_url,
            tracks: full.tracks?.length ? full.tracks : pl.tracks,
          };
        }
      } catch {
        /* reload */
      }
    }
    const full = await getPlaylist(id);
    if (full.artwork_url) {
      full.artwork_url = `${full.artwork_url}${full.artwork_url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    }
    return full;
  };

  for (const method of methods) {
    for (const url of urls) {
      for (const field of fieldNames) {
        for (const extraFields of fieldSets) {
          try {
            const r = await window.electronAPI.apiUpload({
              url,
              method,
              headers: authHeaders,
              fileBase64: base64,
              fileName: name || 'cover.jpg',
              fileField: field,
              mimeType: mime || 'image/jpeg',
              fields: extraFields,
            });
            lastStatus = r.status;
            lastBody = (r.body || '').slice(0, 200);
            log.push(`${method} ${field.includes('playlist') ? 'pl' : 'raw'} → ${r.status}`);
            if (accept(r.status)) {
              console.info('[artwork ok]', log[log.length - 1]);
              return finishOk(r.body);
            }
          } catch (e) {
            log.push(`err: ${e instanceof Error ? e.message : 'x'}`);
          }
        }
      }
    }
  }

  console.warn('[artwork fail]', log.join(' | '), lastBody);
  const bodyHint = lastBody
    ? ` Ответ: ${lastBody.replace(/\s+/g, ' ').slice(0, 100)}`
    : '';
  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error(
      `SoundCloud отклонил обложку (HTTP ${lastStatus}).${bodyHint} ` +
        `Обычно так бывает, если API запрещает смену картинки неофициальным клиентам, ` +
        `или плейлист не твой. Лайки при этом могут работать. ${log.slice(0, 3).join('; ')}`
    );
  }
  throw new Error(
    `Не удалось загрузить обложку (HTTP ${lastStatus || 'сеть'}). ${log.slice(0, 6).join('; ')}${bodyHint}`
  );
}

/** Replace playlist track list (full set of ids in desired order). */
export async function setPlaylistTracks(
  playlistId: number | string,
  trackIds: number[]
): Promise<Playlist> {
  return updatePlaylist(playlistId, { trackIds });
}

/** Collect numeric track ids from playlist tracks (including mini stubs). */
export function playlistTrackIds(tracks: Array<Track | { id?: number }> | undefined | null): number[] {
  return normalizeTrackIds((tracks || []).map((t) => Number((t as Track).id)).filter((n) => n > 0));
}

export async function addTrackToPlaylist(
  playlistId: number | string,
  trackId: number,
  existingTrackIds?: number[]
): Promise<Playlist> {
  const tid = Number(trackId);
  if (!Number.isFinite(tid) || tid <= 0) throw new Error('Некорректный трек');

  // Always re-fetch full playlist so we don't wipe tracks missing from UI state
  const full = await getPlaylist(playlistId);
  const fromServer = playlistTrackIds(full.tracks);
  const fromUi = existingTrackIds ? normalizeTrackIds(existingTrackIds) : [];
  // Prefer longer list (safer against incomplete UI state)
  const base = fromServer.length >= fromUi.length ? fromServer : fromUi;
  // Merge both just in case
  const ids = normalizeTrackIds([...base, ...fromServer, ...fromUi]);

  if (ids.includes(tid)) {
    return full;
  }
  return setPlaylistTracks(playlistId, [...ids, tid]);
}

export async function removeTrackFromPlaylist(
  playlistId: number | string,
  trackId: number,
  existingTrackIds?: number[]
): Promise<Playlist> {
  const tid = Number(trackId);
  const full = await getPlaylist(playlistId);
  const fromServer = playlistTrackIds(full.tracks);
  const fromUi = existingTrackIds ? normalizeTrackIds(existingTrackIds) : [];
  const ids = normalizeTrackIds([...fromServer, ...fromUi]);
  return setPlaylistTracks(
    playlistId,
    ids.filter((id) => id !== tid)
  );
}

/* ---------- Library / likes / stream ---------- */

export async function getLikedTracks(userId: number, limit = 30, offset = 0): Promise<SearchResponse<Track>> {
  // api-v2 returns { collection: [{ track, created_at }, ...] } for likes
  const raw = await apiGet<{ collection: LikeItem[]; next_href: string | null }>(
    `/users/${userId}/track_likes`,
    { limit, offset }
  );
  return {
    collection: (raw.collection || []).map((x) => x.track).filter(Boolean) as Track[],
    next_href: raw.next_href,
  };
}

export async function getLikedPlaylists(userId: number, limit = 30, offset = 0): Promise<SearchResponse<Playlist>> {
  const raw = await apiGet<{ collection: LikeItem[]; next_href: string | null }>(
    `/users/${userId}/playlist_likes`,
    { limit, offset }
  );
  return {
    collection: (raw.collection || []).map((x) => x.playlist).filter(Boolean) as Playlist[],
    next_href: raw.next_href,
  };
}

export async function getLikes(userId: number, limit = 30, offset = 0): Promise<SearchResponse<LikeItem>> {
  return apiGet(`/users/${userId}/likes`, { limit, offset });
}

export async function getStream(limit = 20, offset = 0): Promise<SearchResponse<Record<string, unknown>>> {
  return apiGet('/stream', { limit, offset });
}

/** Recently played tracks (SC home sidebar / History). */
export async function getPlayHistory(limit = 24, offset = 0): Promise<SearchResponse<Track>> {
  const paths = ['/me/play-history/tracks', '/me/history/tracks'];
  for (const path of paths) {
    try {
      const raw = await apiGet<{ collection?: Array<Track | { track?: Track }>; next_href?: string | null }>(
        path,
        { limit, offset }
      );
      const collection = (raw.collection || [])
        .map((x) => {
          if (x && typeof x === 'object' && 'track' in x && (x as { track?: Track }).track) {
            return (x as { track: Track }).track;
          }
          return x as Track;
        })
        .filter((t) => t?.id && t?.title);
      if (collection.length) {
        return { collection, next_href: raw.next_href ?? null };
      }
    } catch {
      /* try next */
    }
  }
  return { collection: [], next_href: null };
}

export async function getUserFollowings(
  userId: number,
  limit = 20,
  offset = 0
): Promise<SearchResponse<SoundCloudUser>> {
  return apiGet(`/users/${userId}/followings`, { limit, offset });
}

export async function getUserFollowers(
  userId: number,
  limit = 20,
  offset = 0
): Promise<SearchResponse<SoundCloudUser>> {
  return apiGet(`/users/${userId}/followers`, { limit, offset });
}

/** Home / Discover shelf group for filtering tabs. */
export type HomeGroup = 'feed' | 'for-you' | 'discover' | 'history' | 'charts';

export type HomeSection = {
  id: string;
  title: string;
  subtitle?: string;
  kind: 'tracks' | 'playlists' | 'mixed' | 'users';
  tracks: Track[];
  playlists?: Playlist[];
  users?: SoundCloudUser[];
  group: HomeGroup;
};

export async function getMixedSelections(limit = 24): Promise<{
  collection: Array<{
    title?: string;
    id?: string | number;
    description?: string;
    tracking_feature_name?: string;
    items?: { collection?: unknown[] };
  }>;
}> {
  return apiGet('/mixed-selections', { limit });
}

export async function getCharts(
  kind: 'top' | 'trending' = 'top',
  genre = 'soundcloud:genres:all-music',
  limit = 20
) {
  return apiGet<{ collection: Array<{ track: Track }> }>('/charts', {
    kind,
    genre,
    limit,
    region: 'soundcloud:regions:all',
  });
}

/** Translate common SC mixed-selection titles to Russian when they match. */
function localizeHomeTitle(raw: string): string {
  const t = raw.trim();
  const map: Record<string, string> = {
    Feed: 'Ваша лента',
    'More of what you like': 'Ещё то, что вам нравится',
    'More of what you like:': 'Ещё то, что вам нравится',
    'The Upload': 'Свежие загрузки',
    Charts: 'Чарты',
    'New & hot': 'Новое и горячее',
    'Because you liked': 'Потому что вам понравилось',
    'Because you follow': 'Потому что вы подписаны',
    'Artists you should follow': 'Артисты, на которых стоит подписаться',
    'Suggested artists': 'Рекомендуемые артисты',
    Discover: 'Обзор',
    'Weekly chart': 'Чарт недели',
    'Trending music': 'В тренде',
    'Top 50': 'Топ 50',
    Stations: 'Станции',
    Mixes: 'Миксы',
    'Recently played': 'Недавно слушали',
    History: 'История',
    'Your likes': 'Ваши лайки',
    Likes: 'Лайки',
    Following: 'Подписки',
  };
  if (map[t]) return map[t];
  // partial matches
  const lower = t.toLowerCase();
  if (lower.includes('because you liked')) return t.replace(/because you liked/i, 'Потому что вам понравилось');
  if (lower.includes('more of what you like')) return 'Ещё то, что вам нравится';
  if (lower.startsWith('charts:')) return t.replace(/^charts:\s*/i, 'Чарты: ');
  return t;
}

/** Pull tracks out of messy mixed-selections / stream item shapes. */
export function extractTracks(
  items: unknown[] | undefined | null,
  opts?: { includePlaylistTracks?: boolean }
): Track[] {
  if (!items?.length) return [];
  const out: Track[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    // Skip bare playlists mistaken for tracks
    if (item.kind === 'playlist' || item.kind === 'system-playlist' || item.kind === 'system_playlist') {
      continue;
    }
    if (item.system_playlist || (item.playlist && !item.track && !item.title)) {
      // nested playlist wrapper — only expand if explicitly requested
      if (opts?.includePlaylistTracks && item.playlist && typeof item.playlist === 'object') {
        const pl = item.playlist as Playlist;
        if (pl.tracks?.length) {
          out.push(...pl.tracks.filter((t) => t?.id && t?.title));
        }
      }
      continue;
    }
    if (item.title && item.id && (item.user || item.artwork_url !== undefined) && item.media !== undefined) {
      out.push(item as unknown as Track);
      continue;
    }
    // track-like without media still ok if has user+title (will hydrate on play)
    if (item.title && item.id && item.user && !item.track_count) {
      out.push(item as unknown as Track);
      continue;
    }
    if (item.track && typeof item.track === 'object') {
      const t = item.track as Track;
      if (t?.id && t?.title) out.push(t);
      continue;
    }
  }
  // dedupe
  const seen = new Set<number>();
  return out.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/** True if this home card is a real Discover mix (system playlist), not a random user set. */
export function isDiscoverMix(pl: Playlist): boolean {
  return Boolean(pl.is_system || isSystemPlaylistRef(pl));
}

function asPlaylist(pl: Playlist, system = false): Playlist | null {
  if (!pl || (!pl.id && !pl.urn) || !pl.title) return null;
  const id = pl.id ?? pl.urn!;
  return {
    ...pl,
    id,
    is_system: system || pl.is_system || isSystemPlaylistRef(pl),
    kind: system ? pl.kind || 'system-playlist' : pl.kind,
    user:
      pl.user ||
      ({
        id: 0,
        username: 'SoundCloud',
        avatar_url: '',
        permalink_url: 'https://soundcloud.com',
      } as SoundCloudUser),
    permalink_url: pl.permalink_url || 'https://soundcloud.com',
    artwork_url: pl.artwork_url ?? null,
    duration: pl.duration || 0,
    track_count: pl.track_count || pl.tracks?.length || 0,
  };
}

export function extractPlaylists(items: unknown[] | undefined | null): Playlist[] {
  if (!items?.length) return [];
  const out: Playlist[] = [];
  const seen = new Set<string>();

  const push = (pl: Playlist | null) => {
    if (!pl) return;
    const key = String(pl.urn || pl.id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(pl);
  };

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    // Discover mixes / charts live under system_playlist
    if (item.system_playlist && typeof item.system_playlist === 'object') {
      push(asPlaylist(item.system_playlist as Playlist, true));
      continue;
    }

    if (item.playlist && typeof item.playlist === 'object') {
      const pl = item.playlist as Playlist;
      push(asPlaylist(pl, isSystemPlaylistRef(pl)));
      continue;
    }

    // bare system playlist / playlist object
    if (item.kind === 'system-playlist' || item.kind === 'system_playlist') {
      push(asPlaylist(item as unknown as Playlist, true));
      continue;
    }

    if (
      (item.track_count !== undefined || item.tracks) &&
      item.title &&
      (item.id || item.urn)
    ) {
      push(asPlaylist(item as unknown as Playlist, isSystemPlaylistRef(item as Playlist)));
    }
  }
  return out;
}

/**
 * Full SoundCloud-like home:
 * Feed (stream) · For you (likes / followings) · Discover (mixed) · History · Charts
 * Sections load in parallel where possible so the UI fills quickly.
 */
export async function loadHomeFeed(
  loggedIn: boolean,
  userId?: number | null
): Promise<HomeSection[]> {
  const sections: HomeSection[] = [];
  const uid = userId || meUserId;

  const push = (sec: HomeSection) => {
    if (sec.kind === 'users') {
      if (sec.users?.length) sections.push(sec);
      return;
    }
    if (sec.tracks.length || sec.playlists?.length) sections.push(sec);
  };

  // ── parallel buckets ──────────────────────────────────────────
  type Bucket = {
    stream?: Track[];
    history?: Track[];
    likes?: Track[];
    followings?: SoundCloudUser[];
    mixed?: Awaited<ReturnType<typeof getMixedSelections>>['collection'];
    charts?: Array<{ id: string; title: string; tracks: Track[] }>;
  };
  const bucket: Bucket = {};

  const tasks: Array<Promise<void>> = [];

  if (loggedIn) {
    tasks.push(
      (async () => {
        try {
          const stream = await getStream(40);
          bucket.stream = tracksFromStream(stream.collection as Array<Record<string, unknown>>);
        } catch {
          /* optional */
        }
      })()
    );

    tasks.push(
      (async () => {
        try {
          const hist = await getPlayHistory(24);
          bucket.history = hist.collection || [];
        } catch {
          /* optional */
        }
      })()
    );

    if (uid) {
      tasks.push(
        (async () => {
          try {
            const likes = await getLikedTracks(uid, 20);
            bucket.likes = likes.collection || [];
          } catch {
            /* optional */
          }
        })()
      );

      tasks.push(
        (async () => {
          try {
            const fol = await getUserFollowings(uid, 16);
            bucket.followings = fol.collection || [];
          } catch {
            /* optional */
          }
        })()
      );
    }
  }

  tasks.push(
    (async () => {
      try {
        const mixed = await getMixedSelections(24);
        bucket.mixed = mixed.collection || [];
      } catch {
        /* optional */
      }
    })()
  );

  const chartSpecs: Array<{ title: string; kind: 'top' | 'trending'; genre: string }> = [
    { title: 'В тренде · Вся музыка', kind: 'trending', genre: 'soundcloud:genres:all-music' },
    { title: 'Топ · Electronic', kind: 'top', genre: 'soundcloud:genres:electronic' },
    { title: 'Топ · Hip-hop & Rap', kind: 'top', genre: 'soundcloud:genres:hiphoprap' },
    { title: 'В тренде · House', kind: 'trending', genre: 'soundcloud:genres:house' },
    { title: 'Топ · Dance & EDM', kind: 'top', genre: 'soundcloud:genres:danceedm' },
    { title: 'Топ · Pop', kind: 'top', genre: 'soundcloud:genres:pop' },
    { title: 'В тренде · Techno', kind: 'trending', genre: 'soundcloud:genres:techno' },
    { title: 'Топ · R&B & Soul', kind: 'top', genre: 'soundcloud:genres:rbsoul' },
  ];

  tasks.push(
    (async () => {
      const results = await Promise.all(
        chartSpecs.map(async (c) => {
          try {
            const charts = await getCharts(c.kind, c.genre, 18);
            const tracks = (charts.collection || [])
              .map((x) => x.track)
              .filter((t) => t?.id && t?.title);
            if (!tracks.length) return null;
            return {
              id: `chart-${c.genre}-${c.kind}`,
              title: c.title,
              tracks,
            };
          } catch {
            return null;
          }
        })
      );
      bucket.charts = results.filter(Boolean) as Array<{ id: string; title: string; tracks: Track[] }>;
    })()
  );

  await Promise.all(tasks);

  // ── assemble in SC-like order ─────────────────────────────────
  if (bucket.stream?.length) {
    push({
      id: 'feed',
      title: 'Ваша лента',
      subtitle: 'Треки и репосты от людей, на которых вы подписаны',
      kind: 'tracks',
      tracks: bucket.stream.slice(0, 40),
      group: 'feed',
    });
  }

  if (bucket.history?.length) {
    push({
      id: 'history',
      title: 'Недавно слушали',
      subtitle: 'Продолжите с того места, где остановились',
      kind: 'tracks',
      tracks: bucket.history.slice(0, 24),
      group: 'history',
    });
  }

  if (bucket.likes?.length) {
    push({
      id: 'your-likes',
      title: 'Ваши лайки',
      subtitle: 'Из вашей библиотеки',
      kind: 'tracks',
      tracks: bucket.likes.slice(0, 20),
      group: 'for-you',
    });
  }

  if (bucket.followings?.length) {
    push({
      id: 'following',
      title: 'Ваши подписки',
      subtitle: 'Артисты, на которых вы подписаны',
      kind: 'users',
      tracks: [],
      users: bucket.followings.slice(0, 16),
      group: 'for-you',
    });
  }

  // Personalized + discover shelves from mixed-selections
  for (const [i, block] of (bucket.mixed || []).entries()) {
    const items = block.items?.collection || [];
    // Do NOT pull mini tracks out of nested playlists — they fill a broken first rail
    const tracks = extractTracks(items, { includePlaylistTracks: false });
    const allPlaylists = extractPlaylists(items);
    // Prefer Discover system mixes (playable). Drop "genre playlist" shells that 404 / empty.
    const systemMixes = allPlaylists.filter((p) => isDiscoverMix(p));
    const userSets = allPlaylists.filter((p) => !isDiscoverMix(p) && (p.track_count || 0) > 0);
    // One row only: system mixes if present, else decent user sets
    const playlists = (systemMixes.length ? systemMixes : userSets).slice(0, 16);

    // Users may appear in mixed selections as user objects
    const users: SoundCloudUser[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (item.user && typeof item.user === 'object' && !item.track && !item.playlist && !item.system_playlist) {
        const u = item.user as SoundCloudUser;
        if (u?.id && u?.username) users.push(u);
      } else if (
        item.username &&
        item.avatar_url !== undefined &&
        item.id &&
        !item.title
      ) {
        users.push(item as unknown as SoundCloudUser);
      }
    }

    const rawTitle = (block.title || block.tracking_feature_name || `Подборка ${i + 1}`).trim();
    const title = localizeHomeTitle(rawTitle);
    const desc = block.description?.trim();
    const feature = (block.tracking_feature_name || '').toLowerCase();
    const isPersonal =
      feature.includes('personalized') ||
      feature.includes('for_you') ||
      /because you|more of what you like|your /i.test(rawTitle);
    const group: HomeGroup = isPersonal ? 'for-you' : 'discover';

    if (users.length && !tracks.length && !playlists.length) {
      push({
        id: `mixed-users-${block.id ?? i}`,
        title,
        subtitle: desc,
        kind: 'users',
        tracks: [],
        users: users.slice(0, 16),
        group,
      });
      continue;
    }

    // Never show tracks + playlists together (double rail: broken row + good row)
    if (playlists.length >= 3) {
      push({
        id: `mixed-pl-${block.id ?? i}`,
        title,
        subtitle: desc || (systemMixes.length ? 'Миксы SoundCloud' : undefined),
        kind: 'playlists',
        tracks: [],
        playlists,
        group,
      });
    } else if (tracks.length) {
      // Prefer tracks that already carry media (playable without heavy hydrate)
      const playable = tracks.filter(
        (t) => t?.id && t?.title && (t.media?.transcodings?.length || t.streamable !== false)
      );
      const list = (playable.length >= 4 ? playable : tracks).slice(0, 24);
      push({
        id: `mixed-${block.id ?? i}`,
        title,
        subtitle: desc,
        kind: 'tracks',
        tracks: list,
        group,
      });
    } else if (playlists.length) {
      push({
        id: `mixed-pl-${block.id ?? i}`,
        title,
        subtitle: desc,
        kind: 'playlists',
        tracks: [],
        playlists,
        group,
      });
    }
  }

  for (const c of bucket.charts || []) {
    push({
      id: c.id,
      title: c.title,
      subtitle: 'Чарты SoundCloud',
      kind: 'tracks',
      tracks: c.tracks,
      group: 'charts',
    });
  }

  if (!sections.length) {
    try {
      const res = await searchTracks('electronic', 24);
      push({
        id: 'fallback',
        title: 'Обзор',
        subtitle: 'Популярное прямо сейчас',
        kind: 'tracks',
        tracks: res.collection || [],
        group: 'discover',
      });
    } catch {
      /* empty */
    }
  }

  return sections;
}

export async function getUser(userId: number): Promise<SoundCloudUser> {
  return apiGet(`/users/${userId}`);
}

export async function getUserTracks(userId: number, limit = 30, offset = 0): Promise<SearchResponse<Track>> {
  return apiGet(`/users/${userId}/tracks`, { limit, offset });
}

/**
 * User reposts (as on profile “Reposts”).
 * Tries several api-v2 shapes used by the web client.
 */
export async function getUserReposts(userId: number, limit = 30, offset = 0): Promise<SearchResponse<Track>> {
  const extract = (
    collection: unknown[] | undefined,
    mode: 'all-tracks' | 'reposts-only'
  ): Track[] => {
    const out: Track[] = [];
    const seen = new Set<number>();
    for (const raw of collection || []) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const type = String(item.type || item.kind || '');
      const isRepost = type.includes('repost');

      let track: Track | null = null;
      if (item.track && typeof item.track === 'object') {
        track = item.track as Track;
      } else if (item.title && item.id && item.user) {
        track = item as unknown as Track;
      }
      if (!track?.id || !track.title) continue;
      if (mode === 'reposts-only' && !isRepost) continue;
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      out.push(track);
    }
    return out;
  };

  const endpoints: Array<{ path: string; mode: 'all-tracks' | 'reposts-only' }> = [
    { path: `/users/${userId}/track_reposts`, mode: 'all-tracks' },
    { path: `/users/${userId}/reposts/tracks`, mode: 'all-tracks' },
    { path: `/stream/users/${userId}`, mode: 'reposts-only' },
  ];

  for (const ep of endpoints) {
    try {
      const raw = await apiGet<{ collection?: unknown[]; next_href?: string | null }>(ep.path, {
        limit,
        offset,
        linked_partitioning: 1,
      });
      const collection = extract(raw.collection, ep.mode);
      if (collection.length) {
        return { collection, next_href: raw.next_href ?? null };
      }
    } catch {
      /* next */
    }
  }

  return { collection: [], next_href: null };
}

/** Profile “All” feed: own tracks + reposts in one list (web-like). */
export async function getUserStream(userId: number, limit = 40, offset = 0): Promise<{
  tracks: Track[];
  repostIds: Set<number>;
  next_href: string | null;
}> {
  try {
    const raw = await apiGet<{
      collection?: Array<{
        type?: string;
        kind?: string;
        track?: Track;
        created_at?: string;
      }>;
      next_href?: string | null;
    }>(`/stream/users/${userId}`, { limit, offset, linked_partitioning: 1 });

    const tracks: Track[] = [];
    const repostIds = new Set<number>();
    const seen = new Set<number>();

    for (const item of raw.collection || []) {
      const t = item?.track;
      if (!t?.id || !t.title || seen.has(t.id)) continue;
      seen.add(t.id);
      const isRepost =
        item.type === 'track-repost' ||
        item.kind === 'track-repost' ||
        String(item.type || '').includes('repost');
      if (isRepost) repostIds.add(t.id);
      tracks.push(t);
    }

    if (tracks.length) {
      return { tracks, repostIds, next_href: raw.next_href ?? null };
    }
  } catch {
    /* fall through to split fetch */
  }

  const [own, reposts] = await Promise.all([
    getUserTracks(userId, limit, offset).catch(() => ({ collection: [] as Track[], next_href: null })),
    getUserReposts(userId, limit, offset).catch(() => ({ collection: [] as Track[], next_href: null })),
  ]);
  const repostIds = new Set((reposts.collection || []).map((t) => t.id));
  const seen = new Set<number>();
  const tracks: Track[] = [];
  for (const t of [...(own.collection || []), ...(reposts.collection || [])]) {
    if (!t?.id || seen.has(t.id)) continue;
    seen.add(t.id);
    tracks.push(t);
  }
  return { tracks, repostIds, next_href: own.next_href || reposts.next_href };
}

/* ---------- Track page: comments / waveform ---------- */

export async function getTrackComments(
  trackId: number,
  limit = 30,
  offset = 0
): Promise<SearchResponse<TrackComment>> {
  const raw = await apiGet<{
    collection?: Array<TrackComment | { comment?: TrackComment }>;
    next_href?: string | null;
  }>(`/tracks/${trackId}/comments`, {
    threaded: 0,
    limit,
    offset,
    filter_replies: 0,
  });

  const collection: TrackComment[] = [];
  for (const item of raw.collection || []) {
    if (!item) continue;
    if ('body' in item && item.id && item.user) {
      collection.push(item as TrackComment);
    } else if ('comment' in item && item.comment?.id) {
      collection.push(item.comment);
    }
  }
  return { collection, next_href: raw.next_href ?? null };
}

function parseCommentPayload(raw: unknown): TrackComment | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.comment && typeof o.comment === 'object') {
    return parseCommentPayload(o.comment);
  }
  if (o.id && o.body && o.user) return o as unknown as TrackComment;
  if (o.id && o.body) {
    return {
      ...(o as unknown as TrackComment),
      user: (o.user as SoundCloudUser) || {
        id: 0,
        username: 'you',
        avatar_url: '',
        permalink_url: '',
      },
    };
  }
  return null;
}

async function commentFetch(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  headers: Record<string, string>,
  body?: string | null
): Promise<{ status: number; body: string }> {
  if (window.electronAPI?.apiFetch) {
    const r = await window.electronAPI.apiFetch({
      url,
      method,
      headers,
      body: body === undefined ? null : body,
    });
    return { status: r.status, body: r.body || '' };
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : body,
  });
  return { status: res.status, body: await res.text().catch(() => '') };
}

function makeOptimisticComment(
  text: string,
  trackId: number,
  uid: number,
  timestampMs?: number | null
): TrackComment {
  return {
    id: Date.now(),
    body: text,
    created_at: new Date().toISOString(),
    timestamp: timestampMs ?? null,
    track_id: trackId,
    user_id: uid,
    localOnly: true,
    user: {
      id: uid,
      username: 'you',
      avatar_url: '',
      permalink_url: '',
    },
  };
}

/** Post a comment; timestampMs = position in track (optional, from player). */
export async function postComment(
  trackId: number,
  body: string,
  timestampMs?: number | null
): Promise<TrackComment> {
  const text = body.trim();
  if (!text) throw new Error('Пустой комментарий');
  if (text.length > 5000) throw new Error('Слишком длинный комментарий');

  await ensureAccessToken();
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const token = cleanToken();
  const id = Number(trackId);
  const ts = timestampMs != null && timestampMs >= 0 ? Math.floor(timestampMs) : 0;

  // Bodies the web client / mobile clients have used over the years
  const jsonBodies: unknown[] = [
    { comment: { body: text, timestamp: ts } },
    { body: text, timestamp: ts },
    { comment: { body: text } },
    { body: text },
  ];

  const formBodies: string[] = [
    new URLSearchParams({
      'comment[body]': text,
      'comment[timestamp]': String(ts),
    }).toString(),
    new URLSearchParams({
      body: text,
      timestamp: String(ts),
    }).toString(),
  ];

  type Attempt = { url: string; headers: Record<string, string>; body: string };
  const attempts: Attempt[] = [];

  const baseHeaders = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Authorization: `OAuth ${token}`,
  };

  const urn = encodeURIComponent(`soundcloud:tracks:${id}`);
  const urls = [
    `${API}/tracks/${id}/comments?client_id=${encodeURIComponent(cid)}`,
    `${API}/tracks/${id}/comments?client_id=${encodeURIComponent(cid)}&app_locale=en`,
    `${API}/tracks/${urn}/comments?client_id=${encodeURIComponent(cid)}`,
    `${API}/tracks/${id}/comments?client_id=${encodeURIComponent(cid)}&oauth_token=${encodeURIComponent(token)}`,
    `${API}/tracks/${id}/comments`,
  ];

  for (const url of urls) {
    for (const json of jsonBodies) {
      attempts.push({
        url,
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(json),
      });
    }
    for (const form of formBodies) {
      attempts.push({
        url,
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: form,
      });
    }
  }

  // query-token only (no Authorization) — rare but works for some tokens
  for (const json of jsonBodies.slice(0, 2)) {
    attempts.push({
      url: `${API}/tracks/${id}/comments?client_id=${encodeURIComponent(cid)}&oauth_token=${encodeURIComponent(token)}`,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(json),
    });
  }

  const log: string[] = [];
  let lastStatus = 0;
  let lastBody = '';

  for (const a of attempts) {
    try {
      const r = await commentFetch(a.url, 'POST', a.headers, a.body);
      lastStatus = r.status;
      lastBody = r.body.slice(0, 200);
      const kind = a.headers['Content-Type']?.includes('json') ? 'json' : 'form';
      log.push(`${kind} → ${r.status}`);

      if (r.status === 200 || r.status === 201 || r.status === 204) {
        console.info('[comment ok]', log[log.length - 1]);
        try {
          const parsed = r.body ? parseCommentPayload(JSON.parse(r.body)) : null;
          if (parsed) return parsed;
        } catch {
          /* fallthrough */
        }
        return makeOptimisticComment(text, id, uid, ts);
      }
      // stop flooding after first few distinct failures of same code
    } catch (e) {
      log.push(`err: ${e instanceof Error ? e.message : 'x'}`);
    }
  }

  console.warn('[comment fail]', log.slice(0, 12).join(' | '), lastBody.slice(0, 100));

  // Friendlier errors
  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error(
      `Комментарий отклонён (HTTP ${lastStatus}). Тот же токен, что для лайков; если лайки ок — попробуй другой трек или сними галочку «В момент трека». [${log.slice(0, 4).join('; ')}]`
    );
  }
  if (lastStatus === 422) {
    throw new Error('Комментарии на этом треке, возможно, отключены автором');
  }
  if (lastStatus === 404) {
    throw new Error(`Эндпоинт комментариев не найден (404). ${log.slice(0, 3).join('; ')}`);
  }
  throw new Error(
    `Не удалось отправить (HTTP ${lastStatus || 'сеть'})${lastBody ? ': ' + lastBody.replace(/\s+/g, ' ').slice(0, 80) : ''}`
  );
}

/**
 * Delete own comment on SoundCloud (server-side).
 * Pass `localOnly: true` for comments that never got a real SC id (UI-only).
 */
export async function deleteComment(
  trackId: number,
  commentId: number,
  opts?: { localOnly?: boolean }
): Promise<void> {
  // Optimistic/local comments were never on the server
  if (opts?.localOnly) return;

  await ensureAccessToken();
  const cid = await ensureClientId();
  const token = cleanToken();
  const tid = Number(trackId);
  const cmt = Number(commentId);

  // Fake ids from Date.now() (~1.7e12+) are not real SC comments
  if (cmt > 1_000_000_000_000) {
    return;
  }

  const urls = [
    `${API}/tracks/${tid}/comments/${cmt}?client_id=${encodeURIComponent(cid)}`,
    `${API}/comments/${cmt}?client_id=${encodeURIComponent(cid)}`,
    `${API}/tracks/${tid}/comments/${cmt}?client_id=${encodeURIComponent(cid)}&oauth_token=${encodeURIComponent(token)}`,
    `${API}/comments/${cmt}?client_id=${encodeURIComponent(cid)}&oauth_token=${encodeURIComponent(token)}`,
    `${API}/tracks/${tid}/comments/${cmt}`,
    `${API}/comments/${cmt}`,
  ];

  const log: string[] = [];
  let lastStatus = 0;
  for (const url of urls) {
    try {
      const r = await commentFetch(
        url,
        'DELETE',
        {
          Accept: 'application/json',
          Authorization: `OAuth ${token}`,
        },
        null
      );
      lastStatus = r.status;
      log.push(`→ ${r.status}`);
      // Only real success — do NOT treat 404 as deleted (comment may still exist on SC)
      if (r.status === 200 || r.status === 204) {
        console.info('[comment delete ok]', url.replace(/\?.*/, ''), r.status);
        return;
      }
    } catch {
      /* next */
    }
  }
  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error('Нет прав удалить на SoundCloud (HTTP ' + lastStatus + ')');
  }
  if (lastStatus === 404) {
    throw new Error(
      'SoundCloud не нашёл комментарий для удаления (404). В приложении он мог быть только локальным — на сайте он мог остаться или уже удалён.'
    );
  }
  throw new Error(`Не удалось удалить на SoundCloud (HTTP ${lastStatus || 'сеть'}). ${log.join('; ')}`);
}

export interface WaveformData {
  width: number;
  height: number;
  samples: number[];
}

/** Fetch samples for waveform visualization (optional; fails soft). */
export async function fetchWaveform(waveformUrl: string | null | undefined): Promise<WaveformData | null> {
  if (!waveformUrl) return null;
  try {
    // SC serves JSON like https://wave.sndcdn.com/xxx_m.json
    const url = waveformUrl.replace(/_\w\.png$/, '_m.json').replace(/\.png$/, '.json');
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { width?: number; height?: number; samples?: number[] };
    if (!data.samples?.length) return null;
    return {
      width: data.width || data.samples.length,
      height: data.height || 140,
      samples: data.samples,
    };
  } catch {
    return null;
  }
}

export function formatRelativeTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'только что';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ч назад`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} дн назад`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} мес назад`;
  return `${Math.floor(mo / 12)} г назад`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ---------- Social actions (api-v2, browser OAuth) ---------- */
/*
 * Real web client uses:
 *   PUT /users/{uid}/track_likes/{trackId}?client_id=...
 *   PUT /reposts/tracks/{trackId}?client_id=...
 * with Authorization: OAuth <browser token>
 * Writes go through Electron api-fetch (page context on soundcloud.com).
 */

function cleanToken(): string {
  return (accessToken || '').replace(/^OAuth\s+/i, '').trim();
}

function socialHeaders(kind: 'auth' | 'query' = 'auth'): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (kind === 'auth') {
    const t = cleanToken();
    if (t) h.Authorization = `OAuth ${t}`;
  }
  return h;
}

function isWriteSuccess(status: number) {
  return status === 200 || status === 201 || status === 204 || status === 409 || status === 422;
}

async function ensureMeIdForLikes(): Promise<number> {
  await ensureAccessToken();
  try {
    const me = await getMe();
    if (me?.id) {
      meUserId = me.id;
      return me.id;
    }
  } catch (e) {
    if (meUserId) return meUserId;
    throw new Error('Сессия недействительна — войди снова (Настройки → войти)');
  }
  throw new Error('Не удалось определить аккаунт — войди снова');
}

type WriteMode = {
  /** auth = Authorization header; query = oauth_token in URL only */
  auth: 'auth' | 'query';
  /** none = no body; empty = ""; json = "{}" */
  body: 'none' | 'empty' | 'json';
  withClientId: boolean;
};

async function scWrite(
  url: string,
  method: 'PUT' | 'POST' | 'DELETE' | 'GET',
  mode: WriteMode
): Promise<{ status: number; body: string }> {
  let finalUrl = url;
  const token = cleanToken();
  if (mode.withClientId) {
    const cid = await ensureClientId();
    const sep = finalUrl.includes('?') ? '&' : '?';
    finalUrl += `${sep}client_id=${encodeURIComponent(cid)}`;
  }
  if (mode.auth === 'query' && token) {
    const sep = finalUrl.includes('?') ? '&' : '?';
    finalUrl += `${sep}oauth_token=${encodeURIComponent(token)}`;
  }

  const headers = socialHeaders(mode.auth);
  let body: string | null | undefined = undefined;
  if (mode.body === 'empty') {
    body = '';
  } else if (mode.body === 'json') {
    headers['Content-Type'] = 'application/json';
    body = '{}';
  }

  if (window.electronAPI?.apiFetch) {
    const r = await window.electronAPI.apiFetch({
      url: finalUrl,
      method,
      headers,
      body: body === undefined ? null : body,
      // Likes/reposts need page Origin + cookies (net-only often 403)
      preferNet: false,
      credentials: 'include',
    });
    return { status: r.status, body: r.body || '' };
  }

  const res = await fetch(finalUrl, {
    method,
    headers,
    body: body === undefined ? undefined : body,
    credentials: 'include',
    mode: 'cors',
  });
  return { status: res.status, body: await res.text().catch(() => '') };
}

type Attempt = {
  method: 'PUT' | 'POST' | 'DELETE';
  path: string; // path only, starting with /
  modes?: WriteMode[];
};

const DEFAULT_MODES: WriteMode[] = [
  // Match browser as closely as possible first
  { auth: 'auth', body: 'none', withClientId: true },
  { auth: 'auth', body: 'empty', withClientId: true },
  { auth: 'auth', body: 'json', withClientId: true },
  { auth: 'auth', body: 'none', withClientId: false },
  { auth: 'query', body: 'none', withClientId: true },
  { auth: 'query', body: 'empty', withClientId: true },
];

async function tryWrite(attempts: Attempt[], label: string): Promise<void> {
  await ensureAccessToken();
  const log: string[] = [];

  for (const a of attempts) {
    const modes = a.modes || DEFAULT_MODES;
    for (const mode of modes) {
      const url = `${API}${a.path}`;
      try {
        const r = await scWrite(url, a.method, mode);
        const tag = `${a.method} ${a.path} [${mode.auth}/${mode.body}/cid=${mode.withClientId}] → ${r.status}`;
        log.push(tag);
        if (isWriteSuccess(r.status)) {
          console.info('[social ok]', label, tag);
          return;
        }
      } catch (e) {
        log.push(`${a.method} ${a.path} err: ${e instanceof Error ? e.message : 'x'}`);
      }
    }
  }

  console.warn('[social fail]', label, log.join(' | '));
  const authAll = log.length > 0 && log.every((x) => /→ 401|→ 403/.test(x));
  if (authAll) {
    throw new Error(
      'Нет прав на действие (403/401). Токен, возможно, только на чтение — скопируй Authorization с запроса like/repost в Network на soundcloud.com'
    );
  }
  // Prefer showing first non-404 if any
  const interesting = log.find((x) => /→ 403|→ 401|→ 429/.test(x)) || log[0] || '';
  const code = interesting.match(/→ (\d+)/)?.[1] || 'сеть';
  throw new Error(`${label} (HTTP ${code}). ${log.slice(0, 2).join('; ')}`);
}

export async function likeTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  if (!Number.isFinite(id)) throw new Error('Некорректный id трека');
  const uid = await ensureMeIdForLikes();
  const token = cleanToken();
  if (!token) throw new Error('Нужен вход в SoundCloud (Настройки → войти)');

  const urn = encodeURIComponent(`soundcloud:tracks:${id}`);
  const uurn = encodeURIComponent(`soundcloud:users:${uid}`);
  const rawUrn = `soundcloud:tracks:${id}`;
  const rawUserUrn = `soundcloud:users:${uid}`;

  await tryWrite(
    [
      { method: 'PUT', path: `/users/${uid}/track_likes/${id}` },
      { method: 'PUT', path: `/users/${rawUserUrn}/track_likes/${rawUrn}` },
      { method: 'PUT', path: `/users/${uurn}/track_likes/${urn}` },
      { method: 'PUT', path: `/me/track_likes/${id}` },
      { method: 'PUT', path: `/users/${uid}/likes/tracks/${id}` },
      { method: 'PUT', path: `/likes/tracks/${id}` },
      { method: 'PUT', path: `/likes/tracks/${urn}` },
      { method: 'POST', path: `/users/${uid}/track_likes/${id}` },
      { method: 'POST', path: `/likes/tracks/${id}` },
      // Legacy public API favorites
      { method: 'PUT', path: `/me/favorites/${id}` },
      { method: 'PUT', path: `/users/${uid}/favorites/${id}` },
    ],
    'Не удалось лайкнуть'
  );
}

export async function unlikeTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const urn = encodeURIComponent(`soundcloud:tracks:${id}`);

  await tryWrite(
    [
      { method: 'DELETE', path: `/users/${uid}/track_likes/${id}` },
      { method: 'DELETE', path: `/users/${uid}/likes/tracks/${id}` },
      { method: 'DELETE', path: `/me/track_likes/${id}` },
      { method: 'DELETE', path: `/likes/tracks/${id}` },
      { method: 'DELETE', path: `/likes/tracks/${urn}` },
    ],
    'Не удалось убрать лайк'
  );
}

export async function followUser(userId: number): Promise<void> {
  const target = Number(userId);
  const uid = await ensureMeIdForLikes();
  await tryWrite(
    [
      { method: 'PUT', path: `/users/${uid}/followings/${target}` },
      { method: 'PUT', path: `/me/followings/${target}` },
      { method: 'POST', path: `/users/${uid}/followings/${target}` },
    ],
    'Не удалось подписаться'
  );
}

export async function unfollowUser(userId: number): Promise<void> {
  const target = Number(userId);
  const uid = await ensureMeIdForLikes();
  await tryWrite(
    [
      { method: 'DELETE', path: `/users/${uid}/followings/${target}` },
      { method: 'DELETE', path: `/me/followings/${target}` },
    ],
    'Не удалось отписаться'
  );
}

export async function isFollowing(userId: number): Promise<boolean> {
  try {
    const target = Number(userId);
    const uid = await ensureMeIdForLikes();
    const r = await scWrite(`${API}/users/${uid}/followings/${target}`, 'GET', {
      auth: 'auth',
      body: 'none',
      withClientId: true,
    });
    if (r.status >= 200 && r.status < 300) return true;
    if (r.status === 404) return false;
    return false;
  } catch {
    return false;
  }
}

export async function repostTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const urn = encodeURIComponent(`soundcloud:tracks:${id}`);

  await tryWrite(
    [
      { method: 'PUT', path: `/reposts/tracks/${id}` },
      { method: 'POST', path: `/reposts/tracks/${id}` },
      { method: 'PUT', path: `/users/${uid}/reposts/tracks/${id}` },
      { method: 'POST', path: `/users/${uid}/reposts/tracks/${id}` },
      { method: 'PUT', path: `/me/track_reposts/${id}` },
      { method: 'PUT', path: `/users/${uid}/track_reposts/${id}` },
      { method: 'PUT', path: `/reposts/tracks/${urn}` },
    ],
    'Не удалось сделать репост'
  );
}

export async function unrepostTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const urn = encodeURIComponent(`soundcloud:tracks:${id}`);

  await tryWrite(
    [
      { method: 'DELETE', path: `/reposts/tracks/${id}` },
      { method: 'DELETE', path: `/users/${uid}/reposts/tracks/${id}` },
      { method: 'DELETE', path: `/me/track_reposts/${id}` },
      { method: 'DELETE', path: `/reposts/tracks/${urn}` },
    ],
    'Не удалось убрать репост'
  );
}

export async function likePlaylist(playlistId: number | string): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const enc = encodeURIComponent(String(playlistId));
  await tryWrite(
    [
      { method: 'PUT', path: `/users/${uid}/playlist_likes/${enc}` },
      { method: 'PUT', path: `/users/${uid}/likes/playlists/${enc}` },
      { method: 'POST', path: `/likes/playlists/${enc}` },
      { method: 'PUT', path: `/likes/playlists/${enc}` },
    ],
    'Не удалось лайкнуть плейлист'
  );
}

export async function unlikePlaylist(playlistId: number | string): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const enc = encodeURIComponent(String(playlistId));
  await tryWrite(
    [
      { method: 'DELETE', path: `/users/${uid}/playlist_likes/${enc}` },
      { method: 'DELETE', path: `/users/${uid}/likes/playlists/${enc}` },
      { method: 'DELETE', path: `/likes/playlists/${enc}` },
    ],
    'Не удалось убрать лайк плейлиста'
  );
}

/* ---------- Utils ---------- */

export function artworkUrl(
  url: string | null | undefined,
  size: 't500x500' | 't300x300' | 'large' | 't67x67' = 't500x500'
): string {
  if (!url) return '';
  return url
    .replace('-large', `-${size}`)
    .replace('-t500x500', `-${size}`)
    .replace('-crop', `-${size}`);
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n ?? 0);
}

/**
 * Track is behind Go / Go+ (preview for free, full with subscription).
 * Stay conservative — SC marks these mainly via policy SNIP.
 * Do NOT treat BLACKBOX / generic monetization as Go+ (that false-positives almost everything).
 */
export function isGoPlusOnlyTrack(track: Track | null | undefined): boolean {
  if (!track) return false;

  // Primary signal on soundcloud.com
  const policy = String((track as Track & { policy?: string }).policy || '').toUpperCase();
  if (policy === 'SNIP') return true;
  // Explicit free / blocked — never badge
  if (policy === 'ALLOW' || policy === 'BLOCK') return false;

  // Explicit subscription catalog only (exact models from api-v2)
  const mon = String(
    (track as Track & { monetization_model?: string | null }).monetization_model || ''
  )
    .toUpperCase()
    .replace(/-/g, '_');
  if (mon === 'SUB_HIGH_TIER' || mon === 'SUB_MID_TIER') return true;

  // Full stream available → not Go+-only (even if some preview variants exist)
  const tcs = track.media?.transcodings;
  if (tcs?.length) {
    const hasFull = tcs.some((t) => t?.url && !t.snipped);
    if (hasFull) return false;
  }

  return false;
}

/**
 * Heuristic: media only lists encrypted HLS (modern SC catalog).
 * Open progressive/plain HLS often still appear in the list but 404 on exchange —
 * this flags tracks that have *no* clear protocol at all, or only encrypted.
 */
export function isDrmOnlyTrack(track: Track | null | undefined): boolean {
  if (!track?.media?.transcodings?.length) return false;
  const list = track.media.transcodings;
  const hasClear = list.some((t) => {
    const p = (t.format?.protocol || '').toLowerCase();
    return p === 'progressive' || p === 'hls';
  });
  const hasEnc = list.some((t) => isEncryptedProtocol(t.format?.protocol || ''));
  // If only encrypted protocols are listed → definitely DRM-only
  if (hasEnc && !hasClear) return true;
  return false;
}

export function tracksFromStream(collection: Array<Record<string, unknown>>): Track[] {
  const out: Track[] = [];
  for (const item of collection) {
    const type = String(item.type || item.kind || '');
    if (item.track && typeof item.track === 'object') {
      out.push(item.track as Track);
    } else if (item.playlist && typeof item.playlist === 'object') {
      const pl = item.playlist as Playlist;
      if (pl.tracks?.length) out.push(...pl.tracks.filter((t) => t && t.title));
    } else if (type.includes('track') && item.title) {
      out.push(item as unknown as Track);
    }
  }
  return out.filter((t) => t?.id && t?.title);
}
