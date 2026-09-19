import type { NewsFeed, NewsSourceResult } from '../news/types.js';

export type PrivacyFacts = {
  modelLabel: string;
  supportsZdr: boolean;
  contextLimit: number;
  transcriptTtlDays: number;
};

export type SettingsFacts = {
  reelsDeploymentAvailable: boolean;
  reelsChannelEnabled: boolean;
  modelLabel: string;
  reasoning: string;
  supportsZdr: boolean;
  contextLimit: number;
  languageName: string;
  dailyCommitted: string;
  monthlyCommitted: string;
};

export type NewsConfigurationState = 'missing' | 'enabled' | 'disabled';
export type NewsPausedReason =
  'destination-unavailable' | 'decryption-failed' | 'deployment-disabled' | 'feed-disabled' | null;

export type NewsStatusFacts = {
  feed: NewsFeed;
  deploymentEnabled: boolean;
  configuration: NewsConfigurationState;
  destination: { kind: 'channel'; channelId: string } | { kind: 'unavailable' } | { kind: 'none' };
  notifyRoleId?: string;
  paused: NewsPausedReason;
  nextCollectionAt: string | null;
  lastOutcome?: NewsSourceResult['outcome'];
  lastSuccessAt: string | null;
  backoffUntil: string | null;
  storedEdition: { current: boolean; collectedAt: string } | null;
  pending: number;
  uncertain: number;
};

export type BriefingStatusFacts = {
  configured: boolean;
  destination: { kind: 'channel'; channelId: string } | { kind: 'unavailable' } | { kind: 'none' };
  hour: number;
  cities: string[];
  maximumCities: number;
  nextDeliveryAt: string | null;
  lastDeliveredAt: string | null;
};

export type UsageTrendPoint = { date: string; costMicrodollars: number; requests: number };

export type UsageMemberRow = {
  name: string;
  requests: number;
  cost: string;
  failures: number;
};

export type UsageFacts = {
  windowDays: number;
  memberWindowDays: number;
  trend: UsageTrendPoint[];
  sparkline: string;
  totalCost: string;
  dailyCost: string;
  dailyLimit: string;
  monthlyCost: string;
  monthlyLimit: string;
  members: UsageMemberRow[];
  othersIncluded: boolean;
};

export type ReminderRow = { id: string; dueAt: string; text: string };
