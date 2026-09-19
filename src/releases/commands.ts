import {
  ChannelType,
  Locale as DiscordLocale,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandGroupBuilder,
} from 'discord.js';
import { safeMentions } from '../discord-response.js';
import { messages, type Locale } from '../i18n/index.js';
import type { ReleaseAnnouncements } from './discord.js';

const english = (text: string) => ({
  [DiscordLocale.EnglishUS]: text,
  [DiscordLocale.EnglishGB]: text,
});

export const releasesGroup = (group: SlashCommandSubcommandGroupBuilder) =>
  group
    .setName('releases')
    .setDescription('Nastaviť prehľad nových funkcií Jolandy')
    .setDescriptionLocalizations(english('Configure Jolanda release notes'))
    .addSubcommand((command) =>
      command
        .setName('set')
        .setDescription('Uložiť kanál a oznámiť aktuálne vydanie')
        .setDescriptionLocalizations(english('Save a channel and announce the current release'))
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Kanál prehľadu zmien')
            .setDescriptionLocalizations(english('Release notes channel'))
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('status')
        .setDescription('Zobraziť kanál prehľadu zmien')
        .setDescriptionLocalizations(english('Show the release notes channel')),
    )
    .addSubcommand((command) =>
      command
        .setName('disable')
        .setDescription('Vypnúť prehľad zmien')
        .setDescriptionLocalizations(english('Disable release notes')),
    );

export const handleReleaseCommand = async (
  interaction: ChatInputCommandInteraction,
  services: ReleaseAnnouncements,
  locale: Locale,
) => {
  const copy = messages(locale).releases;
  const edit = (content: string) =>
    interaction.editReply({ content, allowedMentions: safeMentions });
  const guildId = interaction.guildId!;
  const action = interaction.options.getSubcommand();
  if (action === 'disable') {
    await services.store.disable(guildId);
    await edit(copy.disabled);
  } else if (action === 'set') {
    const channel = interaction.options.getChannel('channel', true);
    if (
      !('guildId' in channel) ||
      channel.guildId !== guildId ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
      !(await services.validateDestination({ guildId, channelId: channel.id }))
    ) {
      await edit(copy.invalidChannel);
      return;
    }
    await services.store.configure({ guildId, channelId: channel.id });
    const outcome = await services.announce(guildId);
    await edit(copy.configured(channel.id, outcome === 'failed'));
  } else {
    const subscription = await services.store.get(guildId);
    const route = subscription?.enabled ? services.store.destination(subscription) : null;
    await edit(route ? copy.status(route.channelId) : copy.disabled);
  }
};
