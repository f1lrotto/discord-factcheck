import { en } from './en.js';
import { sk, type Messages } from './sk.js';
import type { Locale } from './plural.js';

export type { Locale } from './plural.js';
export type { Messages } from './sk.js';

export const locales = ['sk', 'en'] as const satisfies readonly Locale[];

export const defaultLocale: Locale = 'sk';

const catalogs = { sk, en } satisfies Record<Locale, Messages>;

export const isLocale = (value: string): value is Locale =>
  locales.some((candidate) => candidate === value);

export const messages = (locale: Locale): Messages => catalogs[locale];

export const localeName = (locale: Locale) => catalogs[locale].languageName;

export const localeChoices = () =>
  locales.map((value) => ({ name: catalogs[value].languageName, value }));
