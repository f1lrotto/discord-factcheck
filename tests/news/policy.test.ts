import { describe, expect, it } from 'vitest';
import {
  activateContinuousBaseline,
  canAdmitSend,
  continuousEligible,
  dailyCollectionSlot,
  dailySchedule,
  establishContinuousBaseline,
  isCurrentDailyEdition,
  newsLocalDate,
  nextContinuousCollectionAt,
  nextContinuousDeliveryAt,
  observeStory,
  planContinuousPublication,
  planDailyPublication,
  publicationKey,
  safeRetryAt,
} from '../../src/news/policy.js';
import type {
  NewsDailyCollection,
  NewsEdition,
  NewsPublication,
  NewsPublicationDraft,
  NewsStory,
  NewsSubscription,
} from '../../src/news/types.js';

const at = (time: string, date = '2026-01-15') => new Date(`${date}T${time}+01:00`);
const edition = (overrides: Partial<NewsEdition> = {}): NewsEdition => ({
  kind: 'edition',
  source: 'aktuality',
  id: 'edition-1',
  title: 'Denný výber',
  url: 'https://www.aktuality.sk/edition-1',
  publishedAt: at('19:00:00'),
  revision: 'original',
  sections: [{ title: 'Editorial selection' }],
  ...overrides,
});
const story = (overrides: Partial<NewsStory> = {}): NewsStory => ({
  kind: 'story',
  source: 'dennikn',
  id: 'story-1',
  title: 'Important news',
  url: 'https://dennikn.sk/minuta/1',
  publishedAt: at('12:00:00'),
  revision: 'original',
  important: true,
  ...overrides,
});
const subscription = (overrides: Partial<NewsSubscription> = {}): NewsSubscription => ({
  key: 'guild-feed-hmac',
  feed: 'daily',
  revision: 1,
  enabled: true,
  activatedAt: at('10:00:00'),
  baseline: null,
  nextDeliveryAt: at('10:00:00'),
  ...overrides,
});
const publication = (
  draft: NewsPublicationDraft,
  overrides: Partial<NewsPublication> = {},
): NewsPublication => ({ ...draft, status: 'claimed', attempts: 1, nonce: 'stable', ...overrides });
const noReservations = new Set<string>();
const dailyDraft = () =>
  planDailyPublication(subscription(), edition(), at('20:00:00'), noReservations)!;

describe('Slovak daily collection windows', () => {
  it.each([
    ['2026-01-15', '19', '20', '21'],
    ['2026-07-15', '18', '19', '20'],
    ['2026-03-29', '18', '19', '20'],
    ['2026-10-25', '19', '20', '21'],
  ])('maps winter/summer/DST evening windows on %s', (date, primary, fallback, deadline) => {
    const schedule = dailySchedule(new Date(`${date}T00:00:00Z`));
    expect(schedule).toEqual({
      date,
      primaryAt: new Date(`${date}T${primary}:00:00Z`),
      fallbackAt: new Date(`${date}T${fallback}:00:00Z`),
      deadline: new Date(`${date}T${deadline}:00:00Z`),
    });
    const state = { attemptedSlots: [] };
    expect(dailyCollectionSlot(new Date(+schedule.primaryAt - 1), state)).toBeNull();
    expect(dailyCollectionSlot(schedule.primaryAt, state)?.kind).toBe('primary');
    expect(dailyCollectionSlot(schedule.fallbackAt, state)?.kind).toBe('fallback');
    expect(dailyCollectionSlot(schedule.deadline, state)).toBeNull();
    // Computing from the morning of a DST transition must agree with the evening.
    expect(dailySchedule(schedule.primaryAt)).toEqual(schedule);
  });

  it('uses the Slovak calendar date across UTC midnight and rejects invalid clocks', () => {
    expect(newsLocalDate(new Date('2026-07-14T22:30:00Z'))).toBe('2026-07-15');
    expect(() => dailySchedule(new Date('invalid'))).toThrow('Invalid clock instant');
  });

  it('recovers only the current slot and never issues two catch-up attempts', () => {
    const state: NewsDailyCollection = { attemptedSlots: [] };
    expect(dailyCollectionSlot(at('19:59:00'), state)).toBeNull();
    const primary = dailyCollectionSlot(at('20:30:00'), state)!;
    expect(primary).toMatchObject({
      kind: 'primary',
      dueAt: at('20:00:00'),
      expiresAt: at('21:00:00'),
    });
    const attempted = { attemptedSlots: [primary.key] };
    expect(dailyCollectionSlot(at('20:31:00'), attempted)).toBeNull();
    const fallback = dailyCollectionSlot(at('21:30:00'), attempted)!;
    expect(fallback).toMatchObject({
      kind: 'fallback',
      dueAt: at('21:00:00'),
      expiresAt: at('22:00:00'),
    });
    expect(dailyCollectionSlot(at('21:30:00'), state)).toEqual(fallback);
    expect(
      dailyCollectionSlot(at('21:31:00'), { attemptedSlots: [primary.key, fallback.key] }),
    ).toBeNull();
    expect(dailyCollectionSlot(at('22:00:00'), state)).toBeNull();
    expect(dailyCollectionSlot(at('23:30:00'), state)).toBeNull();
    expect(dailyCollectionSlot(at('20:00:00', '2026-01-16'), attempted)?.key).not.toBe(primary.key);
  });

  it('suppresses fallback for stored success independently of the delivery outcome', () => {
    const primary = dailyCollectionSlot(at('20:00:00'), { attemptedSlots: [] })!;
    const state = { attemptedSlots: [primary.key], collectedEdition: edition() };
    for (const status of ['pending', 'sending', 'uncertain', 'expired', 'sent'] as const) {
      const delivery = publication(dailyDraft(), { status });
      expect(delivery.status).toBe(status);
      expect(dailyCollectionSlot(at('21:00:00'), state)).toBeNull();
    }
    expect(dailyCollectionSlot(at('20:30:00'), state)).toBeNull();
  });

  it('permits fallback after missing, stale, parser-failed or timed-out primary attempts', () => {
    const primary = dailyCollectionSlot(at('20:00:00'), { attemptedSlots: [] })!;
    // Failures/304 without a stored edition all retain this same collection state.
    const missing = { attemptedSlots: [primary.key] };
    expect(dailyCollectionSlot(at('21:00:00'), missing)?.kind).toBe('fallback');
    expect(
      dailyCollectionSlot(at('21:00:00'), {
        ...missing,
        collectedEdition: edition({ publishedAt: at('19:00:00', '2026-01-14') }),
      })?.kind,
    ).toBe('fallback');
    expect(dailyCollectionSlot(at('21:00:00'), missing, at('21:10:00'))).toBeNull();
    expect(dailyCollectionSlot(at('21:10:00'), missing, at('21:10:00'))?.kind).toBe('fallback');
    expect(dailyCollectionSlot(at('22:00:00'), missing, at('22:00:00'))).toBeNull();
  });
});

describe('daily eligibility, identity, activation and delivery cutoff', () => {
  it('uses publication date, never discovery date, and excludes future/invalid timestamps', () => {
    expect(isCurrentDailyEdition(edition(), at('20:00:00'))).toBe(true);
    expect(
      isCurrentDailyEdition(edition({ publishedAt: at('19:00:00', '2026-01-14') }), at('20:00:00')),
    ).toBe(false);
    expect(isCurrentDailyEdition(edition({ publishedAt: at('20:01:00') }), at('20:00:00'))).toBe(
      false,
    );
    expect(
      isCurrentDailyEdition(edition({ publishedAt: new Date('invalid') }), at('20:00:00')),
    ).toBe(false);
    const earlySummer = edition({ publishedAt: new Date('2026-07-14T22:30:00Z') });
    expect(isCurrentDailyEdition(earlySummer, new Date('2026-07-15T18:00:00Z'))).toBe(true);
  });

  it.each(['10:00:00', '20:00:00', '20:30:00', '21:30:00'])(
    'admits first/late activation at %s without a continuous baseline',
    (activation) => {
      const sub = subscription({ activatedAt: at(activation) });
      const now = at(activation < '20:00:00' ? '20:00:00' : activation);
      const draft = planDailyPublication(sub, edition(), now, noReservations);
      expect(draft).toMatchObject({
        configurationRevision: 1,
        dueAt: now,
        expiresAt: at('22:00:00'),
      });
      expect(canAdmitSend(publication(draft!), sub, now)).toBe(true);
    },
  );

  it('does not immediately send cached editions before 20:00 or at/after 22:00', () => {
    expect(
      planDailyPublication(
        subscription(),
        edition({ publishedAt: new Date('invalid') }),
        at('20:00:00'),
        noReservations,
      ),
    ).toBeNull();
    for (const time of ['19:59:00', '22:00:00', '23:00:00']) {
      expect(planDailyPublication(subscription(), edition(), at(time), noReservations)).toBeNull();
    }
    expect(
      planDailyPublication(
        subscription(),
        edition({ publishedAt: at('19:00:00', '2026-01-14') }),
        at('20:00:00'),
        noReservations,
      ),
    ).toBeNull();
  });

  it('preserves publisher metadata and editorial sections without requiring optional fields', () => {
    const content = edition({
      description: 'Publisher introduction',
      tags: ['Slovensko'],
      image: { url: 'https://www.aktuality.sk/image.jpg', description: 'Caption' },
      sections: [
        { title: 'Section', url: 'https://www.aktuality.sk/story', description: 'Source excerpt' },
      ],
    });
    expect(
      planDailyPublication(subscription(), content, at('20:00:00'), noReservations)?.content,
    ).toEqual(content);
    expect(dailyDraft().content).toEqual(edition());
  });

  it('preserves daily identity across edition corrections and destination revisions, with independent guilds and feeds', () => {
    const first = dailyDraft();
    const corrected = edition({
      id: 'replacement-edition',
      revision: 'updated',
      title: 'Corrected',
    });
    expect(publicationKey(subscription().key, corrected)).toBe(first.key);
    expect(
      planDailyPublication(
        subscription({ revision: 2 }),
        corrected,
        at('20:30:00'),
        new Set([first.key]),
      ),
    ).toBeNull();
    expect(publicationKey('another-guild', corrected)).not.toBe(first.key);
    expect(publicationKey(subscription().key, story({ id: edition().id }))).not.toBe(first.key);
    expect(
      publicationKey(subscription().key, edition({ publishedAt: at('19:00:00', '2026-01-16') })),
    ).not.toBe(first.key);
    expect(publicationKey(subscription().key, story({ revision: 'correction' }))).toBe(
      publicationKey(subscription().key, story()),
    );
    expect(publicationKey('a', story({ id: 'b:c' }))).not.toBe(
      publicationKey('a:b', story({ id: 'c' })),
    );
  });

  it('replans never-sent cancelled work under a new revision but fences old work and preserves tombstones', () => {
    const old = dailyDraft();
    const changed = subscription({ revision: 2, activatedAt: at('20:30:00') });
    expect(canAdmitSend(publication(old), changed, at('20:30:00'))).toBe(false);
    expect(
      planDailyPublication(changed, edition(), at('20:30:00'), noReservations)
        ?.configurationRevision,
    ).toBe(2);
    expect(planDailyPublication(changed, edition(), at('20:30:00'), new Set([old.key]))).toBeNull();
  });

  it('blocks disabled, paused, future-activated, wrong-guild and wrong-feed sends', () => {
    const draft = dailyDraft();
    for (const sub of [
      subscription({ enabled: false }),
      subscription({ pausedReason: 'destination-unavailable' }),
      subscription({ activatedAt: at('21:00:00') }),
      subscription({ feed: 'continuous' }),
    ]) {
      expect(planDailyPublication(sub, edition(), at('20:00:00'), noReservations)).toBeNull();
      expect(canAdmitSend(publication(draft), sub, at('20:00:00'))).toBe(false);
    }
    expect(canAdmitSend(publication(draft), subscription({ key: 'other' }), at('20:00:00'))).toBe(
      false,
    );
  });

  it('admits pending/claimed work only during its due/deadline interval', () => {
    const draft = dailyDraft();
    expect(
      canAdmitSend(publication(draft, { status: 'pending' }), subscription(), at('20:00:00')),
    ).toBe(true);
    expect(canAdmitSend(publication(draft), subscription(), at('19:59:59'))).toBe(false);
    expect(canAdmitSend(publication(draft), subscription(), at('21:59:59'))).toBe(true);
    expect(canAdmitSend(publication(draft), subscription(), at('22:00:00'))).toBe(false);
    expect(canAdmitSend(publication(draft), subscription(), at('10:00:00', '2026-01-16'))).toBe(
      false,
    );
    for (const status of ['sending', 'sent', 'uncertain', 'cancelled', 'expired'] as const) {
      expect(canAdmitSend(publication(draft, { status }), subscription(), at('20:00:00'))).toBe(
        false,
      );
    }
    // Even a malformed persisted replay deadline cannot extend the daily send window.
    const extended = publication(draft, {
      dueAt: at('00:00:00'),
      expiresAt: at('23:00:00', '2026-01-16'),
    });
    expect(canAdmitSend(extended, subscription(), at('19:59:59'))).toBe(false);
    expect(canAdmitSend(extended, subscription(), at('22:00:00'))).toBe(false);
    expect(canAdmitSend(extended, subscription(), at('20:00:00', '2026-01-16'))).toBe(false);
  });

  it('expires safe retries exactly at the daily cutoff and never retries uncertain work', () => {
    const sending = publication(dailyDraft(), { status: 'sending' });
    expect(safeRetryAt(sending, at('21:59:00'), 59_999)).toEqual(at('21:59:59.999'));
    expect(safeRetryAt(sending, at('21:59:00'), 60_000)).toBeNull();
    expect(safeRetryAt(sending, at('22:00:00'), 0)).toBeNull();
    expect(safeRetryAt({ ...sending, expiresAt: at('23:00:00') }, at('22:00:00'), 0)).toBeNull();
    expect(safeRetryAt({ ...sending, status: 'uncertain' }, at('21:00:00'), 0)).toBeNull();
    for (const delay of [-1, NaN, Infinity])
      expect(safeRetryAt(sending, at('21:00:00'), delay)).toBeNull();
  });
});

describe('continuous baselines, promotion and bounded pacing', () => {
  const baseline = { sequence: 1, collectedAt: at('11:40:00') };
  const sub = () => subscription({ feed: 'continuous', baseline });
  const observed = (overrides: Partial<NewsStory> = {}, sequence = 2, time = '12:00:00') =>
    observeStory(story(overrides), { sequence, collectedAt: at(time) });

  it('uses source snapshot freshness and waits for a first successful baseline without bootstrap posts', () => {
    expect(activateContinuousBaseline(baseline, at('11:59:59'))).toEqual(baseline);
    expect(activateContinuousBaseline(baseline, at('12:00:00'))).toBeNull();
    expect(activateContinuousBaseline(baseline, at('11:39:00'))).toBeNull();
    expect(activateContinuousBaseline(null, at('12:00:00'))).toBeNull();
    const snapshot = { sequence: 2, collectedAt: at('12:00:00') };
    expect(establishContinuousBaseline(null, snapshot)).toEqual(snapshot);
    expect(establishContinuousBaseline(baseline, snapshot)).toEqual(baseline);
    expect(continuousEligible(observed(), null, at('12:00:00'))).toBe(false);
    expect(continuousEligible(observed(), snapshot, at('12:00:00'))).toBe(false);
    // Guild two captures the current sequence even when activation shares its exact clock instant.
    expect(
      planContinuousPublication(
        subscription({ feed: 'continuous', baseline: snapshot }),
        [observed()],
        at('12:00:00'),
        noReservations,
      ),
    ).toBeNull();
    expect(
      planContinuousPublication(sub(), [observed()], at('12:00:00'), noReservations),
    ).not.toBeNull();
  });

  it('preserves first-seen and first-important observations across edits and importance toggles', () => {
    const initial = observed({ important: false }, 1, '12:00:00');
    const promoted = observeStory(
      story({ revision: 'promoted' }),
      { sequence: 2, collectedAt: at('12:20:00') },
      initial,
    );
    expect(promoted).toMatchObject({
      firstSeenAt: at('12:00:00'),
      firstImportantAt: at('12:20:00'),
      firstImportantSequence: 2,
    });
    const demoted = observeStory(
      story({ important: false }),
      { sequence: 3, collectedAt: at('12:40:00') },
      promoted,
    );
    const edited = observeStory(
      story({ revision: 'correction' }),
      { sequence: 4, collectedAt: at('13:00:00') },
      demoted,
    );
    expect(edited).toMatchObject({
      firstSeenAt: at('12:00:00'),
      firstImportantAt: at('12:20:00'),
      firstImportantSequence: 2,
      lastSeenAt: at('13:00:00'),
    });
    expect(continuousEligible(demoted, baseline, at('12:40:00'))).toBe(false);
    expect(continuousEligible(edited, baseline, at('14:20:00'))).toBe(false);
    expect(() => observeStory(story({ id: 'different' }), baseline, initial)).toThrow(
      'Mismatched news observation',
    );
  });

  it('admits delayed importance up to 24 hours from publication, with two-hour replay from promotion', () => {
    const promoted = observed({ publishedAt: at('12:00:00', '2026-01-14') });
    expect(continuousEligible(promoted, baseline, at('12:00:00'))).toBe(true);
    expect(continuousEligible(promoted, baseline, at('13:59:59'))).toBe(true);
    expect(continuousEligible(promoted, baseline, at('14:00:00'))).toBe(false);
    expect(
      continuousEligible(
        observed({ publishedAt: at('11:59:59', '2026-01-14') }),
        baseline,
        at('12:00:00'),
      ),
    ).toBe(false);
    expect(
      continuousEligible(observed({ publishedAt: at('12:01:00') }), baseline, at('12:00:00')),
    ).toBe(false);
    expect(continuousEligible(observed(), baseline, at('11:59:59'))).toBe(false);
    expect(
      continuousEligible(observed({ publishedAt: new Date('invalid') }), baseline, at('12:00:00')),
    ).toBe(false);
    expect(continuousEligible(observed({ important: false }), baseline, at('12:00:00'))).toBe(
      false,
    );
  });

  it('selects deterministic oldest eligible work, ignores reservations and never fills empty intervals', () => {
    const observations = [
      observed({ id: 'b' }),
      observed({ id: 'a' }),
      observed({ id: 'c' }, 3, '12:20:00'),
    ];
    expect(
      planContinuousPublication(sub(), observations, at('12:20:00'), noReservations)?.content.id,
    ).toBe('a');
    expect(
      planContinuousPublication(sub(), [...observations].reverse(), at('12:20:00'), noReservations)
        ?.content.id,
    ).toBe('a');
    const reserved = new Set([publicationKey(sub().key, story({ id: 'a' }))]);
    expect(
      planContinuousPublication(sub(), observations, at('12:20:00'), reserved)?.content.id,
    ).toBe('b');
    expect(planContinuousPublication(sub(), [], at('12:20:00'), noReservations)).toBeNull();
    expect(
      planContinuousPublication(subscription(), observations, at('12:20:00'), noReservations),
    ).toBeNull();
    expect(
      planContinuousPublication(sub(), observations, at('14:20:00'), noReservations),
    ).toBeNull();
  });

  it('respects durable pacing and does not queue stories whose deadline precedes their due time', () => {
    const paced = sub();
    paced.nextDeliveryAt = at('12:20:00');
    const draft = planContinuousPublication(paced, [observed()], at('12:00:00'), noReservations)!;
    expect(draft).toMatchObject({ dueAt: at('12:20:00'), expiresAt: at('14:00:00') });
    expect(canAdmitSend(publication(draft), paced, at('12:00:00'))).toBe(false);
    expect(canAdmitSend(publication(draft), paced, at('12:20:00'))).toBe(true);
    expect(canAdmitSend(publication(draft, { dueAt: at('12:00:00') }), paced, at('12:00:00'))).toBe(
      false,
    );
    expect(
      planContinuousPublication(
        { ...paced, nextDeliveryAt: at('14:00:00') },
        [observed()],
        at('12:00:00'),
        noReservations,
      ),
    ).toBeNull();
    const sending = publication(draft, { status: 'sending' });
    expect(safeRetryAt(sending, at('13:59:00'), 59_999)).toEqual(at('13:59:59.999'));
    expect(safeRetryAt(sending, at('14:00:00'), 0)).toBeNull();
  });

  it('sets independent 20-minute collection/delivery floors and honors publisher backoff', () => {
    expect(nextContinuousCollectionAt(at('12:00:00'))).toEqual(at('12:20:00'));
    expect(nextContinuousCollectionAt(at('12:00:00'), at('12:05:00'))).toEqual(at('12:20:00'));
    expect(nextContinuousCollectionAt(at('12:00:00'), at('13:00:00'))).toEqual(at('13:00:00'));
    expect(nextContinuousDeliveryAt(at('12:03:00'))).toEqual(at('12:23:00'));
  });

  it('replays synthetic multi-day steady traffic without a 15-story quota or manufactured messages', () => {
    const replay = ['2026-01-15', '2026-01-16', '2026-01-17'].map((date) => {
      let current = subscription({
        feed: 'continuous',
        baseline: { sequence: 0, collectedAt: at('00:00:00', date) },
        activatedAt: at('00:00:00', date),
        nextDeliveryAt: at('00:00:00', date),
      });
      const reserved = new Set<string>();
      const delivered = Array.from({ length: 18 }, (_, i) => {
        const now = new Date(+at('08:00:00', date) + i * 20 * 60_000);
        const observation = observeStory(story({ id: `${date}-${i}`, publishedAt: now }), {
          sequence: i + 1,
          collectedAt: now,
        });
        const draft = planContinuousPublication(current, [observation], now, reserved)!;
        expect(canAdmitSend(publication(draft), current, now)).toBe(true);
        reserved.add(draft.key);
        current = { ...current, nextDeliveryAt: nextContinuousDeliveryAt(now) };
        expect(planContinuousPublication(current, [observation], now, reserved)).toBeNull();
        return draft.content.id;
      });
      expect(planContinuousPublication(current, [], at('19:00:00', date), reserved)).toBeNull();
      return delivered;
    });
    expect(replay.map((day) => day.length)).toEqual([18, 18, 18]);
    expect(new Set(replay.flat()).size).toBe(54);
  });

  it('bounds synthetic burst catch-up to six deliveries over two hours after restart', () => {
    const observations = Array.from({ length: 10 }, (_, i) => observed({ id: String(i) }));
    let current = sub();
    const reserved = new Set<string>();
    const sent = Array.from({ length: 7 }, (_, i) => {
      const now = new Date(+at('12:00:00') + i * 20 * 60_000);
      const draft = planContinuousPublication(current, observations, now, reserved);
      if (!draft) return null;
      reserved.add(draft.key);
      // Recreated state models durable pacing and tombstones loaded on process restart.
      current = { ...current, nextDeliveryAt: nextContinuousDeliveryAt(now) };
      return draft;
    });
    expect(sent.filter(Boolean)).toHaveLength(6);
    expect(sent[6]).toBeNull();
  });
});
