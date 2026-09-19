import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createCommandHandler } from '../src/discord-commands.js';
import { currentRelease, renderRelease } from '../src/releases/current.js';
import { createReleaseAnnouncements } from '../src/releases/discord.js';
import type { createReleaseStore, ReleaseSubscription } from '../src/releases/store.js';
import type { NewsPublishResult } from '../src/news/types.js';
import type { JolandaStore } from '../src/types.js';

const guildId = 'guild';
const channelId = 'channel';
const route = { guildId, channelId };
const subscription: ReleaseSubscription = {
  _id: 'protected-guild',
  revision: 1,
  destination: { version: 1, nonce: 'nonce', ciphertext: 'ciphertext', tag: 'tag' },
  enabled: true,
};

const fixture = (
  options: {
    accepting?: boolean;
    outcome?: 'sent' | 'rejected' | 'uncertain' | 'destination-unavailable';
  } = {},
) => {
  let saved: ReleaseSubscription | null = subscription;
  let destination = route;
  const outcome = options.outcome ?? 'sent';
  const result: NewsPublishResult =
    outcome === 'sent' ? { outcome, messageId: 'message' } : { outcome };
  const publisher = {
    validateDestination: vi.fn(async () => true),
    publishPayload: vi.fn(async () => result),
  };
  const store = {
    get: vi.fn(async () => saved),
    destination: vi.fn(() => destination),
    configure: vi.fn(async (next: typeof route) => {
      destination = next;
      saved = { ...subscription, revision: (saved?.revision ?? 0) + 1 };
      return saved;
    }),
    disable: vi.fn(async () => {
      saved = saved ? { ...saved, enabled: false } : null;
    }),
    beginSend: vi.fn(async () => true),
    finishSend: vi.fn(async () => {}),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createReleaseAnnouncements({
    publisher,
    store: store as unknown as ReturnType<typeof createReleaseStore>,
    resolveLocale: async () => 'en',
    logger: logger as unknown as Logger,
    protectIdentifier: (value) => `protected-${value}`,
    isAccepting: () => options.accepting ?? true,
  });
  return { service, store, logger, publisher };
};

const interaction = (options: {
  action: 'set' | 'status' | 'disable';
  manage?: boolean;
  channelGuildId?: string;
}) => {
  const editReply = vi.fn(
    async (payload: { content: string; allowedMentions?: unknown }) => payload,
  );
  const raw = {
    commandName: 'jolanda',
    guildId,
    user: { id: 'member' },
    memberPermissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ManageGuild && (options.manage ?? true),
    },
    options: {
      getSubcommandGroup: () => 'releases',
      getSubcommand: () => options.action,
      getChannel: () => ({
        id: channelId,
        guildId: options.channelGuildId ?? guildId,
        type: ChannelType.GuildText,
      }),
    },
    deferReply: vi.fn(async () => {}),
    editReply,
  };
  return {
    value: raw as unknown as ChatInputCommandInteraction,
    raw,
    text: () => editReply.mock.calls.at(-1)?.[0]?.content ?? '',
  };
};

describe('release notes', () => {
  it('renders canonical, localized release content within Discord limits', () => {
    expect(currentRelease.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    for (const locale of ['en', 'sk'] as const) {
      const content = renderRelease(locale);
      expect(content).toContain(currentRelease.changes[locale]);
      expect(content).toContain(currentRelease.usage[locale]);
      expect(content).toMatch(locale === 'en' ? /restart Discord/ : /reštartujte Discord/);
      expect(content.length).toBeLessThanOrEqual(2_000);
    }
  });

  it('validates destination ownership and permissions before claiming, then publishes safely', async () => {
    const valid = fixture();
    expect(await valid.service.announce(guildId)).toBe('sent');
    expect(valid.publisher.validateDestination.mock.invocationCallOrder[0]).toBeLessThan(
      valid.store.beginSend.mock.invocationCallOrder[0]!,
    );
    const requiredPermissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
    expect(valid.publisher.validateDestination).toHaveBeenCalledWith(route, requiredPermissions);
    expect(valid.publisher.publishPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: route,
        payload: {
          content: renderRelease('en'),
          allowed_mentions: { parse: [] },
          flags: MessageFlags.SuppressEmbeds,
        },
        nonce: `release:${subscription._id}:${currentRelease.id}`,
        signal: expect.any(AbortSignal),
        requiredPermissions,
      }),
    );
    expect(valid.store.finishSend).toHaveBeenCalledWith(subscription, currentRelease.id, 'sent');

    const wrongGuild = fixture();
    wrongGuild.store.destination.mockReturnValue({ ...route, guildId: 'other' });
    expect(await wrongGuild.service.announce(guildId)).toBe('skipped');
    expect(wrongGuild.publisher.validateDestination).not.toHaveBeenCalled();
    expect(wrongGuild.store.beginSend).not.toHaveBeenCalled();

    const denied = fixture();
    denied.publisher.validateDestination.mockResolvedValue(false);
    expect(await denied.service.announce(guildId)).toBe('failed');
    expect(denied.store.beginSend).not.toHaveBeenCalled();
    expect(denied.publisher.publishPayload).not.toHaveBeenCalled();
  });

  it('skips disabled, duplicate and shutdown work without crossing the send boundary', async () => {
    const disabled = fixture();
    disabled.store.get.mockResolvedValue({ ...subscription, enabled: false });
    expect(await disabled.service.announce(guildId)).toBe('skipped');
    expect(disabled.publisher.validateDestination).not.toHaveBeenCalled();

    const duplicate = fixture();
    duplicate.store.beginSend.mockResolvedValue(false);
    expect(await duplicate.service.announce(guildId)).toBe('skipped');
    expect(duplicate.publisher.publishPayload).not.toHaveBeenCalled();

    const shutdown = fixture({ accepting: false });
    expect(await shutdown.service.announce(guildId)).toBe('skipped');
    expect(shutdown.store.get).not.toHaveBeenCalled();
  });

  it.each([
    ['known Discord rejection', 'destination-unavailable', 'rejected'],
    ['network ambiguity', 'uncertain', 'uncertain'],
  ] as const)('records %s without leaking the failure', async (_label, result, outcome) => {
    const f = fixture({ outcome: result });
    expect(await f.service.announce(guildId)).toBe('failed');
    expect(f.store.finishSend).toHaveBeenCalledWith(subscription, currentRelease.id, outcome);
    expect(f.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'release_announcement', outcome }),
    );
  });

  it('isolates service failures and runs authorized set, status and disable commands', async () => {
    const broken = fixture();
    broken.store.get.mockRejectedValue(new Error('database unavailable'));
    expect(await broken.service.announce(guildId)).toBe('failed');
    expect(broken.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'release_announcement_failed',
        guildKey: 'protected-guild',
      }),
    );

    const f = fixture();
    const settings = {
      getSettings: vi.fn(async () => ({
        guildId,
        model: 'luna' as const,
        reasoning: 'medium' as const,
        contextLimitMessages: 0,
        locale: 'en' as const,
        updatedAt: new Date(0),
      })),
    } as unknown as JolandaStore;
    const handler = createCommandHandler({
      store: settings,
      releases: f.service,
      logger: f.logger as unknown as Logger,
      protectIdentifier: (value) => `protected-${value}`,
      transcriptTtlDays: 7,
      maximumContextMessages: 50,
    });

    const set = interaction({ action: 'set' });
    await handler(set.value);
    expect(f.store.configure).toHaveBeenCalledWith(route);
    expect(set.text()).toContain(`<#${channelId}>`);
    expect(f.publisher.publishPayload).toHaveBeenCalledOnce();

    const status = interaction({ action: 'status' });
    await handler(status.value);
    expect(status.text()).toContain(`enabled in <#${channelId}>`);

    const disable = interaction({ action: 'disable' });
    await handler(disable.value);
    expect(f.store.disable).toHaveBeenCalledWith(guildId);
    expect(disable.text()).toContain('off');

    f.store.configure.mockClear();
    const crossGuild = interaction({ action: 'set', channelGuildId: 'other' });
    await handler(crossGuild.value);
    expect(crossGuild.text()).toContain('Choose a text or announcement channel');
    expect(f.store.configure).not.toHaveBeenCalled();

    const denied = interaction({ action: 'set', manage: false });
    await handler(denied.value);
    expect(denied.text()).toContain('Manage Server');
    expect(f.store.configure).not.toHaveBeenCalled();
  });
});
