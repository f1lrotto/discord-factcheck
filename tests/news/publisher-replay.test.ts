import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { NewsHttp } from '../../src/news/http.js';
import {
  createDenniknSource,
  denniknListingUrl,
  parseDennikn,
} from '../../src/news/sources/dennikn.js';
import {
  canAdmitSend,
  establishContinuousBaseline,
  newsLocalDate,
  newsPolicy,
  observeStory,
  planContinuousPublication,
  planContinuousPublications,
} from '../../src/news/policy.js';
import type { NewsObservation, NewsSourceCache, NewsSubscription } from '../../src/news/types.js';

const read = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
const query = 'getInfinitePosts({"important":1,"language":"sk"})';
const raw = JSON.parse(read('publishers/dennikn-initial-state.json')) as {
  postsApi: {
    queries: Record<string, { data: { pages: { posts: Record<string, unknown>[] }[] } }>;
  };
};
const actualPosts = raw.postsApi.queries[query]!.data.pages[0]!.posts;
const snapshot = JSON.parse(read('publishers/dennikn-publication-snapshot.json')) as {
  observedAt: string;
  posts: { id: number; published_at_date: number }[];
};
const envelope = (posts: unknown[]) =>
  `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ postsApi: { queries: { [query]: { data: { pages: [{ posts }] } } } } }).replaceAll('<', '\\u003c')};</script>`;
const interval = newsPolicy.continuousIntervalMs;
const subscription = (key: string, now: Date): NewsSubscription => ({
  key,
  feed: 'continuous',
  revision: 1,
  enabled: true,
  activatedAt: now,
  nextDeliveryAt: now,
  baseline: null,
});

describe('publisher-grounded policy replay (simulated observations and sends)', () => {
  it('replays all actual IDs/timestamps across five dates with one shared collection per simulated poll', async () => {
    const dates = actualPosts.map((post) => Number(post.published_at_date));
    const start = Math.floor(Math.min(...dates) / interval) * interval;
    const end = Math.ceil(Math.max(...dates) / interval) * interval + newsPolicy.catchUpMs;
    expect(
      actualPosts.map((post) => ({ id: post.id, published_at_date: post.published_at_date })),
    ).toEqual(snapshot.posts.map(({ id, published_at_date }) => ({ id, published_at_date })));
    const observed = new Map<string, NewsObservation>();
    const subscriptions = [
      subscription('synthetic-guild-one', new Date(start)),
      subscription('synthetic-guild-two', new Date(start)),
    ];
    const reserved = new Set<string>();
    const sends: {
      guild: string;
      id: string;
      publishedAt: string;
      firstImportantAt: string;
      sentAt: string;
      delayMinutes: number;
      queueMinutes: number;
    }[] = [];
    const http = vi.fn<NewsHttp>();
    const source = createDenniknSource(http);
    let cache: NewsSourceCache = {};
    let sequence = 0;
    for (let clock = start; clock <= end; clock += interval) {
      const now = new Date(clock);
      // Explicit assumptions: importance starts at publication; polling starts with an empty
      // baseline before the first actual timestamp; source overlap is a synthetic 24 hours.
      const posts = actualPosts.filter(
        (post) =>
          Number(post.published_at_date) <= clock &&
          Number(post.published_at_date) > clock - newsPolicy.promotionAgeMs,
      );
      http.mockResolvedValueOnce({
        outcome: 'ok',
        html: envelope(posts),
        url: denniknListingUrl,
        validators: {},
      });
      const result = await source.collect({ now, cache, signal: new AbortController().signal });
      if (result.outcome !== 'stories' && result.outcome !== 'empty')
        throw new Error('Replay source parsing failed');
      cache = result.cache;
      const current = { sequence: ++sequence, collectedAt: now };
      for (const story of result.outcome === 'stories' ? result.stories : [])
        observed.set(story.id, observeStory(story, current, observed.get(story.id)));
      for (const sub of subscriptions) {
        sub.baseline = establishContinuousBaseline(sub.baseline, current);
        for (const draft of planContinuousPublications(
          sub,
          [...observed.values()],
          now,
          reserved,
        )) {
          expect(
            canAdmitSend(
              { ...draft, status: 'claimed', attempts: 1, nonce: 'simulation' },
              sub,
              now,
            ),
          ).toBe(true);
          reserved.add(draft.key);
          const observation = observed.get(draft.content.id)!;
          sends.push({
            guild: sub.key,
            id: draft.content.id,
            publishedAt: draft.content.publishedAt.toISOString(),
            firstImportantAt: observation.firstImportantAt!.toISOString(),
            sentAt: now.toISOString(),
            delayMinutes: (+now - +draft.content.publishedAt) / 60_000,
            queueMinutes: (+now - +observation.firstImportantAt!) / 60_000,
          });
        }
      }
    }
    const delivered = sends.filter(({ guild }) => guild === subscriptions[0]!.key);
    const expectedIds = actualPosts.map((post) => String(post.id)).sort();
    for (const sub of subscriptions)
      expect(
        sends
          .filter(({ guild }) => guild === sub.key)
          .map(({ id }) => id)
          .sort(),
      ).toEqual(expectedIds);
    const expiredIds = expectedIds.filter((id) => !delivered.some((send) => send.id === id));
    const byDate = Object.fromEntries(
      [...new Set(delivered.map((send) => newsLocalDate(new Date(send.publishedAt))))]
        .sort()
        .map((date) => [
          date,
          delivered.filter((send) => newsLocalDate(new Date(send.publishedAt)) === date).length,
        ]),
    );
    const report = {
      kind: 'publisher-grounded replay of accepted policy with simulated observations and sends',
      actualObservationAt: snapshot.observedAt,
      assumptions: [
        'Importance begins at publication (synthetic)',
        'UTC-aligned 20-minute polls and a synthetic 24-hour source overlap',
        'Empty subscription baseline before earliest timestamp',
        'Two subscriptions, no outages or Discord/Mongo effects',
      ],
      actualCaptured: actualPosts.length,
      sourceRequests: http.mock.calls.length,
      simulatedPolls: sequence,
      subscriptions: subscriptions.length,
      sendsPerSubscription: delivered.length,
      expiredIds,
      publicationCountsBySlovakDate: byDate,
      maximumPublicationDelayMinutes:
        Math.round(Math.max(...delivered.map((send) => send.delayMinutes)) * 100) / 100,
      maximumQueueDelayMinutes: Math.max(...delivered.map((send) => send.queueMinutes)),
      deliveries: delivered,
    };
    expect(report).toMatchObject({
      actualCaptured: 50,
      sendsPerSubscription: 50,
      expiredIds: [],
      maximumPublicationDelayMinutes: 19.5,
      maximumQueueDelayMinutes: 0,
      publicationCountsBySlovakDate: {
        '2026-09-10': 14,
        '2026-09-11': 9,
        '2026-09-12': 9,
        '2026-09-13': 15,
        '2026-09-14': 3,
      },
    });
    expect(http).toHaveBeenCalledTimes(sequence);
    expect(sequence).toBe((end - start) / interval + 1);
    // Explicit opt-in evidence output; ordinary tests make no external requests or artifact writes.
    if (process.env.NEWS_REPLAY_REPORT)
      writeFileSync(process.env.NEWS_REPLAY_REPORT, JSON.stringify(report, null, 2) + '\n');
  });
});

describe('fully synthetic adversarial source/policy replay', () => {
  const post = JSON.parse(read('dennikn/synthetic-post.json')) as Record<string, unknown>;
  it('preserves promotion/revision observations and never republishes an already reserved ID', () => {
    const clock = new Date('2026-09-14T06:20:00Z');
    const before = parseDennikn(envelope([{ ...post, isImportant: false }]))[0]!;
    const sub = {
      ...subscription('synthetic-guild', clock),
      baseline: { sequence: 1, collectedAt: clock },
    };
    const initial = observeStory(before, sub.baseline);
    expect(planContinuousPublication(sub, [initial], clock, new Set())).toBeNull();
    const promoted = parseDennikn(
      envelope([{ ...post, excerpt: 'Promoted synthetic story.' }]),
    )[0]!;
    const later = new Date(+clock + interval);
    const observation = observeStory(promoted, { sequence: 2, collectedAt: later }, initial);
    const draft = planContinuousPublication(sub, [observation], later, new Set())!;
    expect(draft.content.id).toBe(String(post.id));
    expect(observation.firstSeenAt).toEqual(clock);
    expect(observation.firstImportantAt).toEqual(later);
    const corrected = parseDennikn(envelope([{ ...post, title: 'Minor correction' }]))[0]!;
    const revised = observeStory(
      corrected,
      { sequence: 3, collectedAt: new Date(+later + interval) },
      observation,
    );
    expect(revised.story.revision).not.toBe(observation.story.revision);
    expect(
      planContinuousPublication(sub, [revised], revised.lastSeenAt, new Set([draft.key])),
    ).toBeNull();
  });
  it('delivers every story in a ten-story burst at its collection time', () => {
    const now = new Date('2026-09-14T06:20:00Z');
    const sub = {
      ...subscription('synthetic-burst', now),
      baseline: { sequence: 1, collectedAt: new Date(+now - interval) },
    };
    const stories = parseDennikn(
      envelope(
        Array.from({ length: 10 }, (_, index) => ({
          ...post,
          id: 91000 + index,
          url: `https://dennikn.sk/minuta/${91000 + index}/`,
        })),
      ),
    );
    const observations = stories.map((story) =>
      observeStory(story, { sequence: 2, collectedAt: now }),
    );
    const reserved = new Set<string>();
    const sent: string[] = [];
    for (const draft of planContinuousPublications(sub, observations, now, reserved)) {
      const clock = now;
      expect(
        canAdmitSend({ ...draft, status: 'claimed', attempts: 1, nonce: 'burst' }, sub, clock),
      ).toBe(true);
      reserved.add(draft.key);
      sent.push(draft.content.id);
    }
    expect(sent).toHaveLength(10);
    expect(stories.filter((story) => !sent.includes(story.id))).toHaveLength(0);
    expect(
      planContinuousPublication(sub, observations, new Date(+now + newsPolicy.catchUpMs), reserved),
    ).toBeNull();
  });
});
