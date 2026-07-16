import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  artworkUrl,
  formatCount,
  formatDuration,
  getLikedPlaylists,
  getLikedTracks,
  getMe,
  getMyPlaylists,
  followUser,
  getRelatedTracks,
  getTrack,
  addTrackToPlaylist,
  createPlaylist,
  deleteComment,
  deletePlaylist,
  getTrackComments,
  postComment,
  removeTrackFromPlaylist,
  resolvePlaylist,
  updatePlaylist,
  getStationTracks,
  getStoredClientId,
  getThemeAccent,
  getUser,
  getUserPlaylists,
  getUserReposts,
  getUserTracks,
  isFollowing,
  isGoPlusOnlyTrack,
  likePlaylist,
  likeTrack,
  loadHomeFeed,
  loadStoredSession,
  loginWithSoundCloud,
  logout,
  refreshSubscription,
  repostTrack,
  resolveClientId,
  searchPlaylists,
  searchTracks,
  searchUsers,
  setAccessToken,
  setClientId,
  setMeUserId,
  setThemeAccent,
  unfollowUser,
  unlikePlaylist,
  unlikeTrack,
  unrepostTrack,
  type HomeGroup,
  type HomeSection,
} from './api/soundcloud';
import { Modal } from './components/Modal';
import { usePlayer } from './hooks/usePlayer';
import { useI18n, useT, LOCALE_LABELS, LOCALE_ORDER, type Locale } from './i18n';
import { TrackPage } from './pages/TrackPage';
import { LocalPage } from './pages/LocalPage';
import { YouTubePage } from './pages/YouTubePage';
import { MiuraMark } from './components/MiuraLogo';
import { EmptyState } from './components/EmptyState';
import { QueueDrawer } from './components/QueueDrawer';
import { SourceBadge } from './components/SourceBadge';
import { getPlayable } from './player/playableBridge';
import { applyAppTheme, getStoredTheme, THEME_ORDER, type AppTheme } from './theme';
import { useMediaHotkeys } from './hooks/useMediaHotkeys';
import { loadRecent, pushRecent, trackToRecent } from './lib/recent';
import {
  favIdFromPlayable,
  favIdFromTrack,
  loadFavorites,
  toggleFavorite,
  type FavItem,
} from './lib/miuraFavorites';
import {
  clearSearchHistory,
  loadSearchHistory,
  pushSearchHistory,
  removeSearchHistoryItem,
} from './lib/searchHistory';
import {
  buildProxyUrl,
  emptyParts,
  matchPresetId,
  parseProxyUrl,
  PROXY_PRESETS,
  type ProxyParts,
  type ProxyScheme,
} from './lib/proxyUrl';
import {
  deleteProfile,
  getProfileState,
  logoutProfile,
  pickProfileAvatar,
  profileInitials,
  updateProfile,
  type MiuraProfile,
  type MiuraProfileState,
} from './lib/miuraProfile';
import { setActiveProfileScope } from './lib/profileScope';
import {
  invalidatePlaylistCache,
  loadPlaylists as loadMiuraPlaylists,
  playlistCover as miuraPlaylistCover,
  type MiuraPlaylist,
} from './lib/miuraPlaylists';
import { resolveMusicUrl } from './lib/urlResolve';
import { cacheGet, cacheSet } from './lib/searchCache';
import { searchYouTube, ytHitToPlayable } from './sources/youtube';
import { ProfileGate } from './components/ProfileGate';
import { ProfilePage } from './pages/ProfilePage';
import { MiuraPlaylistsPage } from './pages/MiuraPlaylistsPage';
import type { Playable } from './player/types';
import type {
  AuthSession,
  Page,
  Playlist,
  SearchTab,
  SoundCloudUser,
  Track,
  TrackComment,
} from './types';

/** Soft white accent — not pure #ffffff (contrast / solid buttons). */
const ACCENT_WHITE = '#f2f2f7';

function isAccentWhite(hex: string): boolean {
  const h = hex.toLowerCase();
  return h === ACCENT_WHITE || h === '#ffffff' || h === '#fff' || h === '#f5f5f7' || h === '#f2f2f7';
}

/** SoundCloud-style home filter tabs */
type HomeTab = 'all' | HomeGroup;

const HOME_TABS: Array<{ id: HomeTab; label: string; needsAuth?: boolean }> = [
  { id: 'all', label: 'Всё' },
  { id: 'feed', label: 'Лента', needsAuth: true },
  { id: 'for-you', label: 'Для вас', needsAuth: true },
  { id: 'discover', label: 'Обзор' },
  { id: 'charts', label: 'Чарты' },
  { id: 'history', label: 'История', needsAuth: true },
];

type NavSnap = {
  page: Page;
  query: string;
  searchTab: SearchTab;
  homeTab: HomeTab;
  activePlaylist: Playlist | null;
  activeTrack: Track | null;
  activeUser: SoundCloudUser | null;
  relatedTracks: Track[];
  trackComments: TrackComment[];
  userTracks: Track[];
  userReposts: Track[];
  userPlaylists: Playlist[];
  userTab: 'tracks' | 'reposts' | 'playlists';
};

const PEOPLE_LABEL: Record<string, string> = {
  ru: 'Люди',
  en: 'People',
  de: 'Personen',
  es: 'Personas',
  fr: 'Personnes',
  it: 'Persone',
  nl: 'Mensen',
  pl: 'Ludzie',
  pt: 'Pessoas',
  sv: 'Personer',
};

export default function App() {
  const t = useT();
  const { locale } = useI18n();
  const peopleLabel = PEOPLE_LABEL[locale] || 'People';
  const player = usePlayer();
  const [page, setPage] = useState<Page>('home');
  const [query, setQuery] = useState('');
  const [searchTab, setSearchTab] = useState<SearchTab>('tracks');
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadSearchHistory());
  /** Media library sub-view */
  const [libraryView, setLibraryView] = useState<'favs' | 'sc-likes' | 'sc-playlists'>('favs');
  const [queueOpen, setQueueOpen] = useState(false);
  const [recent, setRecent] = useState(() => loadRecent());
  const [favorites, setFavorites] = useState<FavItem[]>(() => loadFavorites());
  const [ytHits, setYtHits] = useState<Playable[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [users, setUsers] = useState<SoundCloudUser[]>([]);
  const [homeSections, setHomeSections] = useState<HomeSection[]>([]);
  const [homeTab, setHomeTab] = useState<HomeTab>('all');
  const [libraryPlaylists, setLibraryPlaylists] = useState<Playlist[]>([]);
  const [likedTracks, setLikedTracks] = useState<Track[]>([]);
  const [likedPlaylists, setLikedPlaylists] = useState<Playlist[]>([]);
  const [activePlaylist, setActivePlaylist] = useState<Playlist | null>(null);
  const [activeTrack, setActiveTrack] = useState<Track | null>(null);
  const [relatedTracks, setRelatedTracks] = useState<Track[]>([]);
  const [trackComments, setTrackComments] = useState<TrackComment[]>([]);
  const [activeUser, setActiveUser] = useState<SoundCloudUser | null>(null);
  const [userTracks, setUserTracks] = useState<Track[]>([]);
  const [userReposts, setUserReposts] = useState<Track[]>([]);
  const [userPlaylists, setUserPlaylists] = useState<Playlist[]>([]);
  const [userTab, setUserTab] = useState<'tracks' | 'reposts' | 'playlists'>('tracks');
  const [followingUser, setFollowingUser] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [repostedIds, setRepostedIds] = useState<Set<number>>(() => new Set());
  const [likedPlaylistIds, setLikedPlaylistIds] = useState<Set<string>>(() => new Set());
  const [createPlOpen, setCreatePlOpen] = useState(false);
  const [createPlTitle, setCreatePlTitle] = useState('');
  const [createPlBusy, setCreatePlBusy] = useState(false);
  const [addToPlTrack, setAddToPlTrack] = useState<Track | null>(null);
  const [addToPlBusy, setAddToPlBusy] = useState(false);
  const [renamePlOpen, setRenamePlOpen] = useState(false);
  const [renamePlTitle, setRenamePlTitle] = useState('');
  const [plBusy, setPlBusy] = useState(false);
  const [addTracksOpen, setAddTracksOpen] = useState(false);
  const [addTracksTab, setAddTracksTab] = useState<'likes' | 'search'>('likes');
  const [addTracksQuery, setAddTracksQuery] = useState('');
  const [addTracksResults, setAddTracksResults] = useState<Track[]>([]);
  const [addTracksBusy, setAddTracksBusy] = useState(false);
  const [addTracksFilter, setAddTracksFilter] = useState('');

  /** SPA history for mouse side buttons (back / forward) */
  const navPast = useRef<NavSnap[]>([]);
  const navFuture = useRef<NavSnap[]>([]);
  const navSilent = useRef(false);
  const navSnapRef = useRef<NavSnap | null>(null);

  const [session, setSession] = useState<AuthSession | null>(null);
  const [miuraProfile, setMiuraProfile] = useState<MiuraProfile | null>(null);
  const [miuraProfiles, setMiuraProfiles] = useState<MiuraProfile[]>([]);
  const [profileReady, setProfileReady] = useState(false);
  /** Left-rail playlists (Yandex-style) */
  const [railPlaylists, setRailPlaylists] = useState<MiuraPlaylist[]>(() => loadMiuraPlaylists());
  const [focusMiuraPlaylistId, setFocusMiuraPlaylistId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientIdInput, setClientIdInput] = useState(getStoredClientId() ?? '');
  const [accent, setAccent] = useState(getThemeAccent());
  const [bootDone, setBootDone] = useState(false);
  /** SoundCloud session (optional connected service) */
  const isLoggedIn = Boolean(session?.accessToken && session?.user);
  const hasMiuraProfile = Boolean(miuraProfile);

  // Keep latest nav snapshot for history push
  useEffect(() => {
    navSnapRef.current = {
      page,
      query,
      searchTab,
      homeTab,
      activePlaylist,
      activeTrack,
      activeUser,
      relatedTracks,
      trackComments,
      userTracks,
      userReposts,
      userPlaylists,
      userTab,
    };
  }, [
    page,
    query,
    searchTab,
    homeTab,
    activePlaylist,
    activeTrack,
    activeUser,
    relatedTracks,
    trackComments,
    userTracks,
    userReposts,
    userPlaylists,
    userTab,
  ]);

  const applyNavSnap = useCallback((snap: NavSnap) => {
    navSilent.current = true;
    setPage(snap.page);
    setQuery(snap.query);
    setSearchTab(snap.searchTab);
    setHomeTab(snap.homeTab);
    setActivePlaylist(snap.activePlaylist);
    setActiveTrack(snap.activeTrack);
    setActiveUser(snap.activeUser);
    setRelatedTracks(snap.relatedTracks);
    setTrackComments(snap.trackComments);
    setUserTracks(snap.userTracks);
    setUserReposts(snap.userReposts);
    setUserPlaylists(snap.userPlaylists);
    setUserTab(snap.userTab);
  }, []);

  const pushNavHistory = useCallback(() => {
    if (navSilent.current) {
      navSilent.current = false;
      return;
    }
    const snap = navSnapRef.current;
    if (!snap) return;
    navPast.current.push(snap);
    if (navPast.current.length > 100) navPast.current.shift();
    navFuture.current = [];
  }, []);

  const navigateTo = useCallback(
    (next: Page) => {
      pushNavHistory();
      setPage(next);
    },
    [pushNavHistory]
  );

  const navBack = useCallback(() => {
    const prev = navPast.current.pop();
    if (!prev) return;
    const cur = navSnapRef.current;
    if (cur) navFuture.current.push(cur);
    applyNavSnap(prev);
  }, [applyNavSnap]);

  const navForward = useCallback(() => {
    const next = navFuture.current.pop();
    if (!next) return;
    const cur = navSnapRef.current;
    if (cur) navPast.current.push(cur);
    applyNavSnap(next);
  }, [applyNavSnap]);

  // Mouse side buttons + Chromium back/forward
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      // 3 = back, 4 = forward (XButton1 / XButton2)
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        if (e.button === 3) navBack();
        else navForward();
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Seed history so popstate works for side buttons that trigger browser back
    try {
      window.history.pushState({ miura: true }, '');
    } catch {
      /* ignore */
    }
    const onPopState = () => {
      try {
        window.history.pushState({ miura: true }, '');
      } catch {
        /* ignore */
      }
      navBack();
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, [navBack, navForward]);

  const refreshRailPlaylists = useCallback(() => {
    setRailPlaylists(loadMiuraPlaylists());
  }, []);

  const openMiuraPlaylist = useCallback((id: string | null) => {
    setFocusMiuraPlaylistId(id);
    navigateTo('miura-playlists');
  }, [navigateTo]);

  const applyMiuraProfileState = useCallback((state: MiuraProfileState) => {
    setActiveProfileScope(state.active?.id ?? null);
    setMiuraProfile(state.active);
    setMiuraProfiles(state.profiles);
    setProfileReady(true);
    // Reload per-profile data (favorites / recent / playlists cache)
    invalidatePlaylistCache();
    setFavorites(loadFavorites());
    setRecent(loadRecent());
    setRailPlaylists(loadMiuraPlaylists());
    // Optional profile accent
    if (state.active?.accent) {
      setAccent(state.active.accent);
      setThemeAccent(state.active.accent);
    }
  }, []);

  useEffect(() => {
    setThemeAccent(accent);
  }, [accent]);

  const loadHome = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loggedIn = Boolean(session?.user || session?.accessToken);
      const sections = await loadHomeFeed(loggedIn, session?.user?.id ?? null);
      setHomeSections(sections);
      setTracks(sections.find((s) => s.tracks.length)?.tracks || []);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [session?.user, session?.accessToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setThemeAccent(accent);
        // Local miura profile first — gate UI until we know
        try {
          const ps = await getProfileState();
          if (!cancelled) applyMiuraProfileState(ps);
        } catch {
          if (!cancelled) {
            setMiuraProfile(null);
            setMiuraProfiles([]);
            setProfileReady(true);
          }
        }
        // Show shell (or gate) even if network hangs
        if (!cancelled) setBootDone(true);

        const stored = await loadStoredSession();
        if (cancelled) return;
        if (stored?.accessToken) {
          setAccessToken(stored.accessToken);
          if (stored.clientId) setClientId(stored.clientId);
          if (stored.user?.id) setMeUserId(stored.user.id);
          setSession(stored);
          try {
            const me = await getMe();
            if (!cancelled) {
              setMeUserId(me.id);
              setSession({ ...stored, user: me });
            }
          } catch {
            /* keep stored session */
          }
        }
        try {
          const id = await resolveClientId();
          if (!cancelled) setClientIdInput(id);
        } catch {
          /* settings */
        }
        if (!cancelled) await loadHome();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Ошибка запуска');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (bootDone) void loadHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.accessToken]);

  // Recent + media session metadata
  useEffect(() => {
    const track = player.current;
    if (!track || player.state === 'idle') return;
    setRecent(pushRecent(trackToRecent(track)));
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.user?.full_name || track.user?.username || 'miura',
          artwork: track.artwork_url
            ? [{ src: artworkUrl(track.artwork_url, 't300x300') || '', sizes: '300x300' }]
            : [],
        });
        navigator.mediaSession.playbackState =
          player.state === 'playing' ? 'playing' : player.state === 'paused' ? 'paused' : 'none';
      } catch {
        /* ignore */
      }
    }
  }, [player.current?.id, player.state]);

  const mediaHandlers = useMemo(
    () => ({
      toggle: () => player.toggle(),
      next: () => player.playNext(),
      prev: () => player.playPrev(),
    }),
    [player]
  );
  useMediaHotkeys(mediaHandlers);

  // Discord Rich Presence — throttle progress ticks; react faster on play/pause
  useEffect(() => {
    if (!window.electronAPI?.discordSetPresence) return;

    const track = player.current;
    const st = player.state;

    if (!track || st === 'idle' || st === 'error') {
      void window.electronAPI.discordClearPresence?.();
      return;
    }

    const pushPresence = () => {
      // Prefer track art → playable art (YT/local http) → user avatar
      const playable = getPlayable(track.id);
      const candidates = [
        track.artwork_url,
        playable?.artworkUrl,
        track.user?.avatar_url,
        // YouTube fallback from uid
        playable?.source === 'youtube' && playable.uid.startsWith('yt:')
          ? `https://i.ytimg.com/vi/${playable.uid.slice(3)}/hqdefault.jpg`
          : null,
      ].filter(Boolean) as string[];

      let cover = '';
      for (const raw of candidates) {
        if (!raw) continue;
        if (
          raw.startsWith('data:') ||
          raw.startsWith('blob:') ||
          raw.startsWith('miura-file:') ||
          raw.startsWith('miu-file:')
        ) {
          continue; // Discord cannot fetch local/data images
        }
        // SC: "large" is most reliable; also try t500
        const sized = artworkUrl(raw, 'large') || artworkUrl(raw, 't500x500') || raw;
        let u = sized;
        if (u.startsWith('//')) u = `https:${u}`;
        if (u.startsWith('http://')) u = `https://${u.slice(7)}`;
        if (u.startsWith('https://') && u.length <= 256) {
          cover = u;
          break;
        }
        if (u.startsWith('https://')) {
          const smaller = artworkUrl(raw, 't300x300') || artworkUrl(raw, 't67x67') || u;
          let s = smaller.startsWith('//') ? `https:${smaller}` : smaller;
          if (s.startsWith('http://')) s = `https://${s.slice(7)}`;
          if (s.startsWith('https://') && s.length <= 256) {
            cover = s;
            break;
          }
        }
      }

      const permalink =
        track.permalink_url && /^https?:\/\//i.test(track.permalink_url)
          ? track.permalink_url
          : playable?.meta?.url &&
              typeof playable.meta.url === 'string' &&
              /^https?:\/\//i.test(playable.meta.url)
            ? playable.meta.url
            : playable?.source === 'youtube' && playable.uid.startsWith('yt:')
              ? `https://www.youtube.com/watch?v=${playable.uid.slice(3)}`
              : undefined;

      void window.electronAPI?.discordSetPresence?.({
        title: track.title,
        artist: track.user?.full_name || track.user?.username || playable?.artist || 'miura',
        artworkUrl: cover || undefined,
        permalink,
        duration:
          player.duration ||
          (track.duration > 1000 ? track.duration / 1000 : track.duration) ||
          0,
        progress: player.progress || 0,
        playing: st === 'playing',
      });
    };

    // Immediate on pause/play/load; light delay only for progress-only ticks
    const delay = st === 'playing' || st === 'paused' || st === 'loading' ? 80 : 400;
    const tmr = window.setTimeout(pushPresence, delay);
    return () => window.clearTimeout(tmr);
  }, [
    player.current?.id,
    player.current?.title,
    player.current?.artwork_url,
    player.current?.user?.avatar_url,
    player.state,
    player.duration,
    // Coarse progress while playing (seek / long tick) — pause uses player.state
    player.state === 'playing' ? Math.floor(player.progress / 15) : 0,
  ]);

  // Mini-player / tray: push now-playing to main process (no second Audio instance)
  useEffect(() => {
    if (!window.electronAPI?.playerPushState) return;
    const track = player.current;
    const playable = track ? getPlayable(track.id) : null;
    const art =
      track?.artwork_url ||
      playable?.artworkUrl ||
      (playable?.source === 'youtube' && playable.uid.startsWith('yt:')
        ? `https://i.ytimg.com/vi/${playable.uid.slice(3)}/mqdefault.jpg`
        : null);
    const httpArt =
      art &&
      !art.startsWith('data:') &&
      !art.startsWith('blob:') &&
      !art.startsWith('miura-file:') &&
      !art.startsWith('miu-file:')
        ? art.startsWith('//')
          ? `https:${art}`
          : art
        : null;
    void window.electronAPI.playerPushState({
      title: track?.title || 'miura',
      artist:
        track?.user?.full_name ||
        track?.user?.username ||
        playable?.artist ||
        '—',
      playing: player.state === 'playing',
      artworkUrl: httpArt || (art?.startsWith('data:') ? art : null),
    });
  }, [
    player.current?.id,
    player.current?.title,
    player.current?.artwork_url,
    player.current?.user?.username,
    player.state,
  ]);

  const runSearch = useCallback(
    async (q: string, tab: SearchTab = searchTab) => {
      const trimmed = q.trim();
      setSearchTab(tab);
      setPage('search');
      if (!trimmed) {
        setStatus(null);
        setError(null);
        return;
      }

      // Paste URL → play
      if (/^https?:\/\//i.test(trimmed) || /youtu\.?be/i.test(trimmed)) {
        setLoading(true);
        setError(null);
        try {
          const resolved = await resolveMusicUrl(trimmed);
          if (resolved.kind === 'youtube') {
            player.playPlayable(resolved.playable);
            setStatus('YouTube');
            setSearchHistory(pushSearchHistory(trimmed));
          } else if (resolved.kind === 'soundcloud') {
            player.playTrack(resolved.track, [resolved.track]);
            setStatus('SoundCloud');
            setSearchHistory(pushSearchHistory(trimmed));
          } else {
            setError('Ссылка не распознана (SoundCloud / YouTube)');
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : 'URL error');
        } finally {
          setLoading(false);
        }
        return;
      }

      setLoading(true);
      setError(null);
      setSearchHistory(pushSearchHistory(trimmed));
      try {
        const cacheKey = `sc:${tab}:${trimmed}`;
        if (tab === 'tracks') {
          const cached = cacheGet<{ collection: Track[] }>(cacheKey);
          let scTracks: Track[] = [];
          try {
            const res = cached || (await searchTracks(trimmed, 40));
            if (!cached) cacheSet(cacheKey, res);
            scTracks = res.collection || [];
            setTracks(scTracks);
          } catch (e) {
            setTracks([]);
            console.warn('[search] SC tracks', e);
          }
          let ytCount = 0;
          try {
            const yk = `yt:${trimmed}`;
            const yc = cacheGet<Playable[]>(yk);
            const hits = yc || (await searchYouTube(trimmed, 12)).map(ytHitToPlayable);
            if (!yc) cacheSet(yk, hits);
            setYtHits(hits);
            ytCount = hits.length;
          } catch (e) {
            setYtHits([]);
            console.warn('[search] YT', e);
          }
          setStatus(`${scTracks.length} SC · ${ytCount} YT`);
          if (!scTracks.length && !ytCount) {
            setError(null);
            setStatus(t.youtube.noResults);
          }
        } else if (tab === 'playlists') {
          setYtHits([]);
          setTracks([]);
          try {
            const cached = cacheGet<{ collection: Playlist[] }>(cacheKey);
            const res = cached || (await searchPlaylists(trimmed, 36));
            if (!cached) cacheSet(cacheKey, res);
            setPlaylists(res.collection || []);
            setStatus(
              res.collection?.length ? `${res.collection.length}` : t.youtube.noResults
            );
          } catch (e) {
            setPlaylists([]);
            setError(e instanceof Error ? e.message : 'Ошибка поиска');
          }
        } else {
          // users / people
          setYtHits([]);
          setTracks([]);
          setPlaylists([]);
          try {
            const cached = cacheGet<{ collection: SoundCloudUser[] }>(cacheKey);
            const res = cached || (await searchUsers(trimmed, 36));
            if (!cached) cacheSet(cacheKey, res);
            setUsers(res.collection || []);
            setStatus(
              res.collection?.length ? `${res.collection.length}` : t.youtube.noResults
            );
          } catch (e) {
            setUsers([]);
            setError(e instanceof Error ? e.message : 'Ошибка поиска');
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка поиска');
      } finally {
        setLoading(false);
      }
    },
    [searchTab, t.youtube.noResults]
  );

  const playList = useCallback(
    (list: Track[], start?: Track) => {
      const cleaned = list.filter(
        (t) => t?.id && t?.title && t.streamable !== false && t.policy !== 'BLOCK'
      );
      if (!cleaned.length) return;
      // Prefer starting on a track that already has media (home/charts)
      const preferred =
        start && cleaned.some((t) => t.id === start.id)
          ? start
          : cleaned.find((t) => t.media?.transcodings?.length) || cleaned[0];
      player.playTrack(preferred!, cleaned);
    },
    [player]
  );

  const openTrack = useCallback(async (track: Track) => {
    if (!track?.id) {
      setError('Некорректный трек');
      return;
    }
    // Switch page immediately so UI always responds to click
    setError(null);
    setStatus(null);
    pushNavHistory();
    setActiveTrack(track);
    setRelatedTracks([]);
    setTrackComments([]);
    setPage('track');
    // Don't use global `loading` — it unmounts other views and feels like "nothing happened"
    requestAnimationFrame(() => {
      const el = document.querySelector('.scroll');
      if (el) el.scrollTop = 0;
    });
    try {
      const [full, related, comments] = await Promise.all([
        getTrack(track.id, {
          urn: track.urn,
          permalink_url: track.permalink_url,
        }).catch(() => track),
        getRelatedTracks(track.id, 24).catch(() => ({ collection: [] as Track[], next_href: null })),
        getTrackComments(track.id, 40).catch(() => ({ collection: [] as TrackComment[], next_href: null })),
      ]);
      // Only update if user is still on this track
      setActiveTrack((prev) => (prev?.id === track.id ? full : prev));
      setRelatedTracks((related.collection || []).filter((t) => t?.id && t?.title));
      setTrackComments(comments.collection || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось открыть трек');
    }
  }, [pushNavHistory]);

  const openPlaylist = useCallback(
    async (pl: Playlist, opts?: { autoplay?: boolean }) => {
      setLoading(true);
      setError(null);
      pushNavHistory();
      setPage('playlist');
      try {
        const full = await resolvePlaylist(pl);
        let tracks = (full.tracks || []).filter(
          (t) => t?.id && t?.title && t.streamable !== false && t.policy !== 'BLOCK'
        );
        // Prefer tracks with media for autoplay so first click doesn't fail
        const withMedia = tracks.filter((t) => t.media?.transcodings?.length);
        if (withMedia.length > 0 && withMedia.length < tracks.length) {
          const ids = new Set(withMedia.map((t) => t.id));
          tracks = [...withMedia, ...tracks.filter((t) => !ids.has(t.id))];
        }
        full.tracks = tracks;
        setActivePlaylist(full);
        if (opts?.autoplay && tracks.length) {
          // Start from first with media if possible
          const start = tracks.find((t) => t.media?.transcodings?.length) || tracks[0];
          playList(tracks, start);
        } else if (!tracks.length) {
          setError('В этом миксе/плейлисте нет доступных треков');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось открыть плейлист / микс');
        setActivePlaylist(pl);
      } finally {
        setLoading(false);
      }
    },
    [playList, pushNavHistory]
  );

  const openUser = useCallback(async (user: SoundCloudUser | { id: number }) => {
    setLoading(true);
    setError(null);
    pushNavHistory();
    setPage('user');
    setFollowingUser(false);
    setUserTab('tracks');
    setUserReposts([]);
    try {
      const full = await getUser(user.id);
      setActiveUser(full);
      const [tr, rep, pl, following] = await Promise.all([
        getUserTracks(user.id, 40),
        getUserReposts(user.id, 40).catch(() => ({ collection: [] as Track[], next_href: null })),
        getUserPlaylists(user.id, 40),
        isLoggedIn ? isFollowing(user.id).catch(() => false) : Promise.resolve(false),
      ]);
      setUserTracks(tr.collection || []);
      setUserReposts(rep.collection || []);
      setUserPlaylists(pl.collection || []);
      setFollowingUser(following);
      // If user has no uploads but has reposts — open Reposts tab (like SC profile)
      if (!(tr.collection || []).length && (rep.collection || []).length) {
        setUserTab('reposts');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось открыть профиль');
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn, pushNavHistory]);

  const loadLibrary = useCallback(async () => {
    if (!session?.user) {
      setError('Нужен вход');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const uid = session.user.id;
      const [mine, likes, likePl] = await Promise.all([
        getMyPlaylists(50).catch(() => getUserPlaylists(uid, 50)),
        getLikedTracks(uid, 40),
        getLikedPlaylists(uid, 30),
      ]);
      setLibraryPlaylists(mine.collection || []);
      setLikedTracks(likes.collection || []);
      const likedPl = likePl.collection || [];
      setLikedPlaylists(likedPl);
      setLikedPlaylistIds(new Set(likedPl.map((p) => String(p.urn || p.id))));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка библиотеки');
    } finally {
      setLoading(false);
    }
  }, [session?.user]);

  const go = async (id: Page) => {
    // SC cloud library needs login
    if (['likes', 'playlists'].includes(id) && !isLoggedIn) {
      navigateTo('settings');
      setError('Войди в SoundCloud');
      return;
    }
    // Media library always opens unified miura page (favs + optional SC)
    if (id === 'library') {
      setLibraryView('favs');
      setFavorites(loadFavorites());
      navigateTo('library');
      if (isLoggedIn) void loadLibrary();
      return;
    }
    navigateTo(id);
    if (id === 'home') await loadHome();
    if (id === 'likes' || id === 'playlists') {
      setLibraryView(id === 'playlists' ? 'sc-playlists' : 'sc-likes');
      navigateTo('library');
      await loadLibrary();
    }
    if (id === 'search') {
      setSearchHistory(loadSearchHistory());
    }
  };

  const applySession = useCallback(async (s: AuthSession) => {
    try {
      setAccessToken(s.accessToken);
      if (s.clientId) setClientId(s.clientId);
      if (s.user?.id) setMeUserId(s.user.id);
    } catch {
      /* ignore */
    }
    let next: AuthSession = s;
    try {
      const me = await getMe();
      setMeUserId(me.id);
      next = { ...s, user: me };
    } catch {
      next = s;
    }
    setSession(next);
    setStatus(`ok · signed in${next.user?.username ? ' · ' + next.user.username : ''}`);
    setError(null);
    setPage('home');
  }, []);

  // Browser login completes on local page → main process pushes auth-changed
  useEffect(() => {
    const unsub = window.electronAPI?.onAuthChanged?.((s) => {
      if (s?.accessToken) void applySession(s);
    });
    return () => {
      unsub?.();
    };
  }, [applySession]);

  const handleLogin = useCallback(
    (mode: 'app' | 'browser' = 'browser') => {
      const loginMode = mode === 'app' ? 'app' : 'browser';
      setError(null);
      setStatus(
        loginMode === 'browser'
          ? 'Браузер открыт. Войди на SoundCloud → вставь токен на странице-помощнике.'
          : 'Окно входа открыто. Если SC блокирует — «Браузер» внизу окна.'
      );
      setPage('settings');
      // Don't lock the UI — auth arrives via promise / onAuthChanged
      void loginWithSoundCloud({ mode: loginMode })
        .then((s) => {
          if (s?.accessToken) {
            setStatus(`Вошли как ${s.user?.username || 'ok'}`);
            setError(null);
            return applySession(s);
          }
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : 'Вход не завершён';
          // User closed / timeout — not a hard error if they already imported token
          if (!session?.accessToken) {
            setError(
              /огранич|block|cloudflare|закрыто/i.test(msg)
                ? `${msg} → Настройки → «запасной вход» → браузер или токен.`
                : msg
            );
          }
        });
    },
    [applySession, session?.accessToken]
  );

  const handleLogout = async () => {
    await logout();
    setSession(null);
    setLibraryPlaylists([]);
    setLikedTracks([]);
    setLikedPlaylists([]);
    setStatus('signed out');
  };

  const requireLogin = async (): Promise<boolean> => {
    try {
      const api = await import('./api/soundcloud');
      await api.ensureAccessToken();
      if (session?.user?.id) api.setMeUserId(session.user.id);
      try {
        await api.getMe();
      } catch {
        /* ok if token works */
      }
      return true;
    } catch {
      setError('Войди в SoundCloud');
      setPage('settings');
      return false;
    }
  };

  const toggleLike = async (track: Track) => {
    if (!(await requireLogin())) return;

    const liked = player.likedIds.has(track.id) || Boolean(track.user_favorite);
    player.markLiked(track.id, !liked);
    track.user_favorite = !liked;

    try {
      if (liked) {
        await unlikeTrack(track.id);
      } else {
        await likeTrack(track.id);
      }
      setError(null);
      setStatus(liked ? 'Лайк снят' : 'Добавлено в лайки');
    } catch (e) {
      player.markLiked(track.id, liked);
      track.user_favorite = liked;
      setError(e instanceof Error ? e.message : 'Ошибка лайка');
    }
  };

  const toggleFollow = async () => {
    if (!activeUser) return;
    if (session?.user?.id === activeUser.id) {
      setStatus('Это твой профиль');
      return;
    }
    if (!(await requireLogin())) return;
    setFollowBusy(true);
    const next = !followingUser;
    setFollowingUser(next);
    try {
      if (next) await followUser(activeUser.id);
      else await unfollowUser(activeUser.id);
      setError(null);
      setStatus(next ? `Подписка на ${activeUser.username}` : `Отписка от ${activeUser.username}`);
      setActiveUser({
        ...activeUser,
        followers_count: Math.max(0, (activeUser.followers_count || 0) + (next ? 1 : -1)),
      });
    } catch (e) {
      setFollowingUser(!next);
      setError(e instanceof Error ? e.message : 'Ошибка подписки');
    } finally {
      setFollowBusy(false);
    }
  };

  const toggleRepost = async (track: Track) => {
    if (!(await requireLogin())) return;
    const done = repostedIds.has(track.id) || Boolean(track.user_repost);
    setRepostedIds((prev) => {
      const n = new Set(prev);
      if (done) n.delete(track.id);
      else n.add(track.id);
      return n;
    });
    track.user_repost = !done;
    try {
      if (done) await unrepostTrack(track.id);
      else await repostTrack(track.id);
      setError(null);
      setStatus(done ? 'Репост убран' : 'Репостнуто · смотри вкладку «Репосты» в профиле');
      // Update own profile reposts list if open
      if (session?.user && activeUser?.id === session.user.id) {
        setUserReposts((prev) => {
          if (done) return prev.filter((t) => t.id !== track.id);
          if (prev.some((t) => t.id === track.id)) return prev;
          return [track, ...prev];
        });
      }
    } catch (e) {
      setRepostedIds((prev) => {
        const n = new Set(prev);
        if (done) n.add(track.id);
        else n.delete(track.id);
        return n;
      });
      track.user_repost = done;
      setError(e instanceof Error ? e.message : 'Ошибка репоста');
    }
  };

  const handleCreatePlaylist = async (trackToAdd?: Track | null) => {
    if (!(await requireLogin())) return;
    const title = createPlTitle.trim();
    if (!title) {
      setError('Введите название');
      return;
    }
    setCreatePlBusy(true);
    setError(null);
    try {
      const pl = await createPlaylist({
        title,
        sharing: 'public',
        trackIds: trackToAdd?.id ? [trackToAdd.id] : undefined,
      });
      setLibraryPlaylists((prev) => [pl, ...prev.filter((p) => String(p.id) !== String(pl.id))]);
      setCreatePlOpen(false);
      setCreatePlTitle('');
      setAddToPlTrack(null);
      setStatus(`Плейлист «${pl.title}» создан`);
      if (trackToAdd) {
        setStatus(`Добавлено в «${pl.title}»`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать плейлист');
    } finally {
      setCreatePlBusy(false);
    }
  };

  const handleAddToPlaylist = async (pl: Playlist) => {
    if (!addToPlTrack) return;
    if (!(await requireLogin())) return;
    setAddToPlBusy(true);
    setError(null);
    try {
      await addTrackToPlaylist(pl.id, addToPlTrack.id);
      setStatus(`Добавлено в «${pl.title}»`);
      setAddToPlTrack(null);
      // refresh library list count loosely
      setLibraryPlaylists((prev) =>
        prev.map((p) =>
          String(p.id) === String(pl.id)
            ? { ...p, track_count: (p.track_count || 0) + 1 }
            : p
        )
      );
      if (activePlaylist && String(activePlaylist.id) === String(pl.id)) {
        const full = await resolvePlaylist(pl);
        setActivePlaylist(full);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось добавить в плейлист');
    } finally {
      setAddToPlBusy(false);
    }
  };

  const handleRenamePlaylist = async () => {
    if (!activePlaylist) return;
    if (!(await requireLogin())) return;
    const title = renamePlTitle.trim();
    if (!title) return;
    setPlBusy(true);
    try {
      const updated = await updatePlaylist(activePlaylist.id, { title });
      setActivePlaylist({ ...activePlaylist, ...updated, title });
      setLibraryPlaylists((prev) =>
        prev.map((p) => (String(p.id) === String(activePlaylist.id) ? { ...p, title } : p))
      );
      setRenamePlOpen(false);
      setStatus('Плейлист переименован');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось переименовать');
    } finally {
      setPlBusy(false);
    }
  };

  const handleDeletePlaylist = async () => {
    if (!activePlaylist) return;
    if (!(await requireLogin())) return;
    if (!window.confirm(`Удалить плейлист «${activePlaylist.title}»?`)) return;
    setPlBusy(true);
    try {
      await deletePlaylist(activePlaylist.id);
      setLibraryPlaylists((prev) => prev.filter((p) => String(p.id) !== String(activePlaylist.id)));
      setActivePlaylist(null);
      setPage('playlists');
      setStatus('Плейлист удалён');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить');
    } finally {
      setPlBusy(false);
    }
  };

  const handleRemoveFromPlaylist = async (track: Track) => {
    if (!activePlaylist) return;
    if (!(await requireLogin())) return;
    setPlBusy(true);
    try {
      const ids = (activePlaylist.tracks || []).map((t) => t.id);
      const full = await removeTrackFromPlaylist(activePlaylist.id, track.id, ids);
      setActivePlaylist(full);
      setStatus('Трек убран из плейлиста');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось убрать трек');
    } finally {
      setPlBusy(false);
    }
  };

  const searchTracksForPlaylist = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setAddTracksResults([]);
      return;
    }
    setAddTracksBusy(true);
    setError(null);
    try {
      const res = await searchTracks(trimmed, 24);
      setAddTracksResults((res.collection || []).filter((t) => t?.id && t?.title));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка поиска');
      setAddTracksResults([]);
    } finally {
      setAddTracksBusy(false);
    }
  };

  const isOwnPlaylist = (pl: Playlist | null | undefined) => {
    if (!pl || pl.is_system) return false;
    if (session?.user?.id != null && pl.user?.id != null) {
      if (Number(session.user.id) === Number(pl.user.id)) return true;
    }
    // created sets in library count as own even if user blob is incomplete
    return libraryPlaylists.some((p) => String(p.id) === String(pl.id));
  };

  const handleAddTrackWhileInPlaylist = async (track: Track) => {
    if (!activePlaylist) return;
    if (!(await requireLogin())) return;
    if (!isOwnPlaylist(activePlaylist)) {
      setError('Добавлять треки можно только в свой плейлист');
      return;
    }
    setAddTracksBusy(true);
    setError(null);
    try {
      const ids = (activePlaylist.tracks || []).map((t) => t.id).filter(Boolean) as number[];
      if (ids.includes(track.id)) {
        setStatus('Этот трек уже в плейлисте');
        return;
      }
      const full = await addTrackToPlaylist(activePlaylist.id, track.id, ids);
      // Prefer server list; if empty, optimistically append
      const tracks =
        full.tracks && full.tracks.length
          ? full.tracks
          : [...(activePlaylist.tracks || []).filter((t) => t?.id !== track.id), track];
      setActivePlaylist({ ...activePlaylist, ...full, tracks, track_count: tracks.length });
      setLibraryPlaylists((prev) =>
        prev.map((p) =>
          String(p.id) === String(activePlaylist.id)
            ? { ...p, track_count: tracks.length }
            : p
        )
      );
      setStatus(`«${track.title}» добавлен в плейлист`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось добавить трек');
    } finally {
      setAddTracksBusy(false);
    }
  };

  const openAddToPlaylist = async (track: Track) => {
    if (!(await requireLogin())) return;
    setError(null);
    setAddToPlTrack(track);
    if (!libraryPlaylists.length) {
      try {
        await loadLibrary();
      } catch {
        /* form still opens */
      }
    }
  };

  const togglePlaylistLike = async (pl: Playlist) => {
    if (!(await requireLogin())) return;
    if (pl.is_system) {
      setError('Системные миксы нельзя лайкнуть так');
      return;
    }
    const key = String(pl.urn || pl.id);
    const liked = likedPlaylistIds.has(key) || Boolean(pl.user_like || pl.liked);
    setLikedPlaylistIds((prev) => {
      const n = new Set(prev);
      if (liked) n.delete(key);
      else n.add(key);
      return n;
    });
    try {
      if (liked) await unlikePlaylist(pl.id);
      else await likePlaylist(pl.id);
      setError(null);
      setStatus(liked ? 'Лайк с плейлиста снят' : 'Плейлист в лайках');
      if (activePlaylist && String(activePlaylist.urn || activePlaylist.id) === key) {
        setActivePlaylist({ ...activePlaylist, user_like: !liked, liked: !liked });
      }
    } catch (e) {
      setLikedPlaylistIds((prev) => {
        const n = new Set(prev);
        if (liked) n.add(key);
        else n.delete(key);
        return n;
      });
      setError(e instanceof Error ? e.message : 'Ошибка лайка плейлиста');
    }
  };

  const startStation = async (track: Track) => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const station = await getStationTracks(track, 40);
      player.startStation(track, station);
      setStatus(`station · ${track.title} · ${station.length} tracks`);
      setPage('queue');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось запустить станцию');
    } finally {
      setLoading(false);
    }
  };

  const isLibraryPage = page === 'library' || page === 'likes' || page === 'playlists';

  const pageTitles: Partial<Record<Page, string>> = {
    home: t.nav.home,
    search: t.nav.search,
    library: t.nav.library,
    likes: t.nav.likes,
    playlists: t.nav.playlists,
    queue: t.nav.queue,
    settings: t.nav.settings,
    profile: t.profile.pageTitle,
    local: t.nav.local,
    youtube: t.nav.youtube,
    soundcloud: t.nav.soundcloud,
    'miura-playlists': t.nav.miuraPlaylists,
  };

  const title =
    page === 'home'
      ? t.nav.home
      : isLibraryPage
        ? t.nav.library
        : page === 'playlist' && activePlaylist
          ? activePlaylist.title
          : page === 'track' && activeTrack
            ? activeTrack.title
            : page === 'user' && activeUser
              ? activeUser.username
              : pageTitles[page] || page;

  useEffect(() => {
    document.title = title ? `miura · ${title}` : 'miura';
  }, [title]);

  const mainNav: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
    { id: 'home', label: t.nav.home, icon: <IconHome /> },
    { id: 'search', label: t.nav.search, icon: <IconSearch /> },
    { id: 'library', label: t.nav.library, icon: <IconLibrary /> },
    { id: 'local', label: t.nav.local, icon: <IconLibrary /> },
    { id: 'miura-playlists', label: t.nav.miuraPlaylists, icon: <IconPlaylist /> },
  ];

  const navActive = (id: Page) =>
    page === id ||
    (id === 'library' && (page === 'library' || page === 'likes' || page === 'playlists'));

  const ytFavorites = useMemo(
    () => favorites.filter((f) => f.source === 'youtube'),
    [favorites]
  );
  const otherFavorites = useMemo(
    () => favorites.filter((f) => f.source !== 'youtube'),
    [favorites]
  );

  if (!bootDone || !profileReady) {
    return (
      <div className="shell theme-frame profile-boot">
        <div className="profile-boot-inner">
          <MiuraMark />
          <p>{t.common.loading}</p>
        </div>
      </div>
    );
  }

  if (!hasMiuraProfile) {
    return (
      <div className="shell theme-frame profile-gate-shell">
        <ProfileGate profiles={miuraProfiles} onReady={applyMiuraProfileState} />
      </div>
    );
  }

  return (
    <div className="shell theme-frame">
      <aside className="rail rail-wide" aria-label="Навигация">
        <div className="mark">
          <MiuraMark />
        </div>

        <nav className="rail-nav">
          {mainNav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rail-a rail-a-row ${navActive(item.id) ? 'on' : ''}`}
              onClick={() => {
                if (item.id === 'miura-playlists') setFocusMiuraPlaylistId(null);
                void go(item.id);
              }}
              title={item.label}
              aria-label={item.label}
              aria-current={navActive(item.id) ? 'page' : undefined}
            >
              <span className="ico">{item.icon}</span>
              <span className="t">{item.label}</span>
            </button>
          ))}

          <div className="rail-sep" role="presentation" />

          <div className="rail-section">{t.nav.miuraPlaylists}</div>
          <div className="rail-pl-list">
            {railPlaylists.length === 0 ? (
              <button
                type="button"
                className="rail-pl-empty"
                onClick={() => openMiuraPlaylist(null)}
              >
                {t.playlists.create}
              </button>
            ) : (
              railPlaylists.slice(0, 40).map((pl) => {
                const cover = miuraPlaylistCover(pl);
                const on = page === 'miura-playlists' && focusMiuraPlaylistId === pl.id;
                return (
                  <button
                    key={pl.id}
                    type="button"
                    className={`rail-pl-item ${on ? 'on' : ''}`}
                    title={pl.title}
                    onClick={() => openMiuraPlaylist(pl.id)}
                  >
                    <span className="rail-pl-art">
                      {cover ? (
                        <img src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="rail-pl-art-ph">♪</span>
                      )}
                    </span>
                    <span className="rail-pl-name">{pl.title}</span>
                  </button>
                );
              })
            )}
          </div>
        </nav>

        <div className="rail-foot">
          <button
            type="button"
            className={`rail-user ${page === 'profile' ? 'on' : ''}`}
            onClick={() => navigateTo('profile')}
            title={miuraProfile?.displayName || t.profile.yourProfile}
          >
            {miuraProfile?.avatarUrl ? (
              <img className="who-av" src={miuraProfile.avatarUrl} alt="" />
            ) : (
              <div className="who-av ph">{profileInitials(miuraProfile?.displayName || '?')}</div>
            )}
            <span className="rail-user-name">{miuraProfile?.displayName}</span>
          </button>
          <button
            type="button"
            className={`rail-a ${page === 'settings' ? 'on' : ''}`}
            onClick={() => navigateTo('settings')}
            title={t.nav.settings}
            aria-label={t.nav.settings}
          >
            <span className="ico">
              <IconSettings />
            </span>
            <span className="t">{t.nav.settings}</span>
          </button>
        </div>
      </aside>

      <main className="stage">
        <header className="mast">
          <div className="mast-row">
            <h1>{title}</h1>
            {!isLoggedIn && (
              <button type="button" className="btn" onClick={() => handleLogin()} style={{ flexShrink: 0 }}>
                {t.soundcloud.login}
              </button>
            )}
            <button
              type="button"
              className="btn"
              style={{ flexShrink: 0 }}
              onClick={() => setQueueOpen(true)}
              title={t.nav.queue}
            >
              {t.nav.queue}
              {player.queue.length > 0 ? ` · ${player.queue.length}` : ''}
            </button>
            <form
              className="find"
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch(query);
              }}
            >
              <span className="find-ico">
                <IconSearch />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск · или вставь ссылку SC / YT"
                spellCheck={false}
              />
              <button type="submit" disabled={!query.trim()}>
                {t.common.search}
              </button>
            </form>
          </div>
          {page === 'search' && (
            <div className="chips">
              {(['tracks', 'playlists', 'users'] as SearchTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`chip ${searchTab === tab ? 'on' : ''}`}
                  onClick={() => void runSearch(query, tab)}
                >
                  {tab === 'tracks'
                    ? t.local.viewTracks
                    : tab === 'playlists'
                      ? t.nav.playlists
                      : peopleLabel}
                </button>
              ))}
            </div>
          )}
          {isLibraryPage && (
            <div className="chips">
              <button
                type="button"
                className={`chip ${libraryView === 'favs' ? 'on' : ''}`}
                onClick={() => {
                  setLibraryView('favs');
                  navigateTo('library');
                  setFavorites(loadFavorites());
                }}
              >
                ★ {t.profile.statFavs}
                {favorites.length ? ` · ${favorites.length}` : ''}
              </button>
              {isLoggedIn && (
                <>
                  <button
                    type="button"
                    className={`chip ${libraryView === 'sc-likes' ? 'on' : ''}`}
                    onClick={() => {
                      setLibraryView('sc-likes');
                      navigateTo('library');
                      void loadLibrary();
                    }}
                  >
                    SC {t.nav.likes}
                    {likedTracks.length ? ` · ${likedTracks.length}` : ''}
                  </button>
                  <button
                    type="button"
                    className={`chip ${libraryView === 'sc-playlists' ? 'on' : ''}`}
                    onClick={() => {
                      setLibraryView('sc-playlists');
                      navigateTo('library');
                      void loadLibrary();
                    }}
                  >
                    SC {t.nav.playlists}
                    {libraryPlaylists.length || likedPlaylists.length
                      ? ` · ${libraryPlaylists.length + likedPlaylists.length}`
                      : ''}
                  </button>
                </>
              )}
            </div>
          )}
        </header>

        <div className="scroll">
          {loading && (
            <div className="load">
              <span className="pulse" />
              Загрузка…
            </div>
          )}
          {!loading && error && <p className="note err">{error}</p>}
          {!loading && !error && status && <p className="note">{status}</p>}

          {!loading && page === 'home' && (
            <div className="sc-home">
              <div className="sc-home-hero" style={{ marginTop: 0 }}>
                <div className="sc-home-hero-text">
                  <h2 className="sc-shelf-title">{t.nav.soundcloud}</h2>
                  <p className="sc-home-lead" style={{ marginTop: 6 }}>
                    {isLoggedIn
                      ? session?.user?.username
                      : t.soundcloud.lead}
                    {!isLoggedIn && (
                      <>
                        {' · '}
                        <button type="button" className="linkish" onClick={() => handleLogin()}>
                          {t.common.login}
                        </button>
                      </>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className="sc-home-refresh"
                  onClick={() => void loadHome()}
                  title={t.common.refresh}
                >
                  {t.common.refresh}
                </button>
              </div>

              <div className="sc-home-tabs" role="tablist" aria-label="Разделы главной">
                {HOME_TABS.filter((tab) => !tab.needsAuth || isLoggedIn).map((tab) => {
                  const count =
                    tab.id === 'all'
                      ? homeSections.length
                      : homeSections.filter((s) => s.group === tab.id).length;
                  if (tab.id !== 'all' && count === 0 && isLoggedIn === false && tab.needsAuth) {
                    return null;
                  }
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={homeTab === tab.id}
                      className={`sc-home-tab ${homeTab === tab.id ? 'on' : ''}`}
                      onClick={() => setHomeTab(tab.id)}
                      disabled={tab.id !== 'all' && count === 0}
                    >
                      {tab.label}
                      {count > 0 && tab.id !== 'all' ? (
                        <span className="sc-home-tab-n">{count}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {(() => {
                const visible =
                  homeTab === 'all'
                    ? homeSections
                    : homeSections.filter((s) => s.group === homeTab);
                if (!visible.length && bootDone) {
                  return (
                    <EmptyState
                      title={
                        homeTab === 'history'
                          ? 'История пуста'
                          : homeTab === 'feed'
                            ? 'Лента пуста'
                            : t.common.empty
                      }
                      hint={
                        homeTab === 'history'
                          ? 'Слушай треки — они появятся здесь'
                          : homeTab === 'feed'
                            ? 'Подпишись на артистов, чтобы видеть их загрузки'
                            : 'Проверь прокси в настройках или открой поиск'
                      }
                    >
                      {homeTab !== 'all' && (
                        <button
                          type="button"
                          className="btn solid"
                          style={{ marginTop: 16 }}
                          onClick={() => setHomeTab('all')}
                        >
                          Показать всё
                        </button>
                      )}
                    </EmptyState>
                  );
                }
                return visible.map((sec) => (
                  <HomeShelf
                    key={sec.id}
                    section={sec}
                    currentId={player.current?.id}
                    likedIds={player.likedIds}
                    onPlayTrack={(t, list) => playList(list, t)}
                    onPlayAll={(list) => playList(list)}
                    onAdd={player.addToQueue}
                    onLike={toggleLike}
                    onStation={(t) => void startStation(t)}
                    onOpenPlaylist={(p) => void openPlaylist(p)}
                    onPlayPlaylist={(p) => void openPlaylist(p, { autoplay: true })}
                    onOpenTrack={(t) => void openTrack(t)}
                    onOpenUser={(u) => void openUser(u)}
                  />
                ));
              })()}
            </div>
          )}

          {!loading && page === 'search' && !query.trim() && searchHistory.length > 0 && (
            <section className="chapter search-history">
              <div className="chapter-h">
                <h2>{t.common.search}</h2>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setSearchHistory(clearSearchHistory())}
                >
                  {t.common.remove}
                </button>
              </div>
              <div className="search-history-chips">
                {searchHistory.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setQuery(h);
                      void runSearch(h, searchTab);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSearchHistory(removeSearchHistoryItem(h));
                    }}
                    title={h}
                  >
                    {h}
                  </button>
                ))}
              </div>
            </section>
          )}

          {!loading && page === 'search' && searchTab === 'tracks' && (
            <>
              {tracks.length > 0 && (
                <HomeShelf
                  section={{
                    id: 'search',
                    title: `SoundCloud · ${tracks.length}`,
                    kind: 'tracks',
                    tracks,
                    group: 'discover',
                  }}
                  currentId={player.current?.id}
                  likedIds={player.likedIds}
                  onPlayTrack={(tr, list) => playList(list, tr)}
                  onPlayAll={(list) => playList(list)}
                  onAdd={player.addToQueue}
                  onLike={toggleLike}
                  onStation={(tr) => void startStation(tr)}
                  onOpenPlaylist={(p) => void openPlaylist(p)}
                  onPlayPlaylist={(p) => void openPlaylist(p, { autoplay: true })}
                  onOpenTrack={(tr) => void openTrack(tr)}
                />
              )}
              {ytHits.length > 0 && (
                <section className="chapter">
                  <div className="chapter-h">
                    <h2>YouTube · {ytHits.length}</h2>
                  </div>
                  <div className="cat track-list-compact">
                    {ytHits.map((p, i) => {
                      const favId = favIdFromPlayable(p);
                      const isFav = favorites.some((f) => f.id === favId);
                      return (
                        <div key={p.uid} className="cat-row track-row-compact">
                          <button
                            type="button"
                            className="idx"
                            onClick={() => player.playPlayable(p, ytHits)}
                          >
                            <span className="idx-num">{i + 1}</span>
                            <span className="idx-play hover-only" aria-hidden>
                              ▶
                            </span>
                          </button>
                          <button
                            type="button"
                            className="cat-art-wrap"
                            onClick={() => player.playPlayable(p, ytHits)}
                          >
                            {p.artworkUrl ? (
                              <img className="cat-art" src={p.artworkUrl} alt="" loading="lazy" />
                            ) : (
                              <div className="cat-art ph">♪</div>
                            )}
                          </button>
                          <button
                            type="button"
                            className="cat-main"
                            onClick={() => player.playPlayable(p, ytHits)}
                          >
                            <span className="cat-title">
                              {p.title} <SourceBadge source="youtube" />
                            </span>
                            <span className="cat-sub">{p.artist}</span>
                          </button>
                          <button
                            type="button"
                            className={`op ico-btn ${isFav ? 'hot' : ''}`}
                            title="★"
                            onClick={() => {
                              setFavorites(
                                toggleFavorite({
                                  id: favId,
                                  title: p.title,
                                  artist: p.artist,
                                  artworkUrl: p.artworkUrl,
                                  source: 'youtube',
                                  playable: p,
                                })
                              );
                            }}
                          >
                            {isFav ? '★' : '☆'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
              {query.trim() && !tracks.length && !ytHits.length && (
                <EmptyState title={t.youtube.noResults} />
              )}
            </>
          )}

          {!loading && page === 'search' && searchTab === 'playlists' && (
            playlists.length ? (
              <LedgerPlaylists items={playlists} onOpen={(p) => void openPlaylist(p)} />
            ) : query.trim() ? (
              <EmptyState title={t.youtube.noResults} />
            ) : null
          )}

          {!loading && page === 'search' && searchTab === 'users' && (
            users.length ? (
              <LedgerUsers items={users} onOpen={(u) => void openUser(u)} />
            ) : query.trim() ? (
              <EmptyState title={t.youtube.noResults} />
            ) : null
          )}

          {!loading && isLibraryPage && libraryView === 'favs' && (
            <section className="chapter miura-lib">
              <div className="chapter-h">
                <h2>★ {t.profile.statFavs}</h2>
                {favorites.length > 0 && (
                  <span className="note" style={{ margin: 0 }}>
                    {favorites.length}
                    {ytFavorites.length ? ` · YT ${ytFavorites.length}` : ''}
                  </span>
                )}
              </div>
              {favorites.length === 0 ? (
                <p className="note">{t.profile.favsEmpty}</p>
              ) : (
                <div className="cat track-list-compact">
                  {favorites.map((f, i) => (
                    <div key={f.id} className="cat-row track-row-compact">
                      <button
                        type="button"
                        className="idx"
                        title={t.common.play}
                        onClick={() => {
                          if (f.playable) player.playPlayable(f.playable);
                          else if (f.track) player.playTrack(f.track);
                        }}
                      >
                        <span className="idx-num">{i + 1}</span>
                        <span className="idx-play hover-only" aria-hidden>
                          ▶
                        </span>
                      </button>
                      <button
                        type="button"
                        className="cat-art-wrap"
                        onClick={() => {
                          if (f.playable) player.playPlayable(f.playable);
                          else if (f.track) player.playTrack(f.track);
                        }}
                      >
                        {f.artworkUrl ? (
                          <img
                            className="cat-art"
                            src={
                              f.artworkUrl.startsWith('data:') ||
                              f.artworkUrl.startsWith('miura-file:')
                                ? f.artworkUrl
                                : artworkUrl(f.artworkUrl, 't67x67')
                            }
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <div className="cat-art ph">♪</div>
                        )}
                      </button>
                      <button
                        type="button"
                        className="cat-main"
                        onClick={() => {
                          if (f.playable) player.playPlayable(f.playable);
                          else if (f.track) player.playTrack(f.track);
                        }}
                      >
                        <span className="cat-title">
                          {f.title} <SourceBadge source={f.source} />
                        </span>
                        <span className="cat-sub">{f.artist}</span>
                      </button>
                      <button
                        type="button"
                        className="op ico-btn hot"
                        title={t.common.remove}
                        onClick={() => {
                          setFavorites(
                            toggleFavorite({
                              id: f.id,
                              title: f.title,
                              artist: f.artist,
                              artworkUrl: f.artworkUrl,
                              source: f.source,
                              track: f.track,
                              playable: f.playable,
                            })
                          );
                        }}
                      >
                        ★
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="chapter-h" style={{ marginTop: 28 }}>
                <h2>{t.home.recent}</h2>
              </div>
              {recent.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="cat track-list-compact">
                  {recent.slice(0, 24).map((r, i) => (
                    <div key={r.id} className="cat-row track-row-compact">
                      <button
                        type="button"
                        className="idx"
                        onClick={() => {
                          if (r.playable) player.playPlayable(r.playable);
                          else if (r.track) player.playTrack(r.track);
                        }}
                      >
                        <span className="idx-num">{i + 1}</span>
                        <span className="idx-play hover-only" aria-hidden>
                          ▶
                        </span>
                      </button>
                      <button
                        type="button"
                        className="cat-art-wrap"
                        onClick={() => {
                          if (r.playable) player.playPlayable(r.playable);
                          else if (r.track) player.playTrack(r.track);
                        }}
                      >
                        {r.artworkUrl ? (
                          <img
                            className="cat-art"
                            src={
                              r.artworkUrl.startsWith('data:') ||
                              r.artworkUrl.startsWith('miura-file:')
                                ? r.artworkUrl
                                : artworkUrl(r.artworkUrl, 't67x67')
                            }
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <div className="cat-art ph">♪</div>
                        )}
                      </button>
                      <button
                        type="button"
                        className="cat-main"
                        onClick={() => {
                          if (r.playable) player.playPlayable(r.playable);
                          else if (r.track) player.playTrack(r.track);
                        }}
                      >
                        <span className="cat-title">
                          {r.title} <SourceBadge source={r.source} />
                        </span>
                        <span className="cat-sub">{r.artist}</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {!loading && isLibraryPage && libraryView === 'sc-likes' && (
            <section className="chapter">
              <div className="chapter-h">
                <h2>SoundCloud · {t.nav.likes}</h2>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => playList(likedTracks)}
                  disabled={!likedTracks.length}
                >
                  {t.common.play}
                </button>
              </div>
              {likedTracks.length ? (
                <Catalog
                  tracks={likedTracks}
                  currentId={player.current?.id}
                  playbackState={player.state}
                  likedIds={player.likedIds}
                  onPlay={(tr) => playList(likedTracks, tr)}
                  onToggle={player.toggle}
                  onAdd={player.addToQueue}
                  onLike={toggleLike}
                  onStation={(tr) => void startStation(tr)}
                  onOpenTrack={(tr) => void openTrack(tr)}
                  onAddToPlaylist={(tr) => void openAddToPlaylist(tr)}
                />
              ) : (
                <div className="void">
                  <h3>{t.common.empty}</h3>
                  <p>{t.profile.favsEmpty}</p>
                </div>
              )}
            </section>
          )}

          {!loading && isLibraryPage && libraryView === 'sc-playlists' && (
            <section className="chapter">
              <div className="chapter-h">
                <h2>Твои плейлисты</h2>
                <button
                  type="button"
                  className="btn-icon"
                  title="Новый плейлист"
                  aria-label="new playlist"
                  onClick={() => {
                    if (!isLoggedIn) {
                      handleLogin();
                      return;
                    }
                    setCreatePlTitle('');
                    setCreatePlOpen(true);
                  }}
                >
                  <Ico size={20}>
                    <path d="M12 5v14M5 12h14" />
                  </Ico>
                </button>
              </div>
              <div className="chapter-h" style={{ marginBottom: 10 }}>
                <h3 className="sc-sub">Созданные</h3>
              </div>
              {libraryPlaylists.length ? (
                <LedgerPlaylists items={libraryPlaylists} onOpen={(p) => void openPlaylist(p)} />
              ) : (
                <p className="note" style={{ marginBottom: 20 }}>
                  Нет созданных — нажми «+ Новый»
                </p>
              )}
              <div className="chapter-h" style={{ margin: '24px 0 10px' }}>
                <h3 className="sc-sub">Лайкнутые плейлисты</h3>
              </div>
              {likedPlaylists.length ? (
                <LedgerPlaylists items={likedPlaylists} onOpen={(p) => void openPlaylist(p)} />
              ) : (
                <p className="note">Пока нет лайкнутых плейлистов</p>
              )}
            </section>
          )}

          {!loading && page === 'playlist' && activePlaylist && (
            <>
              <div className="dossier">
                {artworkUrl(activePlaylist.artwork_url || activePlaylist.user?.avatar_url, 't500x500') ? (
                  <img
                    className="dossier-art"
                    src={artworkUrl(activePlaylist.artwork_url || activePlaylist.user?.avatar_url, 't500x500')}
                    alt=""
                  />
                ) : (
                  <div className="dossier-art ph">☰</div>
                )}
                <div>
                  <div className="dossier-k">
                    {activePlaylist.is_system || activePlaylist.kind === 'system-playlist'
                      ? 'Микс'
                      : activePlaylist.is_album
                        ? 'Альбом'
                        : 'Плейлист'}
                  </div>
                  <h1>{activePlaylist.title}</h1>
                  <div className="dossier-m">
                    <button type="button" onClick={() => activePlaylist.user && void openUser(activePlaylist.user)}>
                      {activePlaylist.user?.username}
                    </button>
                    {' · '}
                    {(activePlaylist.tracks?.length || activePlaylist.track_count || 0)} треков ·{' '}
                    {formatDuration(activePlaylist.duration)}
                  </div>
                  <div className="acts acts-icons">
                    <button
                      type="button"
                      className="btn solid btn-ico-text"
                      onClick={() => playList(activePlaylist.tracks || [])}
                      disabled={!activePlaylist.tracks?.length}
                      title="Слушать"
                    >
                      <Ico size={16}>
                        <path d="M9 6.5v11l9-5.5-9-5.5z" fill="currentColor" stroke="none" />
                      </Ico>
                      <span>Слушать</span>
                    </button>
                    {isOwnPlaylist(activePlaylist) && (
                      <>
                        <button
                          type="button"
                          className="btn-icon"
                          disabled={plBusy || addTracksBusy}
                          title="Добавить треки"
                          aria-label="add tracks"
                          onClick={() => {
                            setAddTracksTab('likes');
                            setAddTracksQuery('');
                            setAddTracksFilter('');
                            setAddTracksResults([]);
                            setAddTracksOpen(true);
                            if (!likedTracks.length && isLoggedIn) void loadLibrary();
                          }}
                        >
                          <Ico size={18}>
                            <path d="M12 5v14M5 12h14" />
                          </Ico>
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          disabled={plBusy}
                          title="Переименовать"
                          aria-label="rename"
                          onClick={() => {
                            setRenamePlTitle(activePlaylist.title);
                            setRenamePlOpen(true);
                          }}
                        >
                          <Ico size={18}>
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
                          </Ico>
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          disabled={plBusy}
                          title="Удалить плейлист"
                          aria-label="delete"
                          onClick={() => void handleDeletePlaylist()}
                        >
                          <Ico size={18}>
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M19 6l-1 14H6L5 6" />
                            <path d="M10 11v6M14 11v6" />
                          </Ico>
                        </button>
                      </>
                    )}
                    {!activePlaylist.is_system && (
                      <button
                        type="button"
                        className={`btn-icon ${
                          likedPlaylistIds.has(String(activePlaylist.urn || activePlaylist.id)) ||
                          activePlaylist.user_like ||
                          activePlaylist.liked
                            ? 'on'
                            : ''
                        }`}
                        onClick={() => void togglePlaylistLike(activePlaylist)}
                        title={
                          likedPlaylistIds.has(String(activePlaylist.urn || activePlaylist.id)) ||
                          activePlaylist.user_like ||
                          activePlaylist.liked
                            ? 'Убрать лайк'
                            : 'Лайк плейлиста'
                        }
                        aria-label="like playlist"
                      >
                        <IconHeart
                          filled={
                            likedPlaylistIds.has(String(activePlaylist.urn || activePlaylist.id)) ||
                            Boolean(activePlaylist.user_like || activePlaylist.liked)
                          }
                          size={20}
                        />
                      </button>
                    )}
                    {activePlaylist.permalink_url ? (
                      <a
                        className="btn-icon"
                        href={activePlaylist.permalink_url}
                        target="_blank"
                        rel="noreferrer"
                        title="На сайте"
                      >
                        <Ico size={18}>
                          <path d="M14 3h7v7" />
                          <path d="M10 14L21 3" />
                          <path d="M21 14v6a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1h6" />
                        </Ico>
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
              <Catalog
                tracks={(activePlaylist.tracks || []).filter((t) => t?.title)}
                currentId={player.current?.id}
                playbackState={player.state}
                likedIds={player.likedIds}
                onPlay={(t) => playList(activePlaylist.tracks || [], t)}
                onToggle={player.toggle}
                onAdd={player.addToQueue}
                onLike={toggleLike}
                onStation={(t) => void startStation(t)}
                onOpenTrack={(t) => void openTrack(t)}
                onAddToPlaylist={(t) => void openAddToPlaylist(t)}
                onRemove={
                  isOwnPlaylist(activePlaylist)
                    ? (id) => {
                        const t = (activePlaylist.tracks || []).find((x) => x.id === id);
                        if (t) void handleRemoveFromPlaylist(t);
                      }
                    : undefined
                }
              />
            </>
          )}

          {page === 'track' && activeTrack && (
            <>
              <div className="track-nav">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setPage('home');
                    setError(null);
                  }}
                >
                  ← Назад
                </button>
              </div>
              <TrackPage
                track={activeTrack}
                related={relatedTracks}
                comments={trackComments}
                loading={false}
                currentId={player.current?.id}
                liked={player.likedIds.has(activeTrack.id) || Boolean(activeTrack.user_favorite)}
                reposted={repostedIds.has(activeTrack.id) || Boolean(activeTrack.user_repost)}
                playerProgressSec={player.progress}
                meId={session?.user?.id ?? null}
                isLoggedIn={isLoggedIn}
                onPlay={() => playList([activeTrack, ...relatedTracks], activeTrack)}
                onPlayRelated={(t, list) => playList(list, t)}
                onLike={() => void toggleLike(activeTrack)}
                onRepost={() => void toggleRepost(activeTrack)}
                onStation={() => void startStation(activeTrack)}
                onOpenUser={(u) => void openUser(u)}
                onOpenTrack={(t) => void openTrack(t)}
                onLogin={handleLogin}
                onSeekComment={(ms) => {
                  if (player.current?.id === activeTrack.id) {
                    player.seek(ms / 1000);
                  } else {
                    playList([activeTrack, ...relatedTracks], activeTrack);
                    window.setTimeout(() => player.seek(ms / 1000), 400);
                  }
                }}
                onPostComment={async (body, timestampMs) => {
                  if (!(await requireLogin())) throw new Error('Нужен вход');
                  const created = await postComment(activeTrack.id, body, timestampMs);
                  if (session?.user) {
                    created.user = {
                      id: session.user.id,
                      username: session.user.username,
                      avatar_url: session.user.avatar_url,
                      permalink_url: session.user.permalink_url,
                    };
                    created.user_id = session.user.id;
                  }
                  setTrackComments((prev) => [created, ...prev]);
                  setStatus('Комментарий отправлен');
                  setError(null);
                }}
                onDeleteComment={async (commentId) => {
                  if (!(await requireLogin())) return;
                  const existing = trackComments.find((c) => c.id === commentId);
                  try {
                    await deleteComment(activeTrack.id, commentId, {
                      localOnly: Boolean(existing?.localOnly),
                    });
                    setTrackComments((prev) => prev.filter((c) => c.id !== commentId));
                    setStatus(
                      existing?.localOnly
                        ? 'Убран из списка (не был на сервере)'
                        : 'Комментарий удалён на SoundCloud'
                    );
                    setError(null);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Не удалось удалить');
                  }
                }}
                onAddToPlaylist={() => void openAddToPlaylist(activeTrack)}
              />
            </>
          )}

          {!loading && page === 'user' && activeUser && (
            <>
              <div className="dossier">
                {activeUser.avatar_url ? (
                  <img className="dossier-art round" src={artworkUrl(activeUser.avatar_url, 't500x500')} alt="" />
                ) : (
                  <div className="dossier-art ph round">@</div>
                )}
                <div>
                  <div className="dossier-k">Профиль</div>
                  <h1>{activeUser.username}</h1>
                  <div className="dossier-m">
                    {formatCount(activeUser.followers_count || 0)} подписчиков · {activeUser.track_count ?? 0} треков ·{' '}
                    {userReposts.length} репостов · {activeUser.playlist_count ?? 0} плейлистов
                  </div>
                  <div className="acts">
                    <button
                      type="button"
                      className="btn solid"
                      onClick={() =>
                        playList(userTab === 'reposts' ? userReposts : userTracks)
                      }
                      disabled={!(userTab === 'reposts' ? userReposts : userTracks).length}
                    >
                      Слушать
                    </button>
                    {session?.user?.id !== activeUser.id && (
                      <button
                        type="button"
                        className={`btn ${followingUser ? '' : 'solid'} btn-ico-text`}
                        disabled={followBusy}
                        onClick={() => void toggleFollow()}
                      >
                        {followBusy ? (
                          '…'
                        ) : followingUser ? (
                          <>
                            <Ico size={16}>
                              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
                              <circle cx="9" cy="7" r="4" />
                              <path d="M16 11l2 2 4-4" />
                            </Ico>
                            <span>Вы подписаны</span>
                          </>
                        ) : (
                          <>
                            <Ico size={16}>
                              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
                              <circle cx="9" cy="7" r="4" />
                              <path d="M19 8v6M22 11h-6" />
                            </Ico>
                            <span>Подписаться</span>
                          </>
                        )}
                      </button>
                    )}
                    {activeUser.permalink_url ? (
                      <a
                        className="btn-icon"
                        href={activeUser.permalink_url}
                        target="_blank"
                        rel="noreferrer"
                        title="На сайте"
                      >
                        <Ico size={18}>
                          <path d="M14 3h7v7" />
                          <path d="M10 14L21 3" />
                          <path d="M21 14v6a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1h6" />
                        </Ico>
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="chips" style={{ marginBottom: 18 }}>
                <button
                  type="button"
                  className={`chip ${userTab === 'tracks' ? 'on' : ''}`}
                  onClick={() => setUserTab('tracks')}
                >
                  Треки {userTracks.length ? `· ${userTracks.length}` : ''}
                </button>
                <button
                  type="button"
                  className={`chip ${userTab === 'reposts' ? 'on' : ''}`}
                  onClick={() => setUserTab('reposts')}
                >
                  Репосты {userReposts.length ? `· ${userReposts.length}` : ''}
                </button>
                <button
                  type="button"
                  className={`chip ${userTab === 'playlists' ? 'on' : ''}`}
                  onClick={() => setUserTab('playlists')}
                >
                  Плейлисты {userPlaylists.length ? `· ${userPlaylists.length}` : ''}
                </button>
              </div>

              {userTab === 'tracks' && (
                <section className="chapter">
                  {userTracks.length ? (
                    <Catalog
                      tracks={userTracks}
                      currentId={player.current?.id}
                      playbackState={player.state}
                      likedIds={player.likedIds}
                      onPlay={(t) => playList(userTracks, t)}
                      onToggle={player.toggle}
                      onAdd={player.addToQueue}
                      onLike={toggleLike}
                      onStation={(t) => void startStation(t)}
                      onOpenTrack={(t) => void openTrack(t)}
                      onAddToPlaylist={(t) => void openAddToPlaylist(t)}
                    />
                  ) : (
                    <div className="void">
                      <h3>Нет своих треков</h3>
                      <p>
                        {userReposts.length
                          ? 'Загляни во вкладку «Репосты»'
                          : 'У этого пользователя пока пусто'}
                      </p>
                    </div>
                  )}
                </section>
              )}

              {userTab === 'reposts' && (
                <section className="chapter">
                  {userReposts.length ? (
                    <Catalog
                      tracks={userReposts}
                      currentId={player.current?.id}
                      playbackState={player.state}
                      likedIds={player.likedIds}
                      onPlay={(t) => playList(userReposts, t)}
                      onToggle={player.toggle}
                      onAdd={player.addToQueue}
                      onLike={toggleLike}
                      onStation={(t) => void startStation(t)}
                      onOpenTrack={(t) => void openTrack(t)}
                      onAddToPlaylist={(t) => void openAddToPlaylist(t)}
                    />
                  ) : (
                    <div className="void">
                      <h3>Репостов нет</h3>
                      <p>Когда кто-то репостнет трек — он появится здесь</p>
                    </div>
                  )}
                </section>
              )}

              {userTab === 'playlists' && (
                <section className="chapter">
                  <LedgerPlaylists items={userPlaylists} onOpen={(p) => void openPlaylist(p)} />
                </section>
              )}
            </>
          )}

          {!loading && page === 'queue' && (
            <section className="chapter">
              <div className="chapter-h">
                <h2>{player.stationMode ? 'Станция' : 'Далее'}</h2>
                <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                  {player.stationMode && player.stationSeed && (
                    <span className="linkish" style={{ cursor: 'default', color: 'var(--accent)' }}>
                      от · {player.stationSeed.title}
                    </span>
                  )}
                  {player.queue.length > 0 && (
                    <button type="button" className="linkish" onClick={player.clearQueue}>
                      Очистить
                    </button>
                  )}
                </div>
              </div>
              {player.stationMode && (
                <p className="note">Режим радио — похожие треки, очередь растёт по ходу прослушивания</p>
              )}
              {!player.queue.length ? (
                <div className="void">
                  <h3>Очередь пуста</h3>
                  <p>Запусти трек или станцию — и здесь появится список</p>
                </div>
              ) : (
                <Catalog
                  tracks={player.queue}
                  currentId={player.current?.id}
                  playbackState={player.state}
                  likedIds={player.likedIds}
                  onPlay={(t) =>
                    player.playTrack(t, player.queue, { keepStation: player.stationMode })
                  }
                  onToggle={player.toggle}
                  onAdd={player.addToQueue}
                  onLike={toggleLike}
                  onStation={(t) => void startStation(t)}
                  onRemove={player.removeFromQueue}
                  onOpenTrack={(t) => void openTrack(t)}
                />
              )}
            </section>
          )}

          {page === 'local' && (
            <LocalPage
              key={miuraProfile?.id || 'local'}
              currentUid={player.current ? getPlayable(player.current.id)?.uid : null}
              onPlay={(item, list) => player.playPlayable(item, list)}
              onAddToQueue={(item) => player.addPlayableToQueue(item)}
            />
          )}

          {page === 'miura-playlists' && (
            <MiuraPlaylistsPage
              onPlayTrack={(track, list) => player.playTrack(track, list)}
              onPlayPlayable={(item, list) => player.playPlayable(item, list)}
              currentId={player.current?.id ?? null}
              currentUid={player.current ? getPlayable(player.current.id)?.uid ?? null : null}
              playerState={player.state}
              focusPlaylistId={focusMiuraPlaylistId}
              onPlaylistsChange={refreshRailPlaylists}
              onFocusPlaylist={setFocusMiuraPlaylistId}
            />
          )}

          {page === 'profile' && miuraProfile && (
            <ProfilePage
              profile={miuraProfile}
              profiles={miuraProfiles}
              favorites={favorites}
              recent={recent}
              scConnected={isLoggedIn}
              scUsername={session?.user?.username}
              onProfileState={applyMiuraProfileState}
              onOpenSettings={() => navigateTo('settings')}
              onOpenLocal={() => navigateTo('local')}
              onOpenFavorites={() => navigateTo('library')}
              onPlayFavorite={(f) => {
                if (f.track) player.playTrack(f.track);
                else if (f.playable) player.playPlayable(f.playable);
              }}
              onToggleFavorite={(f) => {
                setFavorites(
                  toggleFavorite({
                    id: f.id,
                    title: f.title,
                    artist: f.artist,
                    artworkUrl: f.artworkUrl,
                    source: f.source,
                    track: f.track,
                    playable: f.playable,
                  })
                );
              }}
              onAccentChange={(hex) => {
                if (hex) {
                  setAccent(hex);
                  setThemeAccent(hex);
                }
              }}
            />
          )}

          {page === 'youtube' && (
            <YouTubePage
              currentUid={player.current ? getPlayable(player.current.id)?.uid : null}
              onPlay={(item, list) => player.playPlayable(item, list)}
            />
          )}

          {page === 'soundcloud' && (
            <div className="chapter">
              <div className="sc-home-hero">
                <div className="sc-home-hero-text">
                  <h1 className="sc-home-greeting">{t.soundcloud.title}</h1>
                  <p className="sc-home-lead">{t.soundcloud.lead}</p>
                </div>
                <button type="button" className="btn solid" onClick={() => void go('home')}>
                  {t.nav.home}
                </button>
              </div>
              {!isLoggedIn && (
                <button type="button" className="btn solid" onClick={() => handleLogin()}>
                  {t.soundcloud.login}
                </button>
              )}
              <p className="note" style={{ marginTop: 16 }}>
                SoundCloud feed lives on Home — open charts &amp; shelves there after login.
              </p>
            </div>
          )}

          {page === 'settings' && (
            <Settings
              session={session}
              miuraProfile={miuraProfile}
              miuraProfiles={miuraProfiles}
              onMiuraProfileState={applyMiuraProfileState}
              clientIdInput={clientIdInput}
              setClientIdInput={setClientIdInput}
              accent={accent}
              setAccent={setAccent}
              onLogin={handleLogin}
              onLogout={() => void handleLogout()}
              onSession={(s) => {
                void applySession(s);
              }}
              onSaveClientId={() => {
                if (!clientIdInput.trim()) return;
                setClientId(clientIdInput.trim());
                setStatus('client_id saved');
                setError(null);
              }}
              onRefreshClientId={async () => {
                setLoading(true);
                try {
                  localStorage.removeItem('sc_client_id');
                  const id = await resolveClientId();
                  setClientIdInput(id);
                  setStatus('client_id refreshed');
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'client_id error');
                } finally {
                  setLoading(false);
                }
              }}
            />
          )}
        </div>
      </main>

      <PlayerBar
        player={player}
        onLike={() => player.current && void toggleLike(player.current)}
        onStation={() => player.current && void startStation(player.current)}
        onOpenTrack={() => player.current && void openTrack(player.current)}
        onOpenUser={() => player.current?.user && void openUser(player.current.user)}
        onOpenQueue={() => setQueueOpen(true)}
        onToggleFav={() => {
          const tr = player.current;
          if (!tr) return;
          const playable = getPlayable(tr.id);
          const source =
            tr.genre === 'local' || tr.genre === 'youtube'
              ? String(tr.genre)
              : playable?.source || 'soundcloud';
          const id = playable ? favIdFromPlayable(playable) : favIdFromTrack(tr);
          setFavorites(
            toggleFavorite({
              id,
              title: tr.title,
              artist: tr.user?.username || playable?.artist || '—',
              artworkUrl: tr.artwork_url || playable?.artworkUrl,
              source,
              track: tr,
              playable: playable || undefined,
            })
          );
        }}
        isFav={
          player.current
            ? (() => {
                const tr = player.current!;
                const playable = getPlayable(tr.id);
                const id = playable ? favIdFromPlayable(playable) : favIdFromTrack(tr);
                return favorites.some((f) => f.id === id);
              })()
            : false
        }
      />

      <QueueDrawer
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
        queue={player.queue}
        currentId={player.current?.id}
        onPlay={(i) => player.playQueueIndex(i)}
        onRemove={(id) => player.removeFromQueue(id)}
        onClear={() => player.clearQueue()}
      />

      {createPlOpen && (
        <Modal title="Новый плейлист" onClose={() => !createPlBusy && setCreatePlOpen(false)}>
          <div className="modal-field">
            <label>Название</label>
            <input
              type="text"
              value={createPlTitle}
              onChange={(e) => setCreatePlTitle(e.target.value)}
              placeholder="Мой set"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreatePlaylist(addToPlTrack);
              }}
            />
          </div>
          {addToPlTrack && (
            <p className="note">Трек «{addToPlTrack.title}» будет добавлен сразу</p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" disabled={createPlBusy} onClick={() => setCreatePlOpen(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn solid"
              disabled={createPlBusy || !createPlTitle.trim()}
              onClick={() => void handleCreatePlaylist(addToPlTrack)}
            >
              {createPlBusy ? '…' : 'Создать'}
            </button>
          </div>
        </Modal>
      )}

      {addToPlTrack && !createPlOpen && (
        <Modal title="Добавить в плейлист" onClose={() => !addToPlBusy && setAddToPlTrack(null)}>
          <p className="note" style={{ marginBottom: 12 }}>
            {addToPlTrack.title}
          </p>
          {libraryPlaylists.length ? (
            <div className="modal-list">
              {libraryPlaylists.map((pl) => (
                <button
                  key={String(pl.id)}
                  type="button"
                  className="modal-list-item"
                  disabled={addToPlBusy}
                  onClick={() => void handleAddToPlaylist(pl)}
                >
                  {artworkUrl(pl.artwork_url || pl.user?.avatar_url, 't67x67') ? (
                    <img src={artworkUrl(pl.artwork_url || pl.user?.avatar_url, 't67x67')} alt="" />
                  ) : (
                    <div className="cat-art ph" style={{ width: 40, height: 40 }}>
                      ☰
                    </div>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div className="t">{pl.title}</div>
                    <div className="s">{pl.track_count ?? 0} треков</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="note">Пока нет своих плейлистов</p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn solid"
              disabled={addToPlBusy}
              onClick={() => {
                setCreatePlTitle('');
                setCreatePlOpen(true);
              }}
            >
              + Новый плейлист
            </button>
          </div>
        </Modal>
      )}

      {renamePlOpen && activePlaylist && (
        <Modal title="Переименовать" onClose={() => !plBusy && setRenamePlOpen(false)}>
          <div className="modal-field">
            <label>Название</label>
            <input
              type="text"
              value={renamePlTitle}
              onChange={(e) => setRenamePlTitle(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRenamePlaylist();
              }}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" disabled={plBusy} onClick={() => setRenamePlOpen(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn solid"
              disabled={plBusy || !renamePlTitle.trim()}
              onClick={() => void handleRenamePlaylist()}
            >
              {plBusy ? '…' : 'Сохранить'}
            </button>
          </div>
        </Modal>
      )}

      {addTracksOpen && activePlaylist && (
        <Modal
          title={`Добавить в «${activePlaylist.title}»`}
          onClose={() => !addTracksBusy && setAddTracksOpen(false)}
        >
          <div className="chips" style={{ marginBottom: 14 }}>
            <button
              type="button"
              className={`chip ${addTracksTab === 'likes' ? 'on' : ''}`}
              onClick={() => {
                setAddTracksTab('likes');
                if (!likedTracks.length && isLoggedIn) void loadLibrary();
              }}
            >
              Лайки{likedTracks.length ? ` · ${likedTracks.length}` : ''}
            </button>
            <button
              type="button"
              className={`chip ${addTracksTab === 'search' ? 'on' : ''}`}
              onClick={() => setAddTracksTab('search')}
            >
              Поиск
            </button>
          </div>

          {addTracksTab === 'likes' && (
            <>
              <div className="modal-field">
                <label>Фильтр по лайкам</label>
                <input
                  type="text"
                  value={addTracksFilter}
                  onChange={(e) => setAddTracksFilter(e.target.value)}
                  placeholder="Название или артист…"
                  autoFocus
                />
              </div>
              {(() => {
                const q = addTracksFilter.trim().toLowerCase();
                const list = likedTracks.filter((t) => {
                  if (!q) return true;
                  return (
                    t.title?.toLowerCase().includes(q) ||
                    t.user?.username?.toLowerCase().includes(q) ||
                    t.user?.full_name?.toLowerCase().includes(q)
                  );
                });
                if (!likedTracks.length) {
                  return (
                    <p className="note">
                      {addTracksBusy ? 'Загрузка лайков…' : 'Нет лайков — поставь лайки или открой «Поиск»'}
                    </p>
                  );
                }
                if (!list.length) {
                  return <p className="note">Ничего не совпало с фильтром</p>;
                }
                return (
                  <div className="modal-list">
                    {list.map((t) => {
                      const already = (activePlaylist.tracks || []).some((x) => x.id === t.id);
                      const art = artworkUrl(t.artwork_url || t.user?.avatar_url, 't67x67');
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className="modal-list-item"
                          disabled={addTracksBusy || already}
                          onClick={() => void handleAddTrackWhileInPlaylist(t)}
                          title={already ? 'Уже в плейлисте' : 'Добавить'}
                        >
                          {art ? (
                            <img src={art} alt="" />
                          ) : (
                            <div className="cat-art ph" style={{ width: 40, height: 40 }}>
                              ♪
                            </div>
                          )}
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="t">{t.title}</div>
                            <div className="s">{t.user?.username}</div>
                          </div>
                          <span className="s" style={{ flexShrink: 0 }}>
                            {already ? '✓' : '+'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </>
          )}

          {addTracksTab === 'search' && (
            <>
              <form
                className="modal-field"
                onSubmit={(e) => {
                  e.preventDefault();
                  void searchTracksForPlaylist(addTracksQuery);
                }}
              >
                <label>Поиск по SoundCloud</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={addTracksQuery}
                    onChange={(e) => setAddTracksQuery(e.target.value)}
                    placeholder="Название, артист…"
                    autoFocus
                    style={{ flex: 1 }}
                  />
                  <button
                    type="submit"
                    className="btn solid"
                    disabled={addTracksBusy || !addTracksQuery.trim()}
                  >
                    {addTracksBusy ? '…' : 'Найти'}
                  </button>
                </div>
              </form>
              {addTracksResults.length > 0 ? (
                <div className="modal-list">
                  {addTracksResults.map((t) => {
                    const already = (activePlaylist.tracks || []).some((x) => x.id === t.id);
                    const art = artworkUrl(t.artwork_url || t.user?.avatar_url, 't67x67');
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className="modal-list-item"
                        disabled={addTracksBusy || already}
                        onClick={() => void handleAddTrackWhileInPlaylist(t)}
                        title={already ? 'Уже в плейлисте' : 'Добавить'}
                      >
                        {art ? (
                          <img src={art} alt="" />
                        ) : (
                          <div className="cat-art ph" style={{ width: 40, height: 40 }}>
                            ♪
                          </div>
                        )}
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="t">{t.title}</div>
                          <div className="s">{t.user?.username}</div>
                        </div>
                        <span className="s" style={{ flexShrink: 0 }}>
                          {already ? '✓' : '+'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="note">
                  {addTracksQuery.trim() && !addTracksBusy
                    ? 'Ничего не найдено'
                    : 'Введи запрос и нажми «Найти»'}
                </p>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function TokenImport({
  clientIdHint,
  onDone,
  onBrowserLogin,
}: {
  clientIdHint: string;
  onDone: (s: AuthSession) => void;
  onBrowserLogin?: () => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const importToken = async () => {
    if (!window.electronAPI?.authImportToken) {
      setMsg('только в electron');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const api = await import('./api/soundcloud');
      const session = await window.electronAPI.authImportToken({
        accessToken: token.trim(),
        clientId: clientIdHint || null,
      });
      if (!session?.accessToken) throw new Error('не сохранилось');
      api.setAccessToken(session.accessToken);
      if (session.clientId) api.setClientId(session.clientId);
      onDone(session);
      setMsg(`ok · ${session.user?.username || 'in'}`);
      setToken('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'import failed');
    } finally {
      setBusy(false);
    }
  };

  // Always expanded when embedded in <details>; keep internal toggle for standalone use
  const show = open;
  return (
    <div style={{ marginTop: 12 }}>
      <p className="settings-desc" style={{ marginBottom: 12 }}>
        Через Chrome/Edge (с VPN, если нужно). Если встроенное окно блокируется — этот путь
        надёжнее.
      </p>
      {onBrowserLogin && (
        <div className="row-btns" style={{ marginBottom: 14 }}>
          <button type="button" className="btn solid" onClick={onBrowserLogin}>
            Открыть вход в браузере
          </button>
        </div>
      )}
      <label className="settings-field-label">Токен OAuth</label>
      <input
        type="text"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="2-123456-… или OAuth 2-…"
        spellCheck={false}
      />
      <div className="row-btns" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn solid"
          disabled={busy || !token.trim()}
          onClick={() => void importToken()}
        >
          {busy ? '…' : 'Импортировать токен'}
        </button>
        {!show && (
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Подсказка
          </button>
        )}
      </div>
      {msg && (
        <p className="note" style={{ marginTop: 10 }}>
          {msg}
        </p>
      )}
      <div className="settings-hint" style={{ marginTop: 12 }}>
        1. soundcloud.com → войди
        <br />
        2. F12 → Network → запрос к api-v2.soundcloud.com
        <br />
        3. Headers → Authorization: OAuth … → вставь сюда
      </div>
    </div>
  );
}

/** Minimal line icons — 24 viewBox, currentColor stroke */
function Ico({
  children,
  size = 18,
}: {
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const IconShuffle = () => (
  <Ico>
    <path d="M16 3h5v5" />
    <path d="M4 20 20 4" />
    <path d="M21 16v5h-5" />
    <path d="M15 15l6 6" />
    <path d="M4 4l5 5" />
  </Ico>
);

/** Outline chevrons — lighter than filled triangles */
const IconPrev = () => (
  <Ico>
    <path d="M14 6l-6 6 6 6" />
    <path d="M6 6v12" />
  </Ico>
);

const IconNext = () => (
  <Ico>
    <path d="M10 6l6 6-6 6" />
    <path d="M18 6v12" />
  </Ico>
);

const IconPlay = () => (
  <Ico size={20}>
    <path d="M9 6.5v11l9-5.5-9-5.5z" fill="currentColor" stroke="none" />
  </Ico>
);

const IconPause = () => (
  <Ico size={18}>
    <path d="M7 5h3v14H7z" fill="currentColor" stroke="none" />
    <path d="M14 5h3v14h-3z" fill="currentColor" stroke="none" />
  </Ico>
);

const IconRepeat = ({ mode }: { mode: 'off' | 'all' | 'one' }) => (
  <span className={`ico-wrap repeat-ico mode-${mode}`} aria-hidden>
    <Ico>
      {/* Clean loop arrows (24 viewBox) */}
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      {mode === 'one' ? (
        <text
          x="12"
          y="13.5"
          textAnchor="middle"
          dominantBaseline="middle"
          className="repeat-one-digit"
          fill="currentColor"
          stroke="none"
          fontSize="8"
          fontWeight="700"
          fontFamily="system-ui, sans-serif"
        >
          1
        </text>
      ) : null}
    </Ico>
  </span>
);

/** Station: simple pulse bars */
const IconRadio = () => (
  <Ico>
    <path d="M6 14v-4" />
    <path d="M10 17V7" />
    <path d="M14 15V9" />
    <path d="M18 13v-2" />
  </Ico>
);

/** Heart as pure stroke (filled uses same path + fill) */
const IconHeart = ({ filled, size = 18 }: { filled?: boolean; size?: number }) => (
  <Ico size={size}>
    <path
      d="M12 20s-7-4.4-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.6-7 10-7 10z"
      fill={filled ? 'currentColor' : 'none'}
    />
  </Ico>
);

/** Speaker as outline wedge + waves */
const IconVol = () => (
  <Ico>
    <path d="M4 10h3l4-3v10l-4-3H4v-4z" />
    <path d="M15 9.5a3.5 3.5 0 010 5" />
    <path d="M17.5 7a6 6 0 010 10" />
  </Ico>
);

const IconMute = () => (
  <Ico>
    <path d="M4 10h3l4-3v10l-4-3H4v-4z" />
    <path d="M16 9l5 6M21 9l-5 6" />
  </Ico>
);

const IconSpinner = () => (
  <span className="ico-spin" aria-hidden>
    <Ico size={16}>
      <path d="M12 3a9 9 0 019 9" />
    </Ico>
  </span>
);

const IconSettings = () => (
  <Ico size={18}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </Ico>
);

const IconHome = () => (
  <Ico size={20}>
    <path d="M3 10.5L12 3l9 7.5" />
    <path d="M5 9.5V20h14V9.5" />
  </Ico>
);

const IconSearch = () => (
  <Ico size={18}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Ico>
);

const IconLibrary = () => (
  <Ico size={20}>
    <path d="M4 4h4v16H4z" />
    <path d="M10 4h4v16h-4z" />
    <path d="M16 6l4 1v13l-4-1V6z" />
  </Ico>
);

const IconQueue = () => (
  <Ico size={20}>
    <path d="M4 6h12" />
    <path d="M4 12h12" />
    <path d="M4 18h8" />
    <path d="M18 14v6l4-3-4-3z" fill="currentColor" stroke="none" />
  </Ico>
);

const IconPlaylist = () => (
  <Ico size={20}>
    <path d="M4 6h12" />
    <path d="M4 12h8" />
    <path d="M4 18h8" />
    <circle cx="17" cy="16" r="3" />
    <path d="M20 16V8l-3 1" />
  </Ico>
);

/** Orange GO+ chip like on soundcloud.com */
function GoPlusBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`badge-go ${className}`.trim()} title="Доступно с SoundCloud Go+">
      GO+
    </span>
  );
}

/** SoundCloud-style horizontal shelf with cover art */
function HomeShelf({
  section,
  currentId,
  likedIds,
  onPlayTrack,
  onPlayAll,
  onAdd,
  onLike,
  onStation,
  onOpenPlaylist,
  onPlayPlaylist,
  onOpenTrack,
  onOpenUser,
}: {
  section: HomeSection;
  currentId?: number;
  likedIds: Set<number>;
  onPlayTrack: (t: Track, list: Track[]) => void;
  onPlayAll: (list: Track[]) => void;
  onAdd: (t: Track) => void;
  onLike: (t: Track) => void;
  onStation: (t: Track) => void;
  onOpenPlaylist: (p: Playlist) => void;
  onPlayPlaylist: (p: Playlist) => void;
  onOpenTrack: (t: Track) => void;
  onOpenUser?: (u: SoundCloudUser) => void;
}) {
  const tracks = section.tracks || [];
  const playlists = section.playlists || [];
  const users = section.users || [];
  const isFeed = section.id === 'feed' || section.group === 'feed';
  // Never render two rails (broken mini-tracks + mixes) — one shelf, one row
  const preferPlaylists =
    playlists.length > 0 &&
    (section.kind === 'playlists' || section.kind === 'mixed' || tracks.length === 0);
  const showTracks = tracks.length > 0 && !preferPlaylists;
  const showPlaylists = playlists.length > 0 && preferPlaylists;

  return (
    <section className={`sc-shelf ${isFeed ? 'sc-shelf-feed' : ''}`}>
      <div className="sc-shelf-h">
        <div className="sc-shelf-heading">
          <h2 className="sc-shelf-title">{section.title}</h2>
          {section.subtitle ? <p className="sc-shelf-sub">{section.subtitle}</p> : null}
        </div>
        {showTracks && (
          <button type="button" className="sc-shelf-play" onClick={() => onPlayAll(tracks)} title="Слушать всё">
            <IconPlay />
            <span>Слушать всё</span>
          </button>
        )}
      </div>

      {showTracks && (
        <div className={`sc-rail ${isFeed ? 'sc-rail-dense' : ''}`}>
          {tracks.map((t, idx) => {
            const art = artworkUrl(t.artwork_url || t.user?.avatar_url, 't300x300');
            const active = currentId === t.id;
            const liked = likedIds.has(t.id) || Boolean(t.user_favorite);
            return (
              <article key={`${section.id}-${t.id}-${idx}`} className={`sc-card ${active ? 'live' : ''}`}>
                <div
                  className="sc-cover"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenTrack(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenTrack(t);
                    }
                  }}
                  title="Открыть трек"
                >
                  {art ? (
                    <img src={art} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <div className="sc-cover-ph">♪</div>
                  )}
                  <div className="sc-cover-fade" />
                  <button
                    type="button"
                    className="sc-play"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlayTrack(t, tracks);
                    }}
                    title="Играть"
                    aria-label="play"
                  >
                    <IconPlay />
                  </button>
                  <div className="sc-cover-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" title="Like" className={liked ? 'on' : ''} onClick={() => onLike(t)}>
                      <IconHeart filled={liked} />
                    </button>
                    <button type="button" title="Station" onClick={() => onStation(t)}>
                      <IconRadio />
                    </button>
                    <button type="button" title="Queue" onClick={() => onAdd(t)}>
                      <Ico size={16}>
                        <path d="M12 5v14M5 12h14" />
                      </Ico>
                    </button>
                  </div>
                  <span className="sc-dur">{formatDuration(t.duration)}</span>
                  {isGoPlusOnlyTrack(t) && (
                    <span className="badge-go badge-go-cover" title="SoundCloud Go+">
                      GO+
                    </span>
                  )}
                  {section.group === 'charts' && (
                    <span className="sc-rank" aria-hidden>
                      {idx + 1}
                    </span>
                  )}
                </div>
                <button type="button" className="sc-meta" onClick={() => onOpenTrack(t)} title="Открыть трек">
                  <div className="sc-t" title={t.title}>
                    {t.title}
                    {isGoPlusOnlyTrack(t) ? <GoPlusBadge /> : null}
                  </div>
                  <div className="sc-a" title={t.user?.username}>
                    {t.user?.username}
                  </div>
                  {(t.playback_count > 0 || t.likes_count > 0) && (
                    <div className="sc-stats">
                      {t.playback_count > 0 && <span>▶ {formatCount(t.playback_count)}</span>}
                      {t.likes_count > 0 && <span>♥ {formatCount(t.likes_count)}</span>}
                    </div>
                  )}
                </button>
              </article>
            );
          })}
        </div>
      )}

      {showPlaylists && (
        <div className="sc-rail sc-rail-pl">
          {playlists.map((p) => {
            const art = artworkUrl(p.artwork_url || p.user?.avatar_url, 't300x300');
            const isMix = Boolean(p.is_system || p.kind === 'system-playlist');
            return (
              <article key={String(p.urn || p.id)} className="sc-card sc-card-pl">
                <div className="sc-cover">
                  {art ? (
                    <img src={art} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <div className="sc-cover-ph">{isMix ? '◎' : '☰'}</div>
                  )}
                  <div className="sc-cover-fade" />
                  <button
                    type="button"
                    className="sc-play"
                    onClick={() => onPlayPlaylist(p)}
                    title="Слушать"
                    aria-label="play mix"
                  >
                    <IconPlay />
                  </button>
                  <span className="sc-dur">
                    {isMix ? 'mix' : `${p.track_count ?? 0} tracks`}
                  </span>
                </div>
                <button type="button" className="sc-meta" onClick={() => onOpenPlaylist(p)}>
                  <div className="sc-t" title={p.title}>
                    {p.title}
                  </div>
                  <div className="sc-a" title={p.user?.username}>
                    {isMix ? 'SoundCloud Mix' : p.user?.username}
                  </div>
                </button>
              </article>
            );
          })}
        </div>
      )}

      {users.length > 0 && (
        <div className="sc-rail sc-rail-users">
          {users.map((u) => {
            const av = artworkUrl(u.avatar_url, 't300x300');
            return (
              <article key={u.id} className="sc-card sc-card-user">
                <button
                  type="button"
                  className="sc-user-cover"
                  onClick={() => onOpenUser?.(u)}
                  title={u.username}
                >
                  {av ? (
                    <img src={av} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <div className="sc-cover-ph">@</div>
                  )}
                </button>
                <button type="button" className="sc-meta" onClick={() => onOpenUser?.(u)}>
                  <div className="sc-t" title={u.username}>
                    {u.username}
                    {u.verified ? <span className="sc-verified" title="verified">✓</span> : null}
                  </div>
                  <div className="sc-a">
                    {u.followers_count != null
                      ? `${formatCount(u.followers_count)} подписчиков`
                      : u.full_name || 'Артист'}
                  </div>
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Catalog({
  tracks,
  currentId,
  playbackState,
  likedIds,
  onPlay,
  onToggle,
  onAdd,
  onLike,
  onStation,
  onRemove,
  onOpenTrack,
  onAddToPlaylist,
}: {
  tracks: Track[];
  currentId?: number;
  /** When this track is current: playing | paused | loading */
  playbackState?: string;
  likedIds: Set<number>;
  onPlay: (t: Track) => void;
  onToggle?: () => void;
  onAdd: (t: Track) => void;
  onLike: (t: Track) => void;
  onStation?: (t: Track) => void;
  onRemove?: (id: number) => void;
  onOpenTrack?: (t: Track) => void;
  onAddToPlaylist?: (t: Track) => void;
}) {
  if (!tracks.length) {
    return (
      <div className="void">
        <h3>Пусто</h3>
      </div>
    );
  }
  return (
    <div className="cat">
      {tracks.map((t, i) => {
        const liked = likedIds.has(t.id) || t.user_favorite;
        const art = artworkUrl(t.artwork_url || t.user?.avatar_url, 't67x67');
        const isCurrent = currentId === t.id;
        const isPlaying = isCurrent && playbackState === 'playing';
        const isLoading = isCurrent && playbackState === 'loading';
        return (
          <div key={`${t.id}-${i}`} className={`cat-row ${isCurrent ? 'live' : ''} ${isPlaying ? 'playing' : ''}`}>
            <button
              type="button"
              className={`idx ${isCurrent ? 'on' : ''}`}
              onClick={() => {
                if (isCurrent && onToggle) onToggle();
                else onPlay(t);
              }}
              title={isPlaying ? 'Пауза' : 'Играть'}
            >
              {isLoading ? (
                <span className="idx-load" />
              ) : isPlaying ? (
                <span className="eq" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              ) : isCurrent ? (
                <span className="idx-play" aria-hidden>
                  ▶
                </span>
              ) : (
                <>
                  <span className="idx-num">{i + 1}</span>
                  <span className="idx-play hover-only" aria-hidden>
                    ▶
                  </span>
                </>
              )}
            </button>
            <button
              type="button"
              className="cat-art-wrap"
              onClick={() => (onOpenTrack ? onOpenTrack(t) : onPlay(t))}
              title={onOpenTrack ? 'Открыть трек' : 'Играть'}
            >
              {art ? (
                <img className="cat-art" src={art} alt="" loading="lazy" draggable={false} />
              ) : (
                <div className="cat-art ph">♪</div>
              )}
            </button>
            <div className="cat-main">
              {onOpenTrack ? (
                <button
                  type="button"
                  className="cat-title-btn"
                  onClick={() => onOpenTrack(t)}
                  title={`Открыть: ${t.title}`}
                >
                  <span className="cat-title-text">{t.title}</span>
                  {isGoPlusOnlyTrack(t) ? <GoPlusBadge /> : null}
                </button>
              ) : (
                <button type="button" className="cat-title-btn" onClick={() => onPlay(t)}>
                  <span className="cat-title-text">{t.title}</span>
                  {isGoPlusOnlyTrack(t) ? <GoPlusBadge /> : null}
                </button>
              )}
              <span className="cat-sub">
                {t.user?.username}
                {isGoPlusOnlyTrack(t) ? (
                  <span className="cat-go-hint"> · только с Go+</span>
                ) : null}
              </span>
            </div>
            <span className="cat-dur">{formatDuration(t.duration)}</span>
            <div className="cat-ops">
              {onStation && (
                <button type="button" className="op ico-btn" onClick={() => onStation(t)} title="Станция">
                  <IconRadio />
                </button>
              )}
              <button
                type="button"
                className={`op ico-btn ${liked ? 'hot' : ''}`}
                onClick={() => onLike(t)}
                title="Лайк"
              >
                <IconHeart filled={liked} />
              </button>
              <button type="button" className="op ico-btn" onClick={() => onAdd(t)} title="В очередь">
                <Ico size={16}>
                  <path d="M12 5v14M5 12h14" />
                </Ico>
              </button>
              {onAddToPlaylist && (
                <button
                  type="button"
                  className="op ico-btn"
                  onClick={() => onAddToPlaylist(t)}
                  title="В плейлист"
                >
                  <Ico size={16}>
                    <path d="M8 6h13M8 12h13M8 18h13" />
                    <path d="M3 6h.01M3 12h.01M3 18h.01" />
                  </Ico>
                </button>
              )}
              {onRemove && (
                <button type="button" className="op ico-btn" onClick={() => onRemove(t.id)} title="Убрать">
                  <Ico size={16}>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </Ico>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LedgerPlaylists({ items, onOpen }: { items: Playlist[]; onOpen: (p: Playlist) => void }) {
  if (!items.length) {
    return (
      <div className="void">
        <h3>Нет плейлистов</h3>
      </div>
    );
  }
  return (
    <div className="ledger">
      {items.map((p) => {
        const art = artworkUrl(p.artwork_url || p.user?.avatar_url, 't300x300');
        return (
          <button key={p.id} type="button" className="cell" onClick={() => onOpen(p)}>
            <div className="cell-top">
              {art ? <img className="cell-mark" src={art} alt="" loading="lazy" /> : <div className="cell-mark" />}
            </div>
            <div className="cell-body">
              <div className="cell-title">{p.title}</div>
              <div className="cell-meta">
                {p.track_count ?? p.tracks?.length ?? 0} треков · {p.user?.username}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function LedgerUsers({ items, onOpen }: { items: SoundCloudUser[]; onOpen: (u: SoundCloudUser) => void }) {
  if (!items.length) {
    return (
      <div className="void">
        <h3>Никого не нашли</h3>
      </div>
    );
  }
  return (
    <div className="ledger">
      {items.map((u) => (
        <button key={u.id} type="button" className="cell" onClick={() => onOpen(u)}>
          <div className="cell-top">
            {u.avatar_url ? (
              <img className="cell-mark round" src={artworkUrl(u.avatar_url, 't300x300')} alt="" loading="lazy" />
            ) : (
              <div className="cell-mark round" />
            )}
          </div>
          <div className="cell-body">
            <div className="cell-title">{u.username}</div>
            <div className="cell-meta">{formatCount(u.followers_count || 0)} подписчиков</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function Settings({
  session,
  miuraProfile,
  miuraProfiles,
  onMiuraProfileState,
  clientIdInput,
  setClientIdInput,
  accent,
  setAccent,
  onLogin,
  onLogout,
  onSession,
  onSaveClientId,
  onRefreshClientId,
}: {
  session: AuthSession | null;
  miuraProfile: MiuraProfile | null;
  miuraProfiles: MiuraProfile[];
  onMiuraProfileState: (s: MiuraProfileState) => void;
  clientIdInput: string;
  setClientIdInput: (v: string) => void;
  accent: string;
  setAccent: (v: string) => void;
  onLogin: (mode?: 'app' | 'browser') => void;
  onLogout: () => void;
  onSession: (s: AuthSession) => void;
  onSaveClientId: () => void;
  onRefreshClientId: () => void;
}) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme());
  type SettingsTab = 'appearance' | 'account' | 'network' | 'discord' | 'advanced';
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance');
  const [profileName, setProfileName] = useState(miuraProfile?.displayName || '');
  const [profileBio, setProfileBio] = useState(miuraProfile?.bio || '');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  useEffect(() => {
    setProfileName(miuraProfile?.displayName || '');
    setProfileBio(miuraProfile?.bio || '');
  }, [miuraProfile?.id, miuraProfile?.displayName, miuraProfile?.bio]);

  const themeLabel = (id: AppTheme) =>
    id === 'black' ? t.settings.themeBlack : id === 'gray' ? t.settings.themeGray : t.settings.themeWhite;
  const [proxyEnabled, setProxyEnabled] = useState(true);
  const [proxyMode, setProxyMode] = useState<'sc' | 'all'>('all');
  const [proxyUrl, setProxyUrl] = useState('socks5://127.0.0.1:12334');
  const [proxyParts, setProxyParts] = useState<ProxyParts>(() =>
    parseProxyUrl('socks5://127.0.0.1:12334')
  );
  const [proxyShowAuth, setProxyShowAuth] = useState(false);
  const [proxyShowAdvanced, setProxyShowAdvanced] = useState(false);
  const [proxyFound, setProxyFound] = useState<
    Array<{ port: number; scheme: string; hint: string; url: string }>
  >([]);
  const [proxyMsg, setProxyMsg] = useState<string | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);

  const [discordEnabled, setDiscordEnabled] = useState(true);
  const [discordMsg, setDiscordMsg] = useState<string | null>(null);
  const [discordBusy, setDiscordBusy] = useState(false);
  const [discordConnected, setDiscordConnected] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await window.electronAPI?.proxyGet?.();
        if (!cfg) return;
        setProxyEnabled(cfg.enabled);
        setProxyMode(cfg.mode === 'all' ? 'all' : 'sc');
        const url = cfg.url || 'socks5://127.0.0.1:12334';
        setProxyUrl(url);
        const parts = parseProxyUrl(url);
        setProxyParts(parts);
        setProxyShowAuth(Boolean(parts.user || parts.pass));
      } catch {
        /* not electron */
      }
    })();
    void (async () => {
      try {
        const st = await window.electronAPI?.discordGet?.();
        if (!st) return;
        setDiscordEnabled(st.enabled);
        setDiscordConnected(st.connected);
        if (!st.hasPackage) {
          setDiscordMsg(t.settings.discordNoPackage);
        } else if (st.enabled && st.connected) {
          setDiscordMsg(t.settings.discordOnline);
        } else if (st.enabled) {
          setDiscordMsg(t.settings.discordWaiting);
        } else {
          setDiscordMsg(null);
        }
      } catch {
        /* not electron */
      }
    })();
  }, [t.settings.discordNoPackage, t.settings.discordOnline, t.settings.discordWaiting]);

  const syncProxyFromParts = (parts: ProxyParts) => {
    setProxyParts(parts);
    setProxyUrl(buildProxyUrl(parts));
  };

  const applyProxyUrlString = (url: string) => {
    const parts = parseProxyUrl(url);
    setProxyParts(parts);
    setProxyUrl(buildProxyUrl(parts));
    if (parts.user || parts.pass) setProxyShowAuth(true);
  };

  const saveProxy = async (opts?: { test?: boolean; url?: string; enabled?: boolean }) => {
    if (!window.electronAPI?.proxySet) {
      setProxyMsg('прокси только в electron-приложении');
      return;
    }
    const url = (opts?.url ?? buildProxyUrl(proxyParts)).trim();
    const enabled = opts?.enabled ?? proxyEnabled;
    setProxyBusy(true);
    setProxyMsg(null);
    try {
      const res = await window.electronAPI.proxySet({
        enabled,
        mode: proxyMode,
        url,
      });
      setProxyUrl(url);
      setProxyParts(parseProxyUrl(url));
      const note = res.applied?.note ? ` · ${res.applied.note}` : '';
      if (opts?.test && enabled && window.electronAPI.proxyTest) {
        const tr = await window.electronAPI.proxyTest();
        setProxyMsg(tr.message || `✓ ${res.applied?.applied || 'ok'}${note}`);
      } else {
        setProxyMsg(`✓ ${res.applied?.applied || 'ok'}${note}`);
      }
    } catch (e) {
      setProxyMsg(e instanceof Error ? e.message : 'proxy error');
    } finally {
      setProxyBusy(false);
    }
  };

  const testProxy = async () => {
    await saveProxy({ test: true });
  };

  const probeLocalProxy = async () => {
    if (!window.electronAPI?.proxyProbeLocal) {
      setProxyMsg(
        'Кнопка «Найти» недоступна: перезапусти miura (npm run dev), чтобы подтянуть Electron IPC.'
      );
      return;
    }
    setProxyBusy(true);
    setProxyMsg(null);
    setProxyFound([]);
    try {
      const res = await window.electronAPI.proxyProbeLocal();
      if (res && res.ok === false && res.error) {
        setProxyMsg(String(res.error));
        return;
      }
      const open = Array.isArray(res?.open) ? res.open : [];
      setProxyFound(open);
      if (!open.length) {
        setProxyMsg(t.settings.proxyFoundNone);
      } else {
        setProxyEnabled(true);
        applyProxyUrlString(open[0]!.url);
        setProxyMsg(t.settings.proxyFound.replace('{n}', String(open.length)));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Common when Electron was started before this feature was added
      if (/no handler|not available|invoke/i.test(msg)) {
        setProxyMsg('Нужен перезапуск приложения (старый Electron без proxy-probe).');
      } else {
        setProxyMsg(msg || 'probe failed');
      }
    } finally {
      setProxyBusy(false);
    }
  };

  const saveDiscord = async (enabled = discordEnabled) => {
    if (!window.electronAPI?.discordSetConfig) {
      setDiscordMsg(t.settings.discordElectronOnly);
      return;
    }
    setDiscordBusy(true);
    setDiscordMsg(null);
    try {
      const res = await window.electronAPI.discordSetConfig({
        enabled,
      });
      setDiscordEnabled(res.config.enabled);
      setDiscordConnected(Boolean(res.connect?.ready || res.connect?.ok));
      if (!res.config.enabled) {
        setDiscordMsg(t.settings.discordOff);
        setDiscordConnected(false);
      } else if (res.connect?.error) {
        setDiscordMsg(res.connect.error);
        setDiscordConnected(false);
      } else {
        setDiscordMsg(t.settings.discordOnline);
        setDiscordConnected(true);
      }
    } catch (e) {
      setDiscordMsg(e instanceof Error ? e.message : 'discord error');
      setDiscordConnected(false);
    } finally {
      setDiscordBusy(false);
    }
  };

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'appearance', label: t.settings.navAppearance },
    { id: 'account', label: t.settings.navAccount },
    { id: 'network', label: t.settings.navNetwork },
    { id: 'discord', label: t.settings.navDiscord },
    { id: 'advanced', label: t.settings.navAdvanced },
  ];

  return (
    <div className="settings-layout">
      <header className="settings-head">
        <h1>{t.settings.title}</h1>
        <p className="lead">{t.settings.lead}</p>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label={t.settings.title}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-nav-item ${settingsTab === tab.id ? 'on' : ''}`}
              onClick={() => setSettingsTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {settingsTab === 'appearance' && (
            <>
              <section className="settings-card">
                <h2>{t.settings.language}</h2>
                <p className="settings-desc">{t.settings.languageHint}</p>
                <div className="settings-seg">
                  {LOCALE_ORDER.map((l) => (
                    <button
                      key={l}
                      type="button"
                      className={locale === l ? 'on' : ''}
                      onClick={() => setLocale(l)}
                    >
                      {LOCALE_LABELS[l]}
                    </button>
                  ))}
                </div>
              </section>

              <section className="settings-card">
                <h2>{t.settings.theme}</h2>
                <p className="settings-desc">{t.settings.themeHint}</p>
                <div className="theme-grid">
                  {THEME_ORDER.map((id) => {
                    const mock =
                      id === 'black'
                        ? { deep: '#000', side: '#0c0c0e', main: '#121214', bar: '#1a1a1c', text: '#f5f5f7', muted: '#666', card: '#1c1c1e' }
                        : id === 'gray'
                          ? { deep: '#1c1c1e', side: '#2c2c2e', main: '#323234', bar: '#3a3a3c', text: '#f5f5f7', muted: '#8e8e93', card: '#48484a' }
                          : { deep: '#e8e8ed', side: '#ffffff', main: '#f2f2f7', bar: '#ffffff', text: '#1c1c1e', muted: '#8e8e93', card: '#ffffff' };
                    return (
                      <button
                        key={id}
                        type="button"
                        data-theme-id={id}
                        className={`theme-tile ${theme === id ? 'on' : ''}`}
                        onClick={() => {
                          setTheme(id);
                          applyAppTheme(id);
                        }}
                      >
                        <span className="theme-mock" style={{ background: mock.deep }} aria-hidden>
                          <span className="theme-mock-side" style={{ background: mock.side }}>
                            <span className="theme-mock-dot" style={{ background: accent }} />
                            <span className="theme-mock-line" style={{ background: mock.muted, opacity: 0.45 }} />
                            <span className="theme-mock-line" style={{ background: mock.muted, opacity: 0.3, width: '70%' }} />
                            <span className="theme-mock-line" style={{ background: mock.muted, opacity: 0.25, width: '55%' }} />
                          </span>
                          <span className="theme-mock-main" style={{ background: mock.main }}>
                            <span className="theme-mock-title" style={{ color: mock.text }}>
                              Aa
                            </span>
                            <span className="theme-mock-cards">
                              <span style={{ background: mock.card, border: id === 'white' ? '1px solid rgba(0,0,0,0.08)' : 'none' }} />
                              <span style={{ background: mock.card, border: id === 'white' ? '1px solid rgba(0,0,0,0.08)' : 'none' }} />
                              <span style={{ background: mock.card, border: id === 'white' ? '1px solid rgba(0,0,0,0.08)' : 'none' }} />
                            </span>
                            <span className="theme-mock-bar" style={{ background: mock.bar }}>
                              <span className="theme-mock-play" style={{ background: accent }} />
                              <span className="theme-mock-prog" style={{ background: mock.muted, opacity: 0.35 }}>
                                <span style={{ background: accent, width: '40%' }} />
                              </span>
                            </span>
                          </span>
                          {theme === id && <span className="theme-mock-check">✓</span>}
                        </span>
                        <span className="theme-tile-label">{themeLabel(id)}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="settings-card">
                <h2>{t.settings.accent}</h2>
                <p className="settings-desc">{t.settings.accentHint}</p>
                <div className="accent-picker">
                  <button
                    type="button"
                    className={`accent-opt ${isAccentWhite(accent) ? 'on' : ''}`}
                    onClick={() => {
                      setAccent(ACCENT_WHITE);
                      setThemeAccent(ACCENT_WHITE);
                    }}
                  >
                    <span className="accent-opt-swatch accent-opt-swatch-white" />
                    <span>{t.settings.accentWhite}</span>
                  </button>
                  <label
                    className={`accent-opt ${!isAccentWhite(accent) ? 'on' : ''}`}
                  >
                    <span
                      className="accent-opt-swatch"
                      style={{ background: isAccentWhite(accent) ? '#c23a2b' : accent }}
                    />
                    <span>{t.settings.accentCustom}</span>
                    <input
                      className="accent-opt-input"
                      type="color"
                      value={isAccentWhite(accent) ? '#c23a2b' : accent}
                      onChange={(e) => {
                        const v = e.target.value.toLowerCase();
                        // never store pure #ffffff — map to soft white
                        const next = v === '#ffffff' || v === '#fff' ? ACCENT_WHITE : v;
                        setAccent(next);
                        setThemeAccent(next);
                      }}
                    />
                  </label>
                  {!isAccentWhite(accent) && <span className="hex">{accent}</span>}
                </div>
              </section>
            </>
          )}

          {settingsTab === 'account' && (
            <>
              <section className="settings-card">
                <h2>{t.settings.miuraProfile}</h2>
                <p className="settings-desc">{t.settings.miuraProfileHint}</p>
                {miuraProfile && (
                  <>
                    <div className="settings-user">
                      {miuraProfile.avatarUrl ? (
                        <img src={miuraProfile.avatarUrl} alt="" className="settings-user-av" />
                      ) : (
                        <div className="settings-user-av ph">{profileInitials(miuraProfile.displayName)}</div>
                      )}
                      <div>
                        <div className="settings-user-name">
                          <strong>{miuraProfile.displayName}</strong>
                        </div>
                        <div className="settings-user-sub" style={{ color: 'var(--ink-3)' }}>
                          {t.profile.localOnly}
                        </div>
                      </div>
                    </div>
                    <label className="settings-field-label" htmlFor="miura-edit-name">
                      {t.profile.name}
                    </label>
                    <input
                      id="miura-edit-name"
                      type="text"
                      value={profileName}
                      maxLength={48}
                      onChange={(e) => setProfileName(e.target.value)}
                      disabled={profileBusy}
                    />
                    <label className="settings-field-label" htmlFor="miura-edit-bio">
                      {t.profile.bio}
                    </label>
                    <textarea
                      id="miura-edit-bio"
                      className="miura-profile-textarea"
                      value={profileBio}
                      maxLength={160}
                      rows={2}
                      placeholder={t.profile.bioPlaceholder}
                      onChange={(e) => setProfileBio(e.target.value)}
                      disabled={profileBusy}
                    />
                    <div className="row-btns" style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="btn"
                        disabled={profileBusy}
                        onClick={() => {
                          void (async () => {
                            setProfileBusy(true);
                            setProfileMsg(null);
                            try {
                              const picked = await pickProfileAvatar();
                              if (picked.canceled || !picked.path) return;
                              const state = await updateProfile({
                                id: miuraProfile.id,
                                avatarPath: picked.path,
                              });
                              onMiuraProfileState(state);
                              setProfileMsg('ok');
                            } catch (e) {
                              setProfileMsg(e instanceof Error ? e.message : String(e));
                            } finally {
                              setProfileBusy(false);
                            }
                          })();
                        }}
                      >
                        {t.profile.pickAvatar}
                      </button>
                      <button
                        type="button"
                        className="btn solid"
                        disabled={profileBusy || !profileName.trim()}
                        onClick={() => {
                          void (async () => {
                            setProfileBusy(true);
                            setProfileMsg(null);
                            try {
                              const state = await updateProfile({
                                id: miuraProfile.id,
                                displayName: profileName.trim(),
                                bio: profileBio.trim().slice(0, 160),
                              });
                              onMiuraProfileState(state);
                              setProfileMsg('ok');
                            } catch (e) {
                              setProfileMsg(e instanceof Error ? e.message : String(e));
                            } finally {
                              setProfileBusy(false);
                            }
                          })();
                        }}
                      >
                        {t.profile.save}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={profileBusy}
                        onClick={() => {
                          void (async () => {
                            setProfileBusy(true);
                            try {
                              const state = await logoutProfile();
                              onMiuraProfileState(state);
                            } catch (e) {
                              setProfileMsg(e instanceof Error ? e.message : String(e));
                            } finally {
                              setProfileBusy(false);
                            }
                          })();
                        }}
                      >
                        {t.profile.switch}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={profileBusy}
                        onClick={() => {
                          if (!window.confirm(t.profile.deleteConfirm)) return;
                          void (async () => {
                            setProfileBusy(true);
                            try {
                              const state = await deleteProfile(miuraProfile.id);
                              onMiuraProfileState(state);
                            } catch (e) {
                              setProfileMsg(e instanceof Error ? e.message : String(e));
                            } finally {
                              setProfileBusy(false);
                            }
                          })();
                        }}
                      >
                        {t.profile.delete}
                      </button>
                    </div>
                    {profileMsg && profileMsg !== 'ok' && (
                      <p className="note" style={{ marginTop: 10, color: 'var(--danger, #c44)' }}>
                        {profileMsg}
                      </p>
                    )}
                    {miuraProfiles.length > 1 && (
                      <p className="note" style={{ marginTop: 10 }}>
                        {t.profile.switch}: {miuraProfiles.map((p) => p.displayName).join(' · ')}
                      </p>
                    )}
                  </>
                )}
              </section>

              <section className="settings-card">
                <h2>{t.settings.account}</h2>
                <p className="settings-desc">{t.settings.accountHint}</p>
                {session?.user ? (
                  <>
                    <div className="settings-user">
                      {session.user.avatar_url ? (
                        <img
                          src={artworkUrl(session.user.avatar_url, 't67x67')}
                          alt=""
                          className="settings-user-av"
                        />
                      ) : (
                        <div className="settings-user-av ph">@</div>
                      )}
                      <div>
                        <div className="settings-user-name">
                          {t.settings.loggedInAs}{' '}
                          <strong>{session.user.username}</strong>
                        </div>
                        {session.user.subscription_label && (
                          <div
                            className="settings-user-sub"
                            style={{
                              color:
                                session.user.subscription_tier === 'go_plus' ||
                                session.user.subscription_tier === 'go'
                                  ? 'var(--accent)'
                                  : 'var(--ink-3)',
                            }}
                          >
                            {session.user.subscription_label}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="row-btns">
                      <button type="button" className="btn solid" onClick={() => onLogin()}>
                        {t.settings.signInAgain}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          void (async () => {
                            try {
                              const sub = await refreshSubscription();
                              onSession({
                                ...session,
                                user: session.user
                                  ? {
                                      ...session.user,
                                      subscription_tier: sub.tier,
                                      subscription_label: sub.label,
                                    }
                                  : session.user,
                              });
                            } catch {
                              /* ignore */
                            }
                          })();
                        }}
                      >
                        {t.settings.checkGoPlus}
                      </button>
                      <button type="button" className="btn" onClick={onLogout}>
                        {t.common.logout}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3 className="settings-subh">{t.settings.signInTitle}</h3>
                    <p className="settings-desc">{t.settings.signInBody}</p>
                    <div className="row-btns">
                      <button type="button" className="btn solid" onClick={() => onLogin()}>
                        {t.settings.signInBtn}
                      </button>
                    </div>
                    <p className="note" style={{ marginTop: 14 }}>
                      {t.settings.signInSteps}
                    </p>
                    <details className="settings-details">
                      <summary>{t.settings.fallbackLogin}</summary>
                      <TokenImport
                        clientIdHint={clientIdInput}
                        onBrowserLogin={() => onLogin('browser')}
                        onDone={(s) => {
                          onSession(s);
                        }}
                      />
                    </details>
                  </>
                )}
              </section>
            </>
          )}

          {settingsTab === 'network' && (
            <section className="settings-card proxy-card">
              <h2>{t.settings.proxyTitle}</h2>
              <p className="settings-desc">{t.settings.proxyHint}</p>

              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={proxyEnabled}
                  onChange={(e) => setProxyEnabled(e.target.checked)}
                />
                <span>{t.settings.proxyEnable}</span>
              </label>

              {/* Presets + Find always clickable (even if proxy toggle is off) */}
              <div className="proxy-quick">
                <p className="settings-field-label">{t.settings.proxyPresets}</p>
                <div className="proxy-presets">
                  {PROXY_PRESETS.map((pr) => {
                    const active = matchPresetId(proxyUrl) === pr.id;
                    const label =
                      (t.settings as unknown as Record<string, string>)[pr.labelKey] || pr.label;
                    return (
                      <button
                        key={pr.id}
                        type="button"
                        className={`chip ${active ? 'on' : ''}`}
                        disabled={proxyBusy}
                        onClick={() => {
                          const parts: ProxyParts = {
                            scheme: pr.scheme,
                            host: pr.host,
                            port: pr.port,
                            user: proxyParts.user,
                            pass: proxyParts.pass,
                          };
                          syncProxyFromParts(parts);
                          setProxyEnabled(true);
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                <div className="row-btns" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn solid"
                    disabled={proxyBusy}
                    onClick={() => void probeLocalProxy()}
                  >
                    {proxyBusy ? '…' : t.settings.proxyFindLocal}
                  </button>
                </div>

                {proxyFound.length > 0 && (
                  <div className="proxy-found">
                    {proxyFound.map((f) => (
                      <button
                        key={`${f.scheme}:${f.port}`}
                        type="button"
                        className="chip"
                        disabled={proxyBusy}
                        onClick={() => {
                          applyProxyUrlString(f.url);
                          setProxyEnabled(true);
                        }}
                      >
                        {f.scheme} :{f.port}
                        <span className="proxy-found-hint"> · {f.hint}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className={`proxy-form ${proxyEnabled ? '' : 'is-disabled'}`}>
                <div className="proxy-connect">
                  <div className="proxy-connect-head">
                    <span className="proxy-connect-title">{t.settings.proxyProtocol}</span>
                    <div className="proxy-proto" role="group" aria-label={t.settings.proxyProtocol}>
                      {(['socks5', 'socks4', 'http', 'https'] as ProxyScheme[]).map((sch) => (
                        <button
                          key={sch}
                          type="button"
                          className={proxyParts.scheme === sch ? 'on' : ''}
                          disabled={!proxyEnabled}
                          onClick={() => syncProxyFromParts({ ...proxyParts, scheme: sch })}
                        >
                          {sch}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="proxy-connect-grid">
                    <label className="proxy-input proxy-input-host">
                      <span className="proxy-input-label">{t.settings.proxyHost}</span>
                      <span className="proxy-input-box">
                        <span className="proxy-input-ico" aria-hidden>
                          ⌂
                        </span>
                        <input
                          type="text"
                          value={proxyParts.host}
                          disabled={!proxyEnabled}
                          spellCheck={false}
                          placeholder="127.0.0.1"
                          onChange={(e) =>
                            syncProxyFromParts({ ...proxyParts, host: e.target.value })
                          }
                        />
                      </span>
                    </label>
                    <label className="proxy-input proxy-input-port">
                      <span className="proxy-input-label">{t.settings.proxyPort}</span>
                      <span className="proxy-input-box">
                        <span className="proxy-input-ico" aria-hidden>
                          #
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={proxyParts.port}
                          disabled={!proxyEnabled}
                          spellCheck={false}
                          placeholder="7890"
                          onChange={(e) =>
                            syncProxyFromParts({
                              ...proxyParts,
                              port: e.target.value.replace(/[^\d]/g, '').slice(0, 5),
                            })
                          }
                        />
                      </span>
                    </label>
                  </div>

                  <button
                    type="button"
                    className={`proxy-auth-toggle ${proxyShowAuth ? 'open' : ''}`}
                    disabled={!proxyEnabled}
                    onClick={() => setProxyShowAuth((v) => !v)}
                  >
                    <span>{t.settings.proxyAuth}</span>
                    <span className="proxy-auth-chevron" aria-hidden>
                      {proxyShowAuth ? '▴' : '▾'}
                    </span>
                  </button>

                  {proxyShowAuth && (
                    <div className="proxy-connect-grid proxy-auth-grid">
                      <label className="proxy-input">
                        <span className="proxy-input-label">{t.settings.proxyUser}</span>
                        <span className="proxy-input-box">
                          <span className="proxy-input-ico" aria-hidden>
                            @
                          </span>
                          <input
                            type="text"
                            value={proxyParts.user}
                            disabled={!proxyEnabled}
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="user"
                            onChange={(e) =>
                              syncProxyFromParts({ ...proxyParts, user: e.target.value })
                            }
                          />
                        </span>
                      </label>
                      <label className="proxy-input">
                        <span className="proxy-input-label">{t.settings.proxyPass}</span>
                        <span className="proxy-input-box">
                          <span className="proxy-input-ico" aria-hidden>
                            •
                          </span>
                          <input
                            type="password"
                            value={proxyParts.pass}
                            disabled={!proxyEnabled}
                            spellCheck={false}
                            autoComplete="new-password"
                            placeholder="••••••••"
                            onChange={(e) =>
                              syncProxyFromParts({ ...proxyParts, pass: e.target.value })
                            }
                          />
                        </span>
                      </label>
                    </div>
                  )}

                  <div className="proxy-mode-block">
                    <span className="proxy-input-label">{t.settings.proxyMode}</span>
                    <div className="proxy-mode-seg">
                      <button
                        type="button"
                        className={proxyMode === 'sc' ? 'on' : ''}
                        onClick={() => setProxyMode('sc')}
                        disabled={!proxyEnabled}
                      >
                        {t.settings.proxyModeSc}
                      </button>
                      <button
                        type="button"
                        className={proxyMode === 'all' ? 'on' : ''}
                        onClick={() => setProxyMode('all')}
                        disabled={!proxyEnabled}
                      >
                        {t.settings.proxyModeAll}
                      </button>
                    </div>
                  </div>

                  <div className="proxy-preview-bar">
                    <span className="proxy-preview-label">{t.settings.proxyPreview}</span>
                    <code className="proxy-preview-code" title={buildProxyUrl(proxyParts)}>
                      {buildProxyUrl(proxyParts)}
                    </code>
                  </div>
                </div>

                <div className="row-btns" style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className="btn solid"
                    onClick={() => void saveProxy({ test: true })}
                    disabled={proxyBusy}
                  >
                    {proxyBusy ? '…' : t.settings.proxySaveTest}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void saveProxy()}
                    disabled={proxyBusy}
                  >
                    {t.settings.proxySave}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void testProxy()}
                    disabled={proxyBusy || !proxyEnabled}
                  >
                    {t.settings.proxyTest}
                  </button>
                </div>

                <button
                  type="button"
                  className="proxy-toggle-link"
                  disabled={!proxyEnabled}
                  onClick={() => setProxyShowAdvanced((v) => !v)}
                >
                  {t.settings.proxyAdvanced}
                  {proxyShowAdvanced ? ' ▴' : ' ▾'}
                </button>
                {proxyShowAdvanced && (
                  <>
                    <label className="settings-field-label">{t.settings.proxyUrl}</label>
                    <input
                      type="text"
                      value={proxyUrl}
                      disabled={!proxyEnabled}
                      spellCheck={false}
                      placeholder="socks5://127.0.0.1:12334"
                      onChange={(e) => applyProxyUrlString(e.target.value)}
                    />
                    <p className="settings-hint">{t.settings.proxyExamples}</p>
                  </>
                )}
              </div>

              {proxyMsg && (
                <p className="note" style={{ marginTop: 12 }}>
                  {proxyMsg}
                </p>
              )}
            </section>
          )}

          {settingsTab === 'discord' && (
            <section className="settings-card">
              <h2>{t.settings.discordTitle}</h2>
              <p className="settings-desc">{t.settings.discordHint}</p>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={discordEnabled}
                  disabled={discordBusy}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setDiscordEnabled(on);
                    void saveDiscord(on);
                  }}
                />
                <span>
                  {t.settings.discordEnable}
                  {discordConnected && (
                    <span className="settings-online"> · {t.settings.discordOnline}</span>
                  )}
                </span>
              </label>
              <p className="settings-desc" style={{ marginTop: 12 }}>
                {t.settings.discordBuiltin}
              </p>
              {discordMsg && (
                <p className="note" style={{ marginTop: 12 }}>
                  {discordMsg}
                </p>
              )}
            </section>
          )}

          {settingsTab === 'advanced' && (
            <>
              <section className="settings-card">
                <h2>{t.settings.clientId}</h2>
                <p className="settings-desc">{t.settings.clientIdHint}</p>
                <input
                  type="text"
                  value={clientIdInput}
                  onChange={(e) => setClientIdInput(e.target.value)}
                  spellCheck={false}
                />
                <div className="row-btns" style={{ marginTop: 14 }}>
                  <button type="button" className="btn solid" onClick={onSaveClientId}>
                    {t.settings.clientIdSave}
                  </button>
                  <button type="button" className="btn" onClick={onRefreshClientId}>
                    {t.settings.clientIdAuto}
                  </button>
                </div>
              </section>
              <section className="settings-card">
                <h2>{t.settings.about}</h2>
                <p className="settings-desc">{t.settings.aboutText}</p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerBar({
  player,
  onLike,
  onStation,
  onOpenTrack,
  onOpenUser,
  onOpenQueue,
  onToggleFav,
  isFav,
}: {
  player: ReturnType<typeof usePlayer>;
  onLike: () => void;
  onStation: () => void;
  onOpenTrack?: () => void;
  onOpenUser?: () => void;
  onOpenQueue?: () => void;
  onToggleFav?: () => void;
  isFav?: boolean;
}) {
  const {
    current,
    state,
    progress,
    duration,
    volume,
    isMuted,
    toggle,
    playNext,
    playPrev,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    shuffle,
    repeat,
    error,
    likedIds,
    stationMode,
  } = player;

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const pct = safeDuration ? (progress / safeDuration) * 100 : 0;
  const liked = current ? likedIds.has(current.id) || current.user_favorite : false;
  const art = current
    ? artworkUrl(current.artwork_url || current.user?.avatar_url, 't67x67')
    : '';

  const artNode = art ? (
    <img className="bar-art" src={art} alt="" draggable={false} />
  ) : (
    <div className="bar-art ph" aria-hidden>
      ♪
    </div>
  );

  const errText = error ? String(error) : '';
  const errView = errText
    ? (() => {
        if (/таймаут|timeout/i.test(errText)) {
          return {
            title: 'YouTube: таймаут',
            detail: 'Проверь SOCKS «весь трафик» и нажми play ещё раз.',
          };
        }
        if (/формат|не открылся|не поддерживается/i.test(errText)) {
          return {
            title: 'YouTube: поток не открылся',
            detail: 'Попробуй ещё раз или другой трек.',
          };
        }
        if (/бот|LOGIN_REQUIRED|блокирует/i.test(errText)) {
          return {
            title: 'YouTube: бот-проверка',
            detail: 'Нужен живой прокси (весь трафик) и перезапуск miura.',
          };
        }
        if (/сеть|прокси|403/i.test(errText)) {
          return {
            title: 'YouTube: сеть',
            detail: 'SOCKS не достучался до потока. Проверь VPN/прокси.',
          };
        }
        // One short line for the bar; full text in title tooltip
        const one = errText.replace(/\s+/g, ' ').trim();
        return {
          title: 'Ошибка воспроизведения',
          detail: one.length > 140 ? `${one.slice(0, 140)}…` : one,
        };
      })()
    : null;
  const subline = state === 'loading'
    ? 'загрузка…'
    : stationMode
      ? `станция · ${current?.user?.username ?? ''}`
      : current?.user?.username ?? '—';

  return (
    <footer className={`bar ${state === 'playing' ? 'is-playing' : ''} ${errView ? 'has-error' : ''}`}>
      {errView ? (
        <div className="bar-error-banner" role="alert" title={errText}>
          <div className="bar-error-title">{errView.title}</div>
          <div className="bar-error-detail">{errView.detail}</div>
        </div>
      ) : null}
      <div className="bar-now">
        {current && onOpenTrack ? (
          <button type="button" className="bar-art-btn" onClick={onOpenTrack} title="Открыть трек">
            <span className={`bar-art-ring ${state === 'playing' ? 'on' : ''}`}>{artNode}</span>
          </button>
        ) : (
          <span className={`bar-art-ring ${state === 'playing' ? 'on' : ''}`}>{artNode}</span>
        )}
        <div className="bar-now-text">
          {current && onOpenTrack ? (
            <button type="button" className="tt btn-like" onClick={onOpenTrack} title="Открыть трек">
              {current.title}
              <SourceBadge track={current} />
              {isGoPlusOnlyTrack(current) ? <GoPlusBadge /> : null}
            </button>
          ) : (
            <div className="tt">
              {current?.title ?? 'Ничего не играет'}
              {current && isGoPlusOnlyTrack(current) ? <GoPlusBadge /> : null}
            </div>
          )}
          {current?.user && onOpenUser ? (
            <button type="button" className="aa btn-like" onClick={onOpenUser}>
              {subline}
            </button>
          ) : (
            <div className="aa">{subline}</div>
          )}
        </div>
        {state === 'playing' && (
          <span className="bar-eq" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
      </div>

      <div className="bar-mid">
        <div className="bar-ctrls">
          <button
            type="button"
            className={`ico-btn ${shuffle ? 'on' : ''}`}
            onClick={toggleShuffle}
            title={shuffle ? 'Перемешивание вкл' : 'Перемешивание выкл'}
            aria-label="shuffle"
          >
            <IconShuffle />
          </button>
          <button
            type="button"
            className="ico-btn"
            onClick={playPrev}
            disabled={!current}
            title="Назад"
            aria-label="previous"
          >
            <IconPrev />
          </button>
          <button
            type="button"
            className="ico-btn main"
            onClick={toggle}
            disabled={!current || state === 'loading'}
            title={state === 'playing' ? 'Пауза' : 'Играть'}
            aria-label="play pause"
          >
            {state === 'loading' ? <IconSpinner /> : state === 'playing' ? <IconPause /> : <IconPlay />}
          </button>
          <button
            type="button"
            className="ico-btn"
            onClick={playNext}
            disabled={!current}
            title="Далее"
            aria-label="next"
          >
            <IconNext />
          </button>
          <button
            type="button"
            className={`ico-btn repeat-btn mode-${repeat}${repeat !== 'off' ? ' on' : ''}`}
            onClick={cycleRepeat}
            title={
              repeat === 'off'
                ? 'Повтор: выкл (нажми — очередь)'
                : repeat === 'all'
                  ? 'Повтор: вся очередь (нажми — один трек)'
                  : 'Повтор: один трек (нажми — выкл)'
            }
            aria-label={
              repeat === 'off'
                ? 'repeat off'
                : repeat === 'all'
                  ? 'repeat queue'
                  : 'repeat one'
            }
            aria-pressed={repeat !== 'off'}
          >
            <IconRepeat mode={repeat} />
          </button>
        </div>
        <div className="seek">
          <span>{formatDuration(progress * 1000)}</span>
          <input
            className="slider"
            type="range"
            min={0}
            max={safeDuration || 0}
            step={0.1}
            value={safeDuration ? Math.min(progress, safeDuration) : 0}
            onChange={(e) => seek(Number(e.target.value))}
            disabled={!current}
            style={{
              background: `linear-gradient(to right, var(--accent) ${pct}%, var(--line-2) ${pct}%)`,
            }}
          />
          <span>{formatDuration(safeDuration * 1000)}</span>
        </div>
      </div>

      <div className="bar-end">
        {current && (
          <button
            type="button"
            className={`ico-btn ${stationMode ? 'on' : ''}`}
            onClick={onStation}
            title="Станция по треку"
            aria-label="station"
          >
            <IconRadio />
          </button>
        )}
        {current && (
          <button
            type="button"
            className={`ico-btn ${liked ? 'on' : ''}`}
            onClick={onLike}
            title="Лайк SC"
            aria-label="like"
          >
            <IconHeart filled={liked} />
          </button>
        )}
        {current && onToggleFav && (
          <button
            type="button"
            className={`ico-btn ${isFav ? 'on' : ''}`}
            onClick={onToggleFav}
            title="Избранное miura"
            aria-label="favorite"
          >
            {isFav ? '★' : '☆'}
          </button>
        )}
        {onOpenQueue && (
          <button type="button" className="ico-btn" onClick={onOpenQueue} title="Очередь" aria-label="queue">
            <IconQueue />
          </button>
        )}
        <button
          type="button"
          className="ico-btn"
          onClick={toggleMute}
          title={isMuted || volume === 0 ? 'Звук' : 'Без звука'}
          aria-label="volume"
        >
          {isMuted || volume === 0 ? <IconMute /> : <IconVol />}
        </button>
        <input
          className="slider vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={isMuted ? 0 : volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          style={{
            background: `linear-gradient(to right, var(--accent) ${(isMuted ? 0 : volume) * 100}%, var(--line-2) ${(isMuted ? 0 : volume) * 100}%)`,
          }}
        />
      </div>
    </footer>
  );
}
