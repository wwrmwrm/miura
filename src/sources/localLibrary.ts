import type { Playable } from '../player/types';
import { localUid } from '../player/types';
import { getActiveProfileScope, readScopedJson, scopedKey, writeScopedJson } from '../lib/profileScope';

const STORAGE_KEY = 'miura_local_library_v3';
const STORAGE_LEGACY = ['miura_local_library_v2', 'miura_local_library_v1'];
const WATCHED_FOLDERS_KEY = 'miura_local_watched_folders';

const AUDIO_EXT = /\.(mp3|flac|m4a|aac|wav|ogg|opus|wma|aiff|aif|webm)$/i;

export type LocalTrackMeta = {
  path: string;
  name: string;
  size?: number;
  /** Prebuilt miura-file:// URL from main process */
  url?: string;
  title?: string;
  artist?: string;
  album?: string | null;
  albumArtist?: string | null;
  genre?: string | null;
  year?: number | null;
  trackNo?: number | null;
  discNo?: number | null;
  durationMs?: number | null;
  /** Cover as data:/miura-file: (data: not persisted long-term) */
  artworkUrl?: string | null;
  /** True after main process read ID3 at least once */
  enriched?: boolean;
  /** Folder that was added as a library root (watch target) */
  rootFolder?: string | null;
  /** Parent directory of the file */
  folder?: string | null;
  addedAt?: number | null;
  playCount?: number;
  lastPlayedAt?: number | null;
  /** File missing on disk */
  missing?: boolean;
  /** ReplayGain track gain in dB */
  replayGainDb?: number | null;
  /** Embedded or sidecar lyrics text */
  lyrics?: string | null;
  /** User edited tags in miura library (not written to disk file) */
  userEdited?: boolean;
};

export type LocalSortKey =
  | 'title'
  | 'artist'
  | 'album'
  | 'genre'
  | 'year'
  | 'duration'
  | 'added'
  | 'played'
  | 'path';

export type LocalBrowseView = 'tracks' | 'artists' | 'albums' | 'genres' | 'folders' | 'smart';

export function isAudioFileName(name: string): boolean {
  return AUDIO_EXT.test(name);
}

/**
 * Clean filenames like "01_cool_track_name.mp3" or "Artist - Song_title.flac".
 * Returns title + optional artist when the name looks like "Artist - Title".
 */
export function parseFileNameMeta(fileName: string): { title: string; artist?: string } {
  let base = String(fileName || '').replace(/\.[^.]+$/i, '');
  base = base.replace(/^\s*[(\[]?\d{1,3}[)\]]?\s*[.\-–—_)\]\s]+\s*/u, '');
  base = base.replace(/[_]+/g, ' ');
  base = base.replace(/\s*[-–—]\s*/g, ' - ');
  base = base.replace(/\s+/g, ' ').trim();
  if (!base) return { title: fileName };

  const m = base.match(/^(.{1,80}?)\s+-\s+(.+)$/);
  if (m && m[2].trim()) {
    return { artist: m[1].trim(), title: m[2].trim() };
  }
  return { title: base };
}

/** "01_cool_track_name" → "cool track name" */
export function prettyFileTitle(fileName: string): string {
  return parseFileNameMeta(fileName).title;
}

function looksLikeRawFileTitle(title: string): boolean {
  if (!title) return true;
  if (/_/.test(title)) return true;
  if (/^\d{1,3}[\s._\-]/.test(title)) return true;
  return false;
}

function normPath(p: string): string {
  return String(p || '').replace(/\\/g, '/');
}

export function folderOf(filePath: string): string {
  const p = normPath(filePath);
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : p;
}

export function pathToPlayable(p: LocalTrackMeta): Playable {
  const fileName = p.name || p.path.split(/[/\\]/).pop() || 'track';
  const fromFile = parseFileNameMeta(fileName);
  const taggedTitle = p.title && String(p.title).trim();
  const taggedArtist = p.artist && String(p.artist).trim();

  let title: string;
  if (taggedTitle && !looksLikeRawFileTitle(taggedTitle)) {
    title = taggedTitle;
  } else if (taggedTitle && looksLikeRawFileTitle(taggedTitle)) {
    title = prettyFileTitle(taggedTitle) || fromFile.title;
  } else {
    title = fromFile.title;
  }

  const artist =
    taggedArtist && taggedArtist !== 'Unknown' ? taggedArtist : fromFile.artist || 'Unknown';

  const folder = p.folder || folderOf(p.path);
  const enriched = Boolean(p.enriched);

  return {
    uid: localUid(p.path),
    source: 'local',
    title: title || fromFile.title || fileName,
    artist: artist || 'Unknown',
    durationMs: typeof p.durationMs === 'number' ? p.durationMs : undefined,
    filePath: p.path,
    streamUrl: p.url ? String(p.url).replace(/^miu-file:/i, 'miura-file:') : undefined,
    artworkUrl: p.artworkUrl || null,
    meta: {
      size: p.size,
      fileName,
      album: p.album || null,
      albumArtist: p.albumArtist || null,
      genre: p.genre || null,
      year: p.year ?? null,
      trackNo: p.trackNo ?? null,
      discNo: p.discNo ?? null,
      folder,
      rootFolder: p.rootFolder || null,
      enriched: enriched || undefined,
      addedAt: p.addedAt ?? null,
      playCount: p.playCount ?? 0,
      lastPlayedAt: p.lastPlayedAt ?? null,
      missing: Boolean(p.missing),
      replayGainDb: p.replayGainDb ?? null,
      lyrics: p.lyrics || null,
      userEdited: Boolean(p.userEdited) || undefined,
    },
  };
}

function readMetaList(): LocalTrackMeta[] {
  try {
    const list = readScopedJson<LocalTrackMeta[]>(STORAGE_KEY, []);
    if (Array.isArray(list) && list.length) return list;
    // migrate legacy keys once
    if (getActiveProfileScope()) {
      for (const key of STORAGE_LEGACY) {
        try {
          const raw = localStorage.getItem(scopedKey(key)) || localStorage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as LocalTrackMeta[];
          if (Array.isArray(parsed) && parsed.length) {
            writeScopedJson(STORAGE_KEY, parsed);
            return parsed;
          }
        } catch {
          /* ignore */
        }
      }
    } else {
      for (const key of STORAGE_LEGACY) {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as LocalTrackMeta[];
          if (Array.isArray(parsed) && parsed.length) {
            writeScopedJson(STORAGE_KEY, parsed);
            return parsed;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function loadLocalLibrary(): Playable[] {
  return readMetaList()
    .filter((x) => x?.path && (x?.name || x?.path))
    .map(pathToPlayable);
}

export function saveLocalLibrary(tracks: Playable[]) {
  const meta: LocalTrackMeta[] = tracks
    .filter((t) => t.source === 'local' && t.filePath)
    .map((t) => {
      const art = t.artworkUrl ?? null;
      const artworkUrl = art && art.startsWith('data:') ? null : art;
      const m = t.meta || {};
      return {
        path: t.filePath!,
        name: String(m.fileName || t.title),
        size: typeof m.size === 'number' ? m.size : undefined,
        title: t.title,
        artist: t.artist,
        album: (m.album as string | null) ?? null,
        albumArtist: (m.albumArtist as string | null) ?? null,
        genre: (m.genre as string | null) ?? null,
        year: typeof m.year === 'number' ? m.year : null,
        trackNo: typeof m.trackNo === 'number' ? m.trackNo : null,
        discNo: typeof m.discNo === 'number' ? m.discNo : null,
        durationMs: t.durationMs ?? null,
        artworkUrl,
        url: t.streamUrl,
        enriched: Boolean(m.enriched),
        rootFolder: (m.rootFolder as string | null) ?? null,
        folder: (m.folder as string | null) ?? folderOf(t.filePath!),
        addedAt: typeof m.addedAt === 'number' ? m.addedAt : null,
        playCount: typeof m.playCount === 'number' ? m.playCount : 0,
        lastPlayedAt: typeof m.lastPlayedAt === 'number' ? m.lastPlayedAt : null,
        missing: Boolean(m.missing),
        replayGainDb: typeof m.replayGainDb === 'number' ? m.replayGainDb : null,
        userEdited: Boolean(m.userEdited) || undefined,
        // lyrics can be large — keep if short enough
        lyrics:
          typeof m.lyrics === 'string' && m.lyrics.length < 12000 ? (m.lyrics as string) : null,
      };
    });
  try {
    writeScopedJson(STORAGE_KEY, meta);
  } catch {
    try {
      const slim = meta.map(({ artworkUrl: _a, lyrics: _l, ...rest }) => rest);
      writeScopedJson(STORAGE_KEY, slim);
    } catch {
      /* ignore */
    }
  }
}

export function mergeLocalTracks(
  existing: Playable[],
  incoming: LocalTrackMeta[],
  opts?: { rootFolder?: string | null }
): Playable[] {
  const map = new Map<string, Playable>();
  for (const t of existing) {
    if (t.filePath) map.set(normPath(t.filePath), t);
  }
  const now = Date.now();
  for (const m of incoming) {
    if (!isAudioFileName(m.name) && !isAudioFileName(m.path)) continue;
    const key = normPath(m.path);
    const prev = map.get(key);
    const prevRoot =
      typeof prev?.meta?.rootFolder === 'string' ? prev.meta.rootFolder : null;
    const p = pathToPlayable({
      ...m,
      rootFolder: m.rootFolder ?? opts?.rootFolder ?? prevRoot,
      folder: m.folder || folderOf(m.path),
      addedAt: m.addedAt ?? (typeof prev?.meta?.addedAt === 'number' ? prev.meta.addedAt : now),
      playCount: m.playCount ?? (typeof prev?.meta?.playCount === 'number' ? prev.meta.playCount : 0),
      lastPlayedAt:
        m.lastPlayedAt ??
        (typeof prev?.meta?.lastPlayedAt === 'number' ? prev.meta.lastPlayedAt : null),
      missing: false,
    });
    // Preserve play stats / manual tag edits when re-enriching
    if (prev) {
      const userEdited = Boolean(prev.meta?.userEdited);
      p.meta = {
        ...p.meta,
        playCount: (typeof prev.meta?.playCount === 'number' ? prev.meta.playCount : null) ?? p.meta?.playCount ?? 0,
        lastPlayedAt:
          (typeof prev.meta?.lastPlayedAt === 'number' ? prev.meta.lastPlayedAt : null) ??
          p.meta?.lastPlayedAt ??
          null,
        addedAt:
          (typeof prev.meta?.addedAt === 'number' ? prev.meta.addedAt : null) ?? p.meta?.addedAt ?? now,
        rootFolder:
          (typeof prev.meta?.rootFolder === 'string' ? prev.meta.rootFolder : null) ||
          p.meta?.rootFolder ||
          null,
        lyrics: (p.meta?.lyrics as string) || (prev.meta?.lyrics as string) || null,
        userEdited: userEdited || undefined,
      };
      // Manual library edits win over re-scanned ID3 until user clears userEdited
      if (userEdited) {
        p.title = prev.title;
        p.artist = prev.artist;
        p.meta = {
          ...p.meta,
          album: prev.meta?.album ?? p.meta?.album,
          genre: prev.meta?.genre ?? p.meta?.genre,
          year: prev.meta?.year ?? p.meta?.year,
          trackNo: prev.meta?.trackNo ?? p.meta?.trackNo,
        };
      }
      if (!p.artworkUrl && prev.artworkUrl) p.artworkUrl = prev.artworkUrl;
    }
    map.set(key, p);
  }
  return Array.from(map.values());
}

export function sortLocalTracks(tracks: Playable[], key: LocalSortKey, dir: 'asc' | 'desc' = 'asc'): Playable[] {
  const mul = dir === 'desc' ? -1 : 1;
  const str = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }) * mul;
  const num = (a: number, b: number) => (a - b) * mul;
  return [...tracks].sort((a, b) => {
    switch (key) {
      case 'title':
        return str(a.title, b.title) || str(a.artist, b.artist);
      case 'artist':
        return str(a.artist, b.artist) || str(a.title, b.title);
      case 'album':
        return (
          str(String(a.meta?.album || ''), String(b.meta?.album || '')) ||
          num(Number(a.meta?.trackNo) || 0, Number(b.meta?.trackNo) || 0) ||
          str(a.title, b.title)
        );
      case 'genre':
        return str(String(a.meta?.genre || ''), String(b.meta?.genre || '')) || str(a.title, b.title);
      case 'year':
        return num(Number(a.meta?.year) || 0, Number(b.meta?.year) || 0) || str(a.title, b.title);
      case 'duration':
        return num(a.durationMs || 0, b.durationMs || 0);
      case 'added':
        return num(Number(a.meta?.addedAt) || 0, Number(b.meta?.addedAt) || 0);
      case 'played':
        return (
          num(Number(a.meta?.playCount) || 0, Number(b.meta?.playCount) || 0) ||
          num(Number(a.meta?.lastPlayedAt) || 0, Number(b.meta?.lastPlayedAt) || 0)
        );
      case 'path':
        return str(a.filePath || '', b.filePath || '');
      default:
        return 0;
    }
  });
}

export type GroupBucket = {
  key: string;
  label: string;
  count: number;
  artworkUrl?: string | null;
  tracks: Playable[];
};

export function groupByArtist(tracks: Playable[]): GroupBucket[] {
  const map = new Map<string, Playable[]>();
  for (const t of tracks) {
    const k = t.artist || 'Unknown';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(t);
  }
  return Array.from(map.entries())
    .map(([label, list]) => ({
      key: `artist:${label}`,
      label,
      count: list.length,
      artworkUrl: list.find((x) => x.artworkUrl)?.artworkUrl || null,
      tracks: sortLocalTracks(list, 'album'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function groupByAlbum(tracks: Playable[]): GroupBucket[] {
  const map = new Map<string, Playable[]>();
  for (const t of tracks) {
    const album = String(t.meta?.album || '').trim() || 'Unknown album';
    const artist = String(t.meta?.albumArtist || t.artist || 'Unknown');
    const k = `${artist}|||${album}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(t);
  }
  return Array.from(map.entries())
    .map(([k, list]) => {
      const [artist, album] = k.split('|||');
      return {
        key: `album:${k}`,
        label: album,
        count: list.length,
        artworkUrl: list.find((x) => x.artworkUrl)?.artworkUrl || null,
        tracks: sortLocalTracks(list, 'album'),
        // stash artist in key via label suffix for UI
        _artist: artist,
      } as GroupBucket & { _artist?: string };
    })
    .map((g) => ({
      ...g,
      label: (g as GroupBucket & { _artist?: string })._artist
        ? `${g.label} · ${(g as GroupBucket & { _artist?: string })._artist}`
        : g.label,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function groupByGenre(tracks: Playable[]): GroupBucket[] {
  const map = new Map<string, Playable[]>();
  for (const t of tracks) {
    const g = String(t.meta?.genre || '').trim() || 'Unknown';
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(t);
  }
  return Array.from(map.entries())
    .map(([label, list]) => ({
      key: `genre:${label}`,
      label,
      count: list.length,
      artworkUrl: list.find((x) => x.artworkUrl)?.artworkUrl || null,
      tracks: sortLocalTracks(list, 'artist'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function groupByFolder(tracks: Playable[]): GroupBucket[] {
  const map = new Map<string, Playable[]>();
  for (const t of tracks) {
    const f = String(t.meta?.folder || folderOf(t.filePath || '') || '—');
    if (!map.has(f)) map.set(f, []);
    map.get(f)!.push(t);
  }
  return Array.from(map.entries())
    .map(([label, list]) => ({
      key: `folder:${label}`,
      label,
      count: list.length,
      artworkUrl: list.find((x) => x.artworkUrl)?.artworkUrl || null,
      tracks: sortLocalTracks(list, 'title'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function loadWatchedFolders(): string[] {
  try {
    const list = readScopedJson<string[]>(WATCHED_FOLDERS_KEY, []);
    return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

export function saveWatchedFolders(folders: string[]) {
  try {
    writeScopedJson(WATCHED_FOLDERS_KEY, [...new Set(folders.map(normPath))]);
  } catch {
    /* ignore */
  }
}

export function recordLocalPlay(tracks: Playable[], filePath: string): Playable[] {
  const key = normPath(filePath);
  const now = Date.now();
  return tracks.map((t) => {
    if (!t.filePath || normPath(t.filePath) !== key) return t;
    return {
      ...t,
      meta: {
        ...t.meta,
        playCount: (Number(t.meta?.playCount) || 0) + 1,
        lastPlayedAt: now,
      },
    };
  });
}

export function applyLocalTagEdit(
  tracks: Playable[],
  filePath: string,
  edit: Partial<{
    title: string;
    artist: string;
    album: string | null;
    genre: string | null;
    year: number | null;
    trackNo: number | null;
    lyrics: string | null;
  }>
): Playable[] {
  const key = normPath(filePath);
  return tracks.map((t) => {
    if (!t.filePath || normPath(t.filePath) !== key) return t;
    return {
      ...t,
      title: edit.title !== undefined ? edit.title : t.title,
      artist: edit.artist !== undefined ? edit.artist : t.artist,
      meta: {
        ...t.meta,
        album: edit.album !== undefined ? edit.album : t.meta?.album,
        genre: edit.genre !== undefined ? edit.genre : t.meta?.genre,
        year: edit.year !== undefined ? edit.year : t.meta?.year,
        trackNo: edit.trackNo !== undefined ? edit.trackNo : t.meta?.trackNo,
        lyrics: edit.lyrics !== undefined ? edit.lyrics : t.meta?.lyrics,
        /** Survives re-enrich; disk files are not rewritten (library-only tags) */
        userEdited: true,
      },
    };
  });
}

export function findDuplicates(tracks: Playable[]): Playable[][] {
  const byKey = new Map<string, Playable[]>();
  for (const t of tracks) {
    const title = t.title.trim().toLowerCase();
    const artist = t.artist.trim().toLowerCase();
    const dur = Math.round((t.durationMs || 0) / 2000); // 2s buckets
    const k = `${artist}|${title}|${dur}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(t);
  }
  return Array.from(byKey.values()).filter((g) => g.length > 1);
}

export function formatDuration(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}
