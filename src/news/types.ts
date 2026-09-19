import type { ManualRunResult } from '../scheduling/manual.js';

export type NewsFeed = 'continuous' | 'daily';
export type NewsSourceId = 'dennikn' | 'aktuality';
export type NewsClock = () => Date;

type NewsMetadata = {
  id: string;
  title: string;
  url: string;
  publishedAt: Date;
  revision: string;
  description?: string;
  tags?: string[];
  image?: { url: string; description?: string };
};

export type NewsStory = NewsMetadata & {
  kind: 'story';
  source: 'dennikn';
  important: boolean;
};

export type NewsEdition = NewsMetadata & {
  // An editorial daily edition; adapters must reject weekly roundups before normalization.
  kind: 'edition';
  source: 'aktuality';
  sections: { title: string; url?: string; description?: string }[];
};

export type NewsContent = NewsStory | NewsEdition;
export type NewsSnapshot = { sequence: number; collectedAt: Date };
export type NewsObservation = {
  story: NewsStory;
  firstSeenAt: Date;
  lastSeenAt: Date;
  firstImportantAt?: Date;
  firstImportantSequence?: number;
};

export type NewsCacheValidators = { etag?: string; lastModified?: string };
export type NewsSourceCache = {
  listing?: NewsCacheValidators;
  candidate?: { url: string; validators?: NewsCacheValidators; edition?: NewsEdition };
};

// Successful parsed/unchanged results may replace validators; failures retain good cache state.
export type NewsSourceResult =
  | { outcome: 'stories'; stories: NewsStory[]; cache: NewsSourceCache }
  | { outcome: 'edition'; edition: NewsEdition; cache: NewsSourceCache }
  | { outcome: 'unchanged' | 'empty' | 'stale'; cache: NewsSourceCache }
  | {
      outcome:
        'malformed' | 'access-denied' | 'rate-limited' | 'unavailable' | 'timeout' | 'cancelled';
      retryAt?: Date;
    };

export type NewsSource = {
  id: NewsSourceId;
  collect: (input: {
    now: Date;
    cache: NewsSourceCache;
    latest?: boolean;
    signal: AbortSignal;
  }) => Promise<NewsSourceResult>;
};

export type NewsDailySlot = {
  key: string;
  date: string;
  kind: 'primary' | 'fallback';
  dueAt: Date;
  expiresAt: Date;
};

export type NewsDailyCollection = {
  // Retain only the current Slovak date's slots; older tombstones live in deliveries.
  attemptedSlots: string[];
  collectedEdition?: NewsEdition;
};

export type NewsLease = { owner: string; expiresAt: Date };
export type NewsSourceState = {
  source: NewsSourceId;
  nextAttemptAt: Date;
  cache: NewsSourceCache;
  failures: number;
  lastOutcome?: NewsSourceResult['outcome'];
  lastSuccessAt?: Date;
  snapshot?: NewsSnapshot;
  backoffUntil?: Date;
  lease?: NewsLease;
  daily?: NewsDailyCollection;
};

export type NewsDestination = { guildId: string; channelId: string; notifyRoleId?: string };
export type NewsEncryptedDestination = {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
};

export type NewsSubscription = {
  // Domain-separated HMAC of guild/feed; never a raw Discord identifier.
  key: string;
  feed: NewsFeed;
  revision: number;
  enabled: boolean;
  activatedAt: Date;
  // Null waits for the first successful snapshot. Sequence avoids same-clock activation races.
  baseline: NewsSnapshot | null;
  // Legacy pacing field retained for stored configuration compatibility; admission ignores it.
  nextDeliveryAt: Date;
  pausedReason?: 'destination-unavailable' | 'decryption-failed';
};

export type NewsSubscriptionRecord = NewsSubscription & {
  // Removed on disable; delivery tombstones do not retain retrievable identifiers.
  destination?: NewsEncryptedDestination;
};

export type NewsPublicationStatus =
  'pending' | 'claimed' | 'sending' | 'sent' | 'uncertain' | 'cancelled' | 'expired';

export type NewsPublicationDraft = {
  manual?: boolean;
  key: string;
  subscriptionKey: string;
  configurationRevision: number;
  content: NewsContent;
  dueAt: Date;
  expiresAt: Date;
};

export type NewsPublication = NewsPublicationDraft & {
  status: NewsPublicationStatus;
  attempts: number;
  nonce: string;
  lease?: NewsLease;
  messageKey?: string;
};

export type NewsPublishResult =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'rejected'; retryAt?: Date }
  | { outcome: 'destination-unavailable' }
  | { outcome: 'uncertain' };

export type NewsPublisher = {
  ready: () => boolean;
  validateDestination: (destination: NewsDestination) => Promise<boolean>;
  publish: (input: {
    destination: NewsDestination;
    content: NewsContent;
    nonce: string;
    signal: AbortSignal;
  }) => Promise<NewsPublishResult>;
};

export type NewsSubscriptionStore = {
  configure: (input: { feed: NewsFeed; destination: NewsDestination }) => Promise<NewsSubscription>;
  disable: (input: { guildId: string; feed: NewsFeed }) => Promise<void>;
  removeGuild: (guildId: string) => Promise<void>;
  getSubscription: (input: { guildId: string; feed: NewsFeed }) => Promise<NewsSubscription | null>;
  // For authorized settings/status only. A revision mismatch or disabled record returns null.
  // Decryption failures must be surfaced, never silently represented as a missing destination.
  getDestination: (input: {
    subscriptionKey: string;
    revision: number;
  }) => Promise<NewsDestination | null>;
  listEnabled: () => Promise<NewsSubscription[]>;
};

export type NewsPollClaim = { source: NewsSourceId; lease: NewsLease; slot?: NewsDailySlot };
export type NewsPublicationClaim = { publication: NewsPublication; lease: NewsLease };

// These are atomic operations, not a CRUD facade. Adapters own injected clocks and lease durations.
export type NewsStore = NewsSubscriptionStore & {
  queueManualEdition: (input: {
    guildId: string;
    requestId: string;
    revision: number;
    edition: NewsEdition;
  }) => Promise<ManualRunResult>;
  getSource: (source: NewsSourceId) => Promise<NewsSourceState>;
  // Atomically consume a daily slot when claiming, so a crash never repeats that attempt.
  // Continuous claims honor persisted cadence/backoff; neither mode overlaps an active lease.
  claimPoll: (
    source: NewsSourceId,
    options?: { manual?: boolean },
  ) => Promise<NewsPollClaim | null>;
  // Fence by owner AND unexpired lease; persist observations/edition with schedule state.
  commitPoll: (claim: NewsPollClaim, result: NewsSourceResult) => Promise<boolean>;
  // Repeatable from durable observations, including after a crash immediately following commitPoll.
  // Unique keys preserve sent/uncertain tombstones across configuration revisions. Cancelled,
  // never-sent work may be replanned with a new revision while still eligible.
  planPublications: () => Promise<void>;
  claimPublication: () => Promise<NewsPublicationClaim | null>;
  // Caller checks publisher readiness first. Atomically check revision, enabled/paused state,
  // deadline and claim ownership, then mark sending.
  // Resolve the destination only for that revision in the same operation.
  beginSend: (claim: NewsPublicationClaim) => Promise<NewsDestination | null>;
  // Hash messageId before persistence. Expired sending leases become uncertain, never pending.
  finishSend: (claim: NewsPublicationClaim, result: NewsPublishResult) => Promise<void>;
  getDeliveryCounts: (subscriptionKey: string) => Promise<{ pending: number; uncertain: number }>;
};
