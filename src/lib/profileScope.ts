/**
 * Active miura profile scope for localStorage keys.
 * When set, favorites / recent / local library are isolated per profile.
 */

let activeId: string | null = null;

export function setActiveProfileScope(profileId: string | null) {
  activeId = profileId ? String(profileId) : null;
}

export function getActiveProfileScope(): string | null {
  return activeId;
}

/** e.g. miura_favorites_v1 → miura_favorites_v1::uuid */
export function scopedKey(base: string, profileId?: string | null): string {
  const id = profileId === undefined ? activeId : profileId;
  if (!id) return base;
  return `${base}::${id}`;
}

/**
 * Read scoped key; if empty and legacy global key has data, migrate once.
 */
export function readScopedJson<T>(base: string, fallback: T): T {
  const key = scopedKey(base);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      return JSON.parse(raw) as T;
    }
  } catch {
    /* ignore */
  }

  // Migrate legacy unscoped / pre-rebrand keys into this profile once
  if (activeId) {
    try {
      const legacy = localStorage.getItem(base);
      if (legacy) {
        localStorage.setItem(key, legacy);
        return JSON.parse(legacy) as T;
      }
      // miu_* → miura_* rebrand
      if (base.startsWith('miura_')) {
        const oldBase = 'miu_' + base.slice('miura_'.length);
        const oldScoped = `${oldBase}::${activeId}`;
        const fromOld = localStorage.getItem(oldScoped) || localStorage.getItem(oldBase);
        if (fromOld) {
          localStorage.setItem(key, fromOld);
          return JSON.parse(fromOld) as T;
        }
      }
    } catch {
      /* ignore */
    }
  } else if (base.startsWith('miura_')) {
    try {
      const oldBase = 'miu_' + base.slice('miura_'.length);
      const fromOld = localStorage.getItem(oldBase);
      if (fromOld) {
        localStorage.setItem(key, fromOld);
        return JSON.parse(fromOld) as T;
      }
    } catch {
      /* ignore */
    }
  }

  return fallback;
}

export function writeScopedJson(base: string, data: unknown): void {
  try {
    localStorage.setItem(scopedKey(base), JSON.stringify(data));
  } catch {
    /* quota */
  }
}
