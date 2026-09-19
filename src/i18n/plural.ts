export type Locale = 'sk' | 'en';

/**
 * Slovak needs three forms for integer counts: `one` for 1, `few` for 2–4, and `other`
 * for 0 and 5 upward. `many` only ever selects for fractions, so integer call sites may
 * leave it out. Interpolating a single form, as English tolerates, reads wrong in Slovak.
 */
export type PluralForms = {
  one: string;
  few?: string;
  many?: string;
  other: string;
};

const rules = new Map<Locale, Intl.PluralRules>();

const pluralRules = (locale: Locale) => {
  const existing = rules.get(locale);
  if (existing) return existing;
  const created = new Intl.PluralRules(locale === 'sk' ? 'sk-SK' : 'en-US');
  rules.set(locale, created);
  return created;
};

export const plural = (locale: Locale, count: number, forms: PluralForms) => {
  const category = pluralRules(locale).select(count);
  const selected =
    category === 'one'
      ? forms.one
      : category === 'few'
        ? (forms.few ?? forms.other)
        : category === 'many'
          ? (forms.many ?? forms.few ?? forms.other)
          : forms.other;
  return selected.replace('{count}', String(count));
};
