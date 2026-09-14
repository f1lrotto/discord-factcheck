import { createHash } from 'node:crypto';
import {
  ChannelType,
  DiscordAPIError,
  DefaultRestOptions,
  HTTPError,
  PermissionFlagsBits,
  PermissionsBitField,
  RateLimitError,
  REST,
  Routes,
  type RESTOptions,
} from 'discord.js';
import { z } from 'zod';
import { renderNews } from './render.js';
import type { NewsClock, NewsDestination, NewsPublisher, NewsPublishResult } from './types.js';

const snowflake = z.string().regex(/^[1-9]\d{0,19}$/);
const bits = z
  .string()
  .regex(/^\d{1,30}$/)
  .transform(BigInt);
const channelSchema = z.object({
  id: snowflake,
  guild_id: snowflake,
  type: z.number(),
  permission_overwrites: z.array(
    z.object({
      id: snowflake,
      type: z.union([z.literal(0), z.literal(1)]),
      allow: bits,
      deny: bits,
    }),
  ),
});
const rolesSchema = z.array(
  z.object({ id: snowflake, permissions: bits, mentionable: z.boolean() }),
);
const memberSchema = z.object({ user: z.object({ id: snowflake }), roles: z.array(snowflake) });
const destinationSchema = z.object({
  guildId: snowflake,
  channelId: snowflake,
  notifyRoleId: snowflake.optional(),
});
const receiptSchema = z.object({
  id: snowflake,
  channel_id: snowflake,
  nonce: z.union([z.string(), z.number()]).optional(),
});
const required =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks;

const permissionsIn = (
  channel: z.infer<typeof channelSchema>,
  roles: z.infer<typeof rolesSchema>,
  member: z.infer<typeof memberSchema>,
) => {
  const roleIds = new Set([channel.guild_id, ...member.roles]);
  const base = roles
    .filter((role) => roleIds.has(role.id))
    .reduce((value, role) => value | role.permissions, 0n);
  if ((base & PermissionFlagsBits.Administrator) !== 0n)
    return new PermissionsBitField(PermissionsBitField.All);
  const apply = (value: bigint, overwrites: typeof channel.permission_overwrites) => {
    const deny = overwrites.reduce((value, overwrite) => value | overwrite.deny, 0n);
    const allow = overwrites.reduce((value, overwrite) => value | overwrite.allow, 0n);
    return (value & ~deny) | allow;
  };
  const everyone = channel.permission_overwrites.filter(
    (overwrite) => overwrite.type === 0 && overwrite.id === channel.guild_id,
  );
  const groups = channel.permission_overwrites.filter(
    (overwrite) =>
      overwrite.type === 0 && overwrite.id !== channel.guild_id && roleIds.has(overwrite.id),
  );
  const individual = channel.permission_overwrites.filter(
    (overwrite) => overwrite.type === 1 && overwrite.id === member.user.id,
  );
  return new PermissionsBitField(apply(apply(apply(base, everyone), groups), individual));
};

// The race bounds even a stalled transport. The same signal cancels the underlying REST request;
// every continuation checks it before starting another operation, especially the POST.
const bounded = async <T>(
  timeoutMs: number,
  signals: AbortSignal[],
  operation: (signal: AbortSignal) => Promise<T>,
) => {
  const controller = new AbortController();
  const signal = AbortSignal.any([...signals, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onAbort = () => {};
  try {
    signal.throwIfAborted();
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
      operation(signal),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
};

const rejection = (error: unknown, clock: NewsClock, sending: boolean): NewsPublishResult => {
  if (error instanceof RateLimitError) {
    const delay = Math.max(error.retryAfter, error.timeToReset, error.sublimitTimeout, 1000);
    return {
      outcome: 'rejected',
      retryAt: new Date(clock().getTime() + (Number.isFinite(delay) ? delay : 60_000)),
    };
  }
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    if ([403, 404].includes(error.status)) return { outcome: 'destination-unavailable' };
    if (error.status >= 400 && error.status < 500 && error.status !== 408)
      return { outcome: 'rejected' };
  }
  return { outcome: sending ? 'uncertain' : 'rejected' };
};

export const createNewsDiscordPublisher = ({
  client,
  token,
  timeoutMs = 10_000,
  clock = () => new Date(),
  makeRequest,
}: {
  client: { isReady: () => boolean; user: { id: string } | null };
  token: string;
  timeoutMs?: number;
  clock?: NewsClock;
  makeRequest?: RESTOptions['makeRequest'];
}) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new Error('Invalid news Discord timeout');
  // Same bot token means shared Discord quota, despite separate bucket knowledge. Reject 429s
  // to the durable scheduler; never let REST retry a possibly accepted POST or sleep indefinitely.
  const rest = new REST({
    timeout: timeoutMs,
    retries: 0,
    rejectOnRateLimit: () => true,
    makeRequest: (url, init) => {
      init.signal?.throwIfAborted();
      return (makeRequest ?? DefaultRestOptions.makeRequest)(url, init);
    },
  }).setToken(token);
  const lifetime = new AbortController();
  const ready = () => !lifetime.signal.aborted && client.isReady() && client.user !== null;
  const validate = async (destination: NewsDestination, signal: AbortSignal) => {
    if (!ready() || !destinationSchema.safeParse(destination).success) return false;
    const userId = client.user!.id;
    const get = async (route: `/${string}`) => {
      signal.throwIfAborted();
      const result = await rest.get(route, { signal });
      signal.throwIfAborted();
      return result;
    };
    const channel = channelSchema.parse(await get(Routes.channel(destination.channelId)));
    if (
      channel.id !== destination.channelId ||
      channel.guild_id !== destination.guildId ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    )
      return false;
    const roles = rolesSchema.parse(await get(Routes.guildRoles(destination.guildId)));
    const member = memberSchema.parse(await get(Routes.guildMember(destination.guildId, userId)));
    if (
      member.user.id !== userId ||
      !roles.some((role) => role.id === destination.guildId) ||
      member.roles.some((id) => !roles.some((role) => role.id === id))
    )
      return false;
    const permissions = permissionsIn(channel, roles, member);
    if (!permissions.has(required)) return false;
    if (!destination.notifyRoleId) return true;
    const role = roles.find((role) => role.id === destination.notifyRoleId);
    return Boolean(
      role &&
      role.id !== destination.guildId &&
      (role.mentionable || permissions.has(PermissionFlagsBits.MentionEveryone)),
    );
  };
  const publisher: NewsPublisher = {
    ready,
    validateDestination: async (destination) => {
      try {
        return await bounded(timeoutMs, [lifetime.signal], (signal) =>
          validate(destination, signal),
        );
      } catch {
        return false;
      }
    },
    publish: async ({ destination, content, nonce, signal: callerSignal }) => {
      let sending = false;
      try {
        return await bounded(
          timeoutMs,
          [callerSignal, lifetime.signal],
          async (signal): Promise<NewsPublishResult> => {
            if (!ready() || !nonce) return { outcome: 'rejected' };
            const payload = renderNews(
              content,
              content.kind === 'edition' ? destination.notifyRoleId : undefined,
            );
            if (!(await validate(destination, signal)))
              return { outcome: 'destination-unavailable' };
            signal.throwIfAborted();
            if (!ready()) return { outcome: 'rejected' };
            const stableNonce = createHash('sha256')
              .update(`jolanda-news:${nonce}`)
              .digest('hex')
              .slice(0, 25);
            sending = true;
            const raw = await rest.post(Routes.channelMessages(destination.channelId), {
              body: { ...payload, nonce: stableNonce, enforce_nonce: true },
              signal,
            });
            const receipt = receiptSchema.safeParse(raw);
            if (
              !receipt.success ||
              receipt.data.channel_id !== destination.channelId ||
              (receipt.data.nonce !== undefined && String(receipt.data.nonce) !== stableNonce)
            )
              return { outcome: 'uncertain' };
            return { outcome: 'sent', messageId: receipt.data.id };
          },
        );
      } catch (error) {
        return rejection(error, clock, sending);
      }
    },
  };
  return {
    ...publisher,
    close: () => {
      lifetime.abort();
      rest.clearHashSweeper();
      rest.clearHandlerSweeper();
    },
  };
};
