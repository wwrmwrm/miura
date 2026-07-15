/**
 * Parse a bulk text tracklist and resolve each line via local / SoundCloud / YouTube search.
 * Does not download files — only finds playable matches for a miura playlist.
 */

import {
  artworkUrl as scArtworkUrl,
  getStreamInfo,
  getTrack,
  isDrmOnlyTrack,
  isGoPlusOnlyTrack,
  searchTracks,
} from '../api/soundcloud';
import type { Track } from '../types';
import type { Playable } from '../player/types';
import { loadLocalLibrary } from '../sources/localLibrary';
import { searchYouTube, ytHitToPlayable } from '../sources/youtube';
import type { MiuraPlaylistItem } from './miuraPlaylists';
import { slimPlayable, slimTrack } from './miuraPlaylists';

export type ParsedTrackLine = {
  raw: string;
  artist?: string;
  title: string;
  query: string;
};

export type ImportSource = 'local' | 'soundcloud' | 'youtube';

export type ResolveResult = {
  status: 'found' | 'not_found' | 'error';
  source?: ImportSource;
  title?: string;
  artist?: string;
  artworkUrl?: string | null;
  durationMs?: number;
  track?: Track;
  playable?: Playable;
  error?: string;
};

/** Split paste into non-empty lines; strip list numbers and # comments. */
export function parseTrackListText(text: string): ParsedTrackLine[] {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));

  const out: ParsedTrackLine[] = [];
  for (let raw of lines) {
    // 1. 01) 1- "Track"
    raw = raw.replace(/^\s*[\d]+[\.\)\-–—:]\s*/, '');
    raw = raw.replace(/^["«]|["»]$/g, '').trim();
    if (!raw || raw.length < 2) continue;

    // Artist - Title / Artist – Title / Artist — Title
    const m = raw.match(/^(.{1,120}?)\s+[-–—]\s+(.+)$/);
    if (m && m[2].trim()) {
      const artist = m[1].trim();
      const title = m[2].trim();
      out.push({
        raw,
        artist,
        title,
        query: `${artist} ${title}`,
      });
    } else {
      out.push({ raw, title: raw, query: raw });
    }
  }
  return out;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMatch(query: ParsedTrackLine, title: string, artist: string): number {
  const qt = norm(query.title);
  const qa = norm(query.artist || '');
  const t = norm(title);
  const a = norm(artist);
  let s = 0;
  if (!qt) return 0;
  if (t === qt) s += 50;
  else if (t.includes(qt) || qt.includes(t)) s += 30;
  else {
    // token overlap
    const qtTok = new Set(qt.split(' ').filter((x) => x.length > 2));
    const tTok = t.split(' ').filter((x) => x.length > 2);
    let hit = 0;
    for (const x of tTok) if (qtTok.has(x)) hit++;
    s += hit * 6;
  }
  if (qa) {
    if (a === qa) s += 40;
    else if (a.includes(qa) || qa.includes(a)) s += 25;
    else {
      const qaTok = new Set(qa.split(' ').filter((x) => x.length > 2));
      for (const x of a.split(' ')) if (qaTok.has(x)) s += 8;
    }
  }
  return s;
}

function matchLocal(line: ParsedTrackLine): ResolveResult | null {
  const lib = loadLocalLibrary();
  let best: Playable | null = null;
  let bestScore = 0;
  for (const p of lib) {
    const sc = scoreMatch(line, p.title, p.artist);
    if (sc > bestScore) {
      bestScore = sc;
      best = p;
    }
  }
  if (!best || bestScore < 28) return null;
  return {
    status: 'found',
    source: 'local',
    title: best.title,
    artist: best.artist,
    artworkUrl: best.artworkUrl,
    durationMs: best.durationMs,
    playable: best,
  };
}

function isEncryptedProto(proto: string): boolean {
  const p = proto.toLowerCase();
  return (
    p.includes('encrypted') ||
    p.includes('cbcs') ||
    p.includes('sample-aes') ||
    p.includes('cenc') ||
    p.includes('ctr-') ||
    p.includes('fairplay') ||
    p.includes('widevine')
  );
}

function scTranscodings(track: Track) {
  return track.media?.transcodings ?? [];
}

function scHasEncryptedFormats(track: Track): boolean {
  return scTranscodings(track).some((t) => isEncryptedProto(t.format?.protocol || ''));
}

/** Non-snipped progressive only (not HLS — HLS is often encrypted ABR). */
function scHasFullProgressive(track: Track): boolean {
  return scTranscodings(track).some((t) => {
    if (!t?.url || t.snipped) return false;
    const p = (t.format?.protocol || '').toLowerCase();
    return p === 'progressive' && !isEncryptedProto(p);
  });
}

/**
 * Playlist import: ONLY full progressive MP3 counts as “open SC”.
 * Any encrypted format without working progressive → YouTube.
 * Empty media after enrich → YouTube (don't guess).
 */
function scQuickReject(track: Track): boolean {
  if (!track) return true;
  const policy = String((track as Track & { policy?: string }).policy || '').toUpperCase();
  if (policy === 'BLOCK' || policy === 'SNIP') return true;
  if (track.streamable === false) return true;
  if (isDrmOnlyTrack(track)) return true;
  if (isGoPlusOnlyTrack(track)) return true;

  const list = scTranscodings(track);
  if (!list.length) return true;
  if (list.every((t) => t.snipped)) return true;

  // Playlist rule (strict): ANY encrypted format → treat as DRM, use YouTube.
  // SC often lists fake/dead progressive next to real encrypted HLS.
  if (scHasEncryptedFormats(track)) return true;

  // No full progressive MP3 → YouTube
  if (!scHasFullProgressive(track)) return true;

  return false;
}

/** Estimate if progressive payload is a short free snip vs full track. */
function looksLikeSnipPayload(track: Track, contentLength: number): boolean {
  if (!contentLength || contentLength < 0) return false;
  const durMs = Number(track.duration || 0);
  // Unknown duration — only reject tiny blobs
  if (!durMs || durMs < 15_000) return contentLength < 40_000;
  // ~128 kbps ≈ 16 KB/s. Full track should be far larger than a 30–45s snip.
  const fullMinBytes = (durMs / 1000) * 8_000; // ~64 kbps floor
  const snipMaxBytes = 50 * 16_000; // ~50s @ 128kbps
  if (durMs >= 90_000 && contentLength > 0 && contentLength < snipMaxBytes) return true;
  if (contentLength < fullMinBytes * 0.2) return true;
  return false;
}

/**
 * Must successfully exchange a progressive (non-encrypted) URL
 * AND the CDN must actually serve full-track audio (not a free 30s snip).
 */
async function scVerifyProgressivePlayable(track: Track): Promise<boolean> {
  if (scQuickReject(track)) return false;
  try {
    const info = await getStreamInfo(track, { forceProgressive: true });
    const proto = String(info.protocol || '').toLowerCase();
    if (proto !== 'progressive') return false;
    if (isEncryptedProto(proto)) return false;
    if (info.snipped) return false;
    if (!info.url || /skd:|blob:|data:/i.test(info.url)) return false;

    // Also reject if the progressive transcoding row itself is snipped
    const prog = scTranscodings(track).find((t) => {
      const p = (t.format?.protocol || '').toLowerCase();
      return p === 'progressive' && t.url && !t.snipped;
    });
    if (!prog) return false;

    try {
      if (window.electronAPI?.mediaFetch) {
        // Full size via Range end-byte probe (HEAD often stripped by CDNs)
        const heady = await window.electronAPI.mediaFetch({
          url: info.url,
          method: 'GET',
          headers: { Range: 'bytes=0-1' },
        });
        if (!(heady.ok || heady.status === 206 || heady.status === 200)) return false;
        const ct = String(heady.headers?.['content-type'] || '').toLowerCase();
        if (ct && /text\/html|application\/json|text\/xml/.test(ct)) return false;

        const cr = String(heady.headers?.['content-range'] || '');
        // Content-Range: bytes 0-1/1234567
        const totalMatch = cr.match(/\/(\d+)\s*$/);
        const total = totalMatch ? Number(totalMatch[1]) : Number(heady.headers?.['content-length'] || 0);
        if (total > 0 && looksLikeSnipPayload(track, total)) {
          console.log('[import] SC skip (snip-sized progressive)', track.title, total, 'bytes', track.duration, 'ms');
          return false;
        }
        const b64 = heady.bodyBase64 || '';
        if (b64.length < 4) return false;
      } else {
        const res = await fetch(info.url, {
          method: 'GET',
          headers: { Range: 'bytes=0-1' },
        });
        if (!(res.ok || res.status === 206)) return false;
        const ct = String(res.headers.get('content-type') || '').toLowerCase();
        if (ct && /text\/html|application\/json|text\/xml/.test(ct)) return false;
        const cr = String(res.headers.get('content-range') || '');
        const totalMatch = cr.match(/\/(\d+)\s*$/);
        const total = totalMatch ? Number(totalMatch[1]) : Number(res.headers.get('content-length') || 0);
        if (total > 0 && looksLikeSnipPayload(track, total)) return false;
      }
    } catch {
      // Network fail → don't trust SC for playlist import
      return false;
    }
    return true;
  } catch {
    // DRM, 404 progressive, blocked, rate limit → YouTube
    return false;
  }
}

async function enrichScTrack(tr: Track): Promise<Track> {
  try {
    const full = await getTrack(tr.id, {
      urn: tr.urn,
      permalink_url: tr.permalink_url,
    });
    // Prefer the result that has media
    if (full?.media?.transcodings?.length) return full;
    return { ...tr, ...full, media: full.media || tr.media };
  } catch {
    return tr;
  }
}

/**
 * SC match only if progressive stream really works.
 * Returns null → caller MUST try YouTube (never return SC DRM as found).
 */
async function matchSoundCloud(line: ParsedTrackLine): Promise<ResolveResult | null> {
  try {
    const res = await searchTracks(line.query, 10, 0);
    const tracks = (res.collection || []).filter((tr) => tr?.id && tr.title);

    const ranked = tracks
      .map((tr) => {
        const artist = tr.user?.username || tr.user?.full_name || '';
        return { tr, score: scoreMatch(line, tr.title, artist) };
      })
      .filter((x) => x.score >= 22)
      .sort((a, b) => b.score - a.score);

    if (!ranked.length) return null;

    for (const { tr } of ranked.slice(0, 5)) {
      const full = await enrichScTrack(tr);
      // Strict gates — any DRM/encrypted path → next candidate or YouTube
      if (scQuickReject(full)) {
        console.log('[import] SC skip (drm/meta)', full.title, full.policy, full.media?.transcodings?.map((t) => t.format?.protocol));
        continue;
      }
      const ok = await scVerifyProgressivePlayable(full);
      if (!ok) {
        console.log('[import] SC skip (no progressive)', full.title);
        continue;
      }
      console.log('[import] SC ok progressive', full.title);
      const art =
        scArtworkUrl(full.artwork_url || full.user?.avatar_url, 't300x300') ||
        full.artwork_url ||
        full.user?.avatar_url ||
        null;
      return {
        status: 'found',
        source: 'soundcloud',
        title: full.title,
        artist: full.user?.username || full.user?.full_name || '',
        artworkUrl: art,
        durationMs: full.duration,
        track: full,
      };
    }

    console.log('[import] SC none playable → YouTube for', line.query);
    return null;
  } catch (e) {
    // Don't block YouTube on SC network errors — return null to continue
    console.warn('[import] SC error', e);
    return null;
  }
}

async function matchYouTube(line: ParsedTrackLine): Promise<ResolveResult | null> {
  try {
    // Prefer music-ish results
    const q = /official|audio|lyrics|topic/i.test(line.query)
      ? line.query
      : `${line.query} audio`;
    const hits = await searchYouTube(q, 8);
    if (!hits.length) {
      // retry without "audio" suffix
      const hits2 = await searchYouTube(line.query, 8);
      if (!hits2.length) return null;
      return ytFromHits(line, hits2);
    }
    return ytFromHits(line, hits);
  } catch (e) {
    // second chance without suffix
    try {
      const hits = await searchYouTube(line.query, 8);
      if (!hits.length) {
        return { status: 'error', error: e instanceof Error ? e.message : String(e) };
      }
      return ytFromHits(line, hits);
    } catch (e2) {
      return {
        status: 'error',
        error: e2 instanceof Error ? e2.message : String(e2),
      };
    }
  }
}

function ytFromHits(line: ParsedTrackLine, hits: Awaited<ReturnType<typeof searchYouTube>>): ResolveResult {
  let best = hits[0];
  let bestScore = 0;
  for (const h of hits) {
    const sc = scoreMatch(line, h.title, h.author);
    if (sc > bestScore) {
      bestScore = sc;
      best = h;
    }
  }
  // When falling back from SC DRM, accept top YT hit even with weak score
  if (!best) best = hits[0];
  const playable = ytHitToPlayable(best);
  return {
    status: 'found',
    source: 'youtube',
    title: playable.title,
    artist: playable.artist,
    artworkUrl: playable.artworkUrl,
    durationMs: playable.durationMs,
    playable,
  };
}

/**
 * Resolve one line:
 *  local → YouTube → SoundCloud (verified progressive only).
 *
 * YouTube first for text tracklists: reliable streams + covers.
 * SC only when YT misses and progressive MP3 really works (byte-probed).
 */
export async function resolveTrackLine(
  line: ParsedTrackLine,
  sources: ImportSource[] = ['local', 'youtube', 'soundcloud']
): Promise<ResolveResult> {
  const want = new Set(
    sources.length ? sources : (['local', 'youtube', 'soundcloud'] as ImportSource[])
  );

  // 1) Local files
  if (want.has('local')) {
    const r = matchLocal(line);
    if (r?.status === 'found') return r;
  }

  // 2) YouTube — preferred for pasted tracklists (covers + open audio)
  let ytError: string | undefined;
  if (want.has('youtube')) {
    const r = await matchYouTube(line);
    if (r?.status === 'found' && r.playable) {
      // Guarantee source + cover even if search thumb was junk
      const videoId = String(r.playable.meta?.videoId || r.playable.uid.replace(/^yt:/, ''));
      const art =
        (r.artworkUrl && /^https?:\/\//i.test(r.artworkUrl) ? r.artworkUrl : '') ||
        (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');
      return {
        ...r,
        source: 'youtube',
        artworkUrl: art || r.artworkUrl || null,
        playable: slimPlayable({
          ...r.playable,
          source: 'youtube',
          artworkUrl: art || r.playable.artworkUrl || null,
        }),
        track: undefined,
      };
    }
    if (r?.status === 'error') ytError = r.error;
  }

  // 3) SoundCloud — only full progressive that actually serves audio
  if (want.has('soundcloud')) {
    const r = await matchSoundCloud(line);
    if (r?.status === 'found' && r.source === 'soundcloud' && r.track) {
      if (!scQuickReject(r.track) && scHasFullProgressive(r.track)) {
        console.log('[import] SC fallback ok for', line.query, '→', r.title);
        return { ...r, playable: undefined };
      }
      console.log('[import] SC rejected at final gate', r.title);
    }
  }

  if (ytError) {
    return { status: 'error', error: ytError };
  }

  return {
    status: 'not_found',
    error: want.has('soundcloud')
      ? 'YouTube not found and SC has no open progressive stream'
      : undefined,
  };
}

export function applyResolveToItem(item: MiuraPlaylistItem, r: ResolveResult): MiuraPlaylistItem {
  if (r.status === 'found') {
    const source = r.source;
    // Keep payload exclusive: SC → track only; YouTube/local → playable only.
    // Prevents "SC" badge while the real stream is YouTube.
    const base: MiuraPlaylistItem = {
      id: item.id,
      query: item.query,
      status: 'found',
      source,
      title: r.title,
      artist: r.artist,
      artworkUrl: r.artworkUrl,
      durationMs: r.durationMs,
      resolvedAt: Date.now(),
    };
    if (source === 'soundcloud' && r.track) {
      return { ...base, track: slimTrack(r.track) };
    }
    if ((source === 'youtube' || source === 'local') && r.playable) {
      return {
        ...base,
        playable: slimPlayable(r.playable),
        source:
          r.playable.source === 'youtube' || r.playable.source === 'local'
            ? r.playable.source
            : source,
      };
    }
    return {
      ...base,
      track: r.track ? slimTrack(r.track) : undefined,
      playable: r.playable ? slimPlayable(r.playable) : undefined,
    };
  }
  if (r.status === 'error') {
    return {
      id: item.id,
      query: item.query,
      status: 'error',
      error: r.error || 'error',
      resolvedAt: Date.now(),
    };
  }
  return {
    id: item.id,
    query: item.query,
    status: 'not_found',
    resolvedAt: Date.now(),
  };
}

/** Run import with limited concurrency. Calls onItem after each line. */
export async function runTrackListImport(opts: {
  lines: ParsedTrackLine[];
  sources?: ImportSource[];
  concurrency?: number;
  shouldCancel?: () => boolean;
  onItem: (index: number, line: ParsedTrackLine, result: ResolveResult) => void;
}): Promise<void> {
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  let next = 0;

  async function worker() {
    while (next < opts.lines.length) {
      if (opts.shouldCancel?.()) return;
      const i = next++;
      const line = opts.lines[i];
      const result = await resolveTrackLine(line, opts.sources);
      opts.onItem(i, line, result);
      // small pause to ease SC rate limits
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
