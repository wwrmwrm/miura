import { getTrack } from '../api/soundcloud';
import type { Track } from '../types';

export type ResolvedUrl =
  | { kind: 'soundcloud'; track: Track }
  | { kind: 'unknown' };

/** Detect & resolve pasted SoundCloud URLs */
export async function resolveMusicUrl(raw: string): Promise<ResolvedUrl> {
  const input = raw.trim();
  if (!input) return { kind: 'unknown' };

  // SoundCloud permalink
  if (/soundcloud\.com\//i.test(input)) {
    try {
      const { resolveUrl } = await import('../api/soundcloud');
      const t = await resolveUrl(input);
      if (t && typeof t === 'object' && 'title' in t && 'user' in t && !('track_count' in t && !('media' in t))) {
        if (
          'duration' in t &&
          !('tracks' in t && Array.isArray((t as { tracks?: unknown }).tracks) && !(t as unknown as Track).media)
        ) {
          return { kind: 'soundcloud', track: t as unknown as Track };
        }
      }
      if (t && 'title' in t && 'permalink_url' in t && 'user' in t && typeof (t as unknown as Track).id === 'number') {
        const maybe = t as unknown as Track & { kind?: string };
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
