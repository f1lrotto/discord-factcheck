export type ClockSnapshot = ReturnType<typeof createClockSnapshot>;

const dateTimeParts = (instant: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const offset = value('timeZoneName').replace(/^GMT/u, '') || '+00:00';
  return {
    localDateTime: `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`,
    weekday: value('weekday'),
    utcOffset: offset,
  };
};

export const timeZoneIsSupported = (timeZone: string) => {
  if (!timeZone || timeZone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

export const zonedDateTime = (instant: Date, timeZone: string) => {
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid clock instant');
  if (!timeZoneIsSupported(timeZone)) throw new Error('Unsupported IANA time zone');
  return {
    instant: instant.toISOString(),
    timeZone,
    ...dateTimeParts(instant, timeZone),
  };
};

export const createClockSnapshot = (instant: Date, timeZone: string) =>
  zonedDateTime(new Date(instant), timeZone);

export const trustedClockContext = (clock: ClockSnapshot) => `Trusted turn clock:
- Request instant (UTC): ${clock.instant}
- Default IANA time zone: ${clock.timeZone}
- Local date and time: ${clock.localDateTime}${clock.utcOffset}
- Local weekday: ${clock.weekday}
Interpret relative dates such as "today", "tomorrow", and "this week" from this clock. Use an available datetime or time-zone tool when exact temporal conversion is needed.`;
