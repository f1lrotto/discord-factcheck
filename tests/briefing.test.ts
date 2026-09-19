import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createWeather, parseWeather, weatherFields } from '../src/briefing/weather.js';
import { createGeocoder, openMeteoUrl } from '../src/briefing/geocode.js';
import { slovakCalendar, easterSunday } from '../src/briefing/calendar.js';
import { namedays } from '../src/briefing/namedays.js';
import { briefingSchedule, briefingDay } from '../src/briefing/policy.js';
import { renderBriefing } from '../src/briefing/render.js';
import { createBriefingRuntime } from '../src/briefing/index.js';
import { wmo } from '../src/briefing/wmo.js';
import type { BriefingStore } from '../src/briefing/types.js';
import type { ReminderStore } from '../src/reminders.js';

const now = new Date('2026-09-15T05:00:00Z');
const city = {
  name: 'Bratislava',
  lat: 48.15,
  lon: 17.11,
  timeZone: 'Europe/Bratislava',
  countryCode: 'SK',
};
// Synthetic provider fixture in the configured city's local time.
const fixture = () => ({
  hourly: {
    time: Array.from({ length: 72 }, (_, index) =>
      new Date(Date.UTC(2026, 8, 14, index)).toISOString().slice(0, 16),
    ),
    temperature_2m: Array.from({ length: 72 }, (_, index) => index / 2),
  },
  daily: Object.fromEntries([
    ['time', ['2026-09-14', '2026-09-15']],
    ...weatherFields.map((field) => [
      field,
      field === 'sunrise'
        ? ['2026-09-14T06:27', '2026-09-15T06:28']
        : field === 'sunset'
          ? ['2026-09-14T19:06', '2026-09-15T19:04']
          : field === 'daylight_duration'
            ? [45567, 45360]
            : [20, 23],
    ]),
  ]),
});

describe('briefing adapters', () => {
  it('requests every daily field once and retains yesterday for daylight delta', async () => {
    const http = vi.fn().mockResolvedValue({ outcome: 'ok', json: fixture() });
    const weather = await createWeather(http)(city, now, new AbortController().signal);
    expect(weather).toMatchObject({ max: 23, daylightDelta: -207, sunrise: '2026-09-15T06:28' });
    const url = new URL(http.mock.calls[0]![0].url);
    expect(url.searchParams.get('past_days')).toBe('1');
    expect(url.searchParams.get('forecast_days')).toBe('2');
    expect(url.searchParams.get('hourly')).toBe('temperature_2m');
    expect(url.searchParams.get('timezone')).toBe(city.timeZone);
    expect(url.searchParams.get('models')).toBe('best_match');
    expect(url.searchParams.get('daily')?.split(',')).toHaveLength(12);
    expect(url.searchParams.has('guildId')).toBe(false);
    http.mockResolvedValue({ outcome: 'unavailable' });
    expect(await createWeather(http)(city, now, new AbortController().signal)).toBeNull();
  });
  it('selects local temperatures every two hours, including the following midnight', async () => {
    const weather = parseWeather(fixture(), '2026-09-15')!;
    expect(weather.hourly).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        time: `${String(6 + index * 2).padStart(2, '0')}:00`,
        temperature: 15 + index,
      })),
    );
    const http = vi.fn().mockResolvedValue({ outcome: 'ok', json: fixture() });
    expect(
      await createWeather(http)(
        city,
        new Date('2026-09-14T23:00:00Z'),
        new AbortController().signal,
      ),
    ).toMatchObject({ hourly: weather.hourly });
  });
  it.each(['2026-01-31', '2026-12-31', '2026-03-29', '2026-10-25'])(
    'selects the following local midnight across the boundary on %s',
    (date) => {
      const data = fixture();
      const yesterday = new Date(`${date}T12:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const tomorrow = new Date(`${date}T12:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      data.daily.time = [yesterday.toISOString().slice(0, 10), date];
      data.hourly = {
        time: [`${date}T00:00`, `${date}T06:00`, `${tomorrow.toISOString().slice(0, 10)}T00:00`],
        temperature_2m: [99, 0, -2],
      };
      const hours = parseWeather(data, date)!.hourly;
      expect(hours[0]).toEqual({ time: '06:00', temperature: 0 });
      expect(hours[1]).toEqual({ time: '08:00', temperature: null });
      expect(hours[9]).toEqual({ time: '24:00', temperature: -2 });
    },
  );
  it('keeps daily weather when hourly data is unavailable and marks missing temperatures', () => {
    expect(parseWeather({ daily: fixture().daily }, '2026-09-15')).toMatchObject({
      max: 23,
      hourly: [],
    });
    for (const hourly of [
      undefined,
      null,
      {},
      { time: ['2026-09-15T06:00'], temperature_2m: [] },
      { time: ['2026-09-15T06:00'], temperature_2m: ['warm'] },
      { time: ['2026-09-15T06:00'], temperature_2m: [1e100] },
    ]) {
      expect(parseWeather({ ...fixture(), hourly }, '2026-09-15')).toMatchObject({
        max: 23,
        hourly: [],
      });
    }
    const weather = parseWeather(
      { ...fixture(), hourly: { time: ['2026-09-15T06:00'], temperature_2m: [null] } },
      '2026-09-15',
    )!;
    expect(weather.hourly).toHaveLength(10);
    expect(weather.hourly.every(({ temperature }) => temperature === null)).toBe(true);
    const payload = renderBriefing({ now, locale: 'sk', cities: [{ city, weather }], agenda: [] });
    expect(payload.embeds[0]!.description).toContain('06:00 **—**');
  });
  it.each(['timeout', 'unavailable'] as const)('recovers from a temporary %s', async (outcome) => {
    const http = vi
      .fn()
      .mockResolvedValueOnce({ outcome })
      .mockResolvedValueOnce({ outcome: 'ok', json: fixture() });
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(
      await createWeather(http, logger)(city, now, new AbortController().signal),
    ).toMatchObject({ max: 23 });
    expect(http).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith({
      event: 'briefing_weather_completed',
      outcome: 'ok',
      attempts: 2,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it('bounds retries and records the final failure without location or routing data', async () => {
    const http = vi.fn().mockRejectedValue(new Error('network'));
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(await createWeather(http, logger)(city, now, new AbortController().signal)).toBeNull();
    expect(http).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'briefing_weather_completed',
      outcome: 'unavailable',
      attempts: 2,
    });
  });
  it('respects rate limits, long Retry-After, invalid data and cancellation', async () => {
    for (const result of [
      { outcome: 'rate-limited' },
      { outcome: 'access-denied' },
      { outcome: 'malformed' },
      { outcome: 'unavailable', retryAt: new Date(Date.now() + 60_000) },
      { outcome: 'ok', json: {} },
    ]) {
      const http = vi.fn().mockResolvedValue(result);
      const logger = { info: vi.fn(), warn: vi.fn() };
      expect(await createWeather(http, logger)(city, now, new AbortController().signal)).toBeNull();
      expect(http).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: result.outcome === 'ok' ? 'invalid-data' : result.outcome,
        }),
      );
    }
    const controller = new AbortController();
    const http = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    expect(await createWeather(http)(city, now, controller.signal)).toBeNull();
    expect(await createWeather(http)(city, now, controller.signal)).toBeNull();
    expect(http).toHaveBeenCalledOnce();
    const duringDelay = new AbortController();
    const unavailable = vi.fn().mockImplementation(async () => {
      setTimeout(() => duringDelay.abort(), 10);
      return { outcome: 'unavailable' as const };
    });
    expect(await createWeather(unavailable)(city, now, duringDelay.signal)).toBeNull();
    expect(unavailable).toHaveBeenCalledOnce();
  });
  it('rejects invalid, truncated or misaligned weather data', () => {
    expect(parseWeather({}, '2026-09-15')).toBeNull();
    expect(parseWeather(fixture(), '2026-09-16')).toBeNull();
    const short = fixture();
    short.daily.temperature_2m_max = [3];
    expect(parseWeather(short, '2026-09-15')).toBeNull();
    const missing = fixture();
    missing.daily.temperature_2m_max = [2, null];
    expect(parseWeather(missing, '2026-09-15')).toBeNull();
    const wrongDay = fixture();
    wrongDay.daily.time = ['2026-09-12', '2026-09-15'];
    expect(parseWeather(wrongDay, '2026-09-15')).toBeNull();
    const yesterdayMissing = fixture();
    yesterdayMissing.daily.daylight_duration = [null, 3];
    expect(parseWeather(yesterdayMissing, '2026-09-15')).toBeNull();
    const unequal = fixture();
    unequal.daily.time = ['2026-09-14', '2026-09-15', '2026-09-16'];
    expect(parseWeather(unequal, '2026-09-15')).toBeNull();
  });
  it('geocodes once at configuration time and validates coordinates and timezone', async () => {
    const http = vi.fn().mockResolvedValue({
      outcome: 'ok',
      json: {
        results: [
          {
            name: 'Bratislava',
            latitude: 48.15,
            longitude: 17.11,
            timezone: 'Europe/Bratislava',
            country_code: 'SK',
          },
        ],
      },
    });
    const geocode = createGeocoder(http),
      signal = new AbortController().signal;
    expect(await geocode('Bratislava', signal)).toEqual(city);
    expect(http).toHaveBeenCalledOnce();
    expect(await geocode('', signal)).toBeNull();
    expect(await geocode('a'.repeat(101), signal)).toBeNull();
    for (const json of [
      {},
      { results: [] },
      { results: [{}] },
      {
        results: [
          { name: 'x', latitude: 900, longitude: 0, timezone: 'invalid', country_code: 'SK' },
        ],
      },
    ]) {
      http.mockResolvedValue({ outcome: 'ok', json });
      expect(await geocode('x', signal)).toBeNull();
    }
    http.mockResolvedValue({ outcome: 'unavailable' });
    expect(await geocode('x', signal)).toBeNull();
  });
  it.each([
    'http://api.open-meteo.com/v1/forecast',
    'https://api.open-meteo.com.evil.test/v1/forecast',
    'https://api.open-meteo.com/private',
    'https://user:pass@api.open-meteo.com/v1/forecast',
    'https://api.open-meteo.com:999/v1/forecast',
    'https://127.0.0.1/v1/search',
  ])('rejects nonallowlisted request %s', (url) => expect(() => openMeteoUrl(url)).toThrow());
  it('allows only the forecast and geocoder endpoints', () => {
    expect(openMeteoUrl('https://api.open-meteo.com/v1/forecast?latitude=48').hostname).toBe(
      'api.open-meteo.com',
    );
    expect(openMeteoUrl('https://geocoding-api.open-meteo.com/v1/search?name=x').hostname).toBe(
      'geocoding-api.open-meteo.com',
    );
  });
});

describe('offline calendar and schedule', () => {
  it('covers all 366 calendar dates using the official name order', () => {
    expect(Object.keys(namedays)).toHaveLength(366);
    expect(slovakCalendar('2026-09-15', 'sk').names).toEqual(['Jolana']);
    expect(slovakCalendar('2028-02-29', 'sk').names).toEqual(['Radomír']);
    expect(slovakCalendar('2026-01-01', 'en').names).toEqual([]);
    expect(slovakCalendar('2026-02-30', 'en').names).toEqual([]);
  });
  it.each([
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2028, '2028-04-16'],
    [2000, '2000-04-23'],
  ])('calculates Easter for %s', (year, date) =>
    expect(easterSunday(Number(year)).toISOString().slice(0, 10)).toBe(date),
  );
  it('distinguishes state holidays, religious holidays and year-specific days off', () => {
    expect(slovakCalendar('2026-09-15', 'sk').holidays[0]).toMatchObject({
      stateHoliday: false,
      dayOff: false,
    });
    expect(slovakCalendar('2027-09-15', 'en').holidays[0]?.dayOff).toBe(true);
    expect(slovakCalendar('2026-05-08', 'en').holidays[0]?.dayOff).toBe(false);
    expect(slovakCalendar('2026-11-17', 'en').holidays[0]).toMatchObject({
      stateHoliday: true,
      dayOff: false,
    });
    expect(slovakCalendar('2026-09-01', 'en').holidays[0]?.dayOff).toBe(false);
    expect(slovakCalendar('2026-10-28', 'en').holidays[0]?.dayOff).toBe(false);
    expect(slovakCalendar('2024-03-29', 'sk').holidays[0]?.name).toBe('Veľký piatok');
    expect(slovakCalendar('2024-04-01', 'en').holidays[0]?.name).toBe('Easter Monday');
  });
  it.each([
    ['2026-03-29', '04:00:00.000Z', 23],
    ['2026-10-25', '05:00:00.000Z', 25],
  ])('uses the post-transition offset on %s and correct agenda day length', (day, utc, hours) => {
    const date = new Date(`${day}T04:00:00Z`),
      schedule = briefingSchedule(date),
      window = briefingDay(date);
    expect(schedule.primaryAt.toISOString()).toBe(`${day}T${utc}`);
    expect(+window.to - +window.from).toBe(Number(hours) * 3_600_000);
  });
});

describe('briefing rendering', () => {
  it.each(['sk', 'en'] as const)(
    'renders independent sections in %s within one embed',
    (locale) => {
      const weather = parseWeather(fixture(), '2026-09-15')!;
      const payload = renderBriefing({
        now,
        locale,
        cities: [
          { city, weather },
          { city: { ...city, name: '**@everyone**' }, weather: null },
        ],
        agenda: [{ id: 'a', text: 'Invoice @everyone', createdAt: now, dueAt: now }],
      });
      expect(payload.embeds).toHaveLength(1);
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      const description = payload.embeds[0]!.description!;
      expect(description).toContain('Jolana');
      expect(description).toContain('3m 27s');
      expect(description).not.toContain('@everyone');
      expect(description).not.toContain('undefined');
      expect(description).toContain('🌡️ 06:00 **15 °C** · 08:00 **16 °C**');
      expect(description).toContain('\n🌡️ 16:00 **20 °C**');
      expect(description).toContain('24:00 **24 °C**');
      const maximum = renderBriefing({
        now,
        locale,
        cities: Array.from({ length: 5 }, () => ({
          city: { ...city, name: '*'.repeat(100) },
          weather: {
            ...weather,
            hourly: weather.hourly.map((hour) => ({ ...hour, temperature: -100 })),
          },
        })),
        agenda: Array.from({ length: 20 }, () => ({
          id: 'a',
          text: '*'.repeat(280),
          createdAt: now,
          dueAt: now,
        })),
      });
      expect(maximum.embeds[0]!.description!.length).toBeLessThanOrEqual(4096);
      expect(
        renderBriefing({
          now,
          locale,
          cities: [{ city, weather: null }],
          agenda: [],
          agendaUnavailable: true,
        }).embeds[0]!.description,
      ).toContain('Jolana');
      expect(
        renderBriefing({
          now: new Date('2026-01-01'),
          locale,
          cities: [
            {
              city,
              weather: { ...weather, sunrise: null, sunset: null, rain: 1, daylightDelta: 42 },
            },
          ],
          agenda: [],
        }).embeds[0]!.description,
      ).toContain('—');
    },
  );
  it('handles all WMO code categories in both languages', () => {
    for (const locale of ['sk', 'en'] as const)
      for (const code of [
        0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85,
        86, 95, 96, 99, -1,
      ])
        expect(wmo(code, locale)).not.toContain('undefined');
  });
});

describe('briefing runtime', () => {
  const setup = () => {
    const subscription = { _id: 's', enabled: true, hour: 7, revision: 1, cities: [city] };
    const claim = { key: 'k', owner: 'o', date: '2026-09-15', subscription };
    const store = {
      subscriptions: vi.fn().mockResolvedValue([subscription]),
      claim: vi.fn().mockResolvedValue(claim),
      destination: vi.fn().mockReturnValue({ guildId: 'g', channelId: 'c' }),
      beginSend: vi.fn().mockResolvedValue({ guildId: 'g', channelId: 'c' }),
      finishSend: vi.fn(),
    } as unknown as BriefingStore;
    const publisher = {
      ready: vi.fn(() => true),
      validateDestination: vi.fn(),
      publishPayload: vi.fn().mockResolvedValue({ outcome: 'sent', messageId: 'm' }),
    };
    const weather = vi.fn().mockRejectedValue(new Error('offline'));
    const reminders = {
      dueInWindow: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as ReminderStore;
    const locale = vi.fn().mockRejectedValue(new Error('offline'));
    const runtime = createBriefingRuntime({
      store,
      publisher,
      weather,
      reminders,
      locale,
      logger: pino({ enabled: false }),
      now: () => now,
    });
    return { store, publisher, weather, reminders, locale, runtime };
  };
  it('still sends calendar when weather, agenda and locale reads fail', async () => {
    const s = setup();
    await s.runtime.start();
    await s.runtime.shutdown();
    expect(s.publisher.publishPayload.mock.calls[0]![0].payload.embeds[0].description).toContain(
      'Jolana',
    );
    expect(s.reminders.dueInWindow).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'g', channelId: 'c' }),
    );
    expect(s.store.finishSend).toHaveBeenCalledWith(
      expect.anything(),
      { outcome: 'sent', messageId: 'm' },
      now,
    );
  });
  it('keeps ambiguous delivery uncertain and catches subscription failures', async () => {
    const s = setup();
    s.publisher.publishPayload.mockRejectedValue(new Error('timeout'));
    await s.runtime.tick();
    expect(s.store.finishSend).toHaveBeenCalledWith(
      expect.anything(),
      { outcome: 'uncertain' },
      now,
    );
    vi.mocked(s.store.claim).mockRejectedValue(new Error('db'));
    await s.runtime.tick();
  });
  it('skips unavailable publisher, lost claims and destinations', async () => {
    const s = setup();
    s.publisher.ready.mockReturnValue(false);
    await s.runtime.tick();
    expect(s.store.claim).not.toHaveBeenCalled();
    s.publisher.ready.mockReturnValue(true);
    vi.mocked(s.store.subscriptions).mockResolvedValueOnce([]);
    await s.runtime.tick();
    expect(s.store.claim).not.toHaveBeenCalled();
    vi.mocked(s.store.claim).mockResolvedValueOnce(null);
    await s.runtime.tick();
    vi.mocked(s.store.destination).mockReturnValueOnce(null);
    await s.runtime.tick();
    vi.mocked(s.store.beginSend).mockResolvedValueOnce(null);
    await s.runtime.tick();
    expect(s.publisher.publishPayload).not.toHaveBeenCalled();
  });
});
