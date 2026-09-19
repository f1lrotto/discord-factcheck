import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { JsonHttp, JsonHttpResult } from '../net/https.js';
import { localDate } from '../scheduling/slots.js';
import { openMeteoHttp } from './geocode.js';
import type { BriefingCity } from './types.js';

const values = z.array(z.number().finite().nullable()).min(2).max(4);
const dailySchema = z.object({
  time: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .min(2)
    .max(4),
  weather_code: values,
  temperature_2m_max: values,
  temperature_2m_min: values,
  apparent_temperature_max: values,
  precipitation_sum: values,
  precipitation_probability_max: values,
  wind_speed_10m_max: values,
  wind_gusts_10m_max: values,
  uv_index_max: values,
  sunrise: z
    .array(
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
        .nullable(),
    )
    .min(2)
    .max(4),
  sunset: z
    .array(
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
        .nullable(),
    )
    .min(2)
    .max(4),
  daylight_duration: values,
});
export const weatherFields = Object.keys(dailySchema.shape).filter((field) => field !== 'time');
const hourlySchema = z
  .object({
    time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)).max(100),
    temperature_2m: z.array(z.number().min(-100).max(100).nullable()).max(100),
  })
  .refine((hourly) => hourly.time.length === hourly.temperature_2m.length);
export type Weather = {
  code: number;
  min: number;
  max: number;
  feels: number;
  rain: number;
  probability: number;
  wind: number;
  gusts: number;
  uv: number;
  sunrise: string | null;
  sunset: string | null;
  daylight: number;
  daylightDelta: number;
  hourly: { time: string; temperature: number | null }[];
};
export const parseWeather = (json: unknown, date: string): Weather | null => {
  const parsed = z.object({ daily: dailySchema, hourly: z.unknown().optional() }).safeParse(json);
  if (!parsed.success) return null;
  const daily = parsed.data.daily;
  const index = daily.time.indexOf(date);
  if (index < 1 || Object.values(daily).some((values) => values.length !== daily.time.length))
    return null;
  const yesterday = new Date(`${date}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (daily.time[index - 1] !== yesterday.toISOString().slice(0, 10)) return null;
  const numberAt = (field: keyof typeof daily) => daily[field][index];
  if (
    weatherFields
      .filter((field) => field !== 'sunrise' && field !== 'sunset')
      .some((field) => typeof numberAt(field as keyof typeof daily) !== 'number') ||
    daily.daylight_duration[index - 1] === null
  )
    return null;
  const hourly = hourlySchema.safeParse(parsed.data.hourly);
  const tomorrow = new Date(`${date}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return {
    code: daily.weather_code[index]!,
    min: daily.temperature_2m_min[index]!,
    max: daily.temperature_2m_max[index]!,
    feels: daily.apparent_temperature_max[index]!,
    rain: daily.precipitation_sum[index]!,
    probability: daily.precipitation_probability_max[index]!,
    wind: daily.wind_speed_10m_max[index]!,
    gusts: daily.wind_gusts_10m_max[index]!,
    uv: daily.uv_index_max[index]!,
    sunrise: daily.sunrise[index] ?? null,
    sunset: daily.sunset[index] ?? null,
    daylight: daily.daylight_duration[index]!,
    daylightDelta: daily.daylight_duration[index]! - daily.daylight_duration[index - 1]!,
    hourly: hourly.success
      ? Array.from({ length: 10 }, (_, index) => {
          const hour = 6 + index * 2;
          const time = `${String(hour).padStart(2, '0')}:00`;
          const timestamp =
            hour === 24 ? `${tomorrow.toISOString().slice(0, 10)}T00:00` : `${date}T${time}`;
          return {
            time,
            temperature: hourly.data.temperature_2m[hourly.data.time.indexOf(timestamp)] ?? null,
          };
        })
      : [],
  };
};
export const createWeather =
  (http: JsonHttp = openMeteoHttp(), logger?: Pick<Logger, 'info' | 'warn'>) =>
  async (city: BriefingCity, now: Date, signal: AbortSignal) => {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude: String(city.lat),
      longitude: String(city.lon),
      timezone: city.timeZone,
      daily: weatherFields.join(','),
      hourly: 'temperature_2m',
      past_days: '1',
      forecast_days: '2',
      models: 'best_match',
    }).toString();
    let outcome: JsonHttpResult['outcome'] | 'invalid-data' = 'cancelled';
    let attempts = 0;
    // Two 10-second requests plus a short delay fit inside the runtime's 25-second budget.
    // Never retry a provider's longer Retry-After or a rejected/malformed response.
    while (attempts < 2 && !signal.aborted) {
      attempts++;
      const result = await http({ url: url.href, signal }).catch((): JsonHttpResult => ({
        outcome: signal.aborted ? 'cancelled' : 'unavailable',
      }));
      if (result.outcome === 'ok') {
        const weather = parseWeather(result.json, localDate(now, city.timeZone));
        if (weather) {
          logger?.info({ event: 'briefing_weather_completed', outcome: 'ok', attempts });
          return weather;
        }
        outcome = 'invalid-data';
        break;
      }
      outcome = result.outcome;
      if (attempts === 2 || !['timeout', 'unavailable'].includes(outcome)) break;
      const retryMs = Math.max(500, result.retryAt ? +result.retryAt - Date.now() : 0);
      if (retryMs > 1_000) break;
      await delay(retryMs, undefined, { signal }).catch(() => undefined);
    }
    logger?.warn({
      event: 'briefing_weather_completed',
      outcome: signal.aborted ? 'cancelled' : outcome,
      attempts,
    });
    return null;
  };
