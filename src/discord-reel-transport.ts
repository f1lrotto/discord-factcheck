import { MessagePayload, REST, Routes, type Message, type MessageReplyOptions } from 'discord.js';
import { discordOperationTimeoutMs } from './limits.js';

export type ReelDiscordTransport = {
  close?: () => void;
  fetchContent: (message: Message<true>) => Promise<string | null>;
  reply: (message: Message<true>, options: MessageReplyOptions) => Promise<{ id: string }>;
};

// Media must not wait indefinitely behind AI sends or Discord rate-limit retries.
// This REST client uses the same bot identity but owns its finite media requests.
export const createReelDiscordTransport = (
  token: string,
  rest = new REST({
    timeout: discordOperationTimeoutMs,
    retries: 0,
    rejectOnRateLimit: () => true,
  }).setToken(token),
): ReelDiscordTransport => ({
  close: () => {
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
  },
  fetchContent: async (message) => {
    const raw = await rest.get(Routes.channelMessage(message.channelId, message.id), {
      signal: AbortSignal.timeout(discordOperationTimeoutMs),
    });
    return typeof raw === 'object' && raw && 'content' in raw && typeof raw.content === 'string'
      ? raw.content
      : null;
  },
  reply: async (message, options) => {
    const payload = await MessagePayload.create(message, {
      ...options,
      reply: { messageReference: message.id, failIfNotExists: true },
    }).resolveBody();
    await payload.resolveFiles();
    const raw = await rest.post(Routes.channelMessages(message.channelId), {
      body: payload.body,
      files: payload.files!,
      signal: AbortSignal.timeout(discordOperationTimeoutMs),
    });
    if (typeof raw !== 'object' || !raw || !('id' in raw) || typeof raw.id !== 'string')
      throw new Error('Invalid Discord media receipt');
    return { id: raw.id };
  },
});
