import type { Client, Message } from 'discord.js';
import type { Logger } from 'pino';
import type { Jolanda } from './jolanda.js';
import {
  createSlidingWindowGate,
  discordOperationTimeoutMs,
  messageLinkLookupsPerMinute,
} from './limits.js';
import { createResponseSink, safeMentions, safeMessageFlags } from './discord-response.js';
import { minimizeDiscordContent, parseJolandaPrompt, stripJolandaMention } from './discord-text.js';
import { safeError } from './security.js';
import type { JolandaStore, TurnOutcome } from './types.js';

const rejectionMessages = (promptsPerMinute: number) =>
  ({
    empty_question: 'Please include a question when you tag me or reply to me.',
    expired_conversation: 'That conversation has expired. Tag me in a new message to start again.',
    conversation_busy: 'I am already answering in that conversation. Please wait for it to finish.',
    conversation_limit:
      'This conversation reached its limit of 10 Jolanda replies. Tag me to start a new one.',
    conversation_owner:
      'Only the person who started that conversation can continue it. Tag me in a new message to start your own.',
    context_limit:
      'That context request exceeds this server’s per-interaction limit. Use a smaller +context value or ask an administrator to change /jolanda context-limit.',
    server_busy: 'Jolanda is at her concurrency limit. Please try again after an answer finishes.',
    shutting_down: 'Jolanda is restarting. Please try again in a moment.',
    duplicate: '',
    rate_limited: `You can send at most ${promptsPerMinute} prompts in a rolling minute. Please wait a moment.`,
    daily_budget:
      'Jolanda has reached the server’s daily spending limit. Please try again tomorrow.',
    monthly_budget: 'Jolanda has reached the server’s monthly spending limit.',
  }) satisfies Record<
    Exclude<TurnOutcome, { status: 'completed' } | { status: 'failed' }>['reason'],
    string
  >;

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

    const parsedPrompt = parseJolandaPrompt(stripJolandaMention(message.content, botUser.id));
    if (!parsedPrompt.ok) {
      await withDeadline(
        message.reply({
          content: 'Use `+context` or `+context=N` at the beginning of your question.',
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
    const outcome = await input.jolanda.handleTurn(
      {
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        question,
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
      }),
    );

    if (outcome.status !== 'rejected' || outcome.reason === 'duplicate') return;
    try {
      await withDeadline(
        message.reply({
          content: rejectionMessages(input.promptsPerMinute)[outcome.reason],
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
