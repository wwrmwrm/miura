import type { Playable } from '../player/types';
import { sortLocalTracks } from '../sources/localLibrary';

export type SmartPlaylistId =
  | 'most_played'
  | 'recently_played'
  | 'recently_added'
  | 'never_played'
  | 'missing'
  | 'no_cover'
  | 'no_tags'
  | 'flac'
  | 'long'
  | 'short';

export type SmartPlaylistDef = {
  id: SmartPlaylistId;
  /** i18n key under local.smart.* */
  labelKey: string;
  filter: (t: Playable) => boolean;
  sort?: Parameters<typeof sortLocalTracks>[1];
  sortDir?: 'asc' | 'desc';
  limit?: number;
};

export const SMART_PLAYLISTS: SmartPlaylistDef[] = [
  {
    id: 'most_played',
    labelKey: 'smartMostPlayed',
    filter: (t) => (Number(t.meta?.playCount) || 0) > 0,
    sort: 'played',
    sortDir: 'desc',
    limit: 100,
  },
  {
    id: 'recently_played',
    labelKey: 'smartRecentlyPlayed',
    filter: (t) => Boolean(t.meta?.lastPlayedAt),
    sort: 'played',
    sortDir: 'desc',
    limit: 50,
  },
  {
    id: 'recently_added',
    labelKey: 'smartRecentlyAdded',
    filter: () => true,
    sort: 'added',
    sortDir: 'desc',
    limit: 50,
  },
  {
    id: 'never_played',
    labelKey: 'smartNeverPlayed',
    filter: (t) => !(Number(t.meta?.playCount) || 0),
    sort: 'added',
    sortDir: 'desc',
  },
  {
    id: 'missing',
    labelKey: 'smartMissing',
    filter: (t) => Boolean(t.meta?.missing),
    sort: 'title',
  },
  {
    id: 'no_cover',
    labelKey: 'smartNoCover',
    filter: (t) => !t.artworkUrl,
    sort: 'artist',
  },
  {
    id: 'no_tags',
    labelKey: 'smartNoTags',
    filter: (t) =>
      !t.meta?.enriched ||
      !t.meta?.album ||
      t.artist === 'Unknown' ||
      /_/.test(t.title),
    sort: 'path',
  },
  {
    id: 'flac',
    labelKey: 'smartFlac',
    filter: (t) => /\.flac$/i.test(t.filePath || ''),
    sort: 'artist',
  },
  {
    id: 'long',
    labelKey: 'smartLong',
    filter: (t) => (t.durationMs || 0) >= 10 * 60 * 1000,
    sort: 'duration',
    sortDir: 'desc',
  },
  {
    id: 'short',
    labelKey: 'smartShort',
    filter: (t) => (t.durationMs || 0) > 0 && (t.durationMs || 0) < 2 * 60 * 1000,
    sort: 'duration',
    sortDir: 'asc',
  },
];

export function runSmartPlaylist(tracks: Playable[], id: SmartPlaylistId): Playable[] {
  const def = SMART_PLAYLISTS.find((d) => d.id === id);
  if (!def) return [];
  let list = tracks.filter(def.filter);
  list = sortLocalTracks(list, def.sort || 'title', def.sortDir || 'asc');
  if (def.limit) list = list.slice(0, def.limit);
  return list;
}
