/** Local miura profile (no server). Stored in Electron userData. */

export type MiuraProfile = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** Wide header background (SoundCloud-style) */
  bannerUrl?: string | null;
  /** Focal point of banner, 0–100 (CSS background-position) */
  bannerPosX?: number;
  bannerPosY?: number;
  /** Short status / about (max 160) */
  bio?: string;
  /** Optional personal accent color (#rrggbb) */
  accent?: string | null;
  createdAt: number;
  lastUsedAt: number;
};

export type MiuraProfileState = {
  active: MiuraProfile | null;
  profiles: MiuraProfile[];
};

const LS_KEY = 'miura_profiles_v1';
const LS_KEY_LEGACY = 'miu_profiles_v1';

function emptyState(): MiuraProfileState {
  return { active: null, profiles: [] };
}

function normalizeProfile(p: Partial<MiuraProfile> & { id: string; displayName: string }): MiuraProfile {
  return {
    id: String(p.id),
    displayName: String(p.displayName).slice(0, 48),
    avatarUrl: p.avatarUrl || null,
    bannerUrl: p.bannerUrl || null,
    bannerPosX: clampPct(p.bannerPosX, 50),
    bannerPosY: clampPct(p.bannerPosY, 50),
    bio: p.bio != null ? String(p.bio).slice(0, 160) : '',
    accent: p.accent || null,
    createdAt: Number(p.createdAt) || Date.now(),
    lastUsedAt: Number(p.lastUsedAt) || Date.now(),
  };
}

function readLocalFallback(): MiuraProfileState {
  try {
    let raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      raw = localStorage.getItem(LS_KEY_LEGACY);
      if (raw) {
        try {
          localStorage.setItem(LS_KEY, raw);
        } catch {
          /* ignore */
        }
      }
    }
    if (!raw) return emptyState();
    const data = JSON.parse(raw) as {
      activeId?: string | null;
      profiles?: Array<Partial<MiuraProfile> & { id: string; displayName: string }>;
    };
    const profiles = (data.profiles || [])
      .filter((p) => p?.id && p?.displayName)
      .map((p) => normalizeProfile(p));
    const active = data.activeId ? profiles.find((p) => p.id === data.activeId) || null : null;
    return { active, profiles };
  } catch {
    return emptyState();
  }
}

function writeLocalFallback(state: MiuraProfileState) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        activeId: state.active?.id ?? null,
        profiles: state.profiles,
      })
    );
  } catch {
    /* ignore */
  }
}

function uid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function clampPct(v: unknown, fallback = 50): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

export async function getProfileState(): Promise<MiuraProfileState> {
  if (window.electronAPI?.profileState) {
    return window.electronAPI.profileState();
  }
  return readLocalFallback();
}

export async function createProfile(opts: {
  displayName: string;
  avatarPath?: string | null;
  avatarUrl?: string | null;
  bio?: string;
  accent?: string | null;
}): Promise<MiuraProfileState> {
  const displayName = String(opts.displayName || '').trim().slice(0, 48);
  if (!displayName) throw new Error('Введите имя профиля');

  if (window.electronAPI?.profileCreate) {
    return window.electronAPI.profileCreate({
      displayName,
      avatarPath: opts.avatarPath || undefined,
      bio: opts.bio,
      accent: opts.accent ?? undefined,
    });
  }

  const now = Date.now();
  const profile: MiuraProfile = {
    id: uid(),
    displayName,
    avatarUrl: opts.avatarUrl || null,
    bio: (opts.bio || '').slice(0, 160),
    accent: opts.accent || null,
    createdAt: now,
    lastUsedAt: now,
  };
  const prev = readLocalFallback();
  const state: MiuraProfileState = {
    active: profile,
    profiles: [profile, ...prev.profiles.filter((p) => p.id !== profile.id)],
  };
  writeLocalFallback(state);
  return state;
}

export async function updateProfile(opts: {
  id: string;
  displayName?: string;
  bio?: string;
  accent?: string | null;
  avatarPath?: string | null;
  avatarUrl?: string | null;
  bannerPath?: string | null;
  bannerUrl?: string | null;
  bannerPosX?: number;
  bannerPosY?: number;
  clearAvatar?: boolean;
  clearBanner?: boolean;
}): Promise<MiuraProfileState> {
  if (window.electronAPI?.profileUpdate) {
    return window.electronAPI.profileUpdate({
      id: opts.id,
      displayName: opts.displayName,
      bio: opts.bio,
      accent: opts.accent,
      avatarPath: opts.avatarPath || undefined,
      bannerPath: opts.bannerPath || undefined,
      bannerPosX: opts.bannerPosX,
      bannerPosY: opts.bannerPosY,
      clearAvatar: opts.clearAvatar,
      clearBanner: opts.clearBanner,
    });
  }

  const state = readLocalFallback();
  const idx = state.profiles.findIndex((p) => p.id === opts.id);
  if (idx < 0) throw new Error('Профиль не найден');
  const p = { ...state.profiles[idx] };
  if (opts.displayName != null) {
    const name = String(opts.displayName).trim().slice(0, 48);
    if (!name) throw new Error('Введите имя профиля');
    p.displayName = name;
  }
  if (opts.bio != null) p.bio = String(opts.bio).trim().slice(0, 160);
  if (opts.accent !== undefined) p.accent = opts.accent || null;
  if (opts.clearAvatar) p.avatarUrl = null;
  if (opts.avatarUrl) p.avatarUrl = opts.avatarUrl;
  if (opts.clearBanner) {
    p.bannerUrl = null;
    p.bannerPosX = 50;
    p.bannerPosY = 50;
  }
  if (opts.bannerUrl) p.bannerUrl = opts.bannerUrl;
  if (opts.bannerPosX != null) p.bannerPosX = clampPct(opts.bannerPosX, 50);
  if (opts.bannerPosY != null) p.bannerPosY = clampPct(opts.bannerPosY, 50);
  p.lastUsedAt = Date.now();
  state.profiles[idx] = p;
  if (state.active?.id === p.id) state.active = p;
  writeLocalFallback(state);
  return state;
}

export async function switchProfile(id: string): Promise<MiuraProfileState> {
  if (window.electronAPI?.profileSwitch) {
    return window.electronAPI.profileSwitch(id);
  }
  const state = readLocalFallback();
  const p = state.profiles.find((x) => x.id === id);
  if (!p) throw new Error('Профиль не найден');
  p.lastUsedAt = Date.now();
  state.active = p;
  writeLocalFallback(state);
  return state;
}

export async function logoutProfile(): Promise<MiuraProfileState> {
  if (window.electronAPI?.profileLogout) {
    return window.electronAPI.profileLogout();
  }
  const state = readLocalFallback();
  state.active = null;
  writeLocalFallback(state);
  return state;
}

export async function deleteProfile(id: string): Promise<MiuraProfileState> {
  if (window.electronAPI?.profileDelete) {
    return window.electronAPI.profileDelete(id);
  }
  const state = readLocalFallback();
  state.profiles = state.profiles.filter((p) => p.id !== id);
  if (state.active?.id === id) state.active = null;
  writeLocalFallback(state);
  return state;
}

export async function pickProfileAvatar(): Promise<{
  canceled: boolean;
  path?: string;
  dataUrl?: string;
  error?: string;
}> {
  if (window.electronAPI?.profilePickAvatar) {
    return window.electronAPI.profilePickAvatar();
  }
  return { canceled: true, error: 'Только в Electron' };
}

export async function pickProfileBanner(): Promise<{
  canceled: boolean;
  path?: string;
  dataUrl?: string;
  error?: string;
}> {
  if (window.electronAPI?.profilePickBanner) {
    return window.electronAPI.profilePickBanner();
  }
  return { canceled: true, error: 'Только в Electron' };
}

export function profileInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function formatProfileDate(ts: number, locale = 'ru'): string {
  try {
    return new Date(ts).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return new Date(ts).toLocaleDateString();
  }
}
