/** Local miura playlists (per profile). Search-import only — no piracy downloads. */

import type { Track } from '../types';
import type { Playable } from '../player/types';
import { readScopedJson, writeScopedJson } from './profileScope';

const KEY = 'miura_playlists_v1';

export type MiuraPlaylistItemStatus = 'pending' | 'searching' | 'found' | 'not_found' | 'error';

export type MiuraPlaylistItem = {
  id: string;
  /** Original text line */
  query: string;
  status: MiuraPlaylistItemStatus;
  source?: 'local' | 'soundcloud';
  title?: string;
  artist?: string;
  artworkUrl?: string | null;
  durationMs?: number;
  /** SoundCloud track (when source=soundcloud) — keep slim */
  track?: Track;
  /** Local playable */
  playable?: Playable;
  error?: string;
  resolvedAt?: number;
};

export type MiuraPlaylist = {
  id: string;
  title: string;
  description?: string;
  artworkUrl?: string | null;
  createdAt: number;
  updatedAt: number;
  items: MiuraPlaylistItem[];
};

function uid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `pl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Drop heavy SC fields not needed for play / UI. */
export function slimTrack(t: Track): Track {
  const media = t.media?.transcodings?.length
    ? {
        transcodings: t.media.transcodings.map((tc) => ({
          url: tc.url,
          preset: tc.preset,
          duration: tc.duration,
          snipped: tc.snipped,
          format: tc.format
            ? { protocol: tc.format.protocol, mime_type: tc.format.mime_type }
            : tc.format,
        })),
      }
    : t.media;
  return {
    id: t.id,
    title: t.title,
    permalink_url: t.permalink_url,
    artwork_url: t.artwork_url,
    duration: t.duration,
    genre: t.genre,
    streamable: t.streamable,
    urn: t.urn,
    media: media as Track['media'],
    user: t.user
      ? {
          id: t.user.id,
          username: t.user.username,
          full_name: t.user.full_name,
          avatar_url: t.user.avatar_url,
          permalink_url: t.user.permalink_url,
        }
      : t.user,
    // keep optional policy if present
    ...(typeof (t as Track & { policy?: string }).policy === 'string'
      ? { policy: (t as Track & { policy?: string }).policy }
      : {}),
  } as Track;
}

export function slimPlayable(p: Playable): Playable {
  return {
    uid: p.uid,
    source: p.source,
    title: p.title,
    artist: p.artist,
    durationMs: p.durationMs,
    artworkUrl: p.artworkUrl,
    filePath: p.filePath,
    streamUrl: p.streamUrl,
    meta: p.meta ? { ...p.meta } : undefined,
  };
}

/**
 * Real playback source for badge/play.
 */
export function itemSource(
  it: Pick<MiuraPlaylistItem, 'source' | 'track' | 'playable'>
): 'local' | 'soundcloud' | undefined {
  const p = it.playable;
  if (p) {
    if (p.source === 'local' || p.uid?.startsWith('local:') || p.filePath) return 'local';
  }
  if (it.source === 'local' || it.source === 'soundcloud') {
    return it.source;
  }
  if (it.track) return 'soundcloud';
  return undefined;
}

export function normalizePlaylistItem(it: MiuraPlaylistItem): MiuraPlaylistItem {
  let next = it;
  // Drop legacy YouTube playlist items (source removed from product)
  const legacySrc = String(it.source || '');
  const playableSrc = String(it.playable?.source || '');
  const isLegacyYt =
    playableSrc === 'youtube' ||
    Boolean(it.playable?.uid?.startsWith('yt:')) ||
    Boolean(it.playable?.meta?.videoId) ||
    legacySrc === 'youtube';
  if (isLegacyYt) {
    next = {
      ...it,
      status: 'not_found',
      source: undefined,
      playable: undefined,
      track: undefined,
      error: 'Source removed',
    };
  } else if (it.playable?.source === 'local' || it.playable?.uid?.startsWith('local:')) {
    if (it.source !== 'local' || it.track) {
      next = { ...it, source: 'local', track: undefined };
    }
  } else if (it.track && !it.playable && it.source !== 'soundcloud') {
    next = { ...it, source: 'soundcloud' };
  }

  // Slim payloads once
  if (next.track) {
    const slim = slimTrack(next.track);
    if (slim !== next.track) next = { ...next, track: slim };
  }
  if (next.playable) {
    next = { ...next, playable: slimPlayable(next.playable) };
  }
  return next;
}

// ─── In-memory cache: avoid re-parse + full normalize on every patch ───

let cache: MiuraPlaylist[] | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let normalizedOnce = false;

function readRaw(): MiuraPlaylist[] {
  const list = readScopedJson<MiuraPlaylist[]>(KEY, []);
  return Array.isArray(list) ? list : [];
}

function ensureCache(): MiuraPlaylist[] {
  if (cache) return cache;
  const list = readRaw();
  if (!normalizedOnce) {
    // One-time normalize on first load (can be heavy — only once per session)
    cache = list.map((pl) => ({
      ...pl,
      items: (pl.items || []).map((it) => normalizePlaylistItem(it)),
    }));
    normalizedOnce = true;
    // Persist slimmed data in background
    scheduleSave(0);
  } else {
    cache = list;
  }
  return cache;
}

function scheduleSave(ms = 400) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!cache) return;
    try {
      writeScopedJson(KEY, cache);
    } catch (e) {
      console.warn('[playlists] save failed', e);
    }
  }, ms);
}

/** Flush pending save immediately (call after bulk import). */
export function flushPlaylists() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!cache) return;
  try {
    writeScopedJson(KEY, cache);
  } catch (e) {
    console.warn('[playlists] flush failed', e);
  }
}

/** Invalidate memory cache (e.g. profile switch). */
export function invalidatePlaylistCache() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  cache = null;
  normalizedOnce = false;
}

export function loadPlaylists(): MiuraPlaylist[] {
  // Return cache reference — callers should treat as read-only / copy on mutate
  return ensureCache();
}

export function savePlaylists(list: MiuraPlaylist[]) {
  cache = list;
  scheduleSave(0);
}

export function getPlaylist(id: string): MiuraPlaylist | null {
  return ensureCache().find((p) => p.id === id) || null;
}

function commit(list: MiuraPlaylist[], opts?: { debounceMs?: number }) {
  cache = list;
  scheduleSave(opts?.debounceMs ?? 400);
  return list;
}

export function createPlaylist(
  title: string,
  opts?: { description?: string; artworkUrl?: string | null }
): MiuraPlaylist {
  const now = Date.now();
  const pl: MiuraPlaylist = {
    id: uid(),
    title: title.trim() || 'Playlist',
    description: opts?.description?.trim() || undefined,
    artworkUrl: opts?.artworkUrl || null,
    createdAt: now,
    updatedAt: now,
    items: [],
  };
  const all = [...ensureCache()];
  all.unshift(pl);
  commit(all, { debounceMs: 0 });
  return pl;
}

export function updatePlaylist(pl: MiuraPlaylist, opts?: { debounceMs?: number }): MiuraPlaylist {
  const next = { ...pl, updatedAt: Date.now() };
  const all = [...ensureCache()];
  const i = all.findIndex((p) => p.id === next.id);
  if (i >= 0) all[i] = next;
  else all.unshift(next);
  commit(all, opts);
  return next;
}

export function deletePlaylist(id: string) {
  commit(
    ensureCache().filter((p) => p.id !== id),
    { debounceMs: 0 }
  );
}

export function renamePlaylist(id: string, title: string): MiuraPlaylist | null {
  const pl = getPlaylist(id);
  if (!pl) return null;
  return updatePlaylist({ ...pl, title: title.trim() || pl.title }, { debounceMs: 0 });
}

export function patchPlaylistMeta(
  id: string,
  patch: { title?: string; description?: string | null; artworkUrl?: string | null }
): MiuraPlaylist | null {
  const pl = getPlaylist(id);
  if (!pl) return null;
  const next: MiuraPlaylist = { ...pl };
  if (typeof patch.title === 'string') next.title = patch.title.trim() || pl.title;
  if ('description' in patch) {
    const d = patch.description;
    if (d == null || !String(d).trim()) delete next.description;
    else next.description = String(d).trim();
  }
  if ('artworkUrl' in patch) {
    next.artworkUrl = patch.artworkUrl || null;
  }
  return updatePlaylist(next, { debounceMs: 0 });
}

/** Best cover for list cards: custom art → first few tracks only (fast). */
export function playlistCover(pl: MiuraPlaylist): string | null {
  if (pl.artworkUrl && String(pl.artworkUrl).trim()) return pl.artworkUrl;
  const items = pl.items || [];
  const limit = Math.min(items.length, 8);
  for (let i = 0; i < limit; i++) {
    const it = items[i];
    if (it.artworkUrl && /^https?:\/\/|^data:|^miura-file:|^miu-file:/i.test(it.artworkUrl)) {
      return it.artworkUrl;
    }
    if (it.playable?.artworkUrl && /^https?:\/\//i.test(it.playable.artworkUrl)) {
      return it.playable.artworkUrl;
    }
    if (it.track?.artwork_url) return it.track.artwork_url;
  }
  return null;
}

export function newPlaylistItem(query: string): MiuraPlaylistItem {
  return {
    id: uid(),
    query: query.trim(),
    status: 'pending',
  };
}

export function appendItems(playlistId: string, queries: string[]): MiuraPlaylist | null {
  const pl = getPlaylist(playlistId);
  if (!pl) return null;
  const items = queries.filter(Boolean).map(newPlaylistItem);
  return updatePlaylist({ ...pl, items: [...pl.items, ...items] }, { debounceMs: 0 });
}

/** Add already-resolved playables (local files, etc.) as ready tracks. */
export function appendPlayables(playlistId: string, playables: Playable[]): MiuraPlaylist | null {
  const pl = getPlaylist(playlistId);
  if (!pl || !playables.length) return null;
  const seen = new Set(
    pl.items
      .map((it) => it.playable?.uid || (it.track ? `sc:${it.track.id}` : ''))
      .filter(Boolean)
  );
  const items: MiuraPlaylistItem[] = [];
  for (const p of playables) {
    const playable = slimPlayable(p);
    if (!playable.uid || seen.has(playable.uid)) continue;
    seen.add(playable.uid);
    const artist = playable.artist || '';
    const title = playable.title || 'Track';
    items.push({
      id: uid(),
      query: artist ? `${artist} - ${title}` : title,
      status: 'found',
      source: playable.source === 'local' ? 'local' : 'soundcloud',
      title,
      artist: artist || undefined,
      artworkUrl: playable.artworkUrl ?? null,
      durationMs: playable.durationMs,
      playable,
      resolvedAt: Date.now(),
    });
  }
  if (!items.length) return pl;
  return updatePlaylist({ ...pl, items: [...pl.items, ...items] }, { debounceMs: 0 });
}

export function patchItem(
  playlistId: string,
  itemId: string,
  patch: Partial<MiuraPlaylistItem> & {
    track?: Track | null;
    playable?: Playable | null;
    error?: string | null;
    artworkUrl?: string | null;
    source?: MiuraPlaylistItem['source'] | null;
  },
  opts?: { debounceMs?: number }
): MiuraPlaylist | null {
  const pl = getPlaylist(playlistId);
  if (!pl) return null;
  const items = pl.items.map((it) => {
    if (it.id !== itemId) return it;
    const merged: MiuraPlaylistItem = { ...it, ...(patch as Partial<MiuraPlaylistItem>) };
    if ('track' in patch && patch.track == null) delete merged.track;
    if ('playable' in patch && patch.playable == null) delete merged.playable;
    if ('error' in patch && patch.error == null) delete merged.error;
    if ('artworkUrl' in patch && patch.artworkUrl == null) delete merged.artworkUrl;
    if ('source' in patch && patch.source == null) delete merged.source;
    if (merged.track) merged.track = slimTrack(merged.track);
    if (merged.playable) merged.playable = slimPlayable(merged.playable);
    return merged;
  });
  return updatePlaylist({ ...pl, items }, opts);
}

/** Replace an item wholesale (used after import resolve). */
export function replaceItem(
  playlistId: string,
  itemId: string,
  next: MiuraPlaylistItem,
  opts?: { debounceMs?: number }
): MiuraPlaylist | null {
  const pl = getPlaylist(playlistId);
  if (!pl) return null;
  const normalized = normalizePlaylistItem({ ...next, id: itemId });
  const items = pl.items.map((it) => (it.id === itemId ? normalized : it));
  return updatePlaylist({ ...pl, items }, opts);
}

/**
 * Bulk-replace many items in one write (import batch).
 * `updates` maps itemId → full next item.
 */
export function replaceItemsBulk(
  playlistId: string,
  updates: Map<string, MiuraPlaylistItem>,
  opts?: { debounceMs?: number }
): MiuraPlaylist | null {
  const pl = getPlaylist(playlistId);
  if (!pl || !updates.size) return pl;
  const items = pl.items.map((it) => {
    const n = updates.get(it.id);
    return n ? normalizePlaylistItem({ ...n, id: it.id }) : it;
  });
  return updatePlaylist({ ...pl, items }, opts);
}

export function removeItem(playlistId: string, itemId: string): MiuraPlaylist | null {
  const pl = getPlaylist(playlistId);
  if (!pl) return null;
  return updatePlaylist(
    { ...pl, items: pl.items.filter((it) => it.id !== itemId) },
    { debounceMs: 0 }
  );
}

export function playlistStats(pl: MiuraPlaylist) {
  let found = 0;
  let pending = 0;
  let missing = 0;
  for (const i of pl.items) {
    if (i.status === 'found') found++;
    else if (i.status === 'pending' || i.status === 'searching') pending++;
    else if (i.status === 'not_found' || i.status === 'error') missing++;
  }
  return { total: pl.items.length, found, pending, missing };
}
