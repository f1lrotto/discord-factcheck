import { createAktualitySource } from './sources/aktuality.js';
import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import type { Logger } from 'pino';
import { zonedDateTime } from '../clock.js';
import { safeMentions } from '../discord-response.js';
import { defaultLocale, messages, type Locale } from '../i18n/index.js';
import type { NewsPausedReason, NewsStatusFacts } from '../i18n/shapes.js';
import { NewsDecryptionError } from './cipher.js';
import { dailyCollectionSlot, dailySchedule, newsLocalDate, newsPolicy } from './policy.js';
import type { NewsClock, NewsFeed, NewsPublisher, NewsSourceState, NewsStore } from './types.js';

export type NewsCommandServices = {
  store: NewsStore;
  publisher: Pick<NewsPublisher, 'validateDestination'>;
  enabled: boolean;
  clock?: NewsClock;
  source?: ReturnType<typeof createAktualitySource>;
};
const feeds = ['continuous', 'daily'] as const;
const localTime = (date: Date) => {
  const local = zonedDateTime(date, newsPolicy.timeZone);
  return `${local.localDateTime.replace('T', ' ')} (UTC${local.utcOffset}, Europe/Bratislava)`;
};

const nextCollection = (feed: NewsFeed, source: NewsSourceState, now: Date) => {
  const earliest = new Date(
    Math.max(
      +now,
      +source.nextAttemptAt,
      +(source.backoffUntil ?? now),
      +(source.lease?.expiresAt ?? now),
    ),
  );
  if (feed === 'continuous') return earliest;
  const day = dailySchedule(earliest);
  const state = source.daily ?? { attemptedSlots: [] };
  const candidates = [
    new Date(Math.max(+earliest, +day.primaryAt)),
    day.fallbackAt,
    ...[1, 2].map((retry) => new Date(+day.fallbackAt + retry * newsPolicy.continuousIntervalMs)),
  ];
  for (const candidate of candidates) {
    if (candidate >= earliest && dailyCollectionSlot(candidate, state, source.backoffUntil))
      return candidate;
  }
  return dailySchedule(new Date(+day.deadline + 12 * 60 * 60_000)).primaryAt;
};

export const createNewsCommands = (input: {
  news?: NewsCommandServices;
  logger: Logger;
  protectIdentifier: (value: string) => string;
}) => {
  const { news } = input;
  const queues = new Map<string, Promise<unknown>>();
  const serialized = async <T>(guildId: string, operation: () => Promise<T>) => {
    const previous = queues.get(guildId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    queues.set(guildId, task);
    try {
      return await task;
    } finally {
      if (queues.get(guildId) === task) queues.delete(guildId);
    }
  };
  const log = (event: string, guildId: string, feed?: NewsFeed) =>
    input.logger.info({
      event,
      guildKey: input.protectIdentifier(guildId),
      ...(feed ? { feed } : {}),
    });
  const removeGuild = async (guildId: string) => {
    if (!news) return;
    await serialized(guildId, () => news.store.removeGuild(guildId));
    log('news_guild_removed', guildId);
  };
  const reconcileGuilds = async (
    hasGuild: (guildId: string) => boolean,
    accepting = () => true,
  ) => {
    if (!news) return;
    try {
      const subscriptions = await news.store.listEnabled();
      for (const subscription of subscriptions) {
        if (!accepting()) break;
        try {
          const destination = await news.store.getDestination({
            subscriptionKey: subscription.key,
            revision: subscription.revision,
          });
          if (destination && !hasGuild(destination.guildId)) {
            await serialized(destination.guildId, async () => {
              if (accepting() && !hasGuild(destination.guildId))
                await news.store.removeGuild(destination.guildId);
            });
            log('news_guild_reconciled', destination.guildId);
          }
        } catch {
          input.logger.warn({
            event: 'news_guild_reconciliation_failed',
            subscriptionKey: subscription.key,
          });
        }
      }
    } catch {
      input.logger.warn({ event: 'news_guild_reconciliation_unavailable' });
    }
  };
  const summary = async (guildId: string, locale: Locale = defaultLocale) => {
    const copy = messages(locale);
    if (!news) return copy.news.unavailableDeployment;
    const subscriptions = await Promise.all(
      feeds.map((feed) => news.store.getSubscription({ guildId, feed })),
    );
    return copy.news.summary({
      available: news.enabled,
      feeds: feeds.map((feed, index) => ({
        feed,
        state: subscriptions[index]?.enabled
          ? subscriptions[index]?.pausedReason
            ? copy.news.summaryState.paused
            : copy.news.summaryState.enabled
          : copy.news.summaryState.off,
      })),
    });
  };
  const status = async (guildId: string, feed: NewsFeed, locale: Locale = defaultLocale) => {
    const copy = messages(locale);
    if (!news) return copy.news.unavailable;
    const now = (news.clock ?? (() => new Date()))();
    const [subscription, source] = await Promise.all([
      news.store.getSubscription({ guildId, feed }),
      news.store.getSource(feed === 'continuous' ? 'dennikn' : 'aktuality'),
    ]);
    const counts = subscription
      ? await news.store.getDeliveryCounts(subscription.key)
      : { pending: 0, uncertain: 0 };
    let destination;
    let destinationProblem = false;
    if (subscription?.enabled) {
      try {
        destination = await news.store.getDestination({
          subscriptionKey: subscription.key,
          revision: subscription.revision,
        });
      } catch (error) {
        if (!(error instanceof NewsDecryptionError)) throw error;
        destinationProblem = true;
      }
      if (!destination || destination.guildId !== guildId) {
        destination = null;
        destinationProblem = true;
      }
    }
    const paused: NewsPausedReason =
      subscription?.pausedReason ??
      (destinationProblem
        ? 'destination-unavailable'
        : !news.enabled
          ? 'deployment-disabled'
          : !subscription?.enabled
            ? 'feed-disabled'
            : null);
    const activePause =
      subscription?.pausedReason ?? (destinationProblem ? 'destination-unavailable' : null);
    const edition = source.daily?.collectedEdition;
    const facts: NewsStatusFacts = {
      feed,
      deploymentEnabled: news.enabled,
      configuration: !subscription ? 'missing' : subscription.enabled ? 'enabled' : 'disabled',
      destination: destination
        ? { kind: 'channel', channelId: destination.channelId }
        : destinationProblem
          ? { kind: 'unavailable' }
          : { kind: 'none' },
      ...(destination?.notifyRoleId ? { notifyRoleId: destination.notifyRoleId } : {}),
      paused,
      nextCollectionAt:
        news.enabled && subscription?.enabled && !activePause
          ? localTime(nextCollection(feed, source, now))
          : null,
      ...(source.lastOutcome ? { lastOutcome: source.lastOutcome } : {}),
      lastSuccessAt: source.lastSuccessAt ? localTime(source.lastSuccessAt) : null,
      backoffUntil:
        source.backoffUntil && source.backoffUntil > now ? localTime(source.backoffUntil) : null,
      storedEdition:
        feed === 'daily' && edition
          ? {
              current: newsLocalDate(edition.publishedAt) === newsLocalDate(now),
              collectedAt: localTime(edition.publishedAt),
            }
          : null,
      pending: counts.pending,
      uncertain: counts.uncertain,
    };
    return copy.news.statusLines(facts).join('\n');
  };
  const handle = async (
    interaction: ChatInputCommandInteraction,
    feed: NewsFeed,
    locale: Locale = defaultLocale,
  ) => {
    const copy = messages(locale);
    const edit = (content: string) =>
      interaction.editReply({ content, allowedMentions: safeMentions });
    const action = interaction.options.getSubcommand();
    if (!['feed', 'disable', 'status', ...(feed === 'daily' ? ['run'] : [])].includes(action)) {
      await edit(copy.news.unknownCommand);
      return;
    }
    if (!news) {
      await edit(copy.news.unavailable);
      return;
    }
    const guildId = interaction.guildId!;
    if (action === 'status') {
      await edit(await status(guildId, feed, locale));
      return;
    }
    await serialized(guildId, async () => {
      if (action === 'run') {
        if (!news.enabled) {
          await edit(copy.news.unavailable);
          return;
        }
        const subscription = await news.store.getSubscription({ guildId, feed });
        if (!subscription?.enabled || subscription.pausedReason) {
          await edit(copy.manualRun.unconfigured);
          return;
        }
        const claim = await news.store.claimPoll('aktuality', { manual: true });
        if (!claim) {
          await edit(copy.manualRun.busy);
          return;
        }
        const state = await news.store.getSource('aktuality');
        const now = (news.clock ?? (() => new Date()))();
        const result = await (news.source ?? createAktualitySource())
          .collect({
            now,
            cache: state.cache,
            latest: true,
            signal: AbortSignal.timeout(40_000),
          })
          .catch(() => ({ outcome: 'unavailable' as const }));
        if (!(await news.store.commitPoll(claim, result))) {
          await edit(copy.manualRun.busy);
          return;
        }
        if (result.outcome !== 'edition') {
          await edit(copy.manualRun.unavailable);
          return;
        }
        const queued = await news.store.queueManualEdition({
          guildId,
          requestId: interaction.id,
          revision: subscription.revision,
          edition: result.edition,
        });
        log('news_manual_run', guildId, feed);
        await edit(copy.manualRun[queued]);
        return;
      }
      if (action === 'disable') {
        await news.store.disable({ guildId, feed });
        log('news_feed_disabled', guildId, feed);
        await edit(copy.news.feedDisabled(feed));
        return;
      }
      const channel = interaction.options.getChannel('channel', true);
      const role = feed === 'daily' ? interaction.options.getRole('notify-role') : null;
      const foreignChannel = 'guildId' in channel && channel.guildId !== guildId;
      const foreignRole = role && 'guild' in role && role.guild.id !== guildId;
      if (
        foreignChannel ||
        foreignRole ||
        ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
        role?.id === guildId
      ) {
        await edit(copy.news.invalidDestination);
        return;
      }
      const destination = {
        guildId,
        channelId: channel.id,
        ...(role ? { notifyRoleId: role.id } : {}),
      };
      if (!(await news.publisher.validateDestination(destination))) {
        await edit(copy.news.validationFailed);
        return;
      }
      await news.store.configure({ feed, destination });
      log('news_feed_configured', guildId, feed);
      await edit(
        copy.news.feedConfigured({
          feed,
          channelId: channel.id,
          ...(role ? { notifyRoleId: role.id } : {}),
          deploymentEnabled: news.enabled,
        }),
      );
    });
  };
  return { handle, summary, removeGuild, reconcileGuilds };
};
