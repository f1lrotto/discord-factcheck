import { zonedDateTime } from '../clock.js';

export const localDate = (instant: Date, timeZone: string) =>
  zonedDateTime(instant, timeZone).localDateTime.slice(0, 10);

export type DailySlotSchedule = {
  date: string;
  primaryAt: Date;
  fallbackAt: Date;
  deadline: Date;
};

/**
 * Resolve a local-hour daily schedule into absolute instants.
 *
 * The offset is read at UTC noon on the local date, which lands mid-afternoon locally and
 * therefore shares one offset with every evening and morning slot on both DST-transition
 * dates. Reading it per slot instead would produce a one-hour gap on those two days.
 */
export const dailySlotSchedule = (input: {
  instant: Date;
  timeZone: string;
  primaryHour: number;
  fallbackHour: number;
  deadlineHour: number;
}): DailySlotSchedule => {
  const hours = [input.primaryHour, input.fallbackHour, input.deadlineHour];
  if (
    !hours.every((hour) => Number.isSafeInteger(hour) && hour >= 0 && hour <= 23) ||
    !(input.primaryHour < input.fallbackHour && input.fallbackHour < input.deadlineHour)
  )
    throw new Error('Invalid daily slot schedule');
  const date = localDate(input.instant, input.timeZone);
  const { utcOffset } = zonedDateTime(new Date(`${date}T12:00:00Z`), input.timeZone);
  const at = (hour: number) =>
    new Date(`${date}T${String(hour).padStart(2, '0')}:00:00${utcOffset}`);
  return {
    date,
    primaryAt: at(input.primaryHour),
    fallbackAt: at(input.fallbackHour),
    deadline: at(input.deadlineHour),
  };
};

/**
 * Convert a local wall-clock date and time into an absolute instant.
 *
 * Validate the round trip with all offsets around the date. Reject nonexistent calendar
 * dates and DST gaps/overlaps so a reminder never silently fires at a different wall time.
 */
export const localWallClockInstant = (input: {
  date: string;
  hour: number;
  minute: number;
  timeZone: string;
}) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null;
  if (
    !Number.isSafeInteger(input.hour) ||
    !Number.isSafeInteger(input.minute) ||
    input.hour < 0 ||
    input.hour > 23 ||
    input.minute < 0 ||
    input.minute > 59
  )
    return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  const expected = `${input.date}T${pad(input.hour)}:${pad(input.minute)}:00`;
  try {
    const noon = new Date(`${input.date}T12:00:00Z`);
    const offsets = new Set(
      [-1, 0, 1].map(
        (day) => zonedDateTime(new Date(+noon + day * 86_400_000), input.timeZone).utcOffset,
      ),
    );
    const candidates = [...offsets]
      .map((offset) => new Date(`${expected}${offset}`))
      .filter(
        (instant) =>
          Number.isFinite(+instant) &&
          zonedDateTime(instant, input.timeZone).localDateTime === expected,
      );
    return candidates.length === 1 ? candidates[0]! : null;
  } catch {
    return null;
  }
};
