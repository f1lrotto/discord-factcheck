import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import {
  getModel,
  isModelId,
  isReasoningEffort,
  modelCatalog,
  modelSupportsReasoning,
  reasoningEfforts,
  UnsupportedReasoningError,
} from './models.js';
import { ephemeral, safeMentions } from './discord-response.js';
import type { JolandaStore } from './types.js';

const formatUsd = (microdollars: number) => `$${(microdollars / 1_000_000).toFixed(4)}`;

export const createCommand = (maximumContextMessages: number) =>
  new SlashCommandBuilder()
    .setName('jolanda')
    .setDescription('Configure Jolanda for this server')
    .addSubcommand((command) =>
      command.setName('privacy').setDescription('Explain how Jolanda handles Discord data'),
    )
    .addSubcommand((command) => command.setName('settings').setDescription('Show current settings'))
    .addSubcommand((command) =>
      command
        .setName('model')
        .setDescription('Set the model used by subsequent interactions')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Model')
            .setRequired(true)
            .addChoices(
              ...Object.values(modelCatalog).map((model) => ({
                name: model.label,
                value: model.id,
              })),
            ),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('reasoning')
        .setDescription('Set reasoning effort for subsequent interactions')
        .addStringOption((option) =>
          option
            .setName('effort')
            .setDescription('Reasoning effort')
            .setRequired(true)
            .addChoices(...reasoningEfforts.map((effort) => ({ name: effort, value: effort }))),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('context')
        .setDescription('Set how many preceding channel messages Jolanda may read')
        .addIntegerOption((option) =>
          option
            .setName('messages')
            .setDescription(`0 disables ambient context; maximum ${maximumContextMessages}`)
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(maximumContextMessages),
        ),
    );

export const createCommandHandler = (input: {
  guildId: string;
  transcriptTtlDays: number;
  store: JolandaStore;
  logger: Logger;
  protectIdentifier: (identifier: string) => string;
}) => {
  const logChange = (
    interaction: ChatInputCommandInteraction,
    setting: string,
    values: Record<string, unknown>,
  ) =>
    input.logger.info({
      event: 'settings_changed',
      setting,
      guildKey: input.protectIdentifier(input.guildId),
      userKey: input.protectIdentifier(interaction.user.id),
      ...values,
    });

  return async (interaction: ChatInputCommandInteraction) => {
    if (interaction.commandName !== 'jolanda' || interaction.guildId !== input.guildId) return;
    const subcommand = interaction.options.getSubcommand();
    const defer = () => interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const edit = (content: string) =>
      interaction.editReply({ content, allowedMentions: safeMentions });
    if (subcommand === 'privacy') {
      await defer();
      const settings = await input.store.getSettings(input.guildId);
      await edit(
        [
          '**Jolanda privacy**',
          'Your question, explicit replies, and conversation turns are processed by OpenRouter and a selected model provider.',
          `Ambient channel context is currently **${settings.contextMessages ? `enabled for ${settings.contextMessages} messages` : 'disabled'}**.`,
          `Conversation text is stored in plaintext so replies can continue; Discord identifiers are pseudonymized. Both expire after **${input.transcriptTtlDays} days**, though Atlas TTL deletion may occur shortly after expiry.`,
          'Web research is isolated and receives only a minimized latest question—never replied messages, ambient context, or conversation history.',
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

    if (subcommand === 'settings') {
      const [settings, budget] = await Promise.all([
        input.store.getSettings(input.guildId),
        input.store.getBudgetSummary(input.guildId, new Date()),
      ]);
      await edit(
        [
          `Model: **${getModel(settings.model).label}**`,
          `Reasoning: **${settings.reasoning}**`,
          `Ambient context: **${settings.contextMessages} messages**`,
          `Daily committed spend: **${formatUsd(budget.dailyUsedMicrodollars + budget.dailyReservedMicrodollars)}**`,
          `Monthly committed spend: **${formatUsd(budget.monthlyUsedMicrodollars + budget.monthlyReservedMicrodollars)}**`,
        ].join('\n'),
      );
      return;
    }

    if (subcommand === 'model') {
      const selected = interaction.options.getString('name', true);
      if (!isModelId(selected)) throw new Error('Discord returned an unknown model option');
      const model = getModel(selected);
      const settings = await input.store.updateSettings(input.guildId, {
        model: selected,
        reasoning: model.defaultReasoning,
      });
      logChange(interaction, 'model', { model: settings.model, reasoning: settings.reasoning });
      await edit(
        `Model set to **${model.label}**. Reasoning was reset to **${model.defaultReasoning}**.`,
      );
      return;
    }

    if (subcommand === 'reasoning') {
      const selected = interaction.options.getString('effort', true);
      if (!isReasoningEffort(selected))
        throw new Error('Discord returned an unknown reasoning option');
      const current = await input.store.getSettings(input.guildId);
      if (!modelSupportsReasoning(current.model, selected)) {
        const supported = getModel(current.model).reasoningEfforts.join(', ');
        await edit(`${getModel(current.model).label} supports: **${supported}**.`);
        return;
      }
      try {
        const settings = await input.store.updateSettings(input.guildId, { reasoning: selected });
        logChange(interaction, 'reasoning', {
          model: settings.model,
          reasoning: settings.reasoning,
        });
        await edit(`Reasoning set to **${selected}**.`);
      } catch (error) {
        if (!(error instanceof UnsupportedReasoningError)) throw error;
        const supported = getModel(error.model).reasoningEfforts.join(', ');
        await edit(`${getModel(error.model).label} now supports: **${supported}**.`);
      }
      return;
    }

    const messages = interaction.options.getInteger('messages', true);
    const settings = await input.store.updateSettings(input.guildId, { contextMessages: messages });
    logChange(interaction, 'context', { contextMessages: settings.contextMessages });
    await edit(
      messages === 0
        ? 'Ambient channel context is disabled. Explicitly replied-to messages are still included.'
        : `Ambient channel context set to **${messages} messages**.`,
    );
  };
};
