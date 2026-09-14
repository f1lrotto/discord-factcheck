import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, PermissionsBitField, Routes } from 'discord.js';
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

const transportFailure = z.union([
  z.object({ kind: z.literal('rate-limited'), retryAt: z.date() }),
  z.object({ kind: z.literal('http'), status: z.number() }),
]);
const rejection = (error: unknown, sending: boolean): NewsPublishResult => {
  const failure = transportFailure.safeParse(error);
  if (failure.success) {
    if (failure.data.kind === 'rate-limited')
      return { outcome: 'rejected', retryAt: failure.data.retryAt };
    const { status } = failure.data;
    if ([403, 404].includes(status)) return { outcome: 'destination-unavailable' };
    if (status >= 400 && status < 500 && status !== 408) return { outcome: 'rejected' };
  }
  return { outcome: sending ? 'uncertain' : 'rejected' };
};

const readJson = async (response: Response, signal: AbortSignal) => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing Discord response body');
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new Error('Discord response exceeds limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
};

// No automatic retries, timer-based rate-limit sleeps or Discord REST background sweepers.
// Only timestamps persist; callers receive retryAt and the durable scheduler owns backoff.
const createTransport = (token: string, clock: NewsClock, makeRequest: typeof fetch) => {
  const cooldowns = new Map<string, number>();
  const buckets = new Map<string, string>();
  let queue = Promise.resolve();
  const seconds = (value: string | number | null | undefined) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 0;
  };
  return (
    method: 'GET' | 'POST',
    route: string,
    signal: AbortSignal,
    body?: unknown,
    onRejection?: (result: NewsPublishResult) => void,
  ) => {
    const result = queue.then(async () => {
      signal.throwIfAborted();
      const key = `${method}:${route}`;
      const now = clock().getTime();
      for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
      const until = Math.max(
        cooldowns.get('*') ?? 0,
        cooldowns.get(key) ?? 0,
        cooldowns.get(buckets.get(key) ?? key) ?? 0,
      );
      if (until > now) throw { kind: 'rate-limited', retryAt: new Date(until) };
      const response = await makeRequest(`https://discord.com/api/v10${route}`, {
        method,
        signal,
        redirect: 'error',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (signal.aborted) void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
      const receivedAt = clock().getTime();
      const hash = response.headers.get('x-ratelimit-bucket');
      if (hash) buckets.set(key, `${route.split('/').slice(1, 3).join('/')}:${hash}`);
      const bucket = buckets.get(key) ?? key;
      const reset = seconds(response.headers.get('x-ratelimit-reset-after'));
      const retain = (scope: string, delay: number) =>
        cooldowns.set(
          scope,
          Math.max(cooldowns.get(scope) ?? 0, Math.min(receivedAt + delay, 8.64e15)),
        );
      if (response.headers.get('x-ratelimit-remaining') === '0' && reset) retain(bucket, reset);
      if (response.status === 429) {
        const retryHeader = response.headers.get('retry-after');
        const headerDelay =
          seconds(retryHeader) || Math.max(0, Date.parse(retryHeader ?? '') - receivedAt) || 0;
        // Retain known header cooldown even when the 429 body is malformed or stalls.
        const scope = response.headers.has('x-ratelimit-global') ? '*' : bucket;
        const priorCooldown = cooldowns.get(scope) ?? 0;
        retain(scope, Math.max(headerDelay, reset) || 60_000);
        onRejection?.({ outcome: 'rejected', retryAt: new Date(cooldowns.get(scope)!) });
        let raw: unknown;
        try {
          raw = await readJson(response, signal);
        } catch {
          raw = null;
        }
        signal.throwIfAborted();
        const data = z
          .object({ retry_after: z.number().optional(), global: z.boolean().optional() })
          .safeParse(raw);
        const bodyDelay = data.success ? seconds(data.data.retry_after) : 0;
        if (bodyDelay && !headerDelay && !reset) cooldowns.set(scope, priorCooldown);
        const finalScope = data.success && data.data.global ? '*' : scope;
        retain(finalScope, Math.max(headerDelay, reset, bodyDelay) || 60_000);
        const retryAt = new Date(cooldowns.get(finalScope)!);
        onRejection?.({ outcome: 'rejected', retryAt });
        throw { kind: 'rate-limited', retryAt };
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw { kind: 'http', status: response.status };
      }
      return readJson(response, signal);
    });
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
};

export const createNewsDiscordPublisher = ({
  client,
  token,
  timeoutMs = 10_000,
  clock = () => new Date(),
  makeRequest = fetch,
}: {
  client: { isReady: () => boolean; user: { id: string } | null };
  token: string;
  timeoutMs?: number;
  clock?: NewsClock;
  makeRequest?: typeof fetch;
}) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new Error('Invalid news Discord timeout');
  // This token shares Discord quota with AI/media despite independent bucket knowledge.
  const request = createTransport(token, clock, makeRequest);
  const lifetime = new AbortController();
  const ready = () => !lifetime.signal.aborted && client.isReady() && client.user !== null;
  const validate = async (
    destination: NewsDestination,
    signal: AbortSignal,
    onRejection?: (result: NewsPublishResult) => void,
  ) => {
    if (!ready() || !destinationSchema.safeParse(destination).success) return false;
    const userId = client.user!.id;
    const get = async (route: `/${string}`) => {
      signal.throwIfAborted();
      const result = await request('GET', route, signal, undefined, onRejection);
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
      let confirmedRejection: NewsPublishResult | undefined;
      const rememberRejection = (result: NewsPublishResult) => {
        confirmedRejection = result;
      };
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
            if (!(await validate(destination, signal, rememberRejection)))
              return { outcome: 'destination-unavailable' };
            signal.throwIfAborted();
            if (!ready()) return { outcome: 'rejected' };
            const stableNonce = createHash('sha256')
              .update(`jolanda-news:${nonce}`)
              .digest('hex')
              .slice(0, 25);
            sending = true;
            const raw = await request(
              'POST',
              Routes.channelMessages(destination.channelId),
              signal,
              { ...payload, nonce: stableNonce, enforce_nonce: true },
              rememberRejection,
            );
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
        return confirmedRejection ?? rejection(error, sending);
      }
    },
  };
  return {
    ...publisher,
    close: () => {
      lifetime.abort();
    },
  };
};
