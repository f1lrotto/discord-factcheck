import {
  ChannelType,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandGroupBuilder,
  Locale as DiscordLocale,
} from 'discord.js';
import { messages, type Locale } from '../i18n/index.js';
import { formatDateTime } from '../i18n/format.js';
import { safeMentions } from '../discord-response.js';
import { text } from '../news/render.js';
import { createGeocoder } from './geocode.js';
import { briefingSchedule, briefingTimeZone, defaultBriefingHour } from './policy.js';
import type { BriefingStore } from './types.js';
import type { BriefingPublisher } from './index.js';

const english = (text: string) => ({
  [DiscordLocale.EnglishUS]: text,
  [DiscordLocale.EnglishGB]: text,
});
export const briefingGroup = (group: SlashCommandSubcommandGroupBuilder) =>
  group
    .setName('briefing')
    .setDescription('Nastaviť ranný prehľad')
    .setDescriptionLocalizations(english('Configure morning briefing'))
    .addSubcommand((command) =>
      command
        .setName('run')
        .setDescription('Poslať nový ranný prehľad teraz')
        .setDescriptionLocalizations(english('Send a fresh morning briefing now')),
    )
    .addSubcommand((command) =>
      command
        .setName('feed')
        .setDescription('Nastaviť cieľový kanál')
        .setDescriptionLocalizations(english('Set the destination channel'))
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Kanál ranného prehľadu')
            .setDescriptionLocalizations(english('Briefing channel'))
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('disable')
        .setDescription('Vypnúť ranný prehľad')
        .setDescriptionLocalizations(english('Disable morning briefing')),
    )
    .addSubcommand((command) =>
      command
        .setName('status')
        .setDescription('Zobraziť nastavenie ranného prehľadu')
        .setDescriptionLocalizations(english('Show briefing settings')),
    )
    .addSubcommand((command) =>
      command
        .setName('time')
        .setDescription('Nastaviť hodinu prehľadu v Europe/Bratislava')
        .setDescriptionLocalizations(english('Set briefing hour in Europe/Bratislava'))
        .addIntegerOption((option) =>
          option
            .setName('hour')
            .setDescription('Hodina od 5 do 21')
            .setDescriptionLocalizations(english('Hour from 5 to 21'))
            .setRequired(true)
            .setMinValue(5)
            .setMaxValue(21),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('city')
        .setDescription('Pridať alebo odstrániť mesto')
        .setDescriptionLocalizations(english('Add or remove a city'))
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('Akcia')
            .setDescriptionLocalizations(english('Action'))
            .setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }),
        )
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Názov mesta')
            .setDescriptionLocalizations(english('City name'))
            .setRequired(true)
            .setMaxLength(100),
        ),
    );

export type BriefingCommandServices = {
  store: BriefingStore;
  publisher: BriefingPublisher;
  maximumCities: number;
  geocode?: ReturnType<typeof createGeocoder>;
};
export const handleBriefingCommand = async (
  interaction: ChatInputCommandInteraction,
  services: BriefingCommandServices,
  locale: Locale,
) => {
  const { store } = services;
  const copy = messages(locale).briefing;
  const edit = (content: string) =>
    interaction.editReply({ content, allowedMentions: safeMentions });
  const guildId = interaction.guildId!;
  const action = interaction.options.getSubcommand();
  if (action === 'run') {
    const result = await store.requestRun(guildId, interaction.id, new Date());
    await edit(messages(locale).manualRun[result]);
    return;
  }
  if (action === 'disable') {
    await store.disable(guildId);
    await edit(copy.disabledFeed);
    return;
  }
  if (action === 'feed') {
    const channel = interaction.options.getChannel('channel', true);
    if (
      !('guildId' in channel) ||
      channel.guildId !== guildId ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    ) {
      await edit(copy.channelUnsupported);
      return;
    }
    const destination = { guildId, channelId: channel.id };
    if (!(await services.publisher.validateDestination(destination))) {
      await edit(messages(locale).news.validationFailed);
      return;
    }
    const subscription = await store.configure(destination);
    await edit(
      copy.configured({
        channelId: channel.id,
        hour: subscription.hour,
      }),
    );
    return;
  }
  if (action === 'time') {
    const hour = interaction.options.getInteger('hour', true);
    await store.setHour(guildId, hour);
    await edit(copy.hourSet(hour));
    return;
  }
  if (action === 'city') {
    const name = interaction.options.getString('name', true).trim();
    if (interaction.options.getString('action', true) === 'remove') {
      await edit(
        (await store.removeCity(guildId, name))
          ? copy.cityRemoved(text(name, 100))
          : copy.cityUnknown(text(name, 100)),
      );
      return;
    }
    const city = await (services.geocode ?? createGeocoder())(name, AbortSignal.timeout(10_000));
    if (!city) {
      await edit(copy.cityUnknown(text(name, 100)));
      return;
    }
    const result = await store.addCity(guildId, city, services.maximumCities);
    await edit(
      result === 'limit'
        ? copy.cityLimit(services.maximumCities)
        : result === 'duplicate'
          ? copy.cityDuplicate(text(city.name, 100))
          : copy.cityAdded({
              name: text(`${city.name} (${city.countryCode})`, 100),
              count: (await store.get(guildId))!.cities.length,
              maximum: services.maximumCities,
            }),
    );
    return;
  }
  const subscription = await store.get(guildId);
  let destination: ReturnType<BriefingStore['destination']> = null;
  try {
    destination = subscription ? store.destination(subscription) : null;
  } catch {
    /* status must allow repairing a broken destination */
  }
  const now = new Date();
  let schedule = briefingSchedule(now, subscription?.hour ?? defaultBriefingHour);
  if (+now >= +schedule.primaryAt)
    schedule = briefingSchedule(
      new Date(+now + 86_400_000),
      subscription?.hour ?? defaultBriefingHour,
    );
  await edit(
    copy
      .statusLines({
        configured: Boolean(subscription?.enabled),
        destination: destination
          ? { kind: 'channel', channelId: destination.channelId }
          : { kind: subscription?.destination ? 'unavailable' : 'none' },
        hour: subscription?.hour ?? defaultBriefingHour,
        cities: subscription?.cities.map((city) => text(city.name, 100)) ?? [],
        maximumCities: services.maximumCities,
        nextDeliveryAt: subscription?.enabled
          ? formatDateTime(locale, schedule.primaryAt, briefingTimeZone)
          : null,
        lastDeliveredAt: subscription?.lastDeliveredAt
          ? formatDateTime(locale, subscription.lastDeliveredAt, briefingTimeZone)
          : null,
      })
      .join('\n'),
  );
};
