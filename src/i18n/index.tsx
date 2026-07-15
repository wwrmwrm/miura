import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ru, type Dict } from './locales/ru';
import { en } from './locales/en';
import { de } from './locales/de';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { nl } from './locales/nl';
import { pl } from './locales/pl';
import { pt } from './locales/pt';
import { sv } from './locales/sv';

export type Locale = 'ru' | 'en' | 'de' | 'es' | 'fr' | 'it' | 'nl' | 'pl' | 'pt' | 'sv';

const LOCALES: Record<Locale, Dict> = {
  ru: ru as Dict,
  en: en as Dict,
  de: de as Dict,
  es: es as Dict,
  fr: fr as Dict,
  it: it as Dict,
  nl: nl as Dict,
  pl: pl as Dict,
  pt: pt as Dict,
  sv: sv as Dict,
};

const STORAGE_KEY = 'miura_locale';
const STORAGE_KEY_LEGACY = 'miu_locale';

/** Display names as requested (native language labels). */
export const LOCALE_LABELS: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English (US)',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  sv: 'Svenska',
};

/** Stable order in the language picker */
export const LOCALE_ORDER: Locale[] = [
  'ru',
  'en',
  'de',
  'es',
  'fr',
  'it',
  'nl',
  'pl',
  'pt',
  'sv',
];

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
    // Migrate removed Ukrainian → Russian (closest), or English
    if (stored === ('uk' as Locale)) {
      stored = 'ru';
      try {
        localStorage.setItem(STORAGE_KEY, stored);
      } catch {
        /* ignore */
      }
    }
    if (stored && stored in LOCALES) return stored;
  } catch {
    /* ignore */
  }
  const nav = (navigator.language || 'en').toLowerCase();
  if (nav.startsWith('ru')) return 'ru';
  if (nav.startsWith('de')) return 'de';
  if (nav.startsWith('es')) return 'es';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('it')) return 'it';
  if (nav.startsWith('nl')) return 'nl';
  if (nav.startsWith('pl')) return 'pl';
  if (nav.startsWith('pt')) return 'pt';
  if (nav.startsWith('sv')) return 'sv';
  if (nav.startsWith('uk')) return 'ru';
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
