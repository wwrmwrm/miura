/** Unified playable item across all miura sources. */
export type MusicSource = 'local' | 'soundcloud';

export type Playable = {
  /** Stable id within source, e.g. `local:C:/Music/a.mp3` or `sc:123` */
  uid: string;
  source: MusicSource;
  title: string;
  artist: string;
  durationMs?: number;
  artworkUrl?: string | null;
  /** Absolute file path (local) */
  filePath?: string;
  /** Direct stream / progressive URL if known */
  streamUrl?: string;
  /** Source-specific payload */
  meta?: Record<string, unknown>;
};

export function localUid(filePath: string): string {
  return `local:${filePath.replace(/\\/g, '/')}`;
}

export function soundcloudUid(trackId: number | string): string {
  return `sc:${trackId}`;
}
