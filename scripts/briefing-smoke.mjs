/* global process, AbortSignal */
import { createGeocoder } from '../dist/briefing/geocode.js';
import { createWeather } from '../dist/briefing/weather.js';
import { renderBriefing } from '../dist/briefing/render.js';

const city = await createGeocoder()(process.argv[2] ?? 'Bratislava', AbortSignal.timeout(15_000));
if (!city) throw new Error('City could not be resolved');
const now = new Date();
const weather = await createWeather()(city, now, AbortSignal.timeout(15_000));
process.stdout.write(
  `${JSON.stringify(renderBriefing({ now, locale: 'sk', cities: [{ city, weather }], agenda: [] }), null, 2)}\n`,
);
if (!weather) process.exitCode = 1;
