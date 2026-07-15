import type { Track } from '../types';
import type { Playable } from '../player/types';
import { readScopedJson, writeScopedJson } from './profileScope';

const KEY = 'miura_favorites_v1';

export type FavItem = {
  id: string;
  title: string;
  artist: string;
  artworkUrl?: string | null;
  source: string;
  track?: Track;
  playable?: Playable;
  at: number;
};

export function loadFavorites(): FavItem[] {
  const list = readScopedJson<FavItem[]>(KEY, []);
  return Array.isArray(list) ? list : [];
}

function save(list: FavItem[]) {
  writeScopedJson(KEY, list);
}

export function isFavorite(id: string): boolean {
  return loadFavorites().some((f) => f.id === id);
}

export function toggleFavorite(item: Omit<FavItem, 'at'>): FavItem[] {
  const prev = loadFavorites();
  const exists = prev.find((f) => f.id === item.id);
  const next = exists ? prev.filter((f) => f.id !== item.id) : [{ ...item, at: Date.now() }, ...prev];
  save(next);
  return next;
}

export function favIdFromTrack(track: Track): string {
  const src =
    track.genre === 'local' || track.genre === 'youtube'
      ? track.genre
      : 'soundcloud';
  // Prefer stable YouTube video id when present in permalink/uid-ish fields
  if (src === 'youtube') {
    const m = String(track.permalink_url || '').match(/(?:v=|youtu\.be\/)([\w-]{6,})/i);
    if (m?.[1]) return `youtube:${m[1]}`;
  }
  return `${src}:${track.id}`;
}

export function favIdFromPlayable(p: Playable): string {
  if (p.source === 'youtube') {
    const vid = String(p.meta?.videoId || p.uid.replace(/^yt:/, ''));
    if (vid) return `youtube:${vid}`;
  }
  return `${p.source}:${p.uid}`;
}

export function favoritesBySource(list: FavItem[], source?: string): FavItem[] {
  if (!source) return list;
  return list.filter((f) => String(f.source) === source);
}
