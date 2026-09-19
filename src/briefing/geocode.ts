import { z } from 'zod';
import { createJsonHttp, type JsonHttp } from '../net/https.js';
import { citySchema } from './types.js';

export const openMeteoUrl = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    value.length > 2048 ||
    !(
      (url.hostname === 'api.open-meteo.com' && url.pathname === '/v1/forecast') ||
      (url.hostname === 'geocoding-api.open-meteo.com' && url.pathname === '/v1/search')
    )
  )
    throw new Error('malformed');
  return url;
};
export const openMeteoHttp = () =>
  createJsonHttp({ validateUrl: openMeteoUrl, userAgent: 'JolandaBriefing/1.0' });

const responseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string(),
        country_code: z.string(),
      }),
    )
    .max(10)
    .optional(),
});

export const createGeocoder =
  (http: JsonHttp = openMeteoHttp()) =>
  async (name: string, signal: AbortSignal) => {
    if (!name.trim() || name.length > 100) return null;
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({
      name: name.trim(),
      count: '1',
      language: 'sk',
      format: 'json',
    }).toString();
    const result = await http({ url: url.href, signal });
    if (result.outcome !== 'ok') return null;
    const parsed = responseSchema.safeParse(result.json);
    const city = parsed.success ? parsed.data.results?.[0] : undefined;
    if (!city) return null;
    const normalized = citySchema.safeParse({
      name: city.name,
      lat: city.latitude,
      lon: city.longitude,
      timeZone: city.timezone,
      countryCode: city.country_code,
    });
    return normalized.success ? normalized.data : null;
  };
