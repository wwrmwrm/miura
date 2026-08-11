export type AppTheme = 'black' | 'gray' | 'white';

const THEME_KEY = 'miura_theme_v1';
const THEME_KEY_LEGACY = ['miu_theme_v1'];

export const THEME_ORDER: AppTheme[] = ['black', 'gray', 'white'];

export function getStoredTheme(): AppTheme {
  try {
    let v = localStorage.getItem(THEME_KEY) as AppTheme | null;
    if (!v) {
      for (const k of THEME_KEY_LEGACY) {
        v = localStorage.getItem(k) as AppTheme | null;
        if (v === 'black' || v === 'gray' || v === 'white') {
          try {
            localStorage.setItem(THEME_KEY, v);
          } catch {
            /* ignore */
          }
          break;
        }
      }
    }
    if (v === 'black' || v === 'gray' || v === 'white') return v;
  } catch {
    /* ignore */
  }
  return 'black';
}

export function applyAppTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  // Match window chrome / custom title bar
  const deep =
    theme === 'white' ? '#efeae3' : theme === 'gray' ? '#1c1917' : '#0c0b0a';
  document.documentElement.style.background = deep;
  if (document.body) document.body.style.background = deep;
  try {
    void window.electronAPI?.titlebarSetTheme?.(theme);
  } catch {
    /* ignore */
  }
}
