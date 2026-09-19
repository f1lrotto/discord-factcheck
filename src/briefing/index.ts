import type { Logger } from 'pino';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { createScheduledRuntime } from '../scheduling/runtime.js';
import type { Locale } from '../i18n/index.js';
import type { NewsDestination, NewsPublishResult } from '../news/types.js';
import type { ReminderStore } from '../reminders.js';
import { briefingDay } from './policy.js';
import { createWeather } from './weather.js';
import { renderBriefing } from './render.js';
import type { BriefingStore } from './types.js';

export type BriefingPublisher = {
  ready: () => boolean;
  validateDestination: (destination: NewsDestination) => Promise<boolean>;
  publishPayload: (input: {
    destination: NewsDestination;
    payload: RESTPostAPIChannelMessageJSONBody;
    nonce: string;
    signal: AbortSignal;
  }) => Promise<NewsPublishResult>;
};
export const createBriefingRuntime = (input: {
  store: BriefingStore;
  publisher: BriefingPublisher;
  logger: Logger;
  reminders?: ReminderStore;
  locale: (guildId: string) => Promise<Locale>;
  weather?: ReturnType<typeof createWeather>;
  now?: () => Date;
}) => {
  const weather = input.weather ?? createWeather(undefined, input.logger);
  const now = input.now ?? (() => new Date());
  return createScheduledRuntime({
    enabled: true,
    logger: input.logger,
    name: 'briefing',
    tick: async (signal) => {
      if (!input.publisher.ready()) return;
      for (const subscription of await input.store.subscriptions()) {
        signal.throwIfAborted();
        try {
          const date = now();
          const claim = await input.store.claim(subscription, date);
          if (!claim) continue;
          const destination = input.store.destination(subscription);
          if (!destination) continue;
          const locale = await input.locale(destination.guildId).catch(() => 'sk' as const);
          const controller = new AbortController();
          const boundedSignal = AbortSignal.any([signal, controller.signal]);
          const timer = setTimeout(() => controller.abort(), 25_000);
          let cities;
          try {
            cities = await Promise.all(
              subscription.cities.map(async (city) => ({
                city,
                weather: await weather(city, date, boundedSignal).catch(() => null),
              })),
            );
          } finally {
            clearTimeout(timer);
          }
          let agendaUnavailable = false;
          const agenda = input.reminders
            ? await input.reminders
                .dueInWindow({
                  guildId: destination.guildId,
                  channelId: destination.channelId,
                  ...briefingDay(date),
                })
                .catch(() => {
                  agendaUnavailable = true;
                  return [];
                })
            : [];
          signal.throwIfAborted();
          const route = await input.store.beginSend(claim, now());
          if (!route) continue;
          let result: NewsPublishResult;
          try {
            result = await input.publisher.publishPayload({
              destination: route,
              payload: renderBriefing({ now: date, locale, cities, agenda, agendaUnavailable }),
              nonce: claim.key,
              signal,
            });
          } catch {
            result = { outcome: 'uncertain' };
          }
          await input.store.finishSend(claim, result, now());
        } catch {
          // A broken destination must not suppress other guilds. No raw routing or texts in logs.
          input.logger.warn({
            event: 'briefing_delivery_failed',
            subscriptionKey: subscription._id,
          });
        }
      }
    },
  });
};
