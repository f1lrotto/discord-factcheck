import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import type { Logger } from 'pino';
import { createResponseSink, safeMentions, safeMessageFlags } from './discord-response.js';
import { minimizeDiscordContent } from './discord-text.js';
import { messages } from './i18n/index.js';
import { imageLimits } from './image-limits.js';
import type { Jolanda } from './jolanda.js';
import { conversationReplyLimit } from './limits.js';
import type { JolandaStore } from './types.js';

export const createAskHandler =
  (input: {
    jolanda: Jolanda;
    store: JolandaStore;
    promptsPerMinute: number;
    logger: Logger;
    protectIdentifier: (identifier: string) => string;
  }) =>
  async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guildId) return;
    await interaction.deferReply();
    const copy = messages((await input.store.getSettings(interaction.guildId)).locale);
    const modelProfile = interaction.options.getString('model');
    const question = minimizeDiscordContent(interaction.options.getString('question', true));
    const outcome = await input.jolanda.handleTurn(
      {
        id: interaction.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        question,
        ...(modelProfile !== null ? { modelProfile } : {}),
        remindersSupported:
          interaction.channel !== null &&
          [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(interaction.channel.type),
        loadAmbientContext: async () => [],
      },
      createResponseSink({
        source: interaction,
        logger: input.logger,
        protectIdentifier: input.protectIdentifier,
        locale: copy.locale,
        question,
      }),
    );
    if (outcome.status !== 'rejected') return;
    if (outcome.reason === 'duplicate') return;
    await interaction.editReply({
      content: copy.rejections(input.promptsPerMinute, imageLimits.count, conversationReplyLimit)[
        outcome.reason
      ],
      allowedMentions: safeMentions,
      flags: safeMessageFlags,
    });
  };
