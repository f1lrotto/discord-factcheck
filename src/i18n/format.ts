import type { Locale } from './plural.js';

/**
 * Display formatting only.
 *
 * `clock.ts` deliberately formats with `en-CA` because `newsLocalDate` slices scheduling
 * keys out of its output; localizing that formatter would corrupt daily slot keys. Anything
 * a member reads is formatted here instead, and the two must stay separate.
 */
const intlLocale = (locale: Locale) => (locale === 'sk' ? 'sk-SK' : 'en-GB');

const formatters = new Map<string, Intl.DateTimeFormat>();

const dateTimeFormat = (locale: Locale, timeZone: string, options: Intl.DateTimeFormatOptions) => {
  const cacheKey = JSON.stringify([locale, timeZone, options]);
  const existing = formatters.get(cacheKey);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat(intlLocale(locale), { timeZone, ...options });
  formatters.set(cacheKey, created);
  return created;
};

export const formatLongDate = (locale: Locale, instant: Date, timeZone: string) =>
  dateTimeFormat(locale, timeZone, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);

export const formatTime = (locale: Locale, instant: Date, timeZone: string) =>
  dateTimeFormat(locale, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);

export const formatDateTime = (locale: Locale, instant: Date, timeZone: string) =>
  dateTimeFormat(locale, timeZone, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);

export const formatShortDate = (locale: Locale, instant: Date, timeZone: string) =>
  dateTimeFormat(locale, timeZone, { day: 'numeric', month: 'numeric' }).format(instant);

export const formatTemperature = (value: number) => `${Math.round(value)} °C`;

export const formatDuration = (locale: Locale, seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secondsPart = total % 60;
  const unit = locale === 'sk' ? { h: 'h', m: 'm', s: 's' } : { h: 'h', m: 'm', s: 's' };
  if (hours) return `${hours}${unit.h} ${minutes}${unit.m}`;
  if (minutes) return `${minutes}${unit.m} ${secondsPart}${unit.s}`;
  return `${secondsPart}${unit.s}`;
};
