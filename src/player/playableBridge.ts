import type { Track, SoundCloudUser } from '../types';
import type { MusicSource, Playable } from './types';

const dummyUser = (name: string): SoundCloudUser => ({
  id: 0,
  username: name || 'Unknown',
  avatar_url: '',
  permalink_url: '',
});

export function hashUid(uid: string): number {
  let h = 2166136261;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 1_000_000_000 + (h >>> 0) % 1_000_000_000;
}

export function playableToTrack(p: Playable): Track {
  let permalink = p.streamUrl || p.filePath || p.uid;
  if (p.source === 'youtube') {
    const vid = String(p.meta?.videoId || (p.uid.startsWith('yt:') ? p.uid.slice(3) : '') || '').trim();
    if (vid) permalink = `https://www.youtube.com/watch?v=${vid}`;
  }
  return {
    id: hashUid(p.uid),
    title: p.title,
    permalink_url: permalink,
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

export function extractYoutubeVideoId(
  track?: Track | null,
  playable?: Playable | null
): string {
  const fromMeta = playable?.meta?.videoId;
  if (fromMeta != null && String(fromMeta).trim()) {
    const v = String(fromMeta).trim();
    if (/^[a-zA-Z0-9_-]{6,}$/.test(v)) return v;
  }
  if (playable?.uid?.startsWith('yt:')) {
    const v = playable.uid.slice(3).trim();
    if (/^[a-zA-Z0-9_-]{6,}$/.test(v)) return v;
  }

  const blobs: string[] = [];
  if (track) {
    blobs.push(
      String(track.permalink_url || ''),
      String(track.artwork_url || ''),
      String(track.waveform_url || ''),
      String(track.title || '')
    );
  }
  if (playable) {
    blobs.push(
      String(playable.uid || ''),
      String(playable.streamUrl || ''),
      String(playable.artworkUrl || '')
    );
  }

  for (const s of blobs) {
    if (!s) continue;
    if (s.startsWith('yt:')) {
      const v = s.slice(3).trim();
      if (/^[a-zA-Z0-9_-]{6,}$/.test(v)) return v;
    }
    const m =
      s.match(
        /(?:youtube\.com\/watch\?(?:[^#]*&)?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{6,})/i
      ) || s.match(/^([a-zA-Z0-9_-]{11})$/);
    if (m?.[1] && /^[a-zA-Z0-9_-]{6,}$/.test(m[1])) return m[1];
  }
  return '';
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
