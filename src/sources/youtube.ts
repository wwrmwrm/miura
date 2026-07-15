import type { Playable } from '../player/types';
import { youtubeUid } from '../player/types';

export type YtSearchHit = {
  id: string;
  title: string;
  author: string;
  durationMs?: number;
  thumbnail?: string;
};

let innertubePromise: Promise<unknown> | null = null;

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k)] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(h)) {
    if (v != null) out[k] = String(v);
  }
  return out;
}

function b64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function bodyToPayload(
  body: BodyInit | null | undefined
): Promise<{ body?: string; bodyBase64?: string } | undefined> {
  if (body == null || body === '') return undefined;
  if (typeof body === 'string') return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof ArrayBuffer) {
    const u8 = new Uint8Array(body);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return { bodyBase64: btoa(s) };
  }
  if (ArrayBuffer.isView(body)) {
    const u8 = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return { bodyBase64: btoa(s) };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const ab = await body.arrayBuffer();
    const u8 = new Uint8Array(ab);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return { bodyBase64: btoa(s) };
  }
  return { body: String(body) };
}

function isYouTubeUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      /(^|\.)youtube\.com$/.test(h) ||
      /(^|\.)youtu\.be$/.test(h) ||
      /(^|\.)googlevideo\.com$/.test(h) ||
      /(^|\.)ytimg\.com$/.test(h) ||
      /(^|\.)ggpht\.com$/.test(h) ||
      /(^|\.)googleusercontent\.com$/.test(h) ||
      /(^|\.)googleapis\.com$/.test(h) ||
      /(^|\.)gstatic\.com$/.test(h) ||
      /(^|\.)youtube-nocookie\.com$/.test(h)
    );
  } catch {
    return false;
  }
}

/**
 * Fetch for youtubei.js — ALWAYS via Electron main (proxy session).
 * Renderer fetch to YouTube dies with CORS / "Failed to fetch".
 */
const safeFetch: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : null;
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : req
          ? req.url
          : String(input);
  const method = (init?.method || req?.method || 'GET').toUpperCase();
  const headers = {
    ...headersToRecord(req?.headers),
    ...headersToRecord(init?.headers),
  };
  // Chromium forbids setting these on Request; strip so IPC doesn't get confused
  for (const k of Object.keys(headers)) {
    if (/^(host|connection|content-length|transfer-encoding|keep-alive)$/i.test(k)) {
      delete headers[k];
    }
  }

  let payloadBody: { body?: string; bodyBase64?: string } | undefined;
  if (init?.body !== undefined && init.body !== null) {
    payloadBody = await bodyToPayload(init.body as BodyInit);
  } else if (req && method !== 'GET' && method !== 'HEAD') {
    try {
      payloadBody = await bodyToPayload(await req.clone().arrayBuffer());
    } catch {
      /* no body */
    }
  }

  const ytFetch = typeof window !== 'undefined' ? window.electronAPI?.ytFetch : undefined;
  if (!ytFetch) {
    throw new Error(
      'YouTube: нужен Electron IPC ytFetch. Полностью перезапусти miura (закрой и npm run dev) — hot reload main/preload не подхватывает.'
    );
  }

  if (!/^https:\/\//i.test(url)) {
    throw new Error(`YouTube: only https URLs supported (${url.slice(0, 80)})`);
  }

  // Non-YT absolute URLs (rare) — still go through main if allowed, else error
  if (!isYouTubeUrl(url) && !/google|gstatic|ytimg|ggpht/i.test(url)) {
    throw new Error(`YouTube client blocked non-YT URL: ${url.slice(0, 100)}`);
  }

  try {
    const r = await ytFetch({
      url,
      method,
      headers,
      body: payloadBody?.body,
      bodyBase64: payloadBody?.bodyBase64,
    });
    const bytes = b64ToUint8(r.bodyBase64 || '');
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const res = new Response(bytes.byteLength ? ab : null, {
      status: r.status || 0,
      statusText: r.ok ? 'OK' : 'Error',
      headers: r.headers || {},
    });
    try {
      Object.defineProperty(res, 'url', { value: r.url || url, configurable: true });
    } catch {
      /* ignore */
    }
    if (!r.ok && r.status >= 500) {
      console.warn('[yt] HTTP', r.status, method, url.slice(0, 100), r._via, r._attempts);
    }
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[yt] ytFetch error', method, url.slice(0, 120), msg);
    throw new Error(
      msg.includes('yt-fetch') || msg.includes('YouTube')
        ? msg
        : `YouTube network: ${msg}`
    );
  }
};

type Tube = {
  search: (q: string, opts?: { type?: string }) => Promise<unknown>;
  getBasicInfo: (id: string, opts?: unknown) => Promise<unknown>;
  getStreamingData?: (
    id: string,
    opts?: { type?: string; quality?: string; format?: string }
  ) => Promise<{ url?: string; mime_type?: string; has_audio?: boolean }>;
  session?: { player?: unknown };
};

/**
 * youtubei.js needs a JS interpreter to decipher signed stream URLs.
 * Default shim throws; we run the extracted player snippet via Function.
 * (Requires CSP script-src 'unsafe-eval' — already set for this Electron app.)
 */
function installYtEval(Platform: {
  shim?: {
    fetch?: typeof fetch;
    eval?: (data: { output: string }, env: Record<string, unknown>) => unknown;
  };
}) {
  const shim = Platform?.shim;
  if (!shim) return;
  shim.fetch = safeFetch;
  shim.eval = (data, _env) => {
    const code = String(data?.output || '');
    if (!code.trim()) throw new Error('YouTube: empty decipher script');
    // data.output already ends with `return process(...)` → { n, sig }
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    const result = new Function(code)();
    if (result == null || typeof result !== 'object') {
      throw new Error('YouTube: decipher script returned invalid result');
    }
    return result as Record<string, unknown>;
  };
}

async function getTube(): Promise<Tube> {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      try {
        const { Innertube, Platform } = await import('youtubei.js');
        installYtEval(Platform as unknown as Parameters<typeof installYtEval>[0]);
        return await Innertube.create({
          generate_session_locally: true,
          fetch: safeFetch,
        });
      } catch (e) {
        innertubePromise = null;
        throw e;
      }
    })();
  }
  return innertubePromise as Promise<Tube>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Reliable cover CDN (no referrer issues if img uses referrerPolicy=no-referrer). */
export function ytArtworkUrl(videoId: string, quality: 'hq' | 'mq' | 'sd' | 'max' = 'hq'): string {
  const id = String(videoId || '').trim();
  if (!id) return '';
  const file =
    quality === 'max'
      ? 'maxresdefault.jpg'
      : quality === 'sd'
        ? 'sddefault.jpg'
        : quality === 'mq'
          ? 'mqdefault.jpg'
          : 'hqdefault.jpg';
  return `https://i.ytimg.com/vi/${id}/${file}`;
}

function httpUrl(v: unknown): string | undefined {
  if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  if (v && typeof v === 'object') {
    const u = (v as { url?: unknown }).url;
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
  }
  return undefined;
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const r = asRecord(v);
  if (typeof r.text === 'string') return r.text;
  if (Array.isArray(r.runs)) {
    return r.runs
      .map((x) => (typeof x === 'string' ? x : String(asRecord(x).text || '')))
      .join('');
  }
  if (typeof (v as { toString?: () => string }).toString === 'function') {
    const s = String((v as { toString: () => string }).toString());
    if (s && s !== '[object Object]') return s;
  }
  return '';
}

function pickThumbnail(it: Record<string, unknown>, videoId: string): string {
  // Prefer built-in ytimg — always works, no broken "[object Object]" from youtubei nodes
  const fallback = ytArtworkUrl(videoId, 'hq');

  const thumbs = it.thumbnails;
  if (Array.isArray(thumbs) && thumbs.length) {
    // last entry is usually largest
    for (let i = thumbs.length - 1; i >= 0; i--) {
      const u = httpUrl(thumbs[i]);
      if (u) return u;
    }
  }
  const best = httpUrl(it.best_thumbnail);
  if (best) return best;
  const single = httpUrl(it.thumbnail);
  if (single) return single;

  return fallback;
}

function videoIdOf(it: Record<string, unknown>): string {
  const direct = String(it.video_id || it.id || '').trim();
  if (direct.length >= 6 && !/\s/.test(direct)) return direct;
  const endpoint = asRecord(it.endpoint);
  const payload = asRecord(endpoint.payload);
  const fromEp = String(payload.videoId || payload.video_id || '').trim();
  if (fromEp.length >= 6) return fromEp;
  return '';
}

export async function searchYouTube(query: string, limit = 24): Promise<YtSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const yt = await getTube();
  const res = await yt.search(q, { type: 'video' });
  const r = asRecord(res);
  const results = (r.results || r.videos || []) as unknown[];
  const out: YtSearchHit[] = [];

  for (const item of results) {
    const it = asRecord(item);
    const type = String(it.type || (item as { constructor?: { name?: string } })?.constructor?.name || '');
    if (type && /playlist|channel|shelf/i.test(type) && !/video/i.test(type)) continue;

    const videoId = videoIdOf(it);
    if (!videoId || videoId.length < 6) continue;

    const title = textOf(it.title) || 'YouTube';
    const author =
      textOf(asRecord(it.author).name) ||
      textOf(it.author) ||
      textOf(asRecord(it.author).text) ||
      'YouTube';

    let durationMs: number | undefined;
    if (typeof it.duration === 'number') durationMs = it.duration * 1000;
    else if (asRecord(it.duration).seconds) durationMs = Number(asRecord(it.duration).seconds) * 1000;
    else if (typeof it.length_seconds === 'number') durationMs = Number(it.length_seconds) * 1000;

    out.push({
      id: videoId,
      title,
      author,
      durationMs,
      thumbnail: pickThumbnail(it, videoId),
    });
    if (out.length >= limit) break;
  }

  // Fallback parse if structured results empty
  if (!out.length && Array.isArray(results)) {
    for (const item of results) {
      try {
        const any = item as {
          id?: string;
          video_id?: string;
          title?: { text?: string } | string;
          author?: { name?: string } | string;
          duration?: { seconds?: number };
          thumbnails?: Array<{ url?: string }>;
        };
        const id = String(any?.video_id || any?.id || '');
        if (!id || id.length < 6) continue;
        out.push({
          id,
          title: typeof any.title === 'string' ? any.title : any.title?.text || 'YouTube',
          author: typeof any.author === 'string' ? any.author : any.author?.name || 'YouTube',
          durationMs: any.duration?.seconds ? any.duration.seconds * 1000 : undefined,
          thumbnail: any.thumbnails?.[0]?.url || ytArtworkUrl(id),
        });
        if (out.length >= limit) break;
      } catch {
        /* skip */
      }
    }
  }

  return out;
}

export function ytHitToPlayable(hit: YtSearchHit): Playable {
  const videoId = String(hit.id || '').trim();
  const art =
    (hit.thumbnail && /^https?:\/\//i.test(hit.thumbnail) ? hit.thumbnail : '') ||
    ytArtworkUrl(videoId);
  return {
    uid: youtubeUid(videoId),
    source: 'youtube',
    title: hit.title,
    artist: hit.author,
    durationMs: hit.durationMs,
    artworkUrl: art || null,
    meta: { videoId },
  };
}

type YtFormatLike = {
  url?: string;
  signature_cipher?: string;
  cipher?: string;
  mime_type?: string;
  has_audio?: boolean;
  has_video?: boolean;
  bitrate?: number;
  decipher?: (player: unknown) => Promise<string>;
};

type YtPlayerLike = {
  decipher?: (
    url?: string,
    signature_cipher?: string,
    cipher?: string
  ) => Promise<string>;
};

type YtInfoLike = {
  streaming_data?: {
    formats?: YtFormatLike[];
    adaptive_formats?: YtFormatLike[];
    hls_manifest_url?: string;
    dash_manifest_url?: string;
  };
  chooseFormat?: (opts: unknown) => YtFormatLike;
};

function formatPlayableHint(f: YtFormatLike): string {
  const parts = [
    f.url ? 'url' : null,
    f.signature_cipher ? 'sig' : null,
    f.cipher ? 'cipher' : null,
    f.mime_type?.slice(0, 24) || null,
  ].filter(Boolean);
  return parts.join('|') || 'empty';
}

async function decipherFormat(
  f: YtFormatLike,
  player: YtPlayerLike | undefined
): Promise<string | null> {
  // Already open URL (common on ANDROID/IOS clients)
  if (typeof f.url === 'string' && f.url.startsWith('http') && !f.signature_cipher && !f.cipher) {
    // Still may need nsig transform when `n=` present
    if (player?.decipher && /[?&]n=/.test(f.url)) {
      try {
        const u = await player.decipher(f.url, undefined, undefined);
        if (u?.startsWith('http')) return u;
      } catch {
        /* use raw */
      }
    }
    return f.url;
  }

  if (typeof f.decipher === 'function' && player) {
    try {
      const u = await f.decipher(player);
      if (u?.startsWith('http')) return u;
    } catch (e) {
      // try lower-level below
      const msg = e instanceof Error ? e.message : String(e);
      if (!/No valid URL/i.test(msg)) throw e;
    }
  }

  if (player?.decipher) {
    const u = await player.decipher(f.url, f.signature_cipher, f.cipher);
    if (u?.startsWith('http')) return u;
  }

  if (typeof f.url === 'string' && f.url.startsWith('http')) return f.url;
  return null;
}

function rankFormat(f: YtFormatLike): number {
  const mime = String(f.mime_type || '');
  const hasAudio = f.has_audio === true || mime.includes('audio');
  const hasVideo = f.has_video === true || (mime.includes('video') && !mime.includes('audio'));
  let s = Number(f.bitrate || 0);
  if (hasAudio && !hasVideo) s += 1_000_000_000; // pure audio first
  else if (hasAudio) s += 100_000_000;
  // Prefer mp4/m4a for <audio> element reliability
  if (mime.includes('mp4') || mime.includes('mp4a')) s += 50_000;
  return s;
}

async function streamFromInfo(
  info: YtInfoLike,
  player: YtPlayerLike | undefined,
  label: string
): Promise<string | null> {
  const sd = info.streaming_data;
  if (!sd) return null;

  const formats = [...(sd.formats || []), ...(sd.adaptive_formats || [])];
  const withPayload = formats.filter(
    (f) => f.url || f.signature_cipher || f.cipher
  );
  console.log(
    '[yt] info',
    label,
    'formats',
    formats.length,
    'with url/cipher',
    withPayload.length,
    'hls',
    Boolean(sd.hls_manifest_url),
    'sample',
    formats.slice(0, 3).map(formatPlayableHint).join(', ')
  );

  const ordered = [...withPayload].sort((a, b) => rankFormat(b) - rankFormat(a));
  for (const f of ordered) {
    try {
      const u = await decipherFormat(f, player);
      if (u) {
        console.log('[yt] stream ok', label, (f.mime_type || '').slice(0, 48));
        return u;
      }
    } catch (e) {
      console.warn('[yt] decipher fail', label, e instanceof Error ? e.message : e);
    }
  }

  // chooseFormat path (respects type/quality)
  if (typeof info.chooseFormat === 'function' && player) {
    for (const opts of [
      { type: 'audio', quality: 'best', format: 'any' },
      { type: 'audio', quality: 'best', format: 'mp4' },
      { type: 'video+audio', quality: 'best', format: 'any' },
      { type: 'video+audio', quality: 'best', format: 'mp4' },
    ] as const) {
      try {
        const f = info.chooseFormat(opts);
        const u = await decipherFormat(f, player);
        if (u) {
          console.log('[yt] stream ok chooseFormat', label, opts.type);
          return u;
        }
      } catch (e) {
        console.warn('[yt] chooseFormat', label, opts, e instanceof Error ? e.message : e);
      }
    }
  }

  // HLS (hls.js in player) — often present when progressive is sealed
  let hls = sd.hls_manifest_url;
  if (hls) {
    if (player?.decipher) {
      try {
        hls = await player.decipher(hls);
      } catch {
        /* keep raw */
      }
    }
    if (String(hls).startsWith('http')) {
      console.log('[yt] stream ok HLS', label);
      return String(hls);
    }
  }

  return null;
}

export async function resolveYouTubeStreamUrl(videoId: string): Promise<string> {
  const id = String(videoId || '').trim();
  if (!id) throw new Error('YouTube: empty video id');

  const yt = (await getTube()) as Tube & {
    getBasicInfo: (id: string, opts?: { client?: string }) => Promise<YtInfoLike>;
    getInfo?: (id: string, opts?: { client?: string }) => Promise<YtInfoLike>;
    session?: { player?: YtPlayerLike };
  };
  const player = yt.session?.player;

  // Prefer mobile/TV clients — progressive URLs more often
  const clients = [
    'ANDROID',
    'IOS',
    'ANDROID_MUSIC',
    'ANDROID_VR',
    'TV',
    'TV_EMBEDDED',
    'MWEB',
    'WEB_EMBEDDED',
    'WEB',
    undefined,
  ] as const;

  const errors: string[] = [];

  for (const client of clients) {
    try {
      const info = (await yt.getBasicInfo(id, client ? { client } : undefined)) as YtInfoLike;
      const url = await streamFromInfo(info, player, client || 'default');
      if (url) return url;
      const n =
        (info.streaming_data?.formats?.length || 0) +
        (info.streaming_data?.adaptive_formats?.length || 0);
      errors.push(`${client || 'default'}:0/${n}`);
    } catch (e) {
      errors.push(`${client || 'default'}:${e instanceof Error ? e.message : e}`);
      console.warn('[yt] getBasicInfo', client, e instanceof Error ? e.message : e);
    }
  }

  // Full getInfo (sometimes has richer streaming_data)
  if (typeof yt.getInfo === 'function') {
    for (const client of ['ANDROID', 'IOS', undefined] as const) {
      try {
        const info = (await yt.getInfo(id, client ? { client } : undefined)) as YtInfoLike;
        const url = await streamFromInfo(info, player, `getInfo:${client || 'def'}`);
        if (url) return url;
      } catch (e) {
        errors.push(`getInfo:${client}:${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Library helper — decipher Format objects, not only .url
  if (typeof yt.getStreamingData === 'function') {
    for (const client of ['ANDROID', 'IOS', 'TV', undefined] as const) {
      for (const opts of [
        { type: 'audio' as const, quality: 'best', format: 'any', client },
        { type: 'audio' as const, quality: 'best', format: 'mp4', client },
        { type: 'video+audio' as const, quality: 'best', format: 'any', client },
      ]) {
        try {
          const format = (await yt.getStreamingData(
            id,
            opts as { type: string; quality: string; format: string }
          )) as YtFormatLike;
          const url = await decipherFormat(format, player);
          if (url?.startsWith('http')) {
            console.log('[yt] stream ok getStreamingData', client || 'def', opts.type);
            return url;
          }
        } catch (e) {
          errors.push(`gsd:${client}:${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }

  // Reset innertube session once — stale player scripts break decipher
  innertubePromise = null;
  try {
    const yt2 = (await getTube()) as typeof yt;
    const player2 = yt2.session?.player;
    const info = (await yt2.getBasicInfo(id, { client: 'ANDROID' })) as YtInfoLike;
    const url = await streamFromInfo(info, player2, 'retry-ANDROID');
    if (url) return url;
  } catch (e) {
    errors.push(`retry:${e instanceof Error ? e.message : e}`);
  }

  throw new Error(
    `YouTube: no playable audio URL (${errors.slice(0, 5).join(' · ') || 'no clients'}). ` +
      'Проверь прокси / попробуй другой ролик.'
  );
}
