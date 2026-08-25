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
  contextMessages: document?.contextMessages ?? defaultGuildSettings.contextMessages,
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
            contextMessages: defaultGuildSettings.contextMessages,
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
        const updated: GuildSettingsDocument = {
          _id: guildKey,
          model,
          reasoning,
          contextMessages: patch.contextMessages ?? current.contextMessages,
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
