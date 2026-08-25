import { describe, expect, it } from 'vitest';
import {
  createClockSnapshot,
  timeZoneIsSupported,
  trustedClockContext,
  zonedDateTime,
} from '../src/clock.js';

describe('trusted clock', () => {
  it('formats a stable instant with daylight-saving-aware local context', () => {
    const clock = createClockSnapshot(new Date('2026-08-25T12:34:56.000Z'), 'Europe/Bratislava');

    expect(clock).toEqual({
      instant: '2026-08-25T12:34:56.000Z',
      timeZone: 'Europe/Bratislava',
      localDateTime: '2026-08-25T14:34:56',
      weekday: 'Tuesday',
      utcOffset: '+02:00',
    });
    expect(trustedClockContext(clock)).toContain('Local weekday: Tuesday');
    expect(trustedClockContext(clock)).toContain('today');
  });

  it('represents the same instant in another IANA time zone', () => {
    expect(zonedDateTime(new Date('2026-01-15T12:00:00.000Z'), 'America/New_York')).toMatchObject({
      localDateTime: '2026-01-15T07:00:00',
      utcOffset: '-05:00',
      weekday: 'Thursday',
    });
  });

  it('validates time zones and clock instants', () => {
    expect(timeZoneIsSupported('UTC')).toBe(true);
    expect(timeZoneIsSupported('Not/A_Time_Zone')).toBe(false);
    expect(timeZoneIsSupported('x'.repeat(101))).toBe(false);
    expect(() => zonedDateTime(new Date('invalid'), 'UTC')).toThrow('Invalid clock instant');
    expect(() => zonedDateTime(new Date(), 'Not/A_Time_Zone')).toThrow(
      'Unsupported IANA time zone',
    );
  });
});
