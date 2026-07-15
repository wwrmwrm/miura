import { readScopedJson, writeScopedJson } from './profileScope';

const KEY = 'miura_local_playback_prefs_v1';

export type EqBand = { freq: number; gain: number };

export type LocalPlaybackPrefs = {
  /** Soft normalize: cap loud tracks via gain node */
  normalize: boolean;
  /** Apply ReplayGain when present in tags */
  replayGain: boolean;
  /** Crossfade seconds (0 = off) */
  crossfadeSec: number;
  /** Gapless-ish: reduce silence between local tracks */
  gapless: boolean;
  /** Equalizer enabled */
  eqEnabled: boolean;
  /** 10-band gains in dB (-12..+12) */
  eq: number[];
  /** Last.fm */
  lastfmEnabled: boolean;
  lastfmSessionKey: string;
  lastfmUser: string;
  lastfmApiKey: string;
  lastfmSecret: string;
};

export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_PRESETS: Record<string, number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  vocal: [-2, -1, 0, 2, 4, 4, 2, 0, -1, -2],
  electronic: [4, 3, 1, 0, -1, 1, 2, 3, 4, 4],
  rock: [4, 3, 2, 1, 0, 1, 2, 3, 3, 2],
};

const DEFAULT: LocalPlaybackPrefs = {
  normalize: false,
  /** Off by default — enable in Settings if tags have ReplayGain */
  replayGain: false,
  crossfadeSec: 0,
  gapless: true,
  eqEnabled: false,
  eq: [...EQ_PRESETS.flat],
  lastfmEnabled: false,
  lastfmSessionKey: '',
  lastfmUser: '',
  lastfmApiKey: '',
  lastfmSecret: '',
};

export function loadPlaybackPrefs(): LocalPlaybackPrefs {
  try {
    const raw = readScopedJson<Partial<LocalPlaybackPrefs>>(KEY, {});
    return {
      ...DEFAULT,
      ...raw,
      eq: Array.isArray(raw.eq) && raw.eq.length === 10 ? raw.eq.map(Number) : [...DEFAULT.eq],
    };
  } catch {
    return { ...DEFAULT, eq: [...DEFAULT.eq] };
  }
}

export function savePlaybackPrefs(prefs: LocalPlaybackPrefs) {
  try {
    writeScopedJson(KEY, prefs);
  } catch {
    /* ignore */
  }
}

/** dB → linear amplitude */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}
