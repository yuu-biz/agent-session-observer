import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { MESSAGES, type Lang, type MessageKey } from './messages.js';

/**
 * Minimal i18n.
 *
 * Hand-rolled rather than pulled from a library, for the same reason the server
 * has no runtime dependencies: this app reads private session logs, and every
 * package it ships is something a reader has to trust. Two locales and simple
 * `{placeholder}` interpolation do not justify a dependency.
 */

export type { Lang, MessageKey };
export { MESSAGES };

const STORAGE_KEY = 'aso.lang';

/** Browser preference, used only when the user has not chosen one. */
function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'ja') return stored;
  } catch {
    // Private mode or blocked storage: fall through to the browser language.
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
  /** BCP-47 tag for `toLocaleString` and friends. */
  locale: string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Remembering the choice is a convenience, not a requirement.
    }
    if (typeof document !== 'undefined') document.documentElement.lang = next;
  }, []);

  const value = useMemo<I18nValue>(() => {
    const table = MESSAGES[lang];
    const t: Translate = (key, vars) => {
      const template = table[key] ?? MESSAGES.en[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match,
      );
    };
    return { lang, setLang, t, locale: lang === 'ja' ? 'ja-JP' : 'en-US' };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}

/** Shorthand for components that only need the translate function. */
export function useT(): Translate {
  return useI18n().t;
}
