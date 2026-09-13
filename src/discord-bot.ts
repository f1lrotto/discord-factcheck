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
import { createMessageHandler } from './discord-messages.js';
import { ephemeral, safeMentions, safeMessageFlags } from './discord-response.js';
import type { Jolanda } from './jolanda.js';
import {
  createConcurrencyGate,
  discordAdapterDrainTimeoutMs,
  discordOperationTimeoutMs,
  maximumDiscordAdapterHandlers,
} from './limits.js';
import { safeError } from './security.js';
import type { ReelStore } from './reel-types.js';
import type { createDiscordReels } from './discord-reels.js';
import type { JolandaStore } from './types.js';

export const createDiscordBot = (input: {
  reels?: ReturnType<typeof createDiscordReels>;
  reelStore?: ReelStore;
  reelsEnabled?: boolean;
  client?: Client;
  token: string;
  maximumContextMessages: number;
  promptsPerMinute: number;
  transcriptTtlDays: number;
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
  const handleCommand = createCommandHandler(input);
  const handleMessage = createMessageHandler({
    ...input,
    client,
    operationTimeoutMs: input.adapterOperationTimeoutMs ?? discordOperationTimeoutMs,
  });
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
    const response = ephemeral('I could not save that setting. Please try again.');
    try {
      if (interaction.deferred && !interaction.replied)
        await interaction.editReply({
          content: 'I could not save that setting. Please try again.',
          allowedMentions: safeMentions,
        });
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
    if (!accepting || !interaction.isChatInputCommand()) return;
    admit(() =>
      handleCommand(interaction).catch((error: unknown) =>
        reportCommandFailure(interaction, error),
      ),
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
            content: 'Jolanda is temporarily unavailable. Please try again.',
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
  client.once(Events.ClientReady, (readyClient) => {
    if (!accepting) return;
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
  const destroy = () => client.destroy();
  return { start, stopAccepting, drain, destroy };
};
