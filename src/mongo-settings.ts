import {
  defaultGuildSettings,
  modelSupportsReasoning,
  UnsupportedReasoningError,
  type GuildSettings,
} from './models.js';
import { mongoOperationOptions, type MongoContext } from './mongo-context.js';
import { isDuplicateKey } from './mongo-helpers.js';
import type { GuildSettingsDocument } from './mongo-schema.js';
import type { JolandaStore } from './types.js';

const fromDocument = (guildId: string, document: GuildSettingsDocument | null) => ({
  guildId,
  model: document?.model ?? defaultGuildSettings.model,
  reasoning: document?.reasoning ?? defaultGuildSettings.reasoning,
  contextLimitMessages:
    document?.contextLimitMessages ??
    document?.contextMessages ??
    defaultGuildSettings.contextLimitMessages,
  updatedAt: document?.updatedAt ?? new Date(0),
});

export const createMongoSettings = (context: MongoContext) => {
  const getSettings = async (guildId: string) => {
    const document = await context.collections.guildSettings.findOne(
      { _id: context.protectIdentifier(guildId) },
      mongoOperationOptions,
    );
    return fromDocument(guildId, document);
  };

  const ensureSettings = async (guildKey: string) => {
    try {
      await context.collections.guildSettings.updateOne(
        { _id: guildKey },
        {
          $setOnInsert: {
            model: defaultGuildSettings.model,
            reasoning: defaultGuildSettings.reasoning,
            contextLimitMessages: defaultGuildSettings.contextLimitMessages,
            updatedAt: new Date(0),
          },
        },
        { upsert: true, ...mongoOperationOptions },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  };

  const updateSettings: JolandaStore['updateSettings'] = async (guildId, patch) => {
    const guildKey = context.protectIdentifier(guildId);
    await ensureSettings(guildKey);
    let settings: GuildSettings | undefined;
    await context.client.withSession(async (session) =>
      session.withTransaction(async () => {
        const current = await context.collections.guildSettings.findOne(
          { _id: guildKey },
          { session },
        );
        if (!current) throw new Error('Guild settings disappeared during update');
        const model = patch.model ?? current.model;
        const reasoning = patch.reasoning ?? current.reasoning;
        if (!modelSupportsReasoning(model, reasoning))
          throw new UnsupportedReasoningError(model, reasoning);
        const contextLimitMessages =
          patch.contextLimitMessages ??
          current.contextLimitMessages ??
          current.contextMessages ??
          defaultGuildSettings.contextLimitMessages;
        if (!Number.isSafeInteger(contextLimitMessages) || contextLimitMessages < 0)
          throw new Error('Context limit must be a non-negative safe integer');
        const updated: GuildSettingsDocument = {
          _id: guildKey,
          model,
          reasoning,
          contextLimitMessages,
          updatedAt: new Date(),
        };
        await context.collections.guildSettings.replaceOne({ _id: guildKey }, updated, { session });
        settings = fromDocument(guildId, updated);
      }, mongoOperationOptions),
    );
    if (!settings) throw new Error('Guild settings update did not complete');
    return settings;
  };

  return { getSettings, updateSettings };
};
