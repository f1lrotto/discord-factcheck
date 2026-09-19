import type { BriefingStore } from './briefing/types.js';
import type { ReminderStore, ReminderPublisher } from './reminders.js';
import { text } from './news/render.js';
import { formatDateTime } from './i18n/format.js';
import {
  Client,
  ApplicationCommandType,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { createCommand, createCommandHandler } from './discord-commands.js';
import { modelChoices } from './models.js';
import { createAskHandler } from './discord-ask.js';
import { createMessageHandler } from './discord-messages.js';
import { ephemeral, safeMentions, safeMessageFlags } from './discord-response.js';
import type { Jolanda } from './jolanda.js';
import {
  createConcurrencyGate,
  discordAdapterDrainTimeoutMs,
  discordOperationTimeoutMs,
  maximumDiscordAdapterHandlers,
} from './limits.js';
import { defaultLocale, messages } from './i18n/index.js';
import { safeError } from './security.js';
import type { ReelStore } from './reel-types.js';
import type { createDiscordReels } from './discord-reels.js';
import type { JolandaStore } from './types.js';
import { createNewsDiscordPublisher } from './news/discord.js';
import type { NewsPublisher, NewsStore } from './news/types.js';

export const createDiscordBot = (input: {
  newsStore?: NewsStore;
  briefingStore?: BriefingStore;
  briefingMaximumCities?: number;
  reminderStore?: ReminderStore;
  timeZone?: string;
  newsEnabled?: boolean;
  newsPublisherOptions?: Pick<
    Parameters<typeof createNewsDiscordPublisher>[0],
    'makeRequest' | 'timeoutMs' | 'clock'
  >;
  reels?: ReturnType<typeof createDiscordReels>;
  reelStore?: ReelStore;
  reelsEnabled?: boolean;
  client?: Client;
  token: string;
  maximumContextMessages: number;
  promptsPerMinute: number;
  transcriptTtlDays: number;
  monthlyLimitMicrodollars?: number;
  protectIdentifier: (identifier: string) => string;
  jolanda: Jolanda;
  store: JolandaStore;
  logger: Logger;
  adapterOperationTimeoutMs?: number;
  maximumAdapterHandlers?: number;
}) => {
  const client =
    input.client ??
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: { timeout: discordOperationTimeoutMs },
    });
  const ownedNewsPublisher =
    input.newsStore || input.briefingStore || input.reminderStore
      ? createNewsDiscordPublisher({
          ...input.newsPublisherOptions,
          client,
          token: input.token,
          resolveLocale: async (guildId) => (await input.store.getSettings(guildId)).locale,
        })
      : undefined;
  const newsPublisher: NewsPublisher | undefined = ownedNewsPublisher;
  const handleCommand = createCommandHandler({
    ...input,
    ...(input.briefingStore && ownedNewsPublisher
      ? {
          briefing: {
            store: input.briefingStore,
            publisher: ownedNewsPublisher,
            maximumCities: input.briefingMaximumCities ?? 5,
          },
        }
      : {}),
    ...(input.newsStore && newsPublisher
      ? {
          news: {
            store: input.newsStore,
            publisher: newsPublisher,
            enabled: input.newsEnabled ?? true,
            ...(input.newsPublisherOptions?.clock
              ? { clock: input.newsPublisherOptions.clock }
              : {}),
          },
        }
      : {}),
  });
  const handleMessage = createMessageHandler({
    ...input,
    client,
    operationTimeoutMs: input.adapterOperationTimeoutMs ?? discordOperationTimeoutMs,
  });
  const handleAsk = createAskHandler(input);
  const handlerGate = createConcurrencyGate(
    input.maximumAdapterHandlers ?? maximumDiscordAdapterHandlers,
  );
  const activeHandlers = new Set<Promise<void>>();
  let accepting = true;

  const track = (task: Promise<void>) => {
    activeHandlers.add(task);
    void task.finally(() => activeHandlers.delete(task)).catch(() => undefined);
  };

  const admit = (
    operation: (trackOperation: (task: Promise<unknown>) => void) => Promise<void>,
  ) => {
    const release = handlerGate.tryAcquire();
    if (!release) return;
    const pendingOperations = new Set<Promise<unknown>>();
    const trackOperation = (task: Promise<unknown>) => {
      pendingOperations.add(task);
      void task.finally(() => pendingOperations.delete(task)).catch(() => undefined);
    };
    const task = Promise.resolve()
      .then(() => operation(trackOperation))
      .finally(async () => {
        while (pendingOperations.size) await Promise.allSettled([...pendingOperations]);
        release();
      });
    track(task);
  };

  const reportCommandFailure = async (interaction: ChatInputCommandInteraction, error: unknown) => {
    input.logger.error({
      event: 'discord_command_failed',
      error: safeError(error),
      interactionKey: input.protectIdentifier(interaction.id),
    });
    const copy = messages(handleCommand.localeFor(interaction));
    const notice =
      interaction.options.getSubcommand() === 'ask'
        ? copy.common.temporarilyUnavailable
        : copy.common.saveFailed;
    const response = ephemeral(notice);
    try {
      if (interaction.deferred && !interaction.replied)
        await interaction.editReply({ content: notice, allowedMentions: safeMentions });
      else if (interaction.replied) await interaction.followUp(response);
      else await interaction.reply(response);
    } catch (replyError) {
      input.logger.error({
        event: 'discord_command_failure_notice_failed',
        error: safeError(replyError),
        interactionKey: input.protectIdentifier(interaction.id),
      });
    }
  };

  client.on(Events.InteractionCreate, (interaction) => {
    if (!accepting) return;
    if (interaction.isAutocomplete?.()) {
      if (interaction.commandName !== 'jolanda' || !interaction.guildId) return;
      const focused = interaction.options.getFocused(true);
      if (!['model', 'profile'].includes(focused.name)) return;
      const locale = interaction.locale.startsWith('en') ? 'en' : 'sk';
      admit(() =>
        interaction.respond(modelChoices(String(focused.value), locale)).catch((error: unknown) => {
          input.logger.warn({
            event: 'discord_model_autocomplete_failed',
            error: safeError(error),
          });
        }),
      );
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const handler =
      interaction.commandName === 'jolanda' && interaction.options.getSubcommand() === 'ask'
        ? handleAsk
        : handleCommand;
    admit(() =>
      handler(interaction).catch((error: unknown) => reportCommandFailure(interaction, error)),
    );
  });
  client.on(Events.MessageCreate, (message) => {
    if (!accepting) return;
    input.reels?.offer(message);
    admit((trackOperation) =>
      handleMessage(message, trackOperation).catch(async (error: unknown) => {
        input.logger.error({
          event: 'discord_message_failed',
          error: safeError(error),
          messageKey: input.protectIdentifier(message.id),
        });
        try {
          await message.reply({
            content: messages(defaultLocale).common.temporarilyUnavailable,
            allowedMentions: safeMentions,
            flags: safeMessageFlags,
          });
        } catch (replyError) {
          input.logger.error({
            event: 'discord_unavailable_notice_failed',
            error: safeError(replyError),
            messageKey: input.protectIdentifier(message.id),
          });
        }
      }),
    );
  });
  client.on(Events.GuildDelete, (guild) => {
    if (!accepting) return;
    track(
      handleCommand.removeNewsGuild(guild.id).catch(() => {
        input.logger.warn({
          event: 'news_guild_removal_failed',
          guildKey: input.protectIdentifier(guild.id),
        });
      }),
    );
  });
  client.once(Events.ClientReady, (readyClient) => {
    if (!accepting) return;
    // READY cache includes unavailable guilds; only absent memberships are erased.
    track(
      handleCommand.reconcileNewsGuilds(
        (guildId) => readyClient.guilds.cache.has(guildId),
        () => accepting,
      ),
    );
    admit(() =>
      readyClient.application.commands
        .set([
          createCommand(input.maximumContextMessages)
            .setContexts(InteractionContextType.Guild)
            .toJSON(),
        ])
        .then(async () => {
          // Older installations may have a guild command shadowing the global definition.
          // Edit it in place to preserve its ID and administrator-configured permissions.
          const definition = createCommand(input.maximumContextMessages);
          for (const guild of readyClient.guilds.cache.values()) {
            if (!accepting) break;
            try {
              const commands = await guild.commands.fetch();
              const legacy = commands.find(
                (command) =>
                  command.name === definition.name &&
                  command.type === ApplicationCommandType.ChatInput,
              );
              if (legacy && accepting) await guild.commands.edit(legacy.id, definition);
            } catch (error) {
              input.logger.error({
                event: 'discord_guild_command_registration_failed',
                guildKey: input.protectIdentifier(guild.id),
                error: safeError(error),
              });
            }
          }
          input.logger.info({
            event: 'discord_connected',
            botUserKey: input.protectIdentifier(readyClient.user.id),
          });
        })
        .catch((error: unknown) => {
          input.logger.error({
            event: 'discord_command_registration_failed',
            error: safeError(error),
          });
        }),
    );
  });

  const start = async () => client.login(input.token);
  const stopAccepting = () => {
    accepting = false;
  };
  const drain = async () => {
    const timeout = AbortSignal.timeout(discordAdapterDrainTimeoutMs);
    while (activeHandlers.size) {
      await Promise.race([
        Promise.allSettled([...activeHandlers]),
        new Promise<never>((_resolve, reject) =>
          timeout.addEventListener(
            'abort',
            () => reject(new Error('Discord adapter drain exceeded the configured timeout')),
            { once: true },
          ),
        ),
      ]);
    }
  };
  const destroy = () => {
    ownedNewsPublisher?.close();
    return client.destroy();
  };
  const reminderPublisher: ReminderPublisher | undefined = ownedNewsPublisher
    ? {
        ready: ownedNewsPublisher.ready,
        publish: async ({ destination, reminder, nonce, signal }) => {
          const locale = await input.store
            .getSettings(destination.guildId)
            .then((settings) => settings.locale)
            .catch(() => defaultLocale);
          return ownedNewsPublisher.publishPayload({
            destination,
            nonce,
            signal,
            payload: {
              content: messages(locale).reminders.deliver({
                userId: destination.userId,
                text: text(reminder.text, 600),
                createdAt: formatDateTime(
                  locale,
                  reminder.createdAt,
                  input.timeZone ?? 'Europe/Bratislava',
                ),
              }),
              allowed_mentions: { parse: [], users: [destination.userId] },
            },
          });
        },
      }
    : undefined;
  return {
    briefingPublisher: ownedNewsPublisher,
    reminderPublisher,
    start,
    stopAccepting,
    drain,
    destroy,
    ...(newsPublisher ? { newsPublisher } : {}),
  };
};
