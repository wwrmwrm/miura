import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ru, type Dict } from './locales/ru';
import { en } from './locales/en';
import { uk } from './locales/uk';

export type Locale = 'ru' | 'en' | 'uk';

const LOCALES: Record<Locale, Dict> = { ru, en, uk };

const STORAGE_KEY = 'miura_locale';
const STORAGE_KEY_LEGACY = 'miu_locale';

export const LOCALE_LABELS: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
  uk: 'Українська',
};

function detectLocale(): Locale {
  try {
    let stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (!stored) {
      stored = localStorage.getItem(STORAGE_KEY_LEGACY) as Locale | null;
      if (stored && stored in LOCALES) {
        try {
          localStorage.setItem(STORAGE_KEY, stored);
        } catch {
          /* ignore */
        }
      }
    }
    if (stored && stored in LOCALES) return stored;
  } catch {
    /* ignore */
  }
  const nav = (navigator.language || 'en').toLowerCase();
  if (nav.startsWith('ru')) return 'ru';
  if (nav.startsWith('uk')) return 'uk';
  return 'en';
}

type I18nCtx = {
  locale: Locale;
  t: Dict;
  setLocale: (l: Locale) => void;
};

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l;
  }, []);

  const value = useMemo(
    () => ({
      locale,
      t: LOCALES[locale] ?? ru,
      setLocale,
    }),
    [locale, setLocale]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside provider');
  return ctx;
}

export function useT(): Dict {
  return useI18n().t;
}
