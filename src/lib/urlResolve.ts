import type { Playable } from '../player/types';
import { youtubeUid } from '../player/types';
import { getTrack } from '../api/soundcloud';
import type { Track } from '../types';

export type ResolvedUrl =
  | { kind: 'youtube'; playable: Playable }
  | { kind: 'soundcloud'; track: Track }
  | { kind: 'unknown' };

/** Detect & resolve pasted SC / YT URLs */
export async function resolveMusicUrl(raw: string): Promise<ResolvedUrl> {
  const input = raw.trim();
  if (!input) return { kind: 'unknown' };

  // YouTube
  const yt =
    input.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{6,})/) ||
    input.match(/^([a-zA-Z0-9_-]{11})$/);
  if (yt && (input.includes('youtu') || yt[1]?.length === 11)) {
    const videoId = yt[1]!;
    if (input.includes('youtu') || videoId.length === 11) {
      return {
        kind: 'youtube',
        playable: {
          uid: youtubeUid(videoId),
          source: 'youtube',
          title: `YouTube ${videoId}`,
          artist: 'YouTube',
          artworkUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          meta: { videoId },
        },
      };
    }
  }

  // SoundCloud permalink
  if (/soundcloud\.com\//i.test(input)) {
    try {
      const { resolveUrl } = await import('../api/soundcloud');
      const t = await resolveUrl(input);
      if (t && typeof t === 'object' && 'title' in t && 'user' in t && !('track_count' in t && !('media' in t))) {
        // Track has media or duration; Playlist has track_count
        if ('duration' in t && !('tracks' in t && Array.isArray((t as { tracks?: unknown }).tracks) && !(t as Track).media)) {
          return { kind: 'soundcloud', track: t as Track };
        }
      }
      if (t && 'title' in t && 'permalink_url' in t && 'user' in t && typeof (t as Track).id === 'number') {
        // Prefer track if it looks like one
        const maybe = t as Track & { kind?: string };
        if (maybe.kind !== 'playlist' && maybe.kind !== 'user') {
          return { kind: 'soundcloud', track: maybe };
        }
      }
    } catch {
      /* fall through */
    }
    const idm = input.match(/\/tracks?\/([0-9]{5,})|soundcloud\.com\/[^/]+\/([a-zA-Z0-9-]+)/);
    if (idm?.[1]) {
      try {
        const track = await getTrack(Number(idm[1]));
        return { kind: 'soundcloud', track };
      } catch {
        /* ignore */
      }
    }
  }

  return { kind: 'unknown' };
}
