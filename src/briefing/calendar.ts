import { namedays } from './namedays.js';
import type { Locale } from '../i18n/index.js';

// Gregorian Meeus/Jones/Butcher computus. UTC arithmetic here represents calendar dates.
export const easterSunday = (year: number) => {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100;
  const d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day, 12));
};
// Act 241/1993, effective 2025-11-01, checked 2026-09-15:
// https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/1993/241/
// §1 state holidays and §2 other holidays are separate legal categories.
const fixed = [
  [
    '01-01',
    'Deň vzniku Slovenskej republiky',
    'Day of the Establishment of the Slovak Republic',
    true,
  ],
  ['01-06', 'Zjavenie Pána (Traja králi)', 'Epiphany', false],
  ['05-01', 'Sviatok práce', 'Labour Day', false],
  ['05-08', 'Deň víťazstva nad fašizmom', 'Victory over Fascism Day', false],
  ['07-05', 'Sviatok svätého Cyrila a Metoda', 'Saints Cyril and Methodius Day', true],
  ['08-29', 'Výročie SNP', 'Slovak National Uprising Anniversary', true],
  ['09-01', 'Deň Ústavy Slovenskej republiky', 'Constitution Day', true],
  ['09-15', 'Sedembolestná Panna Mária', 'Our Lady of Sorrows', false],
  [
    '10-28',
    'Deň vzniku samostatného česko-slovenského štátu',
    'Establishment of the Independent Czecho-Slovak State',
    true,
  ],
  ['11-01', 'Sviatok všetkých svätých', 'All Saints’ Day', false],
  ['11-17', 'Deň boja za slobodu a demokraciu', 'Struggle for Freedom and Democracy Day', true],
  ['12-24', 'Štedrý deň', 'Christmas Eve', false],
  ['12-25', 'Prvý sviatok vianočný', 'Christmas Day', false],
  ['12-26', 'Druhý sviatok vianočný', 'Saint Stephen’s Day', false],
] as const;
export const slovakCalendar = (date: string, locale: Locale) => {
  const year = Number(date.slice(0, 4));
  const key = date.slice(5);
  const holidays: { name: string; stateHoliday: boolean; dayOff: boolean }[] = fixed
    .filter(([day]) => day === key)
    .map(([day, sk, en, stateHoliday]) => ({
      name: locale === 'sk' ? sk : en,
      stateHoliday,
      dayOff: !(
        day === '10-28' ||
        (day === '09-01' && year >= 2024) ||
        (day === '11-17' && year >= 2025) ||
        (year === 2026 && ['05-08', '09-15'].includes(day))
      ),
    }));
  for (const [offset, sk, en] of [
    [-2, 'Veľký piatok', 'Good Friday'],
    [1, 'Veľkonočný pondelok', 'Easter Monday'],
  ] as const) {
    const day = new Date(+easterSunday(year) + offset * 86_400_000).toISOString().slice(0, 10);
    if (day === date)
      holidays.push({ name: locale === 'sk' ? sk : en, dayOff: true, stateHoliday: false });
  }
  return { names: namedays[key] ?? [], holidays };
};
