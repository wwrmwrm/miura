/**
 * Pinned SoundCloud playlists for the top ribbon (quick access).
 * Local miura playlists already appear there; this store is for SC / external ones.
 */

import type { Playlist } from '../types';
import { readScopedJson, writeScopedJson } from './profileScope';

const KEY = 'miura_ribbon_pins_v1';

export type RibbonScPin = {
  kind: 'sc';
  /** Stable key: urn or id string */
  id: string;
  scId: number | string;
  urn?: string;
  title: string;
  artworkUrl?: string | null;
  permalinkUrl?: string;
  trackCount?: number;
  userName?: string;
  at: number;
};

export function pinKeyFromPlaylist(pl: Pick<Playlist, 'id' | 'urn'>): string {
  return String(pl.urn || pl.id);
}

export function loadRibbonPins(): RibbonScPin[] {
  const list = readScopedJson<RibbonScPin[]>(KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && p.kind === 'sc' && p.id && p.title);
}

function save(list: RibbonScPin[]) {
  writeScopedJson(KEY, list);
}

export function isPlaylistPinned(pl: Pick<Playlist, 'id' | 'urn'>): boolean {
  const key = pinKeyFromPlaylist(pl);
  return loadRibbonPins().some((p) => p.id === key);
}

export function playlistToPin(pl: Playlist): RibbonScPin {
  return {
    kind: 'sc',
    id: pinKeyFromPlaylist(pl),
    scId: pl.id,
    urn: pl.urn,
    title: pl.title || 'Playlist',
    artworkUrl: pl.artwork_url ?? pl.user?.avatar_url ?? null,
    permalinkUrl: pl.permalink_url,
    trackCount: pl.track_count ?? pl.tracks?.length,
    userName: pl.user?.username || pl.user?.full_name,
    at: Date.now(),
  };
}

/** Toggle pin; returns next list. */
export function toggleRibbonPin(pl: Playlist): RibbonScPin[] {
  const key = pinKeyFromPlaylist(pl);
  const prev = loadRibbonPins();
  const exists = prev.some((p) => p.id === key);
  const next = exists
    ? prev.filter((p) => p.id !== key)
    : [playlistToPin(pl), ...prev.filter((p) => p.id !== key)].slice(0, 40);
  save(next);
  return next;
}

export function pinToPlaylistStub(pin: RibbonScPin): Playlist {
  return {
    id: pin.scId,
    urn: pin.urn,
    title: pin.title,
    permalink_url: pin.permalinkUrl || '',
    artwork_url: pin.artworkUrl ?? null,
    duration: 0,
    track_count: pin.trackCount || 0,
    user: {
      id: 0,
      username: pin.userName || 'SoundCloud',
      avatar_url: '',
      permalink_url: '',
    },
  };
}
