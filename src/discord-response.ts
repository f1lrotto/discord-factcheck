import { MessageFlags, type InteractionReplyOptions, type Message } from 'discord.js';
import type { Logger } from 'pino';
import { clampDiscordMarkdown, splitDiscordMessage } from './discord-text.js';
import { streamUpdateIntervalMs } from './limits.js';
import { safeError, sanitizeAssistantOutput } from './security.js';
import type { FailureNotice, ResponseSink } from './types.js';

export const safeMentions = { parse: [] as const, repliedUser: false };
export const safeMessageFlags = MessageFlags.SuppressEmbeds;

export const ephemeral = (content: string): InteractionReplyOptions => ({
  content,
  flags: MessageFlags.Ephemeral,
  allowedMentions: safeMentions,
});

const failureMessage = (failure: FailureNotice) => {
  const stage = 'answer generation';
  const reason = {
    timeout: `${stage[0]?.toLocaleUpperCase('en-US')}${stage.slice(1)} timed out.`,
    rate_limited: `OpenRouter rate-limited the ${stage}.`,
    authentication: 'OpenRouter rejected the bot credentials.',
    payment_required: 'OpenRouter rejected the request for billing reasons.',
    request_rejected: `OpenRouter rejected the ${stage} request.`,
    provider_unavailable: `No model provider was available for ${stage}.`,
    provider_failure: `The model provider failed during ${stage}.`,
    malformed_response: `OpenRouter returned an invalid response during ${stage}.`,
    network_failure: `The connection to OpenRouter failed during ${stage}.`,
    cancelled: 'The request was cancelled.',
    unknown: 'I could not finish that response.',
  }[failure.category];
  const reference = failure.reference.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 12) || 'UNKNOWN';
  return `⚠️ ${reason} Please try again. Reference: \`${reference}\`.`;
};

export const createResponseSink = (input: {
  source: Message<true>;
  logger: Logger;
  protectIdentifier: (identifier: string) => string;
}): ResponseSink => {
  const outputMessages: Message<true>[] = [];
  const renderedChunks: string[] = [];
  let lastUpdateAt = 0;
  let renderQueue = Promise.resolve();

  const serialize = <Value>(operation: () => Promise<Value>) => {
    const result = renderQueue.then(operation, operation);
    renderQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const checkCancellation = (signal?: AbortSignal) => signal?.throwIfAborted();

  const prepareNow = async (signal?: AbortSignal) => {
    checkCancellation(signal);
    if (outputMessages.length) return;
    const message = await input.source.reply({
      content: 'Jolanda is thinking…',
      allowedMentions: safeMentions,
      flags: safeMessageFlags,
    });
    outputMessages.push(message);
    renderedChunks.push('Jolanda is thinking…');
    checkCancellation(signal);
  };

  const prepare = (signal?: AbortSignal) => serialize(() => prepareNow(signal));

  const synchronizeNow = async (
    content: string,
    allowedSourceUrls: readonly string[] = [],
    signal?: AbortSignal,
  ) => {
    await prepareNow(signal);
    const chunks = splitDiscordMessage(
      sanitizeAssistantOutput(clampDiscordMarkdown(content), allowedSourceUrls),
    );
    if (!chunks.length) return;
    if (!input.source.channel.isSendable()) throw new Error('Discord channel is not sendable');

    for (const [index, chunk] of chunks.entries()) {
      checkCancellation(signal);
      const existing = outputMessages[index];
      if (existing) {
        if (renderedChunks[index] !== chunk) {
          await existing.edit({
            content: chunk,
            allowedMentions: safeMentions,
            flags: safeMessageFlags,
          });
          renderedChunks[index] = chunk;
          checkCancellation(signal);
        }
        continue;
      }
      const message = await input.source.channel.send({
        content: chunk,
        allowedMentions: safeMentions,
        flags: safeMessageFlags,
      });
      outputMessages.push(message);
      renderedChunks.push(chunk);
      checkCancellation(signal);
    }
    while (outputMessages.length > chunks.length) {
      checkCancellation(signal);
      const surplus = outputMessages.at(-1);
      if (!surplus) break;
      await surplus.delete();
      outputMessages.pop();
      renderedChunks.pop();
      checkCancellation(signal);
    }
    lastUpdateAt = Date.now();
  };

  const update = async (
    content: string,
    allowedSourceUrls: readonly string[] = [],
    signal?: AbortSignal,
  ) => {
    if (Date.now() - lastUpdateAt < streamUpdateIntervalMs) return;
    try {
      await serialize(() => synchronizeNow(content, allowedSourceUrls, signal));
    } catch (error) {
      input.logger.info({
        event: 'discord_stream_update_failed',
        error: safeError(error),
        messageKey: input.protectIdentifier(input.source.id),
      });
    }
  };

  const finish = async (
    content: string,
    allowedSourceUrls: readonly string[] = [],
    signal?: AbortSignal,
  ) => {
    await serialize(() => synchronizeNow(content, allowedSourceUrls, signal));
    return outputMessages.map((message) => message.id);
  };

  const fail = async (
    partialContent: string,
    allowedSourceUrls: readonly string[] = [],
    failure?: FailureNotice,
    signal?: AbortSignal,
  ) => {
    const notice = failure
      ? failureMessage(failure)
      : '⚠️ I could not finish that response. Please try again.';
    try {
      await serialize(() =>
        synchronizeNow(
          partialContent.trim() ? `${partialContent.trim()}\n\n${notice}` : notice,
          allowedSourceUrls,
          signal,
        ),
      );
    } catch (error) {
      input.logger.error({
        event: 'discord_failure_notice_failed',
        error: safeError(error),
        messageKey: input.protectIdentifier(input.source.id),
      });
    }
  };

  return { prepare, update, finish, fail };
};
