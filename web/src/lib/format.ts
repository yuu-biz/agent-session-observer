import { useI18n } from './i18n';
import {
  fmtDateTime,
  fmtDuration,
  fmtDurationPrecise,
  fmtNumber,
  weekdayShort,
} from './formatters.js';

export * from './formatters.js';

/**
 * Locale-bound formatters, so components never have to remember to pass the
 * current language into every call.
 */
export function useFormat(): {
  duration: (ms: number | undefined | null) => string;
  durationPrecise: (ms: number | undefined | null) => string;
  dateTime: (ts: number) => string;
  number: (n: number | undefined | null) => string;
  weekday: (dayKey: string) => string;
  locale: string;
} {
  const { lang, locale } = useI18n();
  return {
    duration: (ms) => fmtDuration(ms, lang),
    durationPrecise: (ms) => fmtDurationPrecise(ms, lang),
    dateTime: (ts) => fmtDateTime(ts, locale),
    number: (n) => fmtNumber(n, locale),
    weekday: (dayKey) => weekdayShort(dayKey, locale),
    locale,
  };
}
