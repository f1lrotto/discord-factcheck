import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { findModelProfile, getModel, modelProfiles } from './models.js';
import { formatUsd } from './money.js';
import { ephemeral, safeMentions } from './discord-response.js';
import { reelChannelSupported, reelPermissions } from './discord-reels.js';
import type { ReelStore } from './reel-types.js';
import type { JolandaStore } from './types.js';

const effectiveContextLimit = (configured: number, maximum: number) =>
  Math.max(0, Math.min(configured, maximum));

export const createCommand = (maximumContextMessages: number) =>
  new SlashCommandBuilder()
    .setName('jolanda')
    .setDescription('Configure Jolanda for this server')
    .addSubcommand((command) =>
      command
        .setName('reels')
        .setDescription('Automatically repost public Instagram Reels and TikToks in this channel')
        .addBooleanOption((option) =>
          option
            .setName('enabled')
            .setDescription('Enable automatic Reel and TikTok downloads')
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command.setName('privacy').setDescription('Explain how Jolanda handles Discord data'),
    )
    .addSubcommand((command) => command.setName('settings').setDescription('Show current settings'))
    .addSubcommand((command) =>
      command
        .setName('model')
        .setDescription('Set a valid model and reasoning profile')
        .addStringOption((option) =>
          option
            .setName('profile')
            .setDescription('Model and reasoning effort')
            .setRequired(true)
            .addChoices(
              ...modelProfiles().map((profile) => ({
                name: profile.label,
                value: profile.id,
              })),
            ),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('context-limit')
        .setDescription('Set the maximum context members may request per interaction')
        .addIntegerOption((option) =>
          option
            .setName('messages')
            .setDescription(`0 disables opt-in context; maximum ${maximumContextMessages}`)
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(maximumContextMessages),
        ),
    );

export const createCommandHandler = (input: {
  reelStore?: ReelStore;
  reelsEnabled?: boolean;
  transcriptTtlDays: number;
  maximumContextMessages: number;
  store: JolandaStore;
  logger: Logger;
  protectIdentifier: (identifier: string) => string;
}) => {
  const logChange = (
    interaction: ChatInputCommandInteraction,
    guildId: string,
    setting: string,
    values: Record<string, unknown>,
  ) =>
    input.logger.info({
      event: 'settings_changed',
      setting,
      guildKey: input.protectIdentifier(guildId),
      userKey: input.protectIdentifier(interaction.user.id),
      ...values,
    });

  return async (interaction: ChatInputCommandInteraction) => {
    if (interaction.commandName !== 'jolanda' || !interaction.guildId) return;
    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand();
    const defer = () => interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const edit = (content: string) =>
      interaction.editReply({ content, allowedMentions: safeMentions });
    if (subcommand === 'privacy') {
      await defer();
      const settings = await input.store.getSettings(guildId);
      const model = getModel(settings.model);
      const contextLimit = effectiveContextLimit(
        settings.contextLimitMessages,
        input.maximumContextMessages,
      );
      await edit(
        [
          '**Jolanda privacy**',
          'In channels with automatic Reels enabled, public video identifiers are sent anonymously to Instagram/Meta or TikTok, depending on the link. Videos are temporarily downloaded on the host and copied to Discord. Copies follow Discord message retention, not transcript expiry; deleting the source does not delete an uploaded copy. Administrators can remove copies with normal moderation. Reposting does not mean the AI watched or fact-checked the video.',
          'Your question, explicit replies, and conversation turns are processed by OpenRouter and a selected model provider.',
          model.supportsZdr
            ? `Zero Data Retention is **enforced** for ${model.label}.`
            : `Zero Data Retention is **not available** for ${model.label}; its provider may retain prompts under its policy.`,
          'Ambient channel context defaults to **disabled for every interaction**.',
          contextLimit
            ? `Start a prompt with **+context** or **+context=N** to request up to **${contextLimit} preceding human messages** from the same channel.`
            : 'Per-interaction ambient context is currently **disabled by server policy**.',
          `Conversation text, including any explicitly requested context, is stored in plaintext so replies can continue; Discord identifiers are pseudonymized. Both expire after **${input.transcriptTtlDays} days**, though Atlas TTL deletion may occur shortly after expiry.`,
          'Every model turn has direct read-only web tools. Your question, replies, conversation history, and requested context can influence a public search query when the model decides research is useful.',
          'Reply conversations are owner-bound. Do not send passwords, tokens, payment details, or other secrets.',
        ].join('\n'),
      );
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply(
        ephemeral('You need the Manage Server permission to change Jolanda.'),
      );
      return;
    }
    await defer();

    if (subcommand === 'reels') {
      const channel = interaction.channel;
      if (!channel || !reelChannelSupported(channel.type) || !input.reelStore) {
        await edit('Reels settings are available in server text and announcement channels only.');
        return;
      }
      const enabled = interaction.options.getBoolean('enabled', true);
      if (enabled && !interaction.appPermissions?.has(reelPermissions)) {
        await edit(
          'I need View Channel, Send Messages, Read Message History, and Attach Files to repost Reels.',
        );
        return;
      }
      await input.reelStore.setEnabled({ guildId, channelId: channel.id }, enabled);
      logChange(interaction, guildId, 'reels', {
        enabled,
        channelKey: input.protectIdentifier(channel.id),
      });
      await edit(
        `Automatic Reels (Instagram and TikTok) are **${enabled ? 'enabled' : 'disabled'}** in this channel.${enabled && !input.reelsEnabled ? ' Downloads remain unavailable while the deployment switch is off.' : ''}`,
      );
      return;
    }
    if (subcommand === 'settings') {
      const [settings, budget] = await Promise.all([
        input.store.getSettings(guildId),
        input.store.getBudgetSummary(guildId, new Date()),
      ]);
      const channelEnabled =
        input.reelStore && interaction.channelId
          ? await input.reelStore.getEnabled({ guildId, channelId: interaction.channelId })
          : false;
      const model = getModel(settings.model);
      await edit(
        [
          `Reels deployment (Instagram and TikTok): **${input.reelsEnabled ? 'available' : 'disabled'}**`,
          `Reels in this channel (Instagram and TikTok): **${channelEnabled ? 'enabled' : 'disabled'}**`,
          `Model: **${model.label}**`,
          `Reasoning: **${settings.reasoning}**`,
          `Zero Data Retention: **${model.supportsZdr ? 'enforced' : 'unavailable'}**`,
          'Ambient context default: **0 messages**',
          `Per-interaction context limit: **${effectiveContextLimit(settings.contextLimitMessages, input.maximumContextMessages)} messages**`,
          `Daily committed spend: **${formatUsd(budget.dailyUsedMicrodollars + budget.dailyReservedMicrodollars)}**`,
          `Monthly committed spend: **${formatUsd(budget.monthlyUsedMicrodollars + budget.monthlyReservedMicrodollars)}**`,
        ].join('\n'),
      );
      return;
    }

    if (subcommand === 'model') {
      const selected = interaction.options.getString('profile', true);
      const profile = findModelProfile(selected);
      if (!profile) throw new Error('Discord returned an unknown model profile');
      const model = getModel(profile.model);
      const settings = await input.store.updateSettings(guildId, {
        model: profile.model,
        reasoning: profile.reasoning,
      });
      logChange(interaction, guildId, 'model', {
        model: settings.model,
        reasoning: settings.reasoning,
      });
      await edit(
        model.supportsZdr
          ? `Model set to **${model.label}** with **${profile.reasoning}** reasoning. Zero Data Retention will be enforced.`
          : `Model set to **${model.label}** with **${profile.reasoning}** reasoning. ⚠️ Zero Data Retention is not available for this model.`,
      );
      return;
    }

    const messages = interaction.options.getInteger('messages', true);
    const settings = await input.store.updateSettings(guildId, {
      contextLimitMessages: messages,
    });
    logChange(interaction, guildId, 'context_limit', {
      contextLimitMessages: settings.contextLimitMessages,
    });
    await edit(
      messages === 0
        ? 'Per-interaction ambient context is disabled. Explicitly replied-to messages are still included.'
        : `Members may now request up to **${messages} preceding human messages** with +context.`,
    );
  };
};
