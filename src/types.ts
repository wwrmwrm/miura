export interface SoundCloudUser {
  id: number;
  urn?: string;
  username: string;
  avatar_url: string;
  permalink_url: string;
  full_name?: string;
  city?: string | null;
  country_code?: string | null;
  followers_count?: number;
  followings_count?: number;
  track_count?: number;
  playlist_count?: number;
  description?: string | null;
  verified?: boolean;
}

export interface Transcoding {
  url: string;
  preset: string;
  duration: number;
  snipped: boolean;
  format: {
    protocol: string;
    mime_type: string;
  };
  quality: string;
}

export interface Track {
  id: number;
  urn?: string;
  title: string;
  permalink_url: string;
  artwork_url: string | null;
  duration: number;
  genre: string | null;
  playback_count: number;
  likes_count: number;
  reposts_count?: number;
  comment_count?: number;
  user: SoundCloudUser;
  media?: {
    transcodings: Transcoding[];
  };
  streamable?: boolean;
  waveform_url?: string;
  description?: string | null;
  created_at?: string;
  user_favorite?: boolean;
  favoritings_count?: number;
  /** Needed for streaming some mix / geo-gated tracks */
  track_authorization?: string;
  user_repost?: boolean;
  /**
   * Playback policy from api-v2:
   * ALLOW = free full play, SNIP = preview / Go+ full, BLOCK = geo blocked
   */
  policy?: 'ALLOW' | 'SNIP' | 'BLOCK' | string;
  /** e.g. SUB_HIGH_TIER = Go+ catalog */
  monetization_model?: string | null;
}

export interface Playlist {
  /** Numeric id for user playlists, or string slug/urn for system mixes */
  id: number | string;
  urn?: string;
  title: string;
  permalink_url: string;
  artwork_url: string | null;
  duration: number;
  track_count: number;
  genre?: string | null;
  description?: string | null;
  user: SoundCloudUser;
  tracks?: Track[];
  likes_count?: number;
  is_album?: boolean;
  created_at?: string;
  secret_token?: string | null;
  /** SoundCloud Discover mixes / charts system playlists */
  kind?: string;
  is_system?: boolean;
  short_description?: string | null;
  user_like?: boolean;
  liked?: boolean;
}

export interface SearchResponse<T = Track> {
  collection: T[];
  next_href: string | null;
  total_results?: number;
}

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/** Listener plan: free | go | go_plus (detected from /me + payments). */
export type SubscriptionTier = 'free' | 'go' | 'go_plus' | 'unknown';

export interface AuthUser {
  id: number;
  username: string;
  avatar_url: string;
  permalink_url: string;
  full_name?: string;
  followers_count?: number;
  followings_count?: number;
  track_count?: number;
  playlist_count?: number;
  /** Filled after login via getSubscription */
  subscription_tier?: SubscriptionTier;
  subscription_label?: string;
}

export interface AuthSession {
  accessToken: string;
  clientId: string | null;
  user: AuthUser | null;
  savedAt?: number | null;
}

export interface LikeItem {
  created_at?: string;
  track?: Track;
  playlist?: Playlist;
}

export interface TrackComment {
  id: number;
  urn?: string;
  body: string;
  created_at: string;
  timestamp?: number | null;
  track_id?: number;
  user_id?: number;
  kind?: string;
  user: SoundCloudUser;
  /** Created only in UI when API didn't return a real id — delete is local-only */
  localOnly?: boolean;
}

export type Page =
  | 'home'
  | 'search'
  | 'library'
  | 'likes'
  | 'playlists'
  | 'playlist'
  | 'track'
  | 'user'
  | 'queue'
  | 'settings'
  | 'profile'
  | 'local'
  | 'soundcloud'
  | 'miura-playlists';

export type SearchTab = 'tracks' | 'playlists' | 'users';
