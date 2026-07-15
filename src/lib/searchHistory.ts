import { readScopedJson, writeScopedJson } from './profileScope';

const KEY = 'miura_search_history_v1';
const MAX = 40;

export function loadSearchHistory(): string[] {
  const list = readScopedJson<string[]>(KEY, []);
  if (!Array.isArray(list)) return [];
  return list.map((x) => String(x || '').trim()).filter(Boolean);
}

export function pushSearchHistory(query: string): string[] {
  const q = String(query || '').trim();
  if (!q || q.length < 1) return loadSearchHistory();
  // Don't store raw URLs as history noise (still searchable)
  const prev = loadSearchHistory().filter((x) => x.toLowerCase() !== q.toLowerCase());
  const next = [q, ...prev].slice(0, MAX);
  try {
    writeScopedJson(KEY, next);
  } catch {
    /* ignore */
  }
  return next;
}

export function clearSearchHistory(): string[] {
  try {
    writeScopedJson(KEY, []);
  } catch {
    /* ignore */
  }
  return [];
}

export function removeSearchHistoryItem(query: string): string[] {
  const q = String(query || '').trim().toLowerCase();
  const next = loadSearchHistory().filter((x) => x.toLowerCase() !== q);
  try {
    writeScopedJson(KEY, next);
  } catch {
    /* ignore */
  }
  return next;
}
