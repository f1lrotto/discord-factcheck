import type { WithId } from 'mongodb';
import { conversationReplyLimit, requestLeaseMs } from './limits.js';
import { mongoOperationOptions, type MongoContext } from './mongo-context.js';
import { isDuplicateKey } from './mongo-helpers.js';
import type { ConversationDocument } from './mongo-schema.js';
import type { Conversation, JolandaStore, StoredTurn } from './types.js';

const toConversation = (document: WithId<ConversationDocument>): Conversation => ({
  id: document._id,
  ownerKey: document.ownerKey,
  replyCount: document.replyCount,
  turns: document.turns.map((turn) => ({
    userContent: turn.userContent,
    assistantContent: turn.assistantContent,
    createdAt: turn.createdAt,
  })),
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  expiresAt: document.expiresAt,
});

export const createMongoConversations = (
  context: MongoContext,
  configuredLeaseMs = requestLeaseMs,
) => {
  const findConversationByMessage: JolandaStore['findConversationByMessage'] = async (query) => {
    const currentTime = new Date();
    const guildKey = context.protectIdentifier(query.guildId);
    const channelKey = context.protectIdentifier(query.channelId);
    const link = await context.collections.messageLinks.findOne(
      {
        _id: context.protectIdentifier(query.messageId),
        guildKey,
        channelKey,
        expiresAt: { $gt: currentTime },
      },
      mongoOperationOptions,
    );
    if (!link) return null;
    const conversation = await context.collections.conversations.findOne(
      {
        _id: link.conversationId,
        guildKey,
        channelKey,
        expiresAt: { $gt: currentTime },
      },
      mongoOperationOptions,
    );
    return conversation ? toConversation(conversation) : null;
  };

  const tryLockConversation = async (conversationId: string, lockToken: string, now: Date) => {
    try {
      await context.collections.conversationLocks.findOneAndUpdate(
        {
          _id: conversationId,
          expiresAt: { $lte: now },
        },
        {
          $set: {
            requestKey: context.protectIdentifier(lockToken),
            expiresAt: new Date(now.getTime() + configuredLeaseMs),
          },
        },
        { upsert: true, ...mongoOperationOptions },
      );
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  };

  const releaseConversation = async (conversationId: string, lockToken: string) => {
    await context.collections.conversationLocks.deleteOne(
      {
        _id: conversationId,
        requestKey: context.protectIdentifier(lockToken),
      },
      mongoOperationOptions,
    );
  };

  const appendTurn = async (stored: StoredTurn) => {
    const requestKey = context.protectIdentifier(stored.requestId);
    const guildKey = context.protectIdentifier(stored.guildId);
    const channelKey = context.protectIdentifier(stored.channelId);
    const ownerKey = context.protectIdentifier(stored.ownerId);
    await context.client.withSession(async (session) =>
      session.withTransaction(async () => {
        const existing = await context.collections.conversations.findOne(
          { _id: stored.conversationId },
          { session },
        );
        if (existing?.turns.some((turn) => turn.requestKey === requestKey)) return;
        if (existing && existing.replyCount >= conversationReplyLimit)
          throw new Error('Conversation reached its maximum turn count');
        if (
          existing &&
          (existing.guildKey !== guildKey ||
            existing.channelKey !== channelKey ||
            existing.ownerKey !== ownerKey)
        )
          throw new Error('Conversation scope or owner changed');

        const turn = { ...stored.turn, requestKey };
        if (existing) {
          const updated = await context.collections.conversations.updateOne(
            { _id: stored.conversationId, replyCount: { $lt: conversationReplyLimit } },
            {
              $push: { turns: turn },
              $inc: { replyCount: 1 },
              $set: { updatedAt: stored.turn.createdAt, expiresAt: stored.expiresAt },
            },
            { session },
          );
          if (!updated.modifiedCount)
            throw new Error('Conversation reached its maximum turn count');
        } else {
          await context.collections.conversations.insertOne(
            {
              _id: stored.conversationId,
              guildKey,
              channelKey,
              ownerKey,
              replyCount: 1,
              turns: [turn],
              createdAt: stored.turn.createdAt,
              updatedAt: stored.turn.createdAt,
              expiresAt: stored.expiresAt,
            },
            { session },
          );
        }

        if (!stored.assistantMessageIds.length) return;
        await context.collections.messageLinks.bulkWrite(
          stored.assistantMessageIds.map((messageId) => ({
            updateOne: {
              filter: { _id: context.protectIdentifier(messageId) },
              update: {
                $set: {
                  conversationId: stored.conversationId,
                  guildKey,
                  channelKey,
                  expiresAt: stored.expiresAt,
                },
              },
              upsert: true,
            },
          })),
          { ordered: false, session },
        );
      }, mongoOperationOptions),
    );
  };

  return {
    findConversationByMessage,
    tryLockConversation,
    releaseConversation,
    appendTurn,
  };
};
