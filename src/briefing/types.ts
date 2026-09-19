import type { ManualRun, ManualRunResult } from '../scheduling/manual.js';
import { z } from 'zod';
import { timeZoneIsSupported } from '../clock.js';
import type { EncryptedDestination } from '../crypto/destination.js';
import type { NewsDestination, NewsPublishResult } from '../news/types.js';

export const citySchema = z.object({
  name: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  timeZone: z.string().max(100).refine(timeZoneIsSupported),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
});
export type BriefingCity = z.infer<typeof citySchema>;
export type BriefingSubscription = {
  _id: string;
  enabled: boolean;
  hour: number;
  revision: number;
  cities: BriefingCity[];
  deliveryFence?: number;
  manualRun?: ManualRun;
  destination?: EncryptedDestination;
  lastDeliveredAt?: Date;
};
export type BriefingDelivery = {
  _id: string;
  subscriptionKey: string;
  revision: number;
  date: string;
  status: 'pending' | 'claimed' | 'sending' | 'sent' | 'uncertain' | 'cancelled';
  owner?: string;
  leaseExpiresAt?: Date;
  retryAt?: Date;
  expiresAt: Date;
  attempts: number;
};
export type BriefingClaim = {
  key: string;
  owner: string;
  subscription: BriefingSubscription;
  date: string;
  manualRun?: ManualRun;
};
export type BriefingStore = {
  requestRun: (guildId: string, requestId: string, now: Date) => Promise<ManualRunResult>;
  get: (guildId: string) => Promise<BriefingSubscription | null>;
  configure: (destination: NewsDestination) => Promise<BriefingSubscription>;
  disable: (guildId: string) => Promise<void>;
  setHour: (guildId: string, hour: number) => Promise<void>;
  addCity: (
    guildId: string,
    city: BriefingCity,
    maximum: number,
  ) => Promise<'added' | 'duplicate' | 'limit'>;
  removeCity: (guildId: string, name: string) => Promise<boolean>;
  subscriptions: () => Promise<BriefingSubscription[]>;
  destination: (subscription: BriefingSubscription) => NewsDestination | null;
  claim: (subscription: BriefingSubscription, now: Date) => Promise<BriefingClaim | null>;
  beginSend: (claim: BriefingClaim, now: Date) => Promise<NewsDestination | null>;
  finishSend: (claim: BriefingClaim, result: NewsPublishResult, now: Date) => Promise<void>;
};
