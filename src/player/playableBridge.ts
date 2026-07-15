import type { Track, SoundCloudUser } from '../types';
import type { MusicSource, Playable } from './types';

const dummyUser = (name: string): SoundCloudUser => ({
  id: 0,
  username: name || 'Unknown',
  avatar_url: '',
  permalink_url: '',
});

/** Stable positive int from string (for Track.id). */
export function hashUid(uid: string): number {
  let h = 2166136261;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // keep in safe positive range, avoid clashing with tiny SC ids accidentally by offset
  return 1_000_000_000 + (h >>> 0) % 1_000_000_000;
}

export function playableToTrack(p: Playable): Track {
  return {
    id: hashUid(p.uid),
    title: p.title,
    permalink_url: p.streamUrl || p.filePath || p.uid,
    artwork_url: p.artworkUrl || null,
    duration: p.durationMs || 0,
    genre: p.source,
    playback_count: 0,
    likes_count: 0,
    user: dummyUser(p.artist),
    streamable: true,
    media: undefined,
  };
}

export function trackSource(track: Track | null | undefined): MusicSource | 'soundcloud' {
  if (!track) return 'soundcloud';
  const g = String(track.genre || '');
  if (g === 'local' || g === 'youtube' || g === 'soundcloud') return g;
  return 'soundcloud';
}

const resolvers = new Map<number, () => Promise<{ url: string; protocol: 'progressive' | 'hls' }>>();
const playables = new Map<number, Playable>();

export function registerPlayableResolver(
  trackId: number,
  playable: Playable,
  resolve: () => Promise<{ url: string; protocol: 'progressive' | 'hls' }>
) {
  resolvers.set(trackId, resolve);
  playables.set(trackId, playable);
}

export function getPlayableResolver(trackId: number) {
  return resolvers.get(trackId) || null;
}

export function getPlayable(trackId: number): Playable | null {
  return playables.get(trackId) || null;
}

export function clearPlayableResolver(trackId: number) {
  resolvers.delete(trackId);
  playables.delete(trackId);
}
