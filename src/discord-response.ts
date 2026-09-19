import { MessageFlags, type InteractionReplyOptions, type Message } from 'discord.js';
import type { Logger } from 'pino';
import { clampDiscordMarkdown, splitDiscordChunks } from './discord-text.js';
import {
  discordMessageCharacters,
  maximumDiscordChunks,
  streamUpdateIntervalMs,
} from './limits.js';
import { defaultLocale, messages, type Locale } from './i18n/index.js';
import { safeError, sanitizeAssistantOutput } from './security.js';
import type { FailureNotice, ResponseSink } from './types.js';

export const safeMentions = { parse: [] as const, repliedUser: false };
export const safeMessageFlags = MessageFlags.SuppressEmbeds;

export const ephemeral = (content: string): InteractionReplyOptions => ({
  content,
  flags: MessageFlags.Ephemeral,
  allowedMentions: safeMentions,
});

const failureMessage = (failure: FailureNotice, locale: Locale) =>
  messages(locale).failures.notice({
    category: failure.category,
    ...(failure.malformedReason ? { malformedReason: failure.malformedReason } : {}),
    reference: failure.reference.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 12) || 'UNKNOWN',
  });

export const createResponseSink = (input: {
  source: Message<true>;
  logger: Logger;
  protectIdentifier: (identifier: string) => string;
  locale?: Locale;
}): ResponseSink => {
  const copy = messages(input.locale ?? defaultLocale);
  const outputMessages: Message<true>[] = [];
  const renderedChunks: string[] = [];
  // Chunks that already have a successor message are frozen, so a growing stream cannot
  // migrate an earlier boundary and cut a link or an emphasis run that already rendered.
  const sealedChunks: string[] = [];
  let sealedSource = '';
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
      content: copy.progress.thinking,
      allowedMentions: safeMentions,
      flags: safeMessageFlags,
    });
    outputMessages.push(message);
    renderedChunks.push(copy.progress.thinking);
    checkCancellation(signal);
  };

  const prepare = (signal?: AbortSignal) => serialize(() => prepareNow(signal));

  const synchronizeNow = async (
    content: string,
    allowedSourceUrls: readonly string[] = [],
    signal?: AbortSignal,
  ) => {
    await prepareNow(signal);
    const rendered = sanitizeAssistantOutput(clampDiscordMarkdown(content), allowedSourceUrls);
    if (!rendered.startsWith(sealedSource)) {
      sealedChunks.length = 0;
      sealedSource = '';
    }
    const tail = splitDiscordChunks(
      rendered.slice(sealedSource.length),
      discordMessageCharacters,
      maximumDiscordChunks - sealedChunks.length,
    );
    const chunks = [...sealedChunks, ...tail.map((chunk) => chunk.text)];
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
    const sealUpTo = tail.at(-2)?.sourceEnd;
    if (sealUpTo !== undefined) {
      sealedChunks.push(...tail.slice(0, -1).map((chunk) => chunk.text));
      sealedSource = rendered.slice(0, sealedSource.length + sealUpTo);
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
      ? failureMessage(failure, input.locale ?? defaultLocale)
      : copy.failures.generic;
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
