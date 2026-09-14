import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import type { Logger } from 'pino';
import { zonedDateTime } from '../clock.js';
import { safeMentions } from '../discord-response.js';
import { NewsDecryptionError } from './cipher.js';
import { dailyCollectionSlot, dailySchedule, newsLocalDate, newsPolicy } from './policy.js';
import type { NewsClock, NewsFeed, NewsPublisher, NewsSourceState, NewsStore } from './types.js';

export type NewsCommandServices = {
  store: NewsStore;
  publisher: Pick<NewsPublisher, 'validateDestination'>;
  enabled: boolean;
  clock?: NewsClock;
};
const feeds = ['continuous', 'daily'] as const;
const label = { continuous: 'Continuous · Denník N', daily: 'Daily · Aktuality.sk' };
const localTime = (date: Date) => {
  const local = zonedDateTime(date, newsPolicy.timeZone);
  return `${local.localDateTime.replace('T', ' ')} (UTC${local.utcOffset}, Europe/Bratislava)`;
};
const outcomeLabel = (source: NewsSourceState) => {
  const outcomes = {
    stories: 'Stories collected',
    edition: 'Editorial edition collected',
    unchanged: 'Source unchanged',
    empty: 'No items or edition found',
    stale: 'No fresh edition found',
    malformed: 'Source parser failed',
    'access-denied': 'Publisher denied access',
    'rate-limited': 'Publisher rate limit',
    unavailable: 'Publisher unavailable',
    timeout: 'Source request timed out',
    cancelled: 'Collection cancelled',
  };
  return source.lastOutcome ? outcomes[source.lastOutcome] : 'Not collected yet';
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
  const candidates = [new Date(Math.max(+earliest, +day.primaryAt)), day.fallbackAt];
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
  const summary = async (guildId: string) => {
    if (!news) return 'News: **unavailable in this deployment**';
    const subscriptions = await Promise.all(
      feeds.map((feed) => news.store.getSubscription({ guildId, feed })),
    );
    return `News deployment: **${news.enabled ? 'available' : 'disabled'}** · ${feeds.map((feed, index) => `${feed}: ${subscriptions[index]?.enabled ? (subscriptions[index]?.pausedReason ? 'paused' : 'enabled') : 'off'}`).join(' · ')}. Use /jolanda continuous status or /jolanda daily status for details.`;
  };
  const status = async (guildId: string, feed: NewsFeed) => {
    if (!news) return 'News is unavailable in this deployment.';
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
    const paused =
      subscription?.pausedReason || (destinationProblem ? 'destination-unavailable' : undefined);
    const edition = source.daily?.collectedEdition;
    return [
      `**${label[feed]} news**`,
      `Deployment switch: **${news.enabled ? 'enabled' : 'disabled'}**`,
      `Configuration: **${!subscription ? 'not configured' : subscription.enabled ? 'enabled' : 'disabled'}**`,
      `Destination: ${destination ? `<#${destination.channelId}>` : destinationProblem ? 'unavailable; configure the feed again' : 'none'}`,
      `Notifications: ${feed === 'continuous' ? 'silent; no mentions' : destination?.notifyRoleId ? `normal channel behavior; explicit role <@&${destination.notifyRoleId}>` : 'normal channel behavior; no role ping'}`,
      `Delivery paused: **${paused ?? (!news.enabled ? 'deployment disabled' : !subscription?.enabled ? 'feed disabled' : 'no')}**`,
      `Next collection: ${news.enabled && subscription?.enabled && !paused ? localTime(nextCollection(feed, source, now)) : 'not scheduled for this subscription'}`,
      `Last source outcome: **${outcomeLabel(source)}**`,
      `Last successful collection: ${source.lastSuccessAt ? localTime(source.lastSuccessAt) : 'never'}`,
      ...(source.backoffUntil && source.backoffUntil > now
        ? [`Source backoff until: ${localTime(source.backoffUntil)}`]
        : []),
      ...(feed === 'daily'
        ? [
            `Stored edition: ${edition ? `${newsLocalDate(edition.publishedAt) === newsLocalDate(now) ? 'current day' : 'older day'} · ${localTime(edition.publishedAt)} (collected, not a delivery receipt)` : 'none; no fresh edition is stored'}`,
          ]
        : []),
      `Pending deliveries: **${counts.pending}** · Uncertain deliveries: **${counts.uncertain}**`,
      ...(counts.uncertain ? ['Uncertain deliveries are held to avoid duplicate messages.'] : []),
    ].join('\n');
  };
  const handle = async (interaction: ChatInputCommandInteraction, feed: NewsFeed) => {
    const edit = (content: string) =>
      interaction.editReply({ content, allowedMentions: safeMentions });
    const action = interaction.options.getSubcommand();
    if (!['feed', 'disable', 'status'].includes(action)) {
      await edit('Unknown news command.');
      return;
    }
    if (!news) {
      await edit('News is unavailable in this deployment.');
      return;
    }
    const guildId = interaction.guildId!;
    if (action === 'status') {
      await edit(await status(guildId, feed));
      return;
    }
    await serialized(guildId, async () => {
      if (action === 'disable') {
        await news.store.disable({ guildId, feed });
        log('news_feed_disabled', guildId, feed);
        await edit(
          `${label[feed]} feed disabled. Stored routing has been removed; already sent messages remain in Discord.`,
        );
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
        await edit(
          'Choose a text or announcement channel in this server and an optional role other than @everyone.',
        );
        return;
      }
      const destination = {
        guildId,
        channelId: channel.id,
        ...(role ? { notifyRoleId: role.id } : {}),
      };
      if (!(await news.publisher.validateDestination(destination))) {
        await edit(
          'I could not validate that destination. I need View Channel, Send Messages and Embed Links there. An optional notification role must still exist and be mentionable, or I need Mention Everyone in that channel.',
        );
        return;
      }
      await news.store.configure({ feed, destination });
      log('news_feed_configured', guildId, feed);
      await edit(
        `${label[feed]} feed enabled in <#${channel.id}>.${feed === 'continuous' ? ' Posts are silent and do not mention anyone.' : role ? ` Daily editions may notify <@&${role.id}> once; member notification settings still apply.` : ' Daily editions use normal channel notifications without a role ping.'}${news.enabled ? '' : ' Collection and delivery remain disabled while the deployment switch is off.'}`,
      );
    });
  };
  return { handle, summary, removeGuild, reconcileGuilds };
};
