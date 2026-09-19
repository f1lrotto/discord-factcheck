import {
  briefingGroup,
  handleBriefingCommand,
  type BriefingCommandServices,
} from './briefing/commands.js';
import { handleReminderCommand } from './reminder-commands.js';
import type { ReminderStore } from './reminders.js';
import {
  MessageFlags,
  ChannelType,
  Locale as DiscordLocale,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandGroupBuilder,
} from 'discord.js';
import type { Logger } from 'pino';
import { defaultGuildSettings, findModelProfile, getModel, modelProfiles } from './models.js';
import { formatUsd } from './money.js';
import { usageTrendDays } from './limits.js';
import { usageFacts } from './usage-report.js';
import { safeMentions } from './discord-response.js';
import { reelChannelSupported, reelPermissions } from './discord-reels.js';
import { defaultLocale, isLocale, localeChoices, messages, type Locale } from './i18n/index.js';
import type { ReelStore } from './reel-types.js';
import type { JolandaStore } from './types.js';
import { createNewsCommands, type NewsCommandServices } from './news/commands.js';

const effectiveContextLimit = (configured: number, maximum: number) =>
  Math.max(0, Math.min(configured, maximum));

/**
 * Discord has no Slovak interface locale, so a Slovak description cannot be delivered through
 * `setDescriptionLocalizations`. This deployment is Slovak-speaking and the guild default is
 * Slovak, so the base description carries Slovak and English is attached as the localization
 * for clients that ask for it. Descriptions follow each member's Discord client language and
 * cannot follow the guild setting, which is a Discord constraint rather than a choice.
 */
const english = (text: string) => ({
  [DiscordLocale.EnglishUS]: text,
  [DiscordLocale.EnglishGB]: text,
});

const newsGroup = (group: SlashCommandSubcommandGroupBuilder, feed: 'continuous' | 'daily') => {
  const configured = group
    .setName(feed)
    .setDescription(feed === 'continuous' ? 'Nastaviť priebežné novinky' : 'Nastaviť denné novinky')
    .setDescriptionLocalizations(english(`Configure ${feed} news`))
    .addSubcommand((command) => {
      command
        .setName('feed')
        .setDescription('Nastaviť cieľový kanál noviniek')
        .setDescriptionLocalizations(english(`Set the ${feed} news destination`))
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Cieľ noviniek na tomto serveri')
            .setDescriptionLocalizations(english('News destination in this server'))
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        );
      if (feed === 'daily')
        command.addRoleOption((option) =>
          option
            .setName('notify-role')
            .setDescription('Nepovinná rola na upozornenie raz za denné vydanie')
            .setDescriptionLocalizations(english('Optional role to notify once per daily edition')),
        );
      return command;
    })
    .addSubcommand((command) =>
      command
        .setName('disable')
        .setDescription(feed === 'continuous' ? 'Vypnúť priebežné novinky' : 'Vypnúť denné novinky')
        .setDescriptionLocalizations(english(`Disable ${feed} news`)),
    )
    .addSubcommand((command) =>
      command
        .setName('status')
        .setDescription('Zobraziť nastavenie a stav doručovania noviniek')
        .setDescriptionLocalizations(
          english(`Show ${feed} news configuration and delivery status`),
        ),
    );

  if (feed === 'daily')
    configured.addSubcommand((command) =>
      command
        .setName('run')
        .setDescription('Poslať najnovší denný výber teraz')
        .setDescriptionLocalizations(english('Fetch and send the latest daily edition now')),
    );
  return configured;
};

export const createCommand = (maximumContextMessages: number) =>
  new SlashCommandBuilder()
    .setName('jolanda')
    .setDescription('Nastaviť Jolandu pre tento server')
    .setDescriptionLocalizations(english('Configure Jolanda for this server'))
    .addSubcommandGroup((group) => newsGroup(group, 'continuous'))
    .addSubcommandGroup((group) => newsGroup(group, 'daily'))
    .addSubcommandGroup(briefingGroup)
    .addSubcommand((command) =>
      command
        .setName('remind')
        .setDescription('Nastaviť pripomienku v tomto kanáli')
        .setDescriptionLocalizations(english('Set a reminder in this channel'))
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('Text pripomienky')
            .setDescriptionLocalizations(english('Reminder text'))
            .setRequired(true)
            .setMaxLength(280),
        )
        .addStringOption((option) =>
          option
            .setName('in')
            .setDescription('O koľko: 2h, 90m alebo 3d')
            .setDescriptionLocalizations(english('Delay: 2h, 90m or 3d')),
        )
        .addStringOption((option) =>
          option
            .setName('at')
            .setDescription('Miestny čas: YYYY-MM-DD HH:MM')
            .setDescriptionLocalizations(english('Local time: YYYY-MM-DD HH:MM')),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('reminders')
        .setDescription('Spravovať svoje pripomienky')
        .setDescriptionLocalizations(english('Manage your reminders'))
        .addSubcommand((command) =>
          command
            .setName('list')
            .setDescription('Zobraziť svoje pripomienky')
            .setDescriptionLocalizations(english('List your reminders')),
        )
        .addSubcommand((command) =>
          command
            .setName('cancel')
            .setDescription('Zrušiť pripomienku')
            .setDescriptionLocalizations(english('Cancel a reminder'))
            .addStringOption((option) =>
              option
                .setName('id')
                .setDescription('ID pripomienky')
                .setDescriptionLocalizations(english('Reminder ID'))
                .setRequired(true)
                .setMaxLength(4),
            ),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('reels')
        .setDescription('Automaticky preposielať verejné videá a fotky z Instagramu a TikToku')
        .setDescriptionLocalizations(
          english('Automatically repost public Instagram and TikTok videos and photos here'),
        )
        .addBooleanOption((option) =>
          option
            .setName('enabled')
            .setDescription('Zapnúť automatické stahovanie médií z Instagramu a TikToku')
            .setDescriptionLocalizations(
              english('Enable automatic Instagram and TikTok media downloads'),
            )
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('privacy')
        .setDescription('Vysvetliť, ako Jolanda zaobchádza s údajmi Discordu')
        .setDescriptionLocalizations(english('Explain how Jolanda handles Discord data')),
    )
    .addSubcommand((command) =>
      command
        .setName('settings')
        .setDescription('Zobraziť aktuálne nastavenia')
        .setDescriptionLocalizations(english('Show current settings')),
    )
    .addSubcommand((command) =>
      command
        .setName('usage')
        .setDescription('Zobraziť spotrebu a výdavky servera')
        .setDescriptionLocalizations(english('Show server usage and spend')),
    )
    .addSubcommand((command) =>
      command
        .setName('language')
        .setDescription('Nastaviť jazyk, v ktorom Jolanda píše vlastné správy')
        .setDescriptionLocalizations(english('Set the language Jolanda uses for her own messages'))
        .addStringOption((option) =>
          option
            .setName('locale')
            .setDescription('Odpovede modelu sa stále riadia jazykom, v ktorom píšeš')
            .setDescriptionLocalizations(
              english('Model answers still follow the language you write in'),
            )
            .setRequired(true)
            .addChoices(...localeChoices()),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('model')
        .setDescription('Nastaviť model a profil uvažovania')
        .setDescriptionLocalizations(english('Set a valid model and reasoning profile'))
        .addStringOption((option) =>
          option
            .setName('profile')
            .setDescription('Model a mieru uvažovania')
            .setDescriptionLocalizations(english('Model and reasoning effort'))
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
        .setDescription('Nastaviť maximálny kontext na jednu interakciu')
        .setDescriptionLocalizations(
          english('Set the maximum context members may request per interaction'),
        )
        .addIntegerOption((option) =>
          option
            .setName('messages')
            .setDescription(`0 vypne voliteľný kontext; maximum ${maximumContextMessages}`)
            .setDescriptionLocalizations(
              english(`0 disables opt-in context; maximum ${maximumContextMessages}`),
            )
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(maximumContextMessages),
        ),
    );

export const createCommandHandler = (input: {
  news?: NewsCommandServices;
  briefing?: BriefingCommandServices;
  reminderStore?: ReminderStore;
  timeZone?: string;
  reelStore?: ReelStore;
  reelsEnabled?: boolean;
  dailyLimitMicrodollars?: number;
  monthlyLimitMicrodollars?: number;
  transcriptTtlDays: number;
  maximumContextMessages: number;
  store: JolandaStore;
  logger: Logger;
  protectIdentifier: (identifier: string) => string;
}) => {
  const newsCommands = createNewsCommands(input);
  const interactionLocales = new WeakMap<ChatInputCommandInteraction, Locale>();
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

  const handle = async (interaction: ChatInputCommandInteraction) => {
    if (interaction.commandName !== 'jolanda' || !interaction.guildId) return;
    const guildId = interaction.guildId;
    const group = interaction.options.getSubcommandGroup?.(false) ?? null;
    const subcommand = interaction.options.getSubcommand();
    const defer = () => interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const edit = (content: string) =>
      interaction.editReply({ content, allowedMentions: safeMentions });
    // Settings are read fresh per interaction, so the locale is always current. The read is
    // defensive on purpose: news and reels administration must stay usable when the AI settings
    // store is degraded, so an unreachable store falls back to the default language rather than
    // failing the command. It also always happens *after* the interaction is acknowledged,
    // because Discord only allows three seconds to ack and a Mongo read must not sit in front
    // of that.
    const loadSettings = () =>
      input.store
        .getSettings(guildId)
        .catch(() => ({ ...defaultGuildSettings, guildId, updatedAt: new Date(0) }))
        .then((settings) => {
          interactionLocales.set(interaction, settings.locale);
          return settings;
        });

    if (!group && subcommand === 'privacy') {
      await defer();
      const settings = await loadSettings();
      const copy = messages(settings.locale);
      const model = getModel(settings.model);
      await edit(
        copy.commands.privacy({
          modelLabel: model.label,
          supportsZdr: model.supportsZdr,
          contextLimit: effectiveContextLimit(
            settings.contextLimitMessages,
            input.maximumContextMessages,
          ),
          transcriptTtlDays: input.transcriptTtlDays,
        }),
      );
      return;
    }
    if (group === 'reminders' || (!group && subcommand === 'remind')) {
      await defer();
      const settings = await loadSettings();
      if (!input.reminderStore) {
        await edit(messages(settings.locale).reminders.saveFailed);
        return;
      }
      await handleReminderCommand({
        interaction,
        store: input.reminderStore,
        locale: settings.locale,
        timeZone: input.timeZone ?? 'Europe/Bratislava',
      });
      return;
    }
    await defer();
    const settings = await loadSettings();
    const copy = messages(settings.locale);
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await edit(copy.commands.needsManageServer);
      return;
    }

    if (group === 'briefing') {
      if (input.briefing) await handleBriefingCommand(interaction, input.briefing, settings.locale);
      else await edit(copy.briefing.unavailable);
      return;
    }
    if (group) {
      if (group === 'continuous' || group === 'daily')
        await newsCommands.handle(interaction, group, settings.locale);
      else await edit(copy.commands.unknownGroup);
      return;
    }
    if (subcommand === 'reels') {
      const channel = interaction.channel;
      if (!channel || !reelChannelSupported(channel.type) || !input.reelStore) {
        await edit(copy.reels.channelUnsupported);
        return;
      }
      const enabled = interaction.options.getBoolean('enabled', true);
      if (enabled && !interaction.appPermissions?.has(reelPermissions)) {
        await edit(copy.reels.missingPermissions);
        return;
      }
      await input.reelStore.setEnabled({ guildId, channelId: channel.id }, enabled);
      logChange(interaction, guildId, 'reels', {
        enabled,
        channelKey: input.protectIdentifier(channel.id),
      });
      await edit(copy.reels.toggled({ enabled, deploymentOff: !input.reelsEnabled }));
      return;
    }
    if (subcommand === 'settings') {
      const budget = await input.store.getBudgetSummary(guildId, new Date());
      const channelEnabled =
        input.reelStore && interaction.channelId
          ? await input.reelStore.getEnabled({ guildId, channelId: interaction.channelId })
          : false;
      const model = getModel(settings.model);
      await edit(
        [
          await newsCommands.summary(guildId, settings.locale),
          copy.commands.settings({
            reelsDeploymentAvailable: Boolean(input.reelsEnabled),
            reelsChannelEnabled: channelEnabled,
            modelLabel: model.label,
            reasoning: settings.reasoning,
            supportsZdr: model.supportsZdr,
            contextLimit: effectiveContextLimit(
              settings.contextLimitMessages,
              input.maximumContextMessages,
            ),
            languageName: copy.languageName,
            dailyCommitted: formatUsd(
              budget.dailyUsedMicrodollars + budget.dailyReservedMicrodollars,
            ),
            monthlyCommitted: formatUsd(
              budget.monthlyUsedMicrodollars + budget.monthlyReservedMicrodollars,
            ),
          }),
        ].join('\n'),
      );
      return;
    }

    if (subcommand === 'usage') {
      const [summary, budget] = await Promise.all([
        input.store.getUsageSummary(guildId, {
          now: new Date(),
          trendDays: usageTrendDays,
          memberWindowDays: input.transcriptTtlDays,
        }),
        input.store.getBudgetSummary(guildId, new Date()),
      ]);
      if (!summary.trend.some((day) => day.costMicrodollars || day.requests)) {
        await edit(copy.usage.noData);
        return;
      }
      // Only members Discord has already cached are resolvable, which keeps this free of the
      // privileged Server Members intent; everyone else is grouped rather than shown as a hash.
      const knownMembers = new Map<string, string>();
      for (const [memberId, member] of interaction.guild?.members.cache ?? [])
        knownMembers.set(input.protectIdentifier(memberId), member.displayName);
      await edit(
        copy.usage.lines(
          usageFacts({
            summary,
            budget,
            dailyLimitMicrodollars: input.dailyLimitMicrodollars ?? 0,
            monthlyLimitMicrodollars: input.monthlyLimitMicrodollars ?? 0,
            knownMembers,
            othersLabel: copy.usage.others,
          }),
        ),
      );
      return;
    }

    if (subcommand === 'language') {
      const requested = interaction.options.getString('locale', true);
      if (!isLocale(requested)) {
        await edit(copy.commands.unknownCommand);
        return;
      }
      const updated = await input.store.updateSettings(guildId, { locale: requested });
      logChange(interaction, guildId, 'language', { locale: updated.locale });
      // Confirm in the newly selected language so the change is immediately visible.
      const next = messages(updated.locale);
      await edit(next.commands.languageSet(next.languageName));
      return;
    }

    if (subcommand === 'model') {
      const selected = interaction.options.getString('profile', true);
      const profile = findModelProfile(selected);
      if (!profile) throw new Error('Discord returned an unknown model profile');
      const model = getModel(profile.model);
      const updated = await input.store.updateSettings(guildId, {
        model: profile.model,
        reasoning: profile.reasoning,
      });
      logChange(interaction, guildId, 'model', {
        model: updated.model,
        reasoning: updated.reasoning,
      });
      await edit(
        copy.commands.modelSet({
          label: model.label,
          reasoning: profile.reasoning,
          supportsZdr: model.supportsZdr,
        }),
      );
      return;
    }

    if (subcommand !== 'context-limit') {
      await edit(copy.commands.unknownCommand);
      return;
    }
    const messageCount = interaction.options.getInteger('messages', true);
    const updated = await input.store.updateSettings(guildId, {
      contextLimitMessages: messageCount,
    });
    logChange(interaction, guildId, 'context_limit', {
      contextLimitMessages: updated.contextLimitMessages,
    });
    await edit(copy.commands.contextLimitSet(messageCount));
  };
  return Object.assign(handle, {
    localeFor: (interaction: ChatInputCommandInteraction) =>
      interactionLocales.get(interaction) ?? defaultLocale,
    removeNewsGuild: newsCommands.removeGuild,
    reconcileNewsGuilds: newsCommands.reconcileGuilds,
  });
};
