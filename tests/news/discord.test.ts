import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNewsDiscordPublisher } from '../../src/news/discord.js';
import type { NewsContent, NewsDestination, NewsStory } from '../../src/news/types.js';

const guildId = '100';
const channelId = '200';
const userId = '300';
const groupId = '400';
const notifyRoleId = '500';
const needed =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks;
const destination = { guildId, channelId };
const story: NewsStory = {
  kind: 'story',
  source: 'dennikn',
  id: '1',
  revision: '1',
  important: true,
  title: 'Správa',
  url: 'https://dennikn.sk/minuta/1/',
  publishedAt: new Date('2026-09-14T13:00:00Z'),
};
const daily: NewsContent = {
  kind: 'edition',
  source: 'aktuality',
  id: '2',
  revision: '1',
  title: 'Denný výber',
  url: 'https://www.aktuality.sk/clanok/abc/denny-vyber/',
  publishedAt: story.publishedAt,
  sections: [{ title: 'Správa' }],
};
const response = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const abortablePending = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.useRealTimers();
});

const fixture = (
  options: { timeoutMs?: number; transport?: typeof fetch; clock?: () => Date } = {},
) => {
  const channel = {
    id: channelId,
    guild_id: guildId,
    type: ChannelType.GuildText,
    permission_overwrites: [] as { id: string; type: number; allow: string; deny: string }[],
  };
  const roles = [
    { id: guildId, permissions: String(needed), mentionable: false },
    { id: groupId, permissions: '0', mentionable: false },
    { id: notifyRoleId, permissions: '0', mentionable: true },
  ];
  const member = { user: { id: userId }, roles: [groupId] };
  const client = { isReady: vi.fn(() => true), user: { id: userId } as { id: string } | null };
  const requests: {
    url: string;
    method: string;
    body: Record<string, unknown> | undefined;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const makeRequest = vi.fn<typeof fetch>(async (url, init) => {
    const body = init!.body
      ? (JSON.parse(String(init!.body)) as Record<string, unknown>)
      : undefined;
    requests.push({ url: String(url), method: init!.method!, body, signal: init!.signal });
    if (options.transport) return options.transport(url, init);
    if (init!.method === 'POST')
      return response({ id: '600', channel_id: channelId, nonce: body!.nonce });
    if (String(url).endsWith(`/channels/${channelId}`)) return response(channel);
    if (String(url).endsWith('/roles')) return response(roles);
    if (String(url).endsWith(`/members/${userId}`)) return response(member);
    throw new Error('Unexpected fake Discord request');
  });
  const publisher = createNewsDiscordPublisher({
    client,
    token: 'fake-token',
    makeRequest,
    clock: options.clock ?? (() => new Date('2026-09-14T18:00:00Z')),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  cleanups.push(publisher.close);
  const publish = (
    content: NewsContent = story,
    target: NewsDestination = destination,
    signal = new AbortController().signal,
  ) =>
    publisher.publish({
      destination: target,
      content,
      nonce: 'durable-publication-identity',
      signal,
    });
  return { publisher, publish, requests, makeRequest, channel, roles, member, client };
};
const overwrite = (id: string, type: number, allow = 0n, deny = 0n) => ({
  id,
  type,
  allow: String(allow),
  deny: String(deny),
});

describe('news destination authorization', () => {
  it.each([ChannelType.GuildText, ChannelType.GuildAnnouncement])(
    're-fetches the selected channel, guild roles and bot member for channel type %s',
    async (type) => {
      const f = fixture();
      f.channel.type = type;
      expect(await f.publisher.validateDestination(destination)).toBe(true);
      expect(f.requests.map(({ url }) => new URL(url).pathname)).toEqual([
        '/api/v10/channels/200',
        '/api/v10/guilds/100/roles',
        '/api/v10/guilds/100/members/300',
      ]);
      f.roles[0]!.permissions = '0';
      expect(await f.publisher.validateDestination(destination)).toBe(false);
      expect(f.requests).toHaveLength(6);
    },
  );
  it.each([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])('requires effective selected-channel permission %s', async (permission) => {
    const f = fixture();
    f.channel.permission_overwrites = [overwrite(guildId, 0, 0n, permission)];
    expect(await f.publish()).toEqual({ outcome: 'destination-unavailable' });
    expect(f.requests.every(({ method }) => method === 'GET')).toBe(true);
  });
  it('applies everyone then combined role overwrites then member overwrites', async () => {
    const f = fixture();
    f.channel.permission_overwrites = [
      overwrite(guildId, 0, 0n, needed),
      overwrite(groupId, 0, needed),
      overwrite(userId, 1, 0n, PermissionFlagsBits.SendMessages),
    ];
    expect(await f.publisher.validateDestination(destination)).toBe(false);
    f.channel.permission_overwrites[2] = overwrite(userId, 1, PermissionFlagsBits.SendMessages);
    expect(await f.publisher.validateDestination(destination)).toBe(true);
    f.member.roles.push(notifyRoleId);
    f.channel.permission_overwrites.push(overwrite(notifyRoleId, 0, 0n, needed));
    expect(await f.publisher.validateDestination(destination)).toBe(true);
  });
  it('honors Administrator despite channel overwrite denials', async () => {
    const f = fixture();
    f.roles[1]!.permissions = String(PermissionFlagsBits.Administrator);
    f.channel.permission_overwrites = [overwrite(userId, 1, 0n, needed)];
    expect(await f.publisher.validateDestination({ ...destination, notifyRoleId })).toBe(true);
  });
  it.each([
    ChannelType.DM,
    ChannelType.GuildVoice,
    ChannelType.GuildForum,
    ChannelType.PublicThread,
  ])('rejects unsupported channel type %s', async (type) => {
    const f = fixture();
    f.channel.type = type;
    expect(await f.publisher.validateDestination(destination)).toBe(false);
  });
  it('rejects cross-guild or mismatched channels, missing everyone roles and mismatched members', async () => {
    const f = fixture();
    f.channel.guild_id = '999';
    expect(await f.publisher.validateDestination(destination)).toBe(false);
    f.channel.guild_id = guildId;
    f.channel.id = '999';
    expect(await f.publisher.validateDestination(destination)).toBe(false);
    f.channel.id = channelId;
    f.member.user.id = '999';
    expect(await f.publisher.validateDestination(destination)).toBe(false);
    f.member.user.id = userId;
    f.roles.shift();
    expect(await f.publisher.validateDestination(destination)).toBe(false);
  });
  it('rejects malformed API roles/members and unresolved member role IDs', async () => {
    const f = fixture();
    f.roles[0]!.permissions = 'not-bits';
    expect(await f.publisher.validateDestination(destination)).toBe(false);
    f.roles[0]!.permissions = String(needed);
    f.member.roles = ['999'];
    expect(await f.publisher.validateDestination(destination)).toBe(false);
    f.member.user.id = '';
    expect(await f.publisher.validateDestination(destination)).toBe(false);
  });
  it('requires a fresh explicit mentionable role or selected-channel MentionEveryone permission', async () => {
    const f = fixture();
    const target = { ...destination, notifyRoleId };
    expect(await f.publisher.validateDestination(target)).toBe(true);
    f.roles[2]!.mentionable = false;
    expect(await f.publisher.validateDestination(target)).toBe(false);
    f.channel.permission_overwrites = [overwrite(userId, 1, PermissionFlagsBits.MentionEveryone)];
    expect(await f.publisher.validateDestination(target)).toBe(true);
    expect(await f.publisher.validateDestination({ ...destination, notifyRoleId: guildId })).toBe(
      false,
    );
    f.roles.pop();
    expect(await f.publisher.validateDestination(target)).toBe(false);
  });
  it('rejects invalid destination IDs before network operations', async () => {
    const f = fixture();
    expect(
      await f.publisher.validateDestination({ ...destination, channelId: '../messages' }),
    ).toBe(false);
    expect(f.requests).toEqual([]);
  });
});

describe('news publication reliability', () => {
  it('sends once with a stable bounded nonce and suppresses continuous notifications/mentions', async () => {
    const f = fixture();
    expect(await f.publish()).toEqual({ outcome: 'sent', messageId: '600' });
    const first = f.requests.find(({ method }) => method === 'POST')!;
    expect(first.body).toMatchObject({
      enforce_nonce: true,
      flags: 4096,
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    });
    expect(first.body!.nonce).toMatch(/^[a-f0-9]{25}$/);
    expect(await f.publish()).toEqual({ outcome: 'sent', messageId: '600' });
    expect(
      f.requests.filter(({ method }) => method === 'POST').map(({ body }) => body!.nonce),
    ).toEqual([first.body!.nonce, first.body!.nonce]);
  });
  it('allows only the authorized daily role and rechecks it immediately before sending', async () => {
    const f = fixture();
    const target = { ...destination, notifyRoleId };
    expect(await f.publish(daily, target)).toEqual({ outcome: 'sent', messageId: '600' });
    const body = f.requests.find(({ method }) => method === 'POST')!.body!;
    expect(body).toMatchObject({
      content: '<@&500>',
      allowed_mentions: { parse: [], users: [], roles: ['500'] },
    });
    expect(body.flags).toBeUndefined();
    expect(body.embeds).toHaveLength(1);
    f.roles[2]!.mentionable = false;
    expect(await f.publish(daily, target)).toEqual({ outcome: 'destination-unavailable' });
    expect(f.requests.filter(({ method }) => method === 'POST')).toHaveLength(1);
  });
  it('does not send until ready or after close', async () => {
    const f = fixture();
    f.client.isReady.mockReturnValue(false);
    expect(f.publisher.ready()).toBe(false);
    expect(await f.publish()).toEqual({ outcome: 'rejected' });
    f.client.isReady.mockReturnValue(true);
    f.client.user = null;
    expect(await f.publisher.validateDestination(destination)).toBe(false);
    f.client.user = { id: userId };
    f.publisher.close();
    expect(f.publisher.ready()).toBe(false);
    expect(await f.publish()).toEqual({ outcome: 'rejected' });
    expect(f.requests).toEqual([]);
  });
  it('treats preflight network failures as safely rejected rather than inaccessible', async () => {
    const f = fixture({
      transport: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(await f.publish()).toEqual({ outcome: 'rejected' });
    expect(f.requests).toHaveLength(1);
  });
  it.each([403, 404])('treats confirmed HTTP %s as destination unavailable', async (status) => {
    const f = fixture();
    f.makeRequest.mockImplementationOnce(async () =>
      response({ code: 50013, message: 'Missing permissions' }, status),
    );
    expect(await f.publish()).toEqual({ outcome: 'destination-unavailable' });
  });
  it('rejects a 429 with a finite retry time and never retries inside the publisher', async () => {
    const f = fixture();
    f.makeRequest.mockImplementationOnce(async () =>
      response({ retry_after: 2, global: false }, 429, { 'retry-after': '2' }),
    );
    const result = await f.publish();
    expect(result.outcome).toBe('rejected');
    expect(result).toHaveProperty('retryAt');
    if (result.outcome === 'rejected')
      expect(result.retryAt!.getTime()).toBeGreaterThanOrEqual(
        new Date('2026-09-14T18:00:02Z').getTime(),
      );
    expect(f.makeRequest).toHaveBeenCalledTimes(1);
  });
  it.each(['network', '500', '408', 'malformed', 'wrong-channel', 'wrong-nonce'])(
    'holds ambiguous POST outcome %s without retries',
    async (outcome) => {
      const f = fixture();
      const normal = f.makeRequest.getMockImplementation()!;
      f.makeRequest.mockImplementation(async (url, init) => {
        if (init!.method !== 'POST') return normal(url, init);
        if (outcome === 'network') throw new Error('connection lost after send');
        if (outcome === '500' || outcome === '408')
          return response({ message: 'unknown acceptance', code: 0 }, Number(outcome));
        if (outcome === 'wrong-channel') return response({ id: '600', channel_id: '999' });
        if (outcome === 'wrong-nonce')
          return response({ id: '600', channel_id: channelId, nonce: 'other' });
        return response({ id: '' });
      });
      expect(await f.publish()).toEqual({ outcome: 'uncertain' });
      expect(f.makeRequest.mock.calls.filter(([, init]) => init!.method === 'POST')).toHaveLength(
        1,
      );
    },
  );
  it.each([400, 403, 429])(
    'classifies confirmed POST rejection %s without repeating the request',
    async (status) => {
      const f = fixture();
      const normal = f.makeRequest.getMockImplementation()!;
      f.makeRequest.mockImplementation(async (url, init) =>
        init!.method === 'POST'
          ? response({ code: 50013, message: 'rejected', retry_after: 1 }, status, {
              'retry-after': '1',
            })
          : normal(url, init),
      );
      const result = await f.publish();
      expect(result.outcome).toBe(status === 403 ? 'destination-unavailable' : 'rejected');
      if (status === 429) expect(result).toHaveProperty('retryAt');
      expect(f.makeRequest.mock.calls.filter(([, init]) => init!.method === 'POST')).toHaveLength(
        1,
      );
    },
  );
  it('times out preflight, aborts transport and cannot send after a late response', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const f = fixture({
      timeoutMs: 100,
      transport: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const pending = f.publish();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.requests[0]!.signal!.aborted).toBe(true);
    resolve(response(f.channel));
    expect(await pending).toEqual({ outcome: 'rejected' });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.requests).toHaveLength(1);
  });
  it('bounds validateDestination by aborting a cooperative transport', async () => {
    vi.useFakeTimers();
    const f = fixture({
      timeoutMs: 100,
      transport: async (_url, init) => abortablePending(init!.signal!),
    });
    const pending = f.publisher.validateDestination(destination);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(false);
  });
  it('holds a timed-out POST as uncertain and aborts the underlying request', async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 100 });
    const normal = f.makeRequest.getMockImplementation()!;
    let postSignal: AbortSignal | null | undefined;
    f.makeRequest.mockImplementation(async (url, init) => {
      if (init!.method !== 'POST') return normal(url, init);
      postSignal = init!.signal;
      return abortablePending(init!.signal!);
    });
    const pending = f.publish();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ outcome: 'uncertain' });
    expect(postSignal!.aborted).toBe(true);
    expect(f.makeRequest.mock.calls.filter(([, init]) => init!.method === 'POST')).toHaveLength(1);
  });
  it('never starts a queued POST after its publication deadline aborts', async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 100 });
    const normal = f.makeRequest.getMockImplementation()!;
    let resolveFirst!: (response: Response) => void;
    let postCount = 0;
    f.makeRequest.mockImplementation(async (url, init) => {
      if (init!.method !== 'POST') return normal(url, init);
      postCount += 1;
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });
    const first = f.publish();
    await vi.advanceTimersByTimeAsync(0);
    expect(postCount).toBe(1);
    const second = f.publish();
    await vi.advanceTimersByTimeAsync(100);
    resolveFirst(response({ id: '600', channel_id: channelId }));
    expect(await first).toEqual({ outcome: 'uncertain' });
    expect(await second).toEqual({ outcome: 'rejected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(postCount).toBe(1);
  });
  it('closing aborts in-flight publication requests and preserves uncertain acceptance', async () => {
    const f = fixture();
    const normal = f.makeRequest.getMockImplementation()!;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.makeRequest.mockImplementation(async (url, init) => {
      if (init!.method !== 'POST') return normal(url, init);
      started();
      return abortablePending(init!.signal!);
    });
    const pending = f.publish();
    await sending;
    f.publisher.close();
    expect(await pending).toEqual({ outcome: 'uncertain' });
    expect(f.publisher.ready()).toBe(false);
  });
  it('honors cancellation before preflight and during preflight without admitting a POST', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    expect(await f.publish(story, destination, controller.signal)).toEqual({ outcome: 'rejected' });
    expect(f.requests).toEqual([]);
    const active = new AbortController();
    const normal = f.makeRequest.getMockImplementation()!;
    f.makeRequest.mockImplementation(async (url, init) => {
      const result = await normal(url, init);
      active.abort();
      return result;
    });
    expect(await f.publish(story, destination, active.signal)).toEqual({ outcome: 'rejected' });
    expect(f.makeRequest.mock.calls.every(([, init]) => init!.method !== 'POST')).toBe(true);
  });
  it('checks readiness again after permission reads', async () => {
    const f = fixture();
    const normal = f.makeRequest.getMockImplementation()!;
    f.makeRequest.mockImplementation(async (url, init) => {
      const result = await normal(url, init);
      if (String(url).includes('/members/')) f.client.isReady.mockReturnValue(false);
      return result;
    });
    expect(await f.publish()).toEqual({ outcome: 'rejected' });
    expect(f.requests).toHaveLength(3);
  });
  it('rejects invalid content/empty identity before sending and invalid timeout configuration', async () => {
    const f = fixture();
    expect(await f.publish({ ...story, url: 'http://evil.test' })).toEqual({ outcome: 'rejected' });
    expect(
      await f.publisher.publish({
        destination,
        content: story,
        nonce: '',
        signal: new AbortController().signal,
      }),
    ).toEqual({ outcome: 'rejected' });
    expect(f.requests).toEqual([]);
    expect(() =>
      createNewsDiscordPublisher({ client: f.client, token: 'fake', timeoutMs: Infinity }),
    ).toThrow('Invalid news Discord timeout');
  });
});

describe('news transport cooldown and shutdown regression N07-F1', () => {
  it.each(['global', 'route', 'bucket'])(
    'retains learned %s cooldown without creating timers or surviving close',
    async (scope) => {
      vi.useFakeTimers();
      let now = new Date('2026-09-14T18:00:00Z');
      const f = fixture({ timeoutMs: 100, clock: () => now });
      const headers = {
        'retry-after': '2',
        ...(scope === 'global' ? { 'x-ratelimit-global': 'true' } : {}),
        ...(scope === 'bucket'
          ? {
              'x-ratelimit-bucket': 'channel-bucket',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset-after': '2',
            }
          : {}),
      };
      f.makeRequest.mockImplementationOnce(async () =>
        response({ retry_after: 2, global: scope === 'global' }, 429, headers),
      );
      expect(await f.publisher.validateDestination(destination)).toBe(false);
      expect(await f.publisher.validateDestination(destination)).toBe(false);
      expect(await f.publish()).toEqual({
        outcome: 'rejected',
        retryAt: new Date('2026-09-14T18:00:02Z'),
      });
      expect(f.makeRequest).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      now = new Date('2026-09-14T18:00:02.001Z');
      expect(await f.publish()).toEqual({ outcome: 'sent', messageId: '600' });
      f.publisher.close();
      expect(vi.getTimerCount()).toBe(0);
      const count = f.makeRequest.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.makeRequest).toHaveBeenCalledTimes(count);
    },
  );
  it('learns an exhausted successful bucket and allows unrelated preflight routes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.makeRequest.mockImplementationOnce(async () =>
      response(f.channel, 200, {
        'x-ratelimit-bucket': 'channel',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset-after': '2',
      }),
    );
    expect(await f.publish()).toEqual({ outcome: 'sent', messageId: '600' });
    expect(f.makeRequest).toHaveBeenCalledTimes(4);
    expect(await f.publish()).toEqual({
      outcome: 'rejected',
      retryAt: new Date('2026-09-14T18:00:02Z'),
    });
    expect(f.makeRequest).toHaveBeenCalledTimes(4);
    f.publisher.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shares cooldown across previously mapped bucket routes in the same guild', async () => {
    const f = fixture();
    const normal = f.makeRequest.getMockImplementation()!;
    let exhaust = false;
    f.makeRequest.mockImplementation(async (url, init) => {
      const result = await normal(url, init);
      if (String(url).includes('/guilds/')) {
        result.headers.set('x-ratelimit-bucket', 'shared-guild-bucket');
        if (exhaust && String(url).includes('/members/')) {
          result.headers.set('x-ratelimit-remaining', '0');
          result.headers.set('x-ratelimit-reset-after', '2');
        }
      }
      return result;
    });
    expect(await f.publisher.validateDestination(destination)).toBe(true);
    exhaust = true;
    expect(await f.publisher.validateDestination(destination)).toBe(true);
    const count = f.makeRequest.mock.calls.length;
    expect(await f.publish()).toEqual({
      outcome: 'rejected',
      retryAt: new Date('2026-09-14T18:00:02Z'),
    });
    expect(f.makeRequest).toHaveBeenCalledTimes(count + 1); // Only unrelated channel GET; guild roles are blocked.
  });
  it('retains body-only global Retry-After and a malformed-body header cooldown', async () => {
    const f = fixture();
    f.makeRequest.mockImplementationOnce(async () =>
      response({ retry_after: 3, global: true }, 429),
    );
    expect(await f.publish()).toEqual({
      outcome: 'rejected',
      retryAt: new Date('2026-09-14T18:00:03Z'),
    });
    expect(await f.publish(story, { guildId: '999', channelId: '888' })).toEqual({
      outcome: 'rejected',
      retryAt: new Date('2026-09-14T18:00:03Z'),
    });
    expect(f.makeRequest).toHaveBeenCalledTimes(1);
    const malformed = fixture();
    malformed.makeRequest.mockImplementationOnce(
      async () => new Response('bad json', { status: 429, headers: { 'retry-after': '4' } }),
    );
    expect(await malformed.publish()).toEqual({
      outcome: 'rejected',
      retryAt: new Date('2026-09-14T18:00:04Z'),
    });
  });
  it('aborts a stalled body and remains uncertain after an accepted-status POST', async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 100 });
    const normal = f.makeRequest.getMockImplementation()!;
    const cancel = vi.fn();
    f.makeRequest.mockImplementation(async (url, init) =>
      init!.method === 'POST' ? new Response(new ReadableStream({ cancel })) : normal(url, init),
    );
    const pending = f.publish();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ outcome: 'uncertain' });
    expect(cancel).toHaveBeenCalledTimes(1);
    f.publisher.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves confirmed 429 rejection and header backoff even when its body stalls', async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 100 });
    const normal = f.makeRequest.getMockImplementation()!;
    const cancel = vi.fn();
    f.makeRequest.mockImplementation(async (url, init) =>
      init!.method === 'POST'
        ? new Response(new ReadableStream({ cancel }), {
            status: 429,
            headers: { 'retry-after': '5' },
          })
        : normal(url, init),
    );
    const pending = f.publish();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({
      outcome: 'rejected',
      retryAt: new Date('2026-09-14T18:00:05Z'),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    f.publisher.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds response bodies and rejects authenticated redirect following', async () => {
    const f = fixture();
    const normal = f.makeRequest.getMockImplementation()!;
    f.makeRequest.mockImplementation(async (url, init) => {
      expect(init!.redirect).toBe('error');
      expect(init!.headers).toMatchObject({ Authorization: 'Bot fake-token' });
      return init!.method === 'POST' ? new Response('x'.repeat(1_048_577)) : normal(url, init);
    });
    expect(await f.publish()).toEqual({ outcome: 'uncertain' });
    expect(f.makeRequest).toHaveBeenCalledTimes(4);
  });
});

describe('publisher cancellation joins cooperative response cleanup', () => {
  it.each(['publish-preflight', 'publish-post', 'validate'] as const)(
    'waits for delayed reader cleanup on %s before settling after timeout',
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture({ timeoutMs: 100 });
      const normal = f.makeRequest.getMockImplementation()!;
      const cleanup = gate();
      let cleanupFinished = false;
      const cancel = vi.fn(async () => {
        await cleanup.promise;
        cleanupFinished = true;
      });
      f.makeRequest.mockImplementation(async (url, init) =>
        stage === 'publish-post' && init!.method !== 'POST'
          ? normal(url, init)
          : new Response(new ReadableStream({ cancel })),
      );
      let settled = false;
      const pending = (
        stage === 'validate' ? f.publisher.validateDestination(destination) : f.publish()
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cleanupFinished).toBe(false);
      expect(settled).toBe(false);
      cleanup.release();
      expect(await pending).toEqual(
        stage === 'validate'
          ? false
          : { outcome: stage === 'publish-post' ? 'uncertain' : 'rejected' },
      );
      expect(cleanupFinished).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.makeRequest.mock.calls.filter(([, init]) => init!.method === 'POST')).toHaveLength(
        stage === 'publish-post' ? 1 : 0,
      );
    },
  );
  it.each(['publish', 'validate'] as const)(
    'close aborts %s and its caller drains cleanup before teardown',
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture({ timeoutMs: 100 });
      const cleanup = gate();
      const cancel = vi.fn(async () => cleanup.promise);
      f.makeRequest.mockImplementation(async () => new Response(new ReadableStream({ cancel })));
      let settled = false;
      const pending = (
        stage === 'validate' ? f.publisher.validateDestination(destination) : f.publish()
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      f.publisher.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.publisher.ready()).toBe(false);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      cleanup.release();
      expect(await pending).toEqual(stage === 'validate' ? false : { outcome: 'rejected' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('waits for fetch cancellation cleanup before returning a safe preflight rejection', async () => {
    const cleanup = gate();
    const cancelling = gate();
    const f = fixture({
      transport: async (_url, init) => {
        await new Promise<void>((resolve) =>
          init!.signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        cancelling.release();
        await cleanup.promise;
        throw init!.signal!.reason;
      },
    });
    const controller = new AbortController();
    let settled = false;
    const pending = f.publish(story, destination, controller.signal).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(f.makeRequest).toHaveBeenCalledOnce());
    controller.abort();
    await cancelling.promise;
    expect(settled).toBe(false);
    cleanup.release();
    expect(await pending).toEqual({ outcome: 'rejected' });
    expect(f.makeRequest).toHaveBeenCalledOnce();
  });
  it('joins cleanup for a response arriving after cancellation without admitting another request', async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 100 });
    const cleanup = gate();
    const responseGate = gate();
    const cancel = vi.fn(async () => cleanup.promise);
    f.makeRequest.mockImplementation(async () => {
      await responseGate.promise;
      return new Response(new ReadableStream({ cancel }));
    });
    let settled = false;
    const pending = f.publish().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(100);
    responseGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    cleanup.release();
    expect(await pending).toEqual({ outcome: 'rejected' });
    expect(f.makeRequest).toHaveBeenCalledOnce();
  });
  it.each([403, 429])(
    'waits for cleanup while retaining confirmed POST HTTP %s rejection',
    async (status) => {
      vi.useFakeTimers();
      const f = fixture({ timeoutMs: 100 });
      const normal = f.makeRequest.getMockImplementation()!;
      const cleanup = gate();
      const cancel = vi.fn(async () => cleanup.promise);
      f.makeRequest.mockImplementation(async (url, init) =>
        init!.method !== 'POST'
          ? normal(url, init)
          : new Response(new ReadableStream({ cancel }), {
              status,
              headers: { 'retry-after': '5' },
            }),
      );
      let settled = false;
      const pending = f.publish().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      cleanup.release();
      expect(await pending).toEqual(
        status === 403
          ? { outcome: 'destination-unavailable' }
          : { outcome: 'rejected', retryAt: new Date('2026-09-14T18:00:05Z') },
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(f.makeRequest.mock.calls.filter(([, init]) => init!.method === 'POST')).toHaveLength(
        1,
      );
    },
  );
  it('waits for oversized-body cancellation and contains rejected cleanup without retrying', async () => {
    const f = fixture();
    const normal = f.makeRequest.getMockImplementation()!;
    const cleanup = gate();
    const cancel = vi.fn(async () => {
      await cleanup.promise;
      throw new Error('cleanup rejected');
    });
    f.makeRequest.mockImplementation(async (url, init) =>
      init!.method !== 'POST'
        ? normal(url, init)
        : new Response(
            new ReadableStream({
              start: (controller) => controller.enqueue(new Uint8Array(1_048_577)),
              cancel,
            }),
          ),
    );
    let settled = false;
    const pending = f.publish().then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    cleanup.release();
    expect(await pending).toEqual({ outcome: 'uncertain' });
    expect(f.makeRequest.mock.calls.filter(([, init]) => init!.method === 'POST')).toHaveLength(1);
  });
});
