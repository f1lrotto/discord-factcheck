import { describe, expect, it } from 'vitest';
import { dailySlotSchedule, localDate } from '../src/scheduling/slots.js';
import { dailySchedule } from '../src/news/policy.js';

const timeZone = 'Europe/Bratislava';
const schedule = (instant: Date, hours = { primaryHour: 7, fallbackHour: 8, deadlineHour: 9 }) =>
  dailySlotSchedule({ instant, timeZone, ...hours });

describe('shared daily slot schedule', () => {
  it('resolves a morning schedule into absolute instants', () => {
    const day = schedule(new Date('2026-09-15T03:00:00Z'));
    expect(day.date).toBe('2026-09-15');
    // Bratislava is UTC+2 in September, so 07:00 local is 05:00Z.
    expect(day.primaryAt.toISOString()).toBe('2026-09-15T05:00:00.000Z');
    expect(day.fallbackAt.toISOString()).toBe('2026-09-15T06:00:00.000Z');
    expect(day.deadline.toISOString()).toBe('2026-09-15T07:00:00.000Z');
  });

  it('pads single-digit hours into a valid instant', () => {
    // An unpadded "7:00:00" is not a parseable ISO time; a NaN date here would silently
    // disable the schedule rather than fail.
    for (const hour of [0, 1, 7, 9]) {
      const day = schedule(new Date('2026-09-15T03:00:00Z'), {
        primaryHour: hour,
        fallbackHour: hour + 1,
        deadlineHour: hour + 2,
      });
      expect(Number.isFinite(day.primaryAt.getTime())).toBe(true);
    }
  });

  it.each([
    ['spring forward', '2026-03-29'],
    ['autumn back', '2026-10-25'],
  ])('keeps one offset across both slots on the %s transition', (_label, date) => {
    const day = schedule(new Date(`${date}T03:00:00Z`));
    expect(day.date).toBe(date);
    // Reading the offset per slot would open a one-hour gap on exactly these two days.
    expect(+day.fallbackAt - +day.primaryAt).toBe(60 * 60_000);
    expect(+day.deadline - +day.fallbackAt).toBe(60 * 60_000);
    expect(localDate(day.primaryAt, timeZone)).toBe(date);
  });

  it.each([
    [{ primaryHour: 9, fallbackHour: 8, deadlineHour: 10 }, 'out of order'],
    [{ primaryHour: 7, fallbackHour: 8, deadlineHour: 8 }, 'a duplicated hour'],
    [{ primaryHour: -1, fallbackHour: 8, deadlineHour: 9 }, 'a negative hour'],
    [{ primaryHour: 7, fallbackHour: 8, deadlineHour: 24 }, 'an hour past the day'],
    [{ primaryHour: 7.5, fallbackHour: 8, deadlineHour: 9 }, 'a fractional hour'],
  ])('rejects %#: %s', (hours) => {
    expect(() => schedule(new Date('2026-09-15T03:00:00Z'), hours)).toThrow(
      'Invalid daily slot schedule',
    );
  });

  it('rejects an invalid instant', () => {
    expect(() => schedule(new Date('nonsense'))).toThrow('Invalid clock instant');
  });

  it('still produces the news evening schedule it was extracted from', () => {
    const day = dailySchedule(new Date('2026-09-15T03:00:00Z'));
    expect(day.primaryAt.toISOString()).toBe('2026-09-15T18:00:00.000Z');
    expect(day.fallbackAt.toISOString()).toBe('2026-09-15T19:00:00.000Z');
    expect(day.deadline.toISOString()).toBe('2026-09-15T20:00:00.000Z');
  });
});
