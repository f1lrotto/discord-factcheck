import { ChannelType, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createCommand, createCommandHandler } from '../src/discord-commands.js';
import { handleBriefingCommand } from '../src/briefing/commands.js';
import { handleReminderCommand } from '../src/reminder-commands.js';
import type { BriefingStore } from '../src/briefing/types.js';
import type { ReminderStore } from '../src/reminders.js';
import type { JolandaStore } from '../src/types.js';
import { defaultGuildSettings } from '../src/models.js';

const now = new Date('2026-09-15T05:00:00Z');
const city = {
  name: 'Bratislava',
  lat: 48,
  lon: 17,
  timeZone: 'Europe/Bratislava',
  countryCode: 'SK',
};
const setup = (action: string, values: Record<string, unknown> = {}) => {
  const subscription = {
    _id: 's',
    enabled: true,
    hour: 6,
    revision: 1,
    cities: [city],
    lastDeliveredAt: now,
  };
  const briefing = {
    requestRun: vi.fn().mockResolvedValue('queued'),
    get: vi.fn().mockResolvedValue(subscription),
    configure: vi.fn().mockResolvedValue(subscription),
    disable: vi.fn(),
    setHour: vi.fn(),
    addCity: vi.fn().mockResolvedValue('added'),
    removeCity: vi.fn().mockResolvedValue(true),
    destination: vi.fn().mockReturnValue({ guildId: 'g', channelId: 'c' }),
  } as unknown as BriefingStore;
  const reminder = { id: 'abcd', text: 'Invoice', dueAt: new Date(+now + 60_000), createdAt: now };
  const reminders = {
    create: vi.fn().mockResolvedValue(reminder),
    listForMember: vi.fn().mockResolvedValue([reminder]),
    cancel: vi.fn().mockResolvedValue(true),
  } as unknown as ReminderStore;
  const interaction = {
    id: 'request',
    commandName: 'jolanda',
    guildId: 'g',
    channelId: 'c',
    channel: { id: 'c', type: ChannelType.GuildText },
    user: { id: 'u' },
    options: {
      getSubcommand: () => action,
      getSubcommandGroup: () => values.group ?? null,
      getString: (key: string) => values[key] ?? null,
      getInteger: (key: string) => values[key],
      getChannel: () => values.channel ?? { id: 'c', guildId: 'g', type: ChannelType.GuildText },
    },
    editReply: vi.fn(),
    deferReply: vi.fn(),
    reply: vi.fn(),
    memberPermissions: {
      has: vi.fn(
        (permission) => permission === PermissionFlagsBits.ManageGuild && values.admin !== false,
      ),
    },
  };
  const publisher = {
    ready: () => true,
    validateDestination: vi.fn().mockResolvedValue(true),
    publishPayload: vi.fn(),
  };
  const geocode = vi.fn().mockResolvedValue(city);
  const services = { store: briefing, publisher, maximumCities: 5, geocode };
  const asInteraction = interaction as unknown as ChatInputCommandInteraction;
  return {
    briefing,
    reminders,
    interaction,
    publisher,
    geocode,
    services,
    briefingRun: (locale: 'sk' | 'en' = 'sk') =>
      handleBriefingCommand(asInteraction, services, locale),
    reminderRun: (locale: 'sk' | 'en' = 'sk') =>
      handleReminderCommand({
        interaction: asInteraction,
        store: reminders,
        locale,
        timeZone: 'Europe/Bratislava',
        now,
      }),
    handlerRun: () =>
      createCommandHandler({
        briefing: services,
        reminderStore: reminders,
        store: {
          getSettings: async () => ({ ...defaultGuildSettings, guildId: 'g', updatedAt: now }),
        } as unknown as JolandaStore,
        logger: pino({ enabled: false }),
        protectIdentifier: (s) => s,
        transcriptTtlDays: 7,
        maximumContextMessages: 50,
      })(asInteraction),
    content: () => String(interaction.editReply.mock.calls.at(-1)?.[0].content),
  };
};

describe('scheduled command definitions', () => {
  it('registers legal Discord nesting and all required commands', () => {
    const command = createCommand(50).toJSON();
    expect(command.options?.length).toBeLessThanOrEqual(25);
    expect(command.options?.map((option) => option.name)).toEqual(
      expect.arrayContaining(['remind', 'reminders', 'briefing', 'usage', 'language']),
    );
    expect(JSON.stringify(command)).toContain('name');
  });
});
describe('manual briefing commands', () => {
  it('requires Manage Server and queues only into configured routing', async () => {
    const denied = setup('run', { group: 'briefing', admin: false });
    await denied.handlerRun();
    expect(denied.briefing.requestRun).not.toHaveBeenCalled();
    for (const outcome of ['queued', 'busy', 'unconfigured'] as const) {
      const s = setup('run', { group: 'briefing' });
      vi.mocked(s.briefing.requestRun).mockResolvedValue(outcome);
      await s.handlerRun();
      expect(s.briefing.requestRun).toHaveBeenCalledWith('g', 'request', expect.any(Date));
      expect(s.content()).not.toContain('undefined');
    }
  });
});
describe('reminder commands', () => {
  it('lets ordinary members create, list and cancel without Manage Server', async () => {
    for (const action of ['remind', 'list', 'cancel']) {
      const s = setup(action, {
        admin: false,
        ...(action === 'remind'
          ? { in: '2h', text: 'Invoice' }
          : { group: 'reminders', id: 'abcd' }),
      });
      await s.handlerRun();
      expect(s.interaction.reply).not.toHaveBeenCalled();
      expect(s.interaction.editReply).toHaveBeenCalledOnce();
    }
  });
  it.each(['sk', 'en'] as const)(
    'creates and lists in %s with mention suppression',
    async (locale) => {
      const s = setup('remind', { in: '2h', text: 'Invoice' });
      await s.reminderRun(locale);
      expect(s.content()).toContain('abcd');
      expect(s.reminders.create).toHaveBeenCalledWith(
        expect.objectContaining({ destination: { guildId: 'g', channelId: 'c', userId: 'u' } }),
      );
      expect(s.interaction.editReply.mock.calls[0]![0].allowedMentions.parse).toEqual([]);
      const listing = setup('list');
      await listing.reminderRun(locale);
      expect(listing.content()).toContain('Invoice');
      vi.mocked(listing.reminders.listForMember).mockResolvedValue([]);
      await listing.reminderRun(locale);
      expect(listing.content().length).toBeGreaterThan(5);
    },
  );
  it('handles invalid times, limits, cancellations and unsuitable channels', async () => {
    const invalid = setup('remind', { in: '2h', at: '2026-09-16 09:00', text: 'Invoice' });
    await invalid.reminderRun();
    expect(invalid.reminders.create).not.toHaveBeenCalled();
    const s = setup('remind', { in: '2h', text: 'Invoice' });
    vi.mocked(s.reminders.create).mockResolvedValue('limit_reached');
    await s.reminderRun();
    expect(s.content()).toContain('20');
    s.interaction.channel.type = ChannelType.GuildVoice;
    await s.reminderRun();
    expect(s.content()).toContain('kanáloch');
    const cancel = setup('cancel', { id: 'abcd' });
    await cancel.reminderRun('en');
    expect(cancel.content()).toContain('cancelled');
    vi.mocked(cancel.reminders.cancel).mockResolvedValue(false);
    await cancel.reminderRun('en');
    expect(cancel.content()).toContain('could not find');
    const badId = setup('cancel', { id: '@everyone' });
    await badId.reminderRun();
    expect(badId.reminders.cancel).not.toHaveBeenCalled();
    expect(badId.content()).not.toContain('@everyone');
  });
});
describe('briefing commands', () => {
  it('requires Manage Server for configuration', async () => {
    const s = setup('feed', { group: 'briefing', admin: false });
    await s.handlerRun();
    expect(s.interaction.editReply).toHaveBeenCalledOnce();
    expect(s.briefing.configure).not.toHaveBeenCalled();
    const admin = setup('feed', { group: 'briefing' });
    await admin.handlerRun();
    expect(admin.briefing.configure).toHaveBeenCalled();
  });
  it.each(['sk', 'en'] as const)('configures, changes time and disables in %s', async (locale) => {
    const feed = setup('feed');
    await feed.briefingRun(locale);
    expect(feed.content()).toContain('<#c>');
    expect(feed.content()).toContain('06:00');
    feed.publisher.validateDestination.mockResolvedValue(false);
    await feed.briefingRun(locale);
    expect(feed.briefing.configure).toHaveBeenCalledOnce();
    const unsupported = setup('feed', {
      channel: { id: 'c', guildId: 'elsewhere', type: ChannelType.GuildText },
    });
    await unsupported.briefingRun(locale);
    expect(unsupported.briefing.configure).not.toHaveBeenCalled();
    const time = setup('time', { hour: 9 });
    await time.briefingRun(locale);
    expect(time.briefing.setHour).toHaveBeenCalledWith('g', 9);
    const disable = setup('disable');
    await disable.briefingRun(locale);
    expect(disable.briefing.disable).toHaveBeenCalledWith('g');
  });
  it('geocodes additions, handles limits and removes stored names without network', async () => {
    const add = setup('city', { action: 'add', name: 'Bratislava' });
    await add.briefingRun();
    expect(add.content()).toContain('Bratislava');
    vi.mocked(add.briefing.addCity).mockResolvedValue('duplicate');
    await add.briefingRun();
    expect(add.content()).toContain('už');
    vi.mocked(add.briefing.addCity).mockResolvedValue('limit');
    await add.briefingRun();
    expect(add.content()).toContain('5');
    add.geocode.mockResolvedValue(null);
    await add.briefingRun();
    expect(add.content()).toContain('nenašla');
    const remove = setup('city', { action: 'remove', name: 'Bratislava' });
    await remove.briefingRun();
    expect(remove.geocode).not.toHaveBeenCalled();
    vi.mocked(remove.briefing.removeCity).mockResolvedValue(false);
    await remove.briefingRun();
    expect(remove.content()).toContain('nenašla');
  });
  it('shows configured, missing and corrupt destinations safely', async () => {
    const s = setup('status');
    await s.briefingRun();
    expect(s.content()).toContain('Bratislava');
    expect(s.content()).toContain('<#c>');
    vi.mocked(s.briefing.destination).mockImplementation(() => {
      throw new Error('key');
    });
    await s.briefingRun('en');
    expect(s.content()).not.toContain('undefined');
    vi.mocked(s.briefing.get).mockResolvedValue(null);
    await s.briefingRun('en');
    expect(s.content()).toContain('not configured');
    expect(s.content()).toContain('06:00');
  });
});
