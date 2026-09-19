import { ChannelType, type Client, type Message } from 'discord.js';
import type { Logger } from 'pino';
import type { Jolanda } from './jolanda.js';
import {
  createSlidingWindowGate,
  discordOperationTimeoutMs,
  messageLinkLookupsPerMinute,
} from './limits.js';
import { createResponseSink, safeMentions, safeMessageFlags } from './discord-response.js';
import { minimizeDiscordContent, parseJolandaPrompt, stripJolandaMention } from './discord-text.js';
import { messages } from './i18n/index.js';
import { conversationReplyLimit } from './limits.js';
import { safeError } from './security.js';
import type { JolandaStore } from './types.js';
import { collectImageAttachments } from './discord-images.js';
import { imageLimits } from './image-limits.js';

const withDeadline = <Value>(
  operation: Promise<Value>,
  timeoutMs: number,
  trackOperation: (task: Promise<unknown>) => void,
) => {
  trackOperation(operation);
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error('Discord operation exceeded the configured timeout'))),
      timeoutMs,
    );
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

export const createMessageHandler = (input: {
  client: Client;
  promptsPerMinute: number;
  jolanda: Jolanda;
  store: JolandaStore;
  logger: Logger;
  protectIdentifier: (identifier: string) => string;
  operationTimeoutMs?: number;
}) => {
  const lookupGate = createSlidingWindowGate(messageLinkLookupsPerMinute);
  const promptGate = createSlidingWindowGate(input.promptsPerMinute + 1);
  const operationTimeoutMs = input.operationTimeoutMs ?? discordOperationTimeoutMs;

  return async (
    message: Message,
    trackOperation: (task: Promise<unknown>) => void = () => undefined,
  ) => {
    if (!message.inGuild() || message.author.bot || message.webhookId) return;
    const botUser = input.client.user;
    if (!botUser) return;

    const explicitlyMentioned =
      message.content.includes(`<@${botUser.id}>`) || message.content.includes(`<@!${botUser.id}>`);
    const replyMessageId = message.reference?.messageId;
    const userKey = input.protectIdentifier(message.author.id);
    let referencesJolanda = false;
    if (replyMessageId) {
      if (!lookupGate.tryAcquire(userKey)) return;
      try {
        referencesJolanda = Boolean(
          await withDeadline(
            input.store.findConversationByMessage({
              messageId: replyMessageId,
              guildId: message.guildId,
              channelId: message.channelId,
            }),
            operationTimeoutMs,
            trackOperation,
          ),
        );
      } catch (error) {
        input.logger.info({
          event: 'discord_link_lookup_unavailable',
          error: safeError(error),
          messageKey: input.protectIdentifier(message.id),
        });
        return;
      }
    }
    if (!explicitlyMentioned && !referencesJolanda) return;
    if (!promptGate.tryAcquire(userKey)) return;

    // Read settings only once the message is known to be for Jolanda, so ordinary channel
    // traffic never costs a settings lookup.
    const copy = messages((await input.store.getSettings(message.guildId)).locale);
    const parsedPrompt = parseJolandaPrompt(stripJolandaMention(message.content, botUser.id));
    if (!parsedPrompt.ok) {
      await withDeadline(
        message.reply({
          content: copy.commands.contextSyntax,
          allowedMentions: safeMentions,
          flags: safeMessageFlags,
        }),
        operationTimeoutMs,
        trackOperation,
      );
      return;
    }

    let referencedMessage: Message<true> | undefined;
    if (replyMessageId) {
      try {
        const fetched = await withDeadline(
          message.fetchReference(),
          operationTimeoutMs,
          trackOperation,
        );
        if (fetched.inGuild()) referencedMessage = fetched;
      } catch (error) {
        input.logger.info({
          event: 'discord_reference_unavailable',
          error: safeError(error),
          messageKey: input.protectIdentifier(message.id),
        });
      }
    }

    if (!explicitlyMentioned && !referencesJolanda) return;
    const question = minimizeDiscordContent(parsedPrompt.question);
    const images = [
      ...collectImageAttachments(message.attachments?.values() ?? [], 'latest_message'),
      ...collectImageAttachments(referencedMessage?.attachments?.values() ?? [], 'replied_message'),
    ];
    const outcome = await input.jolanda.handleTurn(
      {
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        question,
        remindersSupported: [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(
          message.channel.type,
        ),
        ...(images.length ? { images } : {}),
        ...(parsedPrompt.ambientContext ? { ambientContext: parsedPrompt.ambientContext } : {}),
        ...(replyMessageId
          ? {
              referencedMessage: {
                id: replyMessageId,
                content: minimizeDiscordContent(referencedMessage?.content ?? ''),
                isJolanda: referencesJolanda,
              },
            }
          : {}),
        loadAmbientContext: async (limit) => {
          const fetched = await withDeadline(
            message.channel.messages.fetch({
              before: message.id,
              limit: Math.min(100, limit * 2),
            }),
            operationTimeoutMs,
            trackOperation,
          );
          return fetched
            .filter((candidate) => !candidate.author.bot && Boolean(candidate.content.trim()))
            .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
            .last(limit)
            .map((candidate) => ({
              id: candidate.id,
              content: minimizeDiscordContent(candidate.content),
            }));
        },
      },
      createResponseSink({
        source: message,
        logger: input.logger,
        protectIdentifier: input.protectIdentifier,
        locale: copy.locale,
      }),
    );

    if (outcome.status !== 'rejected' || outcome.reason === 'duplicate') return;
    try {
      await withDeadline(
        message.reply({
          content: copy.rejections(
            input.promptsPerMinute,
            imageLimits.count,
            conversationReplyLimit,
          )[outcome.reason],
          allowedMentions: safeMentions,
          flags: safeMessageFlags,
        }),
        operationTimeoutMs,
        trackOperation,
      );
    } catch (error) {
      input.logger.error({
        event: 'discord_rejection_failed',
        error: safeError(error),
        messageKey: input.protectIdentifier(message.id),
      });
    }
  };
};
