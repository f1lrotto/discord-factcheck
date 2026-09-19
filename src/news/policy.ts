import { dailySlotSchedule, localDate } from '../scheduling/slots.js';
import type {
  NewsDailyCollection,
  NewsDailySlot,
  NewsEdition,
  NewsObservation,
  NewsPublication,
  NewsPublicationDraft,
  NewsSnapshot,
  NewsStory,
  NewsSubscription,
} from './types.js';

export const newsPolicy = {
  timeZone: 'Europe/Bratislava',
  continuousIntervalMs: 20 * 60_000,
  catchUpMs: 2 * 60 * 60_000,
  promotionAgeMs: 24 * 60 * 60_000,
} as const;

export const newsLocalDate = (instant: Date) => localDate(instant, newsPolicy.timeZone);

export const dailySchedule = (instant: Date) =>
  dailySlotSchedule({
    instant,
    timeZone: newsPolicy.timeZone,
    primaryHour: 20,
    fallbackHour: 21,
    deadlineHour: 22,
  });

export const isRecentDailyEdition = (edition: NewsEdition, now: Date) =>
  edition.publishedAt <= now && +now - +edition.publishedAt < 48 * 60 * 60_000;

export const isCurrentDailyEdition = (edition: NewsEdition, now: Date) =>
  edition.publishedAt <= now && newsLocalDate(edition.publishedAt) === newsLocalDate(now);

export const dailyCollectionSlot = (
  now: Date,
  state: NewsDailyCollection,
  backoffUntil?: Date,
): NewsDailySlot | null => {
  const { date, primaryAt, fallbackAt, deadline } = dailySchedule(now);
  if (
    now < primaryAt ||
    now >= deadline ||
    (backoffUntil && now < backoffUntil) ||
    (state.collectedEdition && isCurrentDailyEdition(state.collectedEdition, now))
  )
    return null;
  const kind = now < fallbackAt ? 'primary' : 'fallback';
  const retry =
    kind === 'fallback' ? Math.floor((+now - +fallbackAt) / newsPolicy.continuousIntervalMs) : 0;
  const key = JSON.stringify(['aktuality', date, kind, ...(retry ? [retry] : [])]);
  if (state.attemptedSlots.includes(key)) return null;
  return {
    key,
    date,
    kind,
    dueAt:
      kind === 'primary'
        ? primaryAt
        : new Date(+fallbackAt + retry * newsPolicy.continuousIntervalMs),
    expiresAt:
      kind === 'primary'
        ? fallbackAt
        : new Date(
            Math.min(+deadline, +fallbackAt + (retry + 1) * newsPolicy.continuousIntervalMs),
          ),
  };
};

export const publicationKey = (subscriptionKey: string, content: NewsStory | NewsEdition) =>
  JSON.stringify([
    subscriptionKey,
    content.kind === 'story' ? 'continuous' : 'daily',
    content.source,
    content.kind === 'story' ? content.id : newsLocalDate(content.publishedAt),
  ]);

export const nextContinuousCollectionAt = (attemptedAt: Date, backoffUntil?: Date) =>
  new Date(
    Math.max(+attemptedAt + newsPolicy.continuousIntervalMs, +(backoffUntil ?? attemptedAt)),
  );

export const activateContinuousBaseline = (snapshot: NewsSnapshot | null, now: Date) =>
  snapshot &&
  snapshot.collectedAt <= now &&
  +now - +snapshot.collectedAt < newsPolicy.continuousIntervalMs
    ? snapshot
    : null;

export const establishContinuousBaseline = (
  baseline: NewsSnapshot | null,
  snapshot: NewsSnapshot,
) => baseline ?? snapshot;

export const observeStory = (
  story: NewsStory,
  snapshot: NewsSnapshot,
  previous?: NewsObservation,
): NewsObservation => {
  if (previous && previous.story.id !== story.id) throw new Error('Mismatched news observation');
  const firstImportantAt =
    previous?.firstImportantAt ?? (story.important ? snapshot.collectedAt : undefined);
  const firstImportantSequence =
    previous?.firstImportantSequence ?? (story.important ? snapshot.sequence : undefined);
  return {
    story,
    firstSeenAt: previous?.firstSeenAt ?? snapshot.collectedAt,
    lastSeenAt: snapshot.collectedAt,
    ...(firstImportantAt ? { firstImportantAt } : {}),
    ...(firstImportantSequence !== undefined ? { firstImportantSequence } : {}),
  };
};

export const continuousEligible = (
  observation: NewsObservation,
  baseline: NewsSnapshot | null,
  now: Date,
) => {
  const { story, firstImportantAt, firstImportantSequence } = observation;
  return Boolean(
    baseline &&
    story.important &&
    firstImportantAt &&
    firstImportantSequence !== undefined &&
    firstImportantSequence > baseline.sequence &&
    story.publishedAt <= firstImportantAt &&
    +firstImportantAt - +story.publishedAt <= newsPolicy.promotionAgeMs &&
    firstImportantAt <= now &&
    +now < +firstImportantAt + newsPolicy.catchUpMs,
  );
};

const subscriptionActive = (subscription: NewsSubscription, now: Date) =>
  subscription.enabled && !subscription.pausedReason && subscription.activatedAt <= now;

export const planDailyPublication = (
  subscription: NewsSubscription,
  edition: NewsEdition,
  now: Date,
  // Includes pending/claimed/sending/sent/uncertain keys, excluding safely cancelled old revisions.
  reservedKeys: ReadonlySet<string>,
): NewsPublicationDraft | null => {
  const { primaryAt, deadline } = dailySchedule(now);
  if (
    subscription.feed !== 'daily' ||
    !subscriptionActive(subscription, now) ||
    now < primaryAt ||
    now >= deadline ||
    !isCurrentDailyEdition(edition, now)
  )
    return null;
  const key = publicationKey(subscription.key, edition);
  if (reservedKeys.has(key)) return null;
  return {
    key,
    subscriptionKey: subscription.key,
    configurationRevision: subscription.revision,
    content: edition,
    dueAt: now,
    expiresAt: deadline,
  };
};

export const planContinuousPublications = (
  subscription: NewsSubscription,
  observations: readonly NewsObservation[],
  now: Date,
  reservedKeys: ReadonlySet<string>,
): NewsPublicationDraft[] => {
  if (subscription.feed !== 'continuous' || !subscriptionActive(subscription, now)) return [];
  const dueAt = now;
  return observations
    .filter((item) => continuousEligible(item, subscription.baseline, dueAt))
    .filter((item) => !reservedKeys.has(publicationKey(subscription.key, item.story)))
    .sort(
      (a, b) => +a.firstImportantAt! - +b.firstImportantAt! || a.story.id.localeCompare(b.story.id),
    )
    .map((observation) => ({
      key: publicationKey(subscription.key, observation.story),
      subscriptionKey: subscription.key,
      configurationRevision: subscription.revision,
      content: observation.story,
      dueAt,
      expiresAt: new Date(+observation.firstImportantAt! + newsPolicy.catchUpMs),
    }));
};

export const planContinuousPublication = (...args: Parameters<typeof planContinuousPublications>) =>
  planContinuousPublications(...args)[0] ?? null;

export const canAdmitSend = (
  publication: NewsPublication,
  subscription: NewsSubscription,
  now: Date,
) =>
  subscriptionActive(subscription, now) &&
  publication.subscriptionKey === subscription.key &&
  publication.configurationRevision === subscription.revision &&
  (publication.status === 'pending' || publication.status === 'claimed') &&
  publication.dueAt <= now &&
  now < publication.expiresAt &&
  (publication.content.kind === 'edition'
    ? subscription.feed === 'daily' &&
      (publication.manual
        ? isRecentDailyEdition(publication.content, now)
        : isCurrentDailyEdition(publication.content, now) &&
          now >= dailySchedule(now).primaryAt &&
          now < dailySchedule(now).deadline)
    : subscription.feed === 'continuous');

// Call only for confirmed rejection before acceptance; ambiguous results never enter this path.
export const safeRetryAt = (publication: NewsPublication, now: Date, delayMs: number) => {
  if (publication.status !== 'sending' || !Number.isFinite(delayMs) || delayMs < 0) return null;
  const retryAt = new Date(+now + delayMs);
  const deadline =
    publication.content.kind === 'edition' && !publication.manual
      ? Math.min(+publication.expiresAt, +dailySchedule(publication.content.publishedAt).deadline)
      : +publication.expiresAt;
  return +retryAt < deadline ? retryAt : null;
};
