import { dailySlotSchedule, localWallClockInstant, localDate } from '../scheduling/slots.js';
export const briefingTimeZone = 'Europe/Bratislava';
export const defaultBriefingHour = 6;
export const briefingSchedule = (instant: Date, hour = defaultBriefingHour) =>
  dailySlotSchedule({
    instant,
    timeZone: briefingTimeZone,
    primaryHour: hour,
    fallbackHour: hour + 1,
    deadlineHour: hour + 2,
  });
export const briefingDay = (instant: Date) => {
  const date = localDate(instant, briefingTimeZone);
  const tomorrow = new Date(`${date}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return {
    from: localWallClockInstant({ date, hour: 0, minute: 0, timeZone: briefingTimeZone })!,
    to: localWallClockInstant({
      date: tomorrow.toISOString().slice(0, 10),
      hour: 0,
      minute: 0,
      timeZone: briefingTimeZone,
    })!,
  };
};
