import { localDate, localWallClockInstant } from './scheduling/slots.js';

export const reminderLimits = {
  maximumPending: 20,
  maximumTextCharacters: 280,
  minimumLeadMs: 60_000,
  maximumHorizonMs: 365 * 24 * 60 * 60_000,
  leaseMs: 2 * 60_000,
  // A fired reminder is retained briefly so a restart cannot resend it.
  receiptMs: 7 * 24 * 60 * 60_000,
  publicIdCharacters: 4,
} as const;

export type ReminderStatus = 'pending' | 'claimed' | 'sending' | 'sent' | 'uncertain' | 'cancelled';
export type ReminderDestination = { guildId: string; channelId: string; userId: string };

export type Reminder = {
  id: string;
  text: string;
  dueAt: Date;
  createdAt: Date;
  status?: ReminderStatus;
};

export type ReminderClaim = {
  key: string;
  owner: string;
  nonce: string;
  reminder: Reminder;
};

export type ReminderPublishResult =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'rejected'; retryAt?: Date }
  | { outcome: 'destination-unavailable' }
  | { outcome: 'uncertain' };

export type ReminderPublisher = {
  ready: () => boolean;
  publish: (input: {
    destination: ReminderDestination;
    reminder: Reminder;
    nonce: string;
    signal: AbortSignal;
  }) => Promise<ReminderPublishResult>;
};

export type ReminderStore = {
  create: (input: {
    destination: ReminderDestination;
    text: string;
    dueAt: Date;
    now: Date;
  }) => Promise<Reminder | 'limit_reached'>;
  listForMember: (input: { guildId: string; userId: string; now: Date }) => Promise<Reminder[]>;
  cancel: (input: { guildId: string; userId: string; id: string }) => Promise<boolean>;
  dueInWindow: (input: {
    guildId: string;
    channelId: string;
    from: Date;
    to: Date;
  }) => Promise<Reminder[]>;
  claimDue: (now: Date) => Promise<ReminderClaim | null>;
  beginSend: (claim: ReminderClaim) => Promise<ReminderDestination | null>;
  finishSend: (claim: ReminderClaim, result: ReminderPublishResult) => Promise<void>;
};

export type ReminderRejection =
  'invalid_time' | 'too_soon' | 'too_far' | 'empty_text' | 'text_too_long';

export type ParsedReminder =
  { ok: true; dueAt: Date; text: string } | { ok: false; reason: ReminderRejection };

export const normalizeReminderText = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const relativeOffsetMs = (value: string) => {
  const match = /^(\d{1,5})\s*(m|min|h|hod|d)$/iu.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2]!.toLowerCase();
  const multiplier =
    unit === 'm' || unit === 'min' ? 60_000 : unit === 'd' ? 86_400_000 : 3_600_000;
  return amount * multiplier;
};

const absoluteInstant = (value: string, now: Date, timeZone: string) => {
  const match = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const explicitDate = match[1];
  if (explicitDate) return localWallClockInstant({ date: explicitDate, hour, minute, timeZone });
  // A bare time means the next occurrence: today if it is still ahead, otherwise tomorrow.
  const today = localWallClockInstant({ date: localDate(now, timeZone), hour, minute, timeZone });
  if (!today) return null;
  if (+today > +now) return today;
  const tomorrow = new Date(`${localDate(now, timeZone)}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return localWallClockInstant({
    date: tomorrow.toISOString().slice(0, 10),
    hour,
    minute,
    timeZone,
  });
};

/**
 * Resolves a member-supplied reminder into an absolute instant.
 *
 * Accepts a relative offset (`2h`, `90m`, `3d`) or a wall-clock time in the deployment time
 * zone, with or without a date. Everything is validated here so both the slash command and
 * the model tool share one definition of what a valid reminder is.
 */
export const parseReminder = (input: {
  text: string;
  now: Date;
  timeZone: string;
  in?: string | null;
  at?: string | null;
}): ParsedReminder => {
  const text = normalizeReminderText(input.text);
  if (!text) return { ok: false, reason: 'empty_text' };
  if (text.length > reminderLimits.maximumTextCharacters)
    return { ok: false, reason: 'text_too_long' };

  if (Boolean(input.in) === Boolean(input.at)) return { ok: false, reason: 'invalid_time' };
  const offsetMs = input.in ? relativeOffsetMs(input.in) : null;
  const instant = input.at ? absoluteInstant(input.at, input.now, input.timeZone) : null;
  if ((input.in && offsetMs === null) || (input.at && instant === null))
    return { ok: false, reason: 'invalid_time' };
  const dueAt = offsetMs !== null ? new Date(+input.now + offsetMs) : instant;
  if (!dueAt) return { ok: false, reason: 'invalid_time' };

  return checkReminderInstant({ dueAt, text, now: input.now });
};

/** Shared bounds check, also used for the absolute instant the model tool supplies. */
export const checkReminderInstant = (input: {
  dueAt: Date;
  text: string;
  now: Date;
}): ParsedReminder => {
  const text = normalizeReminderText(input.text);
  if (!text) return { ok: false, reason: 'empty_text' };
  if (text.length > reminderLimits.maximumTextCharacters)
    return { ok: false, reason: 'text_too_long' };
  if (!Number.isFinite(input.dueAt.getTime())) return { ok: false, reason: 'invalid_time' };
  const lead = +input.dueAt - +input.now;
  if (lead < reminderLimits.minimumLeadMs) return { ok: false, reason: 'too_soon' };
  if (lead > reminderLimits.maximumHorizonMs) return { ok: false, reason: 'too_far' };
  return { ok: true, dueAt: input.dueAt, text };
};
