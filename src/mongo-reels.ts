import { randomUUID } from 'node:crypto';
import { mongoOperationOptions, type MongoContext } from './mongo-context.js';
import { isDuplicateKey } from './mongo-helpers.js';
import { reelLimits } from './reel-limits.js';
import type { ReelStore, ReelStatus, ReelOutcome } from './reel-types.js';
export type ReelSettingDocument = { _id: string; enabled: boolean; updatedAt: Date };
export type ReelDeliveryDocument = {
  _id: string;
  status: ReelStatus;
  leaseOwnerKey: string;
  leaseExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  outcome?: ReelOutcome;
  deliveredMessageKey?: string;
};
export const createMongoReels = (context: MongoContext, now = () => new Date()): ReelStore => {
  const { reelSettings, reelDeliveries } = context.collections;
  const key = (domain: string, values: string[]) =>
    context.protectIdentifier(JSON.stringify([domain, ...values]));
  return {
    getEnabled: async ({ guildId, channelId }) =>
      (
        await reelSettings.findOne(
          { _id: key('reel-channel', [guildId, channelId]) },
          mongoOperationOptions,
        )
      )?.enabled ?? false,
    setEnabled: async ({ guildId, channelId }, enabled) => {
      await reelSettings.updateOne(
        { _id: key('reel-channel', [guildId, channelId]) },
        { $set: { enabled, updatedAt: now() } },
        { upsert: true, ...mongoOperationOptions },
      );
    },
    claim: async ({ guildId, channelId, messageId, shortcode }) => {
      const claim = {
        key: key('reel-delivery', [guildId, channelId, messageId, shortcode]),
        owner: key('reel-owner', [randomUUID()]),
      };
      const date = now();
      try {
        const document = await reelDeliveries.findOneAndUpdate(
          {
            _id: claim.key,
            $or: [
              { expiresAt: { $lte: date } },
              { status: 'processing', leaseExpiresAt: { $lte: date } },
            ],
          },
          {
            $set: {
              status: 'processing',
              leaseOwnerKey: claim.owner,
              leaseExpiresAt: new Date(+date + reelLimits.leaseMs),
              createdAt: date,
              updatedAt: date,
              expiresAt: new Date(+date + reelLimits.receiptMs),
            },
            $unset: { outcome: '', deliveredMessageKey: '' },
          },
          { upsert: true, returnDocument: 'after', ...mongoOperationOptions },
        );
        return document ? claim : null;
      } catch (error) {
        if (isDuplicateKey(error)) return null;
        throw error;
      }
    },
    transition: async (claim, from, to, outcome, deliveredMessageId) => {
      const date = now();
      const result = await reelDeliveries.updateOne(
        {
          _id: claim.key,
          leaseOwnerKey: claim.owner,
          status: from,
          expiresAt: { $gt: date },
          ...(from === 'processing' ? { leaseExpiresAt: { $gt: date } } : {}),
        },
        {
          $set: {
            status: to,
            updatedAt: date,
            ...(outcome ? { outcome } : {}),
            ...(deliveredMessageId
              ? { deliveredMessageKey: key('reel-message', [deliveredMessageId]) }
              : {}),
          },
        },
        mongoOperationOptions,
      );
      return result.modifiedCount === 1;
    },
  };
};
