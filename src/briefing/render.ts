import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { messages, type Locale } from '../i18n/index.js';
import { formatLongDate, formatTime, formatDuration } from '../i18n/format.js';
import { text } from '../news/render.js';
import { localDate } from '../scheduling/slots.js';
import type { Reminder } from '../reminders.js';
import { slovakCalendar } from './calendar.js';
import { briefingTimeZone } from './policy.js';
import type { BriefingCity } from './types.js';
import type { Weather } from './weather.js';
import { wmo } from './wmo.js';

export type BriefingContent = {
  now: Date;
  locale: Locale;
  cities: { city: BriefingCity; weather: Weather | null }[];
  agenda: Reminder[];
  agendaUnavailable?: boolean;
};
export const renderBriefing = ({
  now,
  locale,
  cities,
  agenda,
  agendaUnavailable,
}: BriefingContent) => {
  const copy = messages(locale).briefing;
  const calendar = slovakCalendar(localDate(now, briefingTimeZone), locale);
  const sections = cities.slice(0, 5).map(({ city, weather }) => {
    const name = text(`${city.name} (${city.countryCode})`, 100);
    if (!weather) return copy.weatherUnavailable(name);
    const sun = `${weather.sunrise?.slice(11) ?? '—'} → ${weather.sunset?.slice(11) ?? '—'}`;
    return [
      `**${name}** · ${Math.round(weather.min)} → ${Math.round(weather.max)} °C (${copy.feels(`${Math.round(weather.feels)} °C`)})`,
      `${wmo(weather.code, locale)} · ${copy.rain({ millimetres: weather.rain, probability: weather.probability })}`,
      `${copy.wind({ speed: weather.wind, gusts: weather.gusts })} · ${copy.uv(weather.uv)}`,
      `☀️ ${sun} · ${copy.daylight({ duration: formatDuration(locale, weather.daylight), delta: formatDuration(locale, Math.abs(weather.daylightDelta)), shorter: weather.daylightDelta < 0 })}`,
      ...[weather.hourly.slice(0, 5), weather.hourly.slice(5)]
        .filter((hours) => hours.length)
        .map(
          (hours) =>
            `🌡️ ${hours.map(({ time, temperature }) => `${time} **${temperature === null ? '—' : `${Math.round(temperature)} °C`}**`).join(' · ')}`,
        ),
    ].join('\n');
  });
  sections.push(`🎉 ${calendar.names.length ? copy.namedays(calendar.names) : copy.noNameday}`);
  for (const holiday of calendar.holidays) sections.push(`🇸🇰 ${copy.holiday(holiday)}`);
  if (agenda.length)
    sections.push(
      `🔔 ${copy.agenda(agenda.slice(0, 5).map((reminder) => ({ id: reminder.id, dueAt: formatTime(locale, reminder.dueAt, briefingTimeZone), text: text(reminder.text, 100) })))}`,
    );
  if (agenda.length > 5) sections.push(copy.moreAgenda(agenda.length - 5));
  if (agendaUnavailable) sections.push(copy.agendaUnavailable);
  return {
    embeds: [
      {
        title: `☀️ ${copy.greeting(formatLongDate(locale, now, briefingTimeZone))}`,
        description: sections.join('\n\n'),
        footer: { text: 'Open-Meteo · CC BY 4.0' },
      },
    ],
    allowed_mentions: { parse: [] },
  } satisfies RESTPostAPIChannelMessageJSONBody;
};
