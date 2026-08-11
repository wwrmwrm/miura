import type { Track } from '../types';
import type { Playable } from '../player/types';
import { readScopedJson, writeScopedJson } from './profileScope';

const KEY = 'miura_recent_v1';
const MAX = 40;

export type RecentItem = {
  id: string;
  title: string;
  artist: string;
  artworkUrl?: string | null;
  source: string;
  track?: Track;
  playable?: Playable;
  at: number;
};

export function loadRecent(): RecentItem[] {
  const list = readScopedJson<RecentItem[]>(KEY, []);
  return Array.isArray(list) ? list.slice(0, MAX) : [];
}

export function pushRecent(item: Omit<RecentItem, 'at' | 'id'> & { id?: string }) {
  const entry: RecentItem = {
    ...item,
    id: item.id || `${item.source}:${item.title}:${item.artist}`,
    at: Date.now(),
  };
  const prev = loadRecent().filter((r) => r.id !== entry.id);
  const next = [entry, ...prev].slice(0, MAX);
  writeScopedJson(KEY, next);
  return next;
}

export function trackToRecent(track: Track): Omit<RecentItem, 'at' | 'id'> {
  const source = track.genre === 'local' ? 'local' : 'soundcloud';
  return {
    title: track.title,
    artist: track.user?.username || track.user?.full_name || '—',
    artworkUrl: track.artwork_url,
    source,
    track,
  };
}
