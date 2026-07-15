import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { extendStation, getStreamInfo } from '../api/soundcloud';
import type { StreamInfo } from '../api/soundcloud';
import type { PlaybackState, Track } from '../types';
import type { Playable } from '../player/types';
import {
  getPlayable,
  getPlayableResolver,
  playableToTrack,
  registerPlayableResolver,
} from '../player/playableBridge';
import { resolveYouTubeStreamUrl } from '../sources/youtube';

export type RepeatMode = 'off' | 'all' | 'one';

const PLAYER_STORAGE_KEY = 'miura_player_v1';
const PLAYER_STORAGE_LEGACY = ['cloudplay_player_v1', 'miu_player_v1'];
const MAX_SAVED_QUEUE = 80;

type PersistedPlayer = {
  v: 1;
  volume: number;
  isMuted: boolean;
  progress: number;
  current: Track | null;
  queue: Track[];
  shuffle?: boolean;
  repeat?: RepeatMode;
};

function slimTrack(t: Track): Track {
  return {
    id: t.id,
    title: t.title,
    permalink_url: t.permalink_url,
    artwork_url: t.artwork_url,
    duration: t.duration,
    genre: t.genre ?? null,
    playback_count: t.playback_count ?? 0,
    likes_count: t.likes_count ?? 0,
    user: t.user,
    media: t.media,
    streamable: t.streamable,
    track_authorization: t.track_authorization,
    policy: t.policy,
    monetization_model: t.monetization_model,
    user_favorite: t.user_favorite,
    waveform_url: t.waveform_url,
  };
}

function loadPersistedPlayer(): PersistedPlayer | null {
  try {
    let raw = localStorage.getItem(PLAYER_STORAGE_KEY);
    if (!raw) {
      for (const k of PLAYER_STORAGE_LEGACY) {
        raw = localStorage.getItem(k);
        if (raw) {
          try {
            localStorage.setItem(PLAYER_STORAGE_KEY, raw);
          } catch {
            /* ignore */
          }
          break;
        }
      }
    }
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PersistedPlayer>;
    if (!data || typeof data !== 'object') return null;
    const volume =
      typeof data.volume === 'number' && Number.isFinite(data.volume)
        ? Math.min(1, Math.max(0, data.volume))
        : 0.85;
    const queue = Array.isArray(data.queue)
      ? data.queue.filter((t): t is Track => Boolean(t && typeof t.id === 'number' && t.title))
      : [];
    const current =
      data.current && typeof data.current.id === 'number' && data.current.title
        ? (data.current as Track)
        : null;
    const repeatRaw = data.repeat;
    const repeat: RepeatMode =
      repeatRaw === 'all' || repeatRaw === 'one' || repeatRaw === 'off' ? repeatRaw : 'off';
    return {
      v: 1,
      volume,
      isMuted: Boolean(data.isMuted),
      progress:
        typeof data.progress === 'number' && Number.isFinite(data.progress) && data.progress >= 0
          ? data.progress
          : 0,
      current,
      queue,
      shuffle: Boolean(data.shuffle),
      repeat,
    };
  } catch {
    return null;
  }
}

function savePersistedPlayer(data: PersistedPlayer) {
  try {
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota / private mode */
  }
}

/**
 * Shuffle bag: no track repeats until every track in the queue has played once.
 * After a full cycle, the bag resets and a new random order starts
 * (current track is avoided as the first pick of the new cycle when possible).
 */
function pickShuffleNext(
  q: Track[],
  currentId: number,
  played: Set<number>
): Track | null {
  if (!q.length) return null;

  // Drop ids that left the queue
  const qIds = new Set(q.map((t) => t.id));
  for (const id of [...played]) {
    if (!qIds.has(id)) played.delete(id);
  }

  // Current should count as already heard this cycle
  played.add(currentId);

  let pool = q.filter((t) => !played.has(t.id));

  // Full circle complete → new cycle
  if (!pool.length) {
    played.clear();
    played.add(currentId);
    pool = q.filter((t) => t.id !== currentId);
    // Single-track queue
    if (!pool.length) {
      const only = q.find((t) => t.id === currentId) ?? q[0] ?? null;
      return only;
    }
  }

  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

/** Random among remaining when station extends etc. — prefer unplayed. */
function pickRandomOther(q: Track[], currentId: number): Track | null {
  const others = q.filter((t) => t.id !== currentId);
  if (!others.length) return null;
  return others[Math.floor(Math.random() * others.length)] ?? null;
}

type LoadOpts = {
  autoplay?: boolean;
  startAt?: number;
  /** When restoring session, don't auto-skip to next on failure */
  skipOnFail?: boolean;
};

export function usePlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const queueRef = useRef<Track[]>([]);
  const currentRef = useRef<Track | null>(null);
  const loadAndPlayRef = useRef<(track: Track, opts?: LoadOpts) => Promise<void>>(async () => {});
  const stationModeRef = useRef(false);
  const extendingRef = useRef(false);
  const skipFailCountRef = useRef(0);
  const volumeRef = useRef(0.85);
  const mutedRef = useRef(false);
  const progressRef = useRef(0);
  const restoredRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  /** Seconds to seek after a deferred stream load (session restore). */
  const pendingSeekRef = useRef(0);
  /** Track id whose stream is currently attached to <audio>. */
  const streamLoadedForIdRef = useRef<number | null>(null);
  /** blob: URL for local files — revoke on next load */
  const localBlobUrlRef = useRef<string | null>(null);

  const revokeLocalBlob = () => {
    if (localBlobUrlRef.current) {
      try {
        URL.revokeObjectURL(localBlobUrlRef.current);
      } catch {
        /* ignore */
      }
      localBlobUrlRef.current = null;
    }
  };

  const initial = useRef(loadPersistedPlayer()).current;
  const initialProgress =
    initial?.current && typeof initial.progress === 'number' && initial.progress > 2
      ? initial.progress
      : 0;

  // IMPORTANT: init shuffle/repeat refs once from storage — never re-assign from
  // `initial` on every render (that wiped toggles after the first progress tick).
  const shuffleRef = useRef(Boolean(initial?.shuffle));
  const repeatRef = useRef<RepeatMode>(initial?.repeat ?? 'off');
  /** Track ids already played in the current shuffle cycle (no repeats until full pass). */
  const shufflePlayedRef = useRef<Set<number>>(new Set());
  /** Ordered history for shuffle "previous". */
  const shuffleStackRef = useRef<number[]>([]);

  const [queue, setQueue] = useState<Track[]>(() => initial?.queue ?? []);
  const [current, setCurrent] = useState<Track | null>(() => initial?.current ?? null);
  const [state, setState] = useState<PlaybackState>(() => (initial?.current ? 'paused' : 'idle'));
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(() => initialProgress);
  const [duration, setDuration] = useState(() =>
    initial?.current?.duration ? initial.current.duration / 1000 : 0
  );
  const [volume, setVolumeState] = useState(() => initial?.volume ?? 0.85);
  const [isMuted, setIsMuted] = useState(() => initial?.isMuted ?? false);
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  const [stationMode, setStationMode] = useState(false);
  const [stationSeed, setStationSeed] = useState<Track | null>(null);
  const [shuffle, setShuffle] = useState(() => Boolean(initial?.shuffle));
  const [repeat, setRepeat] = useState<RepeatMode>(() => initial?.repeat ?? 'off');

  // Seed pending seek once from last session (before first play loads stream)
  if (!restoredRef.current && initialProgress > 0 && pendingSeekRef.current === 0) {
    pendingSeekRef.current = initialProgress;
    progressRef.current = initialProgress;
  }

  volumeRef.current = volume;
  mutedRef.current = isMuted;
  progressRef.current = progress;

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);
  useEffect(() => {
    stationModeRef.current = stationMode;
  }, [stationMode]);
  useEffect(() => {
    shuffleRef.current = shuffle;
  }, [shuffle]);
  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);

  const persistNow = useCallback(() => {
    const cur = currentRef.current;
    const q = queueRef.current;
    savePersistedPlayer({
      v: 1,
      volume: volumeRef.current,
      isMuted: mutedRef.current,
      progress: progressRef.current,
      current: cur ? slimTrack(cur) : null,
      queue: q.slice(0, MAX_SAVED_QUEUE).map(slimTrack),
      shuffle: shuffleRef.current,
      repeat: repeatRef.current,
    });
  }, []);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persistNow();
    }, 400);
  }, [persistNow]);

  const destroyHls = () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  };

  const appendUnique = useCallback((tracks: Track[]) => {
    setQueue((q) => {
      const ids = new Set(q.map((t) => t.id));
      const add = tracks.filter((t) => t?.id && t.title && !ids.has(t.id));
      if (!add.length) return q;
      const next = [...q, ...add];
      queueRef.current = next;
      return next;
    });
  }, []);

  const maybeExtendStation = useCallback(
    async (from: Track) => {
      if (!stationModeRef.current || extendingRef.current) return;
      const q = queueRef.current;
      const idx = q.findIndex((t) => t.id === from.id);
      const remaining = idx >= 0 ? q.length - idx - 1 : 0;
      if (remaining > 4) return;
      extendingRef.current = true;
      try {
        const exclude = new Set(q.map((t) => t.id));
        const more = await extendStation(from, exclude, 24);
        if (more.length) appendUnique(more);
      } finally {
        extendingRef.current = false;
      }
    },
    [appendUnique]
  );

  const resetShuffleBag = useCallback((seedId?: number | null) => {
    shufflePlayedRef.current = new Set();
    shuffleStackRef.current = [];
    if (seedId != null) {
      shufflePlayedRef.current.add(seedId);
      shuffleStackRef.current.push(seedId);
    }
  }, []);

  const markShufflePlayed = useCallback((trackId: number) => {
    if (!shuffleRef.current) return;
    if (!shufflePlayedRef.current.has(trackId)) {
      shufflePlayedRef.current.add(trackId);
      shuffleStackRef.current.push(trackId);
    }
  }, []);

  const resolveNext = useCallback((fromEnded: boolean): Track | null => {
    const q = queueRef.current;
    const cur = currentRef.current;
    if (!q.length || !cur) return null;
    if (fromEnded && repeatRef.current === 'one') return cur;
    if (shuffleRef.current) {
      const rnd = pickShuffleNext(q, cur.id, shufflePlayedRef.current);
      if (rnd) return rnd;
      // Only one track / nothing left
      if (repeatRef.current === 'all' || repeatRef.current === 'one') return cur;
      return null;
    }
    const idx = q.findIndex((t) => t.id === cur.id);
    const next = q[idx + 1];
    if (next) return next;
    if (stationModeRef.current) return null;
    if (repeatRef.current === 'all') return q[0] ?? null;
    return null;
  }, []);

  const attachStream = useCallback(async (audio: HTMLAudioElement, stream: StreamInfo) => {
    destroyHls();
    audio.pause();
    // Drop previous local blob so memory doesn't leak across tracks
    if (localBlobUrlRef.current && stream.url !== localBlobUrlRef.current) {
      revokeLocalBlob();
    }
    audio.removeAttribute('src');
    try {
      audio.load();
    } catch {
      /* ignore */
    }

    const isHls = stream.protocol === 'hls' || stream.url.includes('.m3u8');

    if (isHls) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: false,
          lowLatencyMode: false,
          maxBufferLength: 30,
          fragLoadingMaxRetry: 4,
          manifestLoadingMaxRetry: 3,
        });
        hlsRef.current = hls;
        hls.loadSource(stream.url);
        hls.attachMedia(audio);
        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(() => reject(new Error('HLS timeout')), 20000);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            window.clearTimeout(t);
            resolve();
          });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            window.clearTimeout(t);
            reject(new Error(`HLS: ${data.details || data.type || 'fatal'}`));
          });
        });
      } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = stream.url;
      } else {
        throw new Error('HLS не поддерживается');
      }
    } else {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          cleanup();
          reject(new Error('Таймаут загрузки аудио'));
        }, 20000);
        const cleanup = () => {
          window.clearTimeout(timer);
          audio.removeEventListener('canplay', onOk);
          audio.removeEventListener('loadeddata', onOk);
          audio.removeEventListener('error', onErr);
        };
        const onOk = () => {
          cleanup();
          resolve();
        };
        const onErr = () => {
          cleanup();
          const code = audio.error?.code;
          const msg =
            code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
              ? 'Формат не поддерживается (лучше MP3, M4A, FLAC, WAV, OGG). WMA — нет.'
              : code === MediaError.MEDIA_ERR_NETWORK
                ? 'Не удалось прочитать файл (путь / права / miura-file).'
                : 'Ошибка загрузки аудио';
          reject(new Error(msg));
        };
        audio.addEventListener('canplay', onOk, { once: true });
        audio.addEventListener('loadeddata', onOk, { once: true });
        audio.addEventListener('error', onErr, { once: true });
        audio.src = stream.url;
        try {
          audio.load();
        } catch (e) {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    }
  }, []);

  const loadAndPlay = useCallback(
    async (track: Track, opts?: LoadOpts) => {
      const audio = audioRef.current;
      if (!audio) return;

      const autoplay = opts?.autoplay !== false;
      const skipOnFail = opts?.skipOnFail !== false;
      const startAt = opts?.startAt;

      currentRef.current = track;
      setCurrent(track);
      setState('loading');
      setError(null);
      setProgress(typeof startAt === 'number' && startAt > 0 ? startAt : 0);
      progressRef.current = typeof startAt === 'number' && startAt > 0 ? startAt : 0;
      setDuration(track.duration / 1000 || 0);
      // Count this track in the current shuffle cycle
      markShufflePlayed(track.id);

      destroyHls();
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        /* ignore */
      }

      try {
        // Multi-source: local / youtube / custom resolver, else SoundCloud open streams
        let stream: StreamInfo;
        const external = getPlayableResolver(track.id);
        if (external) {
          const resolved = await external();
          stream = {
            url: resolved.url,
            protocol: resolved.protocol,
            mimeType: resolved.protocol === 'hls' ? 'application/x-mpegURL' : 'audio/mpeg',
            snipped: false,
          };
        } else {
          stream = await getStreamInfo(track);
        }
        await attachStream(audio, stream);
        streamLoadedForIdRef.current = track.id;

        audio.volume = mutedRef.current ? 0 : volumeRef.current;
        audio.muted = mutedRef.current;

        // Only seek when caller asked (restore/toggle). Don't apply stale pendingSeek
        // when user starts a different track via playTrack.
        const seekTo = typeof startAt === 'number' && startAt > 1 ? startAt : 0;
        if (seekTo > 0) pendingSeekRef.current = 0;

        if (seekTo > 1) {
          const applySeek = () => {
            try {
              const max =
                Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration - 0.5 : seekTo;
              audio.currentTime = Math.min(seekTo, Math.max(0, max));
              setProgress(audio.currentTime);
              progressRef.current = audio.currentTime;
            } catch {
              /* ignore */
            }
          };
          if (audio.readyState >= 1) applySeek();
          else audio.addEventListener('loadedmetadata', applySeek, { once: true });
        }

        if (autoplay) {
          await audio.play();
          skipFailCountRef.current = 0;
          setState('playing');
          void maybeExtendStation(track);
          const playable = getPlayable(track.id);
          if (playable?.source === 'local' && playable.filePath) {
            try {
              window.dispatchEvent(
                new CustomEvent('miura-local-play', { detail: { filePath: playable.filePath } })
              );
            } catch {
              /* ignore */
            }
          }
        } else {
          skipFailCountRef.current = 0;
          setState('paused');
        }
        schedulePersist();
      } catch (e) {
        streamLoadedForIdRef.current = null;
        const msg = e instanceof Error ? e.message : 'Не удалось воспроизвести';
        if (/429|rate limit|ограничил/i.test(msg)) {
          setState('error');
          setError(msg);
          return;
        }
        // DRM / protected — tell user clearly, do not open browser/widgets
        if (/DRM|encrypted|Widevine|только с DRM/i.test(msg)) {
          setState('error');
          setError(msg);
          return;
        }
        if (!skipOnFail) {
          setState('error');
          setError(msg);
          return;
        }
        const q = queueRef.current;
        const idx = q.findIndex((t) => t.id === track.id);
        const next = idx >= 0 ? q[idx + 1] : null;
        if (next && skipFailCountRef.current < 2) {
          skipFailCountRef.current += 1;
          setError(`Пропуск: ${track.title || track.id}`);
          void loadAndPlayRef.current(next);
          return;
        }
        skipFailCountRef.current = 0;
        setState('error');
        setError(msg);
      }
    },
    [attachStream, maybeExtendStation, schedulePersist, markShufflePlayed]
  );

  loadAndPlayRef.current = loadAndPlay;

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = volumeRef.current;
    audio.muted = mutedRef.current;
    audioRef.current = audio;

    let lastPersistAt = 0;
    const onTime = () => {
      setProgress(audio.currentTime);
      progressRef.current = audio.currentTime;
      const now = Date.now();
      if (now - lastPersistAt > 4000) {
        lastPersistAt = now;
        schedulePersist();
      }
    };
    const onMeta = () => setDuration(audio.duration || 0);
    const onPlay = () => setState('playing');
    const onPause = () => {
      if (!audio.ended) setState('paused');
      persistNow();
    };
    const onEnded = () => {
      const q = queueRef.current;
      const cur = currentRef.current;
      if (!q.length || !cur) return;
      if (repeatRef.current === 'one') {
        audio.currentTime = 0;
        void audio.play().catch(() => void loadAndPlayRef.current(cur));
        return;
      }
      const next = resolveNext(true);
      if (next) {
        void loadAndPlayRef.current(next);
        return;
      }
      if (stationModeRef.current) {
        void (async () => {
          const exclude = new Set(q.map((t) => t.id));
          const more = await extendStation(cur, exclude, 24);
          if (more.length) {
            const nextQ = [...q, ...more];
            queueRef.current = nextQ;
            setQueue(nextQ);
            void loadAndPlayRef.current(
              shuffleRef.current ? more[Math.floor(Math.random() * more.length)]! : more[0]!
            );
          } else {
            setState('paused');
          }
        })();
        return;
      }
      setState('paused');
      persistNow();
    };
    const onErr = () => {
      setState('error');
      setError('Ошибка воспроизведения');
    };

    const flush = () => persistNow();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onErr);

    // Restore last session in UI only — do NOT resolve stream yet.
    // SC progressive URLs expire; early restore also races auth/client_id boot.
    // Fresh stream is fetched on first play (see toggle).
    const restoreTrack = initial?.current ?? null;
    if (!restoredRef.current && restoreTrack) {
      restoredRef.current = true;
      const q = initial!.queue.length > 0 ? initial!.queue : [restoreTrack];
      queueRef.current = q;
      setQueue(q);
      currentRef.current = restoreTrack;
      setCurrent(restoreTrack);
      const pos = (initial?.progress ?? 0) > 2 ? initial!.progress : 0;
      pendingSeekRef.current = pos;
      progressRef.current = pos;
      setProgress(pos);
      setDuration(restoreTrack.duration / 1000 || 0);
      setState('paused');
      setError(null);
      streamLoadedForIdRef.current = null;
    } else {
      restoredRef.current = true;
    }

    return () => {
      flush();
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      destroyHls();
      revokeLocalBlob();
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onErr);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once for audio element
  }, [resolveNext, schedulePersist, persistNow, initial]);

  const playTrack = useCallback(
    (track: Track, list?: Track[], opts?: { keepStation?: boolean }) => {
      if (!opts?.keepStation) {
        setStationMode(false);
        stationModeRef.current = false;
        setStationSeed(null);
      }
      // Fresh pick from library/search — don't keep restored seek position
      if (currentRef.current?.id !== track.id) {
        pendingSeekRef.current = 0;
      }
      if (list) {
        const cleaned = list.filter((t) => t && t.id && t.title);
        setQueue(cleaned);
        queueRef.current = cleaned;
        // New playlist/queue → new shuffle cycle
        resetShuffleBag(track.id);
      } else if (!queueRef.current.find((t) => t.id === track.id)) {
        const next = [...queueRef.current, track];
        setQueue(next);
        queueRef.current = next;
      }
      void loadAndPlay(track);
    },
    [loadAndPlay, resetShuffleBag]
  );

  const registerPlayableStream = useCallback((p: Playable) => {
    const track = playableToTrack(p);
    registerPlayableResolver(track.id, p, async () => {
      if (p.source === 'local' && p.filePath) {
        if (window.electronAPI?.localReadAudio) {
          const res = await window.electronAPI.localReadAudio(p.filePath);
          if (!res || res.ok === false) {
            throw new Error((res && 'error' in res && res.error) || 'Не удалось прочитать файл');
          }
          const raw = res.buffer;
          const bytes =
            raw instanceof Uint8Array
              ? raw
              : raw instanceof ArrayBuffer
                ? new Uint8Array(raw)
                : new Uint8Array(raw as ArrayBuffer);
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          const mime = res.mime && res.mime !== 'application/octet-stream' ? res.mime : 'audio/mpeg';
          const blob = new Blob([copy], { type: mime });
          revokeLocalBlob();
          const url = URL.createObjectURL(blob);
          localBlobUrlRef.current = url;
          return { url, protocol: 'progressive' as const };
        }
        throw new Error(
          'Локальные файлы: перезапусти miura (npm run dev) — нужен Electron IPC localReadAudio'
        );
      }
      if (p.source === 'youtube') {
        const videoId = String(p.meta?.videoId || p.uid.replace(/^yt:/, ''));
        const url = await resolveYouTubeStreamUrl(videoId);
        const isHls = url.includes('.m3u8');
        return { url, protocol: isHls ? ('hls' as const) : ('progressive' as const) };
      }
      if (p.streamUrl) {
        return {
          url: p.streamUrl,
          protocol: p.streamUrl.includes('.m3u8') ? ('hls' as const) : ('progressive' as const),
        };
      }
      throw new Error(`Нет потока: ${p.source}`);
    });
    return track;
  }, []);

  /** Play a multi-source item (local / YouTube / …) inside the same player core. */
  const playPlayable = useCallback(
    (item: Playable, list?: Playable[]) => {
      void (async () => {
        const hydrateCover = async (p: Playable): Promise<Playable> => {
          if (p.source !== 'local' || !p.filePath) return p;
          if (p.artworkUrl?.startsWith('data:') || p.artworkUrl?.startsWith('blob:')) return p;
          if (!window.electronAPI?.localCoverForPath) return p;
          try {
            const r = await window.electronAPI.localCoverForPath(p.filePath);
            if (r?.ok && r.dataUrl) return { ...p, artworkUrl: r.dataUrl };
          } catch {
            /* ignore */
          }
          return p;
        };

        const playItem = await hydrateCover(item);
        const playList = list?.length
          ? await Promise.all(list.map((p) => hydrateCover(p)))
          : undefined;

        const track = registerPlayableStream(playItem);
        const tracks = playList?.length ? playList.map(registerPlayableStream) : undefined;
        playTrack(track, tracks);
      })();
    },
    [playTrack, registerPlayableStream]
  );

  const startStation = useCallback(
    (seed: Track, stationTracks: Track[]) => {
      const cleaned = stationTracks.filter((t) => t && t.id && t.title);
      if (!cleaned.length) return;
      setStationMode(true);
      stationModeRef.current = true;
      setStationSeed(seed);
      setQueue(cleaned);
      queueRef.current = cleaned;
      void loadAndPlay(seed);
    },
    [loadAndPlay]
  );

  const stopStation = useCallback(() => {
    setStationMode(false);
    stationModeRef.current = false;
    setStationSeed(null);
  }, []);

  const playNext = useCallback(() => {
    const q = queueRef.current;
    const cur = currentRef.current;
    if (!q.length || !cur) return;
    if (shuffleRef.current) {
      const rnd = pickShuffleNext(q, cur.id, shufflePlayedRef.current);
      if (rnd) {
        void loadAndPlay(rnd);
        return;
      }
    }
    const idx = q.findIndex((t) => t.id === cur.id);
    const next = q[idx + 1];
    if (next) {
      void loadAndPlay(next);
      return;
    }
    if (stationModeRef.current) {
      void maybeExtendStation(cur);
      // Prefer unplayed if shuffle bag active
      const rnd = shuffleRef.current
        ? pickShuffleNext(q, cur.id, shufflePlayedRef.current)
        : pickRandomOther(q, cur.id);
      if (rnd) void loadAndPlay(rnd);
      return;
    }
    if (repeatRef.current !== 'off') void loadAndPlay(q[0]!);
  }, [loadAndPlay, maybeExtendStation]);

  const playPrev = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const q = queueRef.current;
    const cur = currentRef.current;
    if (!q.length || !cur) return;
    if (shuffleRef.current) {
      // Go back along shuffle history instead of random jump
      const stack = shuffleStackRef.current;
      const at = stack.lastIndexOf(cur.id);
      if (at > 0) {
        const prevId = stack[at - 1]!;
        const prev = q.find((t) => t.id === prevId);
        if (prev) {
          // Trim stack so "next" after going back continues forward cleanly
          shuffleStackRef.current = stack.slice(0, at);
          void loadAndPlay(prev);
          return;
        }
      }
      // No history — stay on first of cycle / previous in queue order
      const idx = q.findIndex((t) => t.id === cur.id);
      const prev = q[idx - 1];
      if (prev) void loadAndPlay(prev);
      return;
    }
    const idx = q.findIndex((t) => t.id === cur.id);
    const prev = q[idx - 1] ?? (repeatRef.current !== 'off' ? q[q.length - 1] : null);
    if (prev) void loadAndPlay(prev);
  }, [loadAndPlay]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    const track = currentRef.current;
    if (!audio || !track) return;

    if (!audio.paused && streamLoadedForIdRef.current === track.id && audio.currentSrc) {
      audio.pause();
      setState('paused');
      persistNow();
      return;
    }

    // After restore / expired CDN URL / failed attach — fetch a fresh stream
    const needsFreshStream =
      streamLoadedForIdRef.current !== track.id ||
      !audio.currentSrc ||
      Boolean(audio.error);

    if (needsFreshStream) {
      const startAt =
        pendingSeekRef.current > 1
          ? pendingSeekRef.current
          : progressRef.current > 1
            ? progressRef.current
            : 0;
      void loadAndPlay(track, { autoplay: true, startAt, skipOnFail: true });
      return;
    }

    void audio
      .play()
      .then(() => setState('playing'))
      .catch(() => {
        // Stale signed URL — re-resolve stream and play again
        const startAt = progressRef.current > 1 ? progressRef.current : 0;
        void loadAndPlay(track, { autoplay: true, startAt, skipOnFail: true });
      });
  }, [loadAndPlay, persistNow]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    // Stream not loaded yet (restored session) — remember position for first play
    if (streamLoadedForIdRef.current !== currentRef.current?.id || !audio.currentSrc) {
      pendingSeekRef.current = time;
      progressRef.current = time;
      setProgress(time);
      schedulePersist();
      return;
    }
    audio.currentTime = time;
    setProgress(time);
    progressRef.current = time;
    schedulePersist();
  }, [schedulePersist]);

  const setVolume = useCallback(
    (v: number) => {
      const audio = audioRef.current;
      const clamped = Math.min(1, Math.max(0, v));
      volumeRef.current = clamped;
      setVolumeState(clamped);
      if (audio) {
        audio.volume = clamped;
        if (clamped > 0 && audio.muted) {
          audio.muted = false;
          mutedRef.current = false;
          setIsMuted(false);
        }
      }
      schedulePersist();
    },
    [schedulePersist]
  );

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    mutedRef.current = audio.muted;
    setIsMuted(audio.muted);
    schedulePersist();
  }, [schedulePersist]);

  const toggleShuffle = useCallback(() => {
    setShuffle((s) => {
      const next = !s;
      shuffleRef.current = next;
      if (next) {
        // Fresh bag: current track counts as already played this cycle
        resetShuffleBag(currentRef.current?.id ?? null);
      } else {
        resetShuffleBag(null);
      }
      schedulePersist();
      return next;
    });
  }, [schedulePersist, resetShuffleBag]);

  const cycleRepeat = useCallback(() => {
    setRepeat((r) => {
      const next: RepeatMode = r === 'off' ? 'all' : r === 'all' ? 'one' : 'off';
      repeatRef.current = next;
      schedulePersist();
      return next;
    });
  }, [schedulePersist]);

  const addToQueue = useCallback(
    (track: Track) => {
      setQueue((q) => {
        if (q.find((t) => t.id === track.id)) return q;
        const next = [...q, track];
        queueRef.current = next;
        return next;
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  const addPlayableToQueue = useCallback(
    (item: Playable) => {
      const track = registerPlayableStream(item);
      addToQueue(track);
    },
    [registerPlayableStream, addToQueue]
  );

  /** Insert right after currently playing track */
  const addNext = useCallback(
    (track: Track) => {
      setQueue((q) => {
        if (q.find((t) => t.id === track.id)) return q;
        const cur = currentRef.current;
        const idx = cur ? q.findIndex((t) => t.id === cur.id) : -1;
        const next =
          idx >= 0 ? [...q.slice(0, idx + 1), track, ...q.slice(idx + 1)] : [...q, track];
        queueRef.current = next;
        return next;
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  const playQueueIndex = useCallback(
    (index: number) => {
      const t = queueRef.current[index];
      if (t) void loadAndPlay(t);
    },
    [loadAndPlay]
  );

  const moveInQueue = useCallback(
    (from: number, to: number) => {
      setQueue((q) => {
        if (from < 0 || from >= q.length || to < 0 || to >= q.length) return q;
        const next = [...q];
        const [item] = next.splice(from, 1);
        if (!item) return q;
        next.splice(to, 0, item);
        queueRef.current = next;
        return next;
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  const removeFromQueue = useCallback(
    (trackId: number) => {
      setQueue((q) => {
        const next = q.filter((t) => t.id !== trackId);
        queueRef.current = next;
        return next;
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  const clearQueue = useCallback(() => {
    setQueue([]);
    queueRef.current = [];
    resetShuffleBag(null);
    schedulePersist();
  }, [schedulePersist, resetShuffleBag]);

  const markLiked = useCallback((id: number, liked: boolean) => {
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (liked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  return {
    queue,
    current,
    state,
    error,
    progress,
    duration,
    volume,
    isMuted,
    likedIds,
    stationMode,
    stationSeed,
    shuffle,
    repeat,
    playTrack,
    playPlayable,
    addPlayableToQueue,
    startStation,
    stopStation,
    playNext,
    playPrev,
    toggle,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    addToQueue,
    addNext,
    playQueueIndex,
    moveInQueue,
    removeFromQueue,
    clearQueue,
    markLiked,
    setLikedIds,
  };
}
