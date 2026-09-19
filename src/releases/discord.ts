import { PermissionFlagsBits } from 'discord.js';
import type { Logger } from 'pino';
import { safeMessageFlags } from '../discord-response.js';
import { discordOperationTimeoutMs } from '../limits.js';
import type { createNewsDiscordPublisher } from '../news/discord.js';
import type { Locale } from '../i18n/index.js';
import { safeError } from '../security.js';
import { currentRelease, renderRelease } from './current.js';
import type { createReleaseStore } from './store.js';

const releasePermissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;

export const createReleaseAnnouncements = (input: {
  publisher: Pick<
    ReturnType<typeof createNewsDiscordPublisher>,
    'validateDestination' | 'publishPayload'
  >;
  store: ReturnType<typeof createReleaseStore>;
  resolveLocale: (guildId: string) => Promise<Locale>;
  logger: Logger;
  protectIdentifier: (value: string) => string;
  isAccepting: () => boolean;
}) => {
  const announce = async (guildId: string) => {
    try {
      if (!input.isAccepting()) return 'skipped' as const;
      const subscription = await input.store.get(guildId);
      if (!subscription?.enabled) return 'skipped' as const;
      const destination = input.store.destination(subscription);
      if (!destination || destination.guildId !== guildId) return 'skipped' as const;
      if (!(await input.publisher.validateDestination(destination, releasePermissions))) {
        input.logger.warn({
          event: 'release_announcement_unavailable',
          guildKey: subscription._id,
        });
        return 'failed' as const;
      }
      const content = renderRelease(await input.resolveLocale(guildId));
      if (!input.isAccepting() || !(await input.store.beginSend(subscription, currentRelease.id)))
        return 'skipped' as const;

      const result = await input.publisher.publishPayload({
        destination,
        payload: { content, allowed_mentions: { parse: [] }, flags: safeMessageFlags },
        nonce: `release:${subscription._id}:${currentRelease.id}`,
        signal: AbortSignal.timeout(discordOperationTimeoutMs),
        requiredPermissions: releasePermissions,
      });
      const outcome = result.outcome === 'destination-unavailable' ? 'rejected' : result.outcome;
      await input.store.finishSend(subscription, currentRelease.id, outcome);
      input.logger.info({
        event: 'release_announcement',
        releaseId: currentRelease.id,
        guildKey: subscription._id,
        outcome,
      });
      return outcome === 'sent' ? ('sent' as const) : ('failed' as const);
    } catch (error) {
      input.logger.error({
        event: 'release_announcement_failed',
        guildKey: input.protectIdentifier(guildId),
        error: safeError(error),
      });
      return 'failed' as const;
    }
  };

  return {
    store: input.store,
    announce,
    validateDestination: (destination: Parameters<typeof input.publisher.validateDestination>[0]) =>
      input.publisher.validateDestination(destination, releasePermissions),
  };
};

export type ReleaseAnnouncements = ReturnType<typeof createReleaseAnnouncements>;
