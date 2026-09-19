import { manualRunWindowMs } from '../scheduling/manual.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDestinationCipher } from '../crypto/destination.js';
import { mongoOperationOptions as options, type MongoContext } from '../mongo-context.js';
import { isDuplicateKey } from '../mongo-helpers.js';
import { briefingSchedule, defaultBriefingHour } from './policy.js';
import { citySchema, type BriefingStore, type BriefingSubscription } from './types.js';

export const createMongoBriefing = (context: MongoContext, secret: string): BriefingStore => {
  const subscriptions = context.collections.briefingSubscriptions;
  const deliveries = context.collections.briefingDeliveries;
  const destinationSchema = z.object({ guildId: z.string(), channelId: z.string() });
  const cipher = createDestinationCipher({
    secret,
    namespace: 'jolanda/briefing/v1',
    aadDomain: 'jolanda/briefing/destination',
    parse: (value) => {
      const parsed = destinationSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    reject: () => {
      throw new Error('Briefing destination authentication failed');
    },
  });
  const keyOf = (guildId: string) => cipher.hash('subscription', [guildId]);
  const get = (guildId: string) => subscriptions.findOne({ _id: keyOf(guildId) }, options);
  const ensure = async (guildId: string) => {
    try {
      await subscriptions.updateOne(
        { _id: keyOf(guildId) },
        { $setOnInsert: { enabled: false, revision: 1, hour: defaultBriefingHour, cities: [] } },
        { upsert: true, ...options },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  };
  const destination = (subscription: BriefingSubscription) =>
    subscription.destination ? cipher.decrypt(subscription.destination, subscription._id, 1) : null;
  return {
    get,
    destination,
    requestRun: async (guildId, requestId, now) => {
      const current = await get(guildId);
      if (!current?.enabled || !current.destination) return 'unconfigured';
      const manualRun = {
        key: cipher.hash('manual-delivery', [current._id, requestId]),
        expiresAt: new Date(+now + manualRunWindowMs),
      };
      if (current.manualRun?.key === manualRun.key) return 'queued';
      const result = await subscriptions.updateOne(
        {
          _id: current._id,
          enabled: true,
          revision: current.revision,
          $or: [
            { manualRun: { $exists: false } },
            { 'manualRun.key': manualRun.key },
            { 'manualRun.expiresAt': { $lte: now } },
          ],
        },
        { $set: { manualRun } },
        options,
      );
      return result.matchedCount ? 'queued' : 'busy';
    },
    configure: async (route) => {
      await ensure(route.guildId);
      return (await subscriptions.findOneAndUpdate(
        { _id: keyOf(route.guildId) },
        {
          $set: { enabled: true, destination: cipher.encrypt(route, keyOf(route.guildId), 1) },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after', ...options },
      ))!;
    },
    disable: async (guildId) => {
      const key = keyOf(guildId);
      await subscriptions.updateOne(
        { _id: key },
        {
          $set: { enabled: false },
          $unset: { destination: '', manualRun: '' },
          $inc: { revision: 1 },
        },
        options,
      );
      await deliveries.updateMany(
        { subscriptionKey: key, status: { $in: ['pending', 'claimed'] } },
        { $set: { status: 'cancelled' } },
        options,
      );
    },
    setHour: async (guildId, hour) => {
      if (!Number.isInteger(hour) || hour < 5 || hour > 21)
        throw new Error('Invalid briefing hour');
      await ensure(guildId);
      await subscriptions.updateOne(
        { _id: keyOf(guildId) },
        { $set: { hour }, $inc: { revision: 1 } },
        options,
      );
    },
    addCity: async (guildId, city, maximum) => {
      citySchema.parse(city);
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5)
        throw new Error('Invalid city limit');
      await ensure(guildId);
      const result = await subscriptions.updateOne(
        {
          _id: keyOf(guildId),
          cities: { $not: { $elemMatch: { lat: city.lat, lon: city.lon } } },
          $expr: { $lt: [{ $size: '$cities' }, maximum] },
        },
        { $push: { cities: city }, $inc: { revision: 1 } },
        options,
      );
      if (result.modifiedCount) return 'added';
      return (await get(guildId))!.cities.some(
        (existing) => existing.lat === city.lat && existing.lon === city.lon,
      )
        ? 'duplicate'
        : 'limit';
    },
    removeCity: async (guildId, name) => {
      const current = await get(guildId);
      const city = current?.cities.find(
        (city) => city.name.toLocaleLowerCase('sk') === name.toLocaleLowerCase('sk'),
      );
      if (!city) return false;
      const result = await subscriptions.updateOne(
        { _id: keyOf(guildId) },
        { $pull: { cities: { name: city.name } }, $inc: { revision: 1 } },
        options,
      );
      return result.modifiedCount === 1;
    },
    subscriptions: () => subscriptions.find({ enabled: true }, options).toArray(),
    claim: async (subscription, now) => {
      await deliveries.updateMany(
        { subscriptionKey: subscription._id, status: 'sending', leaseExpiresAt: { $lte: now } },
        { $set: { status: 'uncertain' } },
        options,
      );
      const schedule = briefingSchedule(now, subscription.hour);
      const manualRun =
        subscription.manualRun && subscription.manualRun.expiresAt > now
          ? subscription.manualRun
          : undefined;
      // A finished manual run retains its cooldown, but must not block the scheduled run.
      const manualDelivery = manualRun
        ? await deliveries.findOne({ _id: manualRun.key }, options)
        : null;
      const manual =
        manualRun &&
        (!manualDelivery || ['pending', 'claimed', 'sending'].includes(manualDelivery.status))
          ? manualRun
          : undefined;
      if (
        !subscription.enabled ||
        (!manual && (+now < +schedule.primaryAt || +now >= +schedule.deadline))
      )
        return null;
      const key = manual?.key ?? cipher.hash('delivery', [subscription._id, schedule.date]);
      try {
        await deliveries.updateOne(
          { _id: key },
          {
            $setOnInsert: {
              subscriptionKey: subscription._id,
              revision: subscription.revision,
              date: schedule.date,
              status: 'pending',
              attempts: 0,
              expiresAt: new Date(+now + 7 * 86_400_000),
            },
          },
          { upsert: true, ...options },
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      const owner = cipher.hash('lease', [randomUUID()]);
      const claimed = await deliveries.findOneAndUpdate(
        {
          _id: key,
          $or: [
            {
              status: 'pending',
              $or: [{ retryAt: { $exists: false } }, { retryAt: { $lte: now } }],
            },
            { status: 'claimed', leaseExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            status: 'claimed',
            owner,
            revision: subscription.revision,
            leaseExpiresAt: new Date(+now + 120_000),
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after', ...options },
      );
      return claimed
        ? {
            key,
            owner,
            subscription,
            date: schedule.date,
            ...(manual ? { manualRun: manual } : {}),
          }
        : null;
    },
    beginSend: async (claim, now) => {
      // Configuration and the send boundary share a transaction: a concurrent disable or
      // reroute invalidates the old revision before it can cross this boundary.
      const session = context.client.startSession();
      try {
        return await session.withTransaction(async () => {
          const subscription = await subscriptions.findOneAndUpdate(
            { _id: claim.subscription._id, enabled: true, revision: claim.subscription.revision },
            { $inc: { deliveryFence: 1 } },
            { returnDocument: 'after', session, ...options },
          );
          if (
            !subscription ||
            (claim.manualRun
              ? subscription.manualRun?.key !== claim.manualRun.key ||
                now >= claim.manualRun.expiresAt
              : briefingSchedule(now, subscription.hour).date !== claim.date ||
                +now >= +briefingSchedule(now, subscription.hour).deadline)
          )
            return null;
          const route = destination(subscription);
          if (!route) return null;
          const result = await deliveries.updateOne(
            { _id: claim.key, owner: claim.owner, status: 'claimed', leaseExpiresAt: { $gt: now } },
            { $set: { status: 'sending' } },
            { session, ...options },
          );
          return result.modifiedCount ? route : null;
        });
      } finally {
        await session.endSession();
      }
    },
    finishSend: async (claim, result, now) => {
      const status =
        result.outcome === 'sent'
          ? 'sent'
          : result.outcome === 'uncertain'
            ? 'uncertain'
            : result.outcome === 'destination-unavailable'
              ? 'cancelled'
              : 'pending';
      const schedule = briefingSchedule(now, claim.subscription.hour);
      const finished = await deliveries.updateOne(
        { _id: claim.key, owner: claim.owner, status: 'sending' },
        {
          $set: {
            status,
            retryAt: new Date(
              Math.max(
                +(claim.manualRun ? now : schedule.fallbackAt),
                +now + 60_000,
                +(result.outcome === 'rejected' && result.retryAt ? result.retryAt : now),
              ),
            ),
          },
          $unset: { owner: '', leaseExpiresAt: '' },
        },
        options,
      );
      if (finished.modifiedCount && status === 'sent')
        await subscriptions.updateOne(
          { _id: claim.subscription._id },
          { $set: { lastDeliveredAt: now } },
          options,
        );
    },
  };
};
