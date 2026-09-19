import { messages, type Locale } from '../i18n/index.js';
export const wmo = (code: number, locale: Locale) => {
  const copy = messages(locale).weather;
  if (code === 0) return `☀️ ${copy.clear}`;
  if (code === 1 || code === 2) return `🌤️ ${copy.partlyCloudy}`;
  if (code === 3) return `☁️ ${copy.overcast}`;
  if ([45, 48].includes(code)) return `🌫️ ${copy.fog}`;
  if ([51, 53, 55].includes(code)) return `🌦️ ${copy.drizzle}`;
  if ([56, 57, 66, 67].includes(code)) return `🌧️ ${copy.freezingRain}`;
  if ([61, 63, 65, 80, 81, 82].includes(code)) return `🌧️ ${copy.rain}`;
  if ([71, 73, 75, 77, 85, 86].includes(code)) return `🌨️ ${copy.snow}`;
  if ([95, 96, 99].includes(code)) return `⛈️ ${copy.thunderstorm}`;
  return `🌡️ ${copy.unknown}`;
};
