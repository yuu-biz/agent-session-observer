import { describe, expect, it } from 'vitest';

import { fmtCost, fmtDuration } from '../web/src/lib/formatters.js';
import { MESSAGES } from '../web/src/lib/messages.js';

/**
 * The English table is the source of truth. These tests exist so that adding a
 * string in one locale and forgetting the other fails here rather than showing
 * up as an English sentence in the middle of a Japanese page.
 */

describe('translation tables', () => {
  const enKeys = Object.keys(MESSAGES.en).sort();
  const jaKeys = Object.keys(MESSAGES.ja).sort();

  it('cover exactly the same keys', () => {
    expect(jaKeys).toEqual(enKeys);
  });

  it('have no empty translations', () => {
    for (const lang of ['en', 'ja'] as const) {
      for (const key of enKeys) {
        const value = MESSAGES[lang][key as keyof typeof MESSAGES.en];
        expect(value.trim(), `${lang}.${key}`).not.toBe('');
      }
    }
  });

  it('use the same placeholders in both languages', () => {
    const placeholders = (s: string): string[] =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

    for (const key of enKeys) {
      const k = key as keyof typeof MESSAGES.en;
      expect(placeholders(MESSAGES.ja[k]), `placeholders differ for ${key}`).toEqual(
        placeholders(MESSAGES.en[k]),
      );
    }
  });

  it('translates every status and confidence level the server can emit', () => {
    for (const status of ['active', 'recently_active', 'likely_idle', 'ended']) {
      expect(MESSAGES.ja).toHaveProperty(`live.${status}`);
    }
    for (const level of ['high', 'medium', 'low']) {
      expect(MESSAGES.ja).toHaveProperty(`live.${level}`);
    }
  });
});

describe('locale-aware formatting', () => {
  const MIN = 60_000;

  it('formats durations with localised units', () => {
    expect(fmtDuration(90 * MIN, 'en')).toBe('1h 30m');
    expect(fmtDuration(90 * MIN, 'ja')).toBe('1時間30分');
    expect(fmtDuration(45 * MIN, 'en')).toBe('45m');
    expect(fmtDuration(45 * MIN, 'ja')).toBe('45分');
    expect(fmtDuration(30_000, 'ja')).toBe('30秒');
  });

  it('drops the minutes component on a whole number of hours', () => {
    expect(fmtDuration(2 * 60 * MIN, 'en')).toBe('2h');
    expect(fmtDuration(2 * 60 * MIN, 'ja')).toBe('2時間');
  });

  it('treats zero and nonsense identically in both languages', () => {
    expect(fmtDuration(0, 'en')).toBe('0m');
    expect(fmtDuration(0, 'ja')).toBe('0分');
    expect(fmtDuration(Number.NaN, 'ja')).toBe('0分');
    expect(fmtDuration(null, 'ja')).toBe('0分');
  });

  it('keeps cost in USD whatever the language', () => {
    // The provider recorded dollars; converting would invent precision.
    expect(fmtCost(1.5)).toBe('$1.50');
    expect(fmtCost(0.0001)).toBe('$0.0001');
    expect(fmtCost(undefined)).toBe('n/a');
  });
});
