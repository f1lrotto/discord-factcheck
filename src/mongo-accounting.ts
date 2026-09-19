import type { ClientSession } from 'mongodb';
import { recoveryIntervalMs, requestLeaseMs } from './limits.js';
import { mongoOperationOptions, type MongoContext } from './mongo-context.js';
import { bucketIds, isDuplicateKey } from './mongo-helpers.js';
import type { BudgetBucketDocument, RequestDocument } from './mongo-schema.js';
import { safeError } from './security.js';
import type { AuthorizationResult, BudgetSummary, JolandaStore, Usage } from './types.js';

type AuthorizationFailure = Exclude<AuthorizationResult, { ok: true }>['reason'];

const authorizationDenied = (reason: AuthorizationFailure) => ({
  type: 'authorization_denied' as const,
  reason,
});

const isAuthorizationDenied = (value: unknown): value is ReturnType<typeof authorizationDenied> =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  value.type === 'authorization_denied' &&
  'reason' in value;

export const createMongoAccounting = (
  context: MongoContext,
  input: {
    monthlyLimitMicrodollars: number;
    promptsPerMinute: number;
    transcriptTtlMs: number;
    instanceId: string;
    recoveryIntervalMs?: number;
    requestLeaseMs?: number;
  },
) => {
  const recoveryBatchSize = 100;
  const instanceKey = context.protectIdentifier(input.instanceId);
  const leaseMs = input.requestLeaseMs ?? requestLeaseMs;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let activeRecovery: Promise<void> | null = null;

  const settleByKey = async (settlement: {
    requestKey: string;
    usage?: Usage;
    status: RequestDocument['status'];
    errorCode?: string;
  }) => {
    let exceededReservation = false;
    await context.client.withSession(async (session) =>
      session.withTransaction(async () => {
        const request = await context.collections.requests.findOne(
          { _id: settlement.requestKey, status: 'processing' },
          { session },
        );
        if (!request) return;
        const reportedCost = settlement.usage?.costMicrodollars;
        const validUsage =
          reportedCost !== undefined && Number.isSafeInteger(reportedCost) && reportedCost >= 0;
        const usage =
          settlement.status === 'completed' && validUsage ? settlement.usage : undefined;
        const costMicrodollars = usage?.costMicrodollars ?? 0;
        exceededReservation = costMicrodollars > request.reservationMicrodollars;
        for (const bucketId of [request.dailyBucketId, request.monthlyBucketId]) {
          await context.collections.budgetBuckets.updateOne(
            { _id: bucketId },
            {
              $inc: {
                reservedMicrodollars: -request.reservationMicrodollars,
                usedMicrodollars: costMicrodollars,
              },
            },
            { session },
          );
        }
        await context.collections.requests.updateOne(
          { _id: settlement.requestKey, status: 'processing' },
          {
            $set: {
              status:
                settlement.status === 'failed' || validUsage ? settlement.status : 'usage_missing',
              ...(usage ? { usage } : {}),
              ...(settlement.errorCode ? { errorCode: settlement.errorCode } : {}),
              settledAt: new Date(),
            },
          },
          { session },
        );
      }, mongoOperationOptions),
    );
    if (exceededReservation) {
      context.logger.error({
        event: 'cost_envelope_exceeded',
        requestKey: settlement.requestKey,
        actualMicrodollars: settlement.usage?.costMicrodollars,
      });
    }
  };

  const sweepExpiredRequests = async (now = new Date()) => {
    let recoveredReservations = 0;
    for await (const request of context.collections.requests
      .find(
        {
          status: 'processing',
          leaseExpiresAt: { $lte: now },
        },
        mongoOperationOptions,
      )
      .limit(recoveryBatchSize)) {
      await settleByKey({
        requestKey: request._id,
        status: 'failed',
        errorCode: 'lease_expired',
      });
      recoveredReservations += 1;
    }
    if (recoveredReservations)
      context.logger.error({ event: 'stale_reservations_recovered', recoveredReservations });
  };

  const recoverExpiredRequests = (now = new Date()) => {
    if (activeRecovery) return activeRecovery;
    const recovery = sweepExpiredRequests(now).finally(() => {
      if (activeRecovery === recovery) activeRecovery = null;
    });
    activeRecovery = recovery;
    return recovery;
  };

  const startRecovery = () => {
    recoveryTimer = setInterval(() => {
      void recoverExpiredRequests().catch((error: unknown) =>
        context.logger.error({ event: 'reservation_recovery_failed', error: safeError(error) }),
      );
    }, input.recoveryIntervalMs ?? recoveryIntervalMs);
    recoveryTimer.unref();
  };

  const stopRecovery = async () => {
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = undefined;
    const recovery = activeRecovery;
    if (recovery) {
      await recovery.catch((error: unknown) =>
        context.logger.error({
          event: 'reservation_recovery_drain_failed',
          error: safeError(error),
        }),
      );
    }
  };

  const ensureAuthorizationDocuments = async (documents: {
    rateLimitId: string;
    ids: ReturnType<typeof bucketIds>;
    guildKey: string;
    now: Date;
  }) => {
    const bucketExpiry = new Date(documents.now.getTime() + 120 * 24 * 60 * 60 * 1_000);
    const buckets: BudgetBucketDocument[] = [
      {
        _id: documents.ids.day,
        guildKey: documents.guildKey,
        period: 'day',
        periodKey: documents.ids.keys.day,
        usedMicrodollars: 0,
        reservedMicrodollars: 0,
        expiresAt: bucketExpiry,
      },
      {
        _id: documents.ids.month,
        guildKey: documents.guildKey,
        period: 'month',
        periodKey: documents.ids.keys.month,
        usedMicrodollars: 0,
        reservedMicrodollars: 0,
        expiresAt: bucketExpiry,
      },
    ];
    await Promise.all([
      context.collections.rateLimits.updateOne(
        { _id: documents.rateLimitId },
        {
          $setOnInsert: {
            attempts: [],
            expiresAt: new Date(documents.now.getTime() + 2 * 60_000),
          },
        },
        { upsert: true, ...mongoOperationOptions },
      ),
      ...buckets.map((bucket) =>
        context.collections.budgetBuckets.updateOne(
          { _id: bucket._id },
          { $setOnInsert: bucket },
          { upsert: true, ...mongoOperationOptions },
        ),
      ),
    ]);
  };

  const authorizeTurn: JolandaStore['authorizeTurn'] = async (authorization) => {
    const guildKey = context.protectIdentifier(authorization.guildId);
    const channelKey = context.protectIdentifier(authorization.channelId);
    const userKey = context.protectIdentifier(authorization.userId);
    const requestKey = context.protectIdentifier(authorization.requestId);
    const ids = bucketIds(guildKey, authorization.now);
    const rateLimitId = `${guildKey}:${userKey}`;
    await ensureAuthorizationDocuments({ rateLimitId, ids, guildKey, now: authorization.now });

    try {
      await context.client.withSession(async (session) =>
        session.withTransaction(async () => {
          await context.collections.requests.insertOne(
            {
              _id: requestKey,
              guildKey,
              channelKey,
              userKey,
              instanceKey,
              dailyBucketId: ids.day,
              monthlyBucketId: ids.month,
              reservationMicrodollars: authorization.reservationMicrodollars,
              status: 'processing',
              createdAt: authorization.now,
              leaseExpiresAt: new Date(authorization.now.getTime() + leaseMs),
              expiresAt: new Date(authorization.now.getTime() + input.transcriptTtlMs),
            },
            { session },
          );
          await applyRateLimit(rateLimitId, authorization.now, session);
          await reserveBudgets(ids, authorization.reservationMicrodollars, session);
        }, mongoOperationOptions),
      );
      return { ok: true };
    } catch (error) {
      if (isAuthorizationDenied(error)) return { ok: false, reason: error.reason };
      if (isDuplicateKey(error)) {
        const duplicateRequest = await context.collections.requests.findOne(
          { _id: requestKey },
          { projection: { _id: 1 }, ...mongoOperationOptions },
        );
        if (duplicateRequest) return { ok: false, reason: 'duplicate' };
      }
      throw error;
    }
  };

  const applyRateLimit = async (rateLimitId: string, now: Date, session: ClientSession) => {
    const rateLimit = await context.collections.rateLimits.findOne(
      { _id: rateLimitId },
      { session },
    );
    const cutoff = now.getTime() - 60_000;
    const recentAttempts = (rateLimit?.attempts ?? []).filter(
      (attempt) => attempt.getTime() > cutoff,
    );
    if (recentAttempts.length >= input.promptsPerMinute) throw authorizationDenied('rate_limited');
    await context.collections.rateLimits.updateOne(
      { _id: rateLimitId },
      {
        $set: {
          attempts: [...recentAttempts, now],
          expiresAt: new Date(now.getTime() + 2 * 60_000),
        },
      },
      { session },
    );
  };

  const reserveBudgets = async (
    ids: ReturnType<typeof bucketIds>,
    reservationMicrodollars: number,
    session: ClientSession,
  ) => {
    const monthlyBucket = await context.collections.budgetBuckets.findOne(
      { _id: ids.month },
      { session },
    );
    const monthlyCommitted =
      (monthlyBucket?.usedMicrodollars ?? 0) + (monthlyBucket?.reservedMicrodollars ?? 0);
    if (monthlyCommitted + reservationMicrodollars > input.monthlyLimitMicrodollars)
      throw authorizationDenied('monthly_budget');
    for (const bucketId of [ids.day, ids.month]) {
      await context.collections.budgetBuckets.updateOne(
        { _id: bucketId },
        { $inc: { reservedMicrodollars: reservationMicrodollars } },
        { session },
      );
    }
  };

  const settleRequest: JolandaStore['settleRequest'] = async ({ requestId, usage, status }) =>
    settleByKey({ requestKey: context.protectIdentifier(requestId), usage, status });

  const failRequest = async (requestId: string, errorCode: string) =>
    settleByKey({
      requestKey: context.protectIdentifier(requestId),
      status: 'failed',
      errorCode,
    });

  const getBudgetSummary = async (guildId: string, now: Date): Promise<BudgetSummary> => {
    const ids = bucketIds(context.protectIdentifier(guildId), now);
    const [daily, monthly] = await Promise.all([
      context.collections.budgetBuckets.findOne({ _id: ids.day }, mongoOperationOptions),
      context.collections.budgetBuckets.findOne({ _id: ids.month }, mongoOperationOptions),
    ]);
    return {
      dailyUsedMicrodollars: daily?.usedMicrodollars ?? 0,
      dailyReservedMicrodollars: daily?.reservedMicrodollars ?? 0,
      monthlyUsedMicrodollars: monthly?.usedMicrodollars ?? 0,
      monthlyReservedMicrodollars: monthly?.reservedMicrodollars ?? 0,
    };
  };

  /**
   * Reads two windows that are not interchangeable.
   *
   * `trend` comes from the guild's daily budget buckets, which are retained for about 120
   * days, so it can show weeks of history. `members` is derived from per-request documents,
   * which expire with the transcript TTL (seven days by default). The caller must label the
   * two windows separately; presenting them as one makes the totals look inconsistent when
   * they are simply measuring different spans.
   */
  const getUsageSummary: JolandaStore['getUsageSummary'] = async (guildId, options) => {
    const guildKey = context.protectIdentifier(guildId);
    // The two windows are independent by design: bucket retention and transcript retention
    // are different spans, so the member window is not clamped to the trend window.
    const bounded = (value: number) =>
      Number.isFinite(value) ? Math.max(1, Math.min(120, Math.trunc(value))) : 14;
    const trendDays = bounded(options.trendDays);
    const memberWindowDays = Math.min(
      bounded(options.memberWindowDays),
      input.transcriptTtlMs / 86_400_000,
    );
    const dayKey = (offset: number) =>
      new Date(+options.now - offset * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const earliestTrendDay = dayKey(trendDays - 1);
    const memberCutoff = new Date(+options.now - memberWindowDays * 24 * 60 * 60_000);

    const [buckets, requests] = await Promise.all([
      context.collections.budgetBuckets
        .find(
          {
            guildKey,
            period: 'day',
            periodKey: { $gte: earliestTrendDay, $lte: dayKey(0) },
            expiresAt: { $gt: options.now },
          },
          mongoOperationOptions,
        )
        .sort({ periodKey: 1 })
        .toArray(),
      context.collections.requests
        .aggregate<{
          _id: { userKey: string; day: string };
          requests: number;
          costMicrodollars: number;
          failures: number;
        }>(
          [
            {
              $match: {
                guildKey,
                createdAt: { $gte: memberCutoff, $lte: options.now },
                expiresAt: { $gt: options.now },
              },
            },
            {
              $group: {
                _id: {
                  userKey: '$userKey',
                  day: {
                    $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' },
                  },
                },
                requests: { $sum: 1 },
                costMicrodollars: {
                  $sum: {
                    $cond: [
                      { $eq: ['$status', 'completed'] },
                      { $ifNull: ['$usage.costMicrodollars', 0] },
                      0,
                    ],
                  },
                },
                failures: {
                  $sum: { $cond: [{ $in: ['$status', ['failed', 'usage_missing']] }, 1, 0] },
                },
              },
            },
          ],
          mongoOperationOptions,
        )
        .toArray(),
    ]);

    const spendByDay = new Map(
      buckets.map((bucket) => [bucket.periodKey, bucket.usedMicrodollars]),
    );
    const requestsByDay = new Map<string, number>();
    const byMember = new Map<
      string,
      { requests: number; costMicrodollars: number; failures: number }
    >();
    for (const request of requests) {
      const day = request._id.day;
      requestsByDay.set(day, (requestsByDay.get(day) ?? 0) + request.requests);
      const member = byMember.get(request._id.userKey) ?? {
        requests: 0,
        costMicrodollars: 0,
        failures: 0,
      };
      // Only settled, reported usage is counted, matching how the budget is charged.
      member.requests += request.requests;
      member.costMicrodollars += request.costMicrodollars;
      member.failures += request.failures;
      byMember.set(request._id.userKey, member);
    }

    // Oldest first, with silent gaps filled so a sparkline reads as a real timeline.
    const trend = Array.from({ length: trendDays }, (_unused, offset) => {
      const date = dayKey(trendDays - 1 - offset);
      return {
        date,
        costMicrodollars: spendByDay.get(date) ?? 0,
        requests: requestsByDay.get(date) ?? 0,
      };
    });

    return {
      trendDays,
      memberWindowDays,
      trend,
      members: [...byMember.entries()]
        .map(([userKey, totals]) => ({ userKey, ...totals }))
        .sort(
          (left, right) =>
            right.costMicrodollars - left.costMicrodollars ||
            right.requests - left.requests ||
            left.userKey.localeCompare(right.userKey),
        ),
      totalCostMicrodollars: trend.reduce((total, day) => total + day.costMicrodollars, 0),
    };
  };

  return {
    authorizeTurn,
    settleRequest,
    failRequest,
    getBudgetSummary,
    getUsageSummary,
    recoverExpiredRequests,
    startRecovery,
    stopRecovery,
  };
};
