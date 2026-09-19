import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.js';
import { sk } from '../src/i18n/sk.js';
import { defaultLocale, isLocale, localeChoices, locales, messages } from '../src/i18n/index.js';
import { plural } from '../src/i18n/plural.js';
import { formatDuration, formatLongDate, formatTime } from '../src/i18n/format.js';
import { buildPromptMessages, systemPrompt } from '../src/prompt.js';
import { createClockSnapshot } from '../src/clock.js';
import { defaultGuildSettings } from '../src/models.js';

const shape = (value: unknown, path = ''): string[] => {
  if (typeof value === 'function') return [`${path}:function`];
  if (Array.isArray(value)) return [`${path}:array`];
  if (value && typeof value === 'object')
    return Object.entries(value)
      .flatMap(([key, nested]) => shape(nested, `${path}.${key}`))
      .sort();
  return [`${path}:${typeof value}`];
};

// Entries that are intentionally empty: a duplicate turn is dropped silently, and a cancelled
// media job must not announce itself.
const intentionallyEmpty = new Set(['rejections.duplicate', 'reels.failure.cancelled']);

describe('message catalogs', () => {
  it('declares the Slovak default and both locales', () => {
    expect(defaultLocale).toBe('sk');
    expect([...locales]).toEqual(['sk', 'en']);
    expect(isLocale('sk')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(localeChoices()).toEqual([
      { name: 'Slovenčina', value: 'sk' },
      { name: 'English', value: 'en' },
    ]);
    expect(messages('sk')).toBe(sk);
    expect(messages('en')).toBe(en);
  });

  it('keeps both catalogs structurally identical', () => {
    expect(shape(en)).toEqual(shape(sk));
  });

  it('never renders an empty string except where silence is intended', () => {
    for (const locale of locales) {
      const copy = messages(locale);
      const rejections = copy.rejections(3, 4, 10);
      for (const [reason, text] of Object.entries(rejections)) {
        if (intentionallyEmpty.has(`rejections.${reason}`)) expect(text).toBe('');
        else expect(text.trim(), `${locale} rejections.${reason}`).not.toBe('');
      }
      for (const key of ['unavailable', 'too_large', 'timeout', 'too_many_photos'] as const) {
        expect(
          copy.reels.failure({ failure: key, platform: 'TikTok', maximumPhotos: 35 }).trim(),
        ).not.toBe('');
      }
      expect(
        copy.reels.failure({ failure: 'cancelled', platform: 'TikTok', maximumPhotos: 35 }),
      ).toBe('');
    }
  });

  it('renders the same structural facts in both languages', () => {
    for (const locale of locales) {
      const copy = messages(locale);
      const privacy = copy.commands.privacy({
        modelLabel: 'GLM 5.3 Flash',
        supportsZdr: true,
        contextLimit: 5,
        transcriptTtlDays: 7,
      });
      // The facts a reader depends on must survive translation.
      expect(privacy).toContain('GLM 5.3 Flash');
      expect(privacy).toContain('Open-Meteo');
      expect(privacy.length).toBeGreaterThan(500);
      const status = copy.news.statusLines({
        feed: 'daily',
        deploymentEnabled: true,
        configuration: 'enabled',
        destination: { kind: 'channel', channelId: '42' },
        paused: null,
        nextCollectionAt: 'later',
        lastSuccessAt: null,
        backoffUntil: null,
        storedEdition: null,
        pending: 2,
        uncertain: 1,
      });
      expect(status.join('\n')).toContain('<#42>');
      expect(status.join('\n')).toContain('Aktuality.sk');
    }
  });
});

describe('Slovak grammatical number', () => {
  it('selects one, few and other for integer counts', () => {
    const forms = { one: '{count} správa', few: '{count} správy', other: '{count} správ' };
    expect(plural('sk', 1, forms)).toBe('1 správa');
    expect(plural('sk', 2, forms)).toBe('2 správy');
    expect(plural('sk', 4, forms)).toBe('4 správy');
    expect(plural('sk', 5, forms)).toBe('5 správ');
    expect(plural('sk', 0, forms)).toBe('0 správ');
    expect(plural('sk', 21, forms)).toBe('21 správ');
  });

  it('falls back to other when a form is omitted', () => {
    expect(plural('sk', 3, { one: 'jeden', other: 'viac' })).toBe('viac');
    expect(plural('en', 2, { one: '{count} day', other: '{count} days' })).toBe('2 days');
    expect(plural('en', 1, { one: '{count} day', other: '{count} days' })).toBe('1 day');
  });

  it('applies the Slovak forms through the catalogs', () => {
    expect(sk.commands.contextLimitSet(1)).toContain('1 správu');
    expect(sk.commands.contextLimitSet(3)).toContain('3 správy');
    expect(sk.commands.contextLimitSet(10)).toContain('10 správ');
    expect(en.commands.contextLimitSet(1)).toContain('1 message');
    expect(en.commands.contextLimitSet(10)).toContain('10 messages');
  });
});

describe('display formatting', () => {
  const instant = new Date('2026-09-15T05:00:00Z');

  it('formats dates and times per locale without touching scheduling keys', () => {
    expect(formatLongDate('sk', instant, 'Europe/Bratislava')).toBe('utorok 15. septembra 2026');
    expect(formatTime('sk', instant, 'Europe/Bratislava')).toBe('07:00');
    expect(formatLongDate('en', instant, 'Europe/Bratislava')).toContain('2026');
    expect(formatDuration('sk', 45372)).toBe('12h 36m');
    expect(formatDuration('sk', 207)).toBe('3m 27s');
  });
});

describe('model prompt isolation', () => {
  it('instructs the model to follow the question language', () => {
    expect(systemPrompt).toContain('Answer in the language of the latest user question');
  });

  it('builds a prompt that cannot vary with the guild locale', () => {
    // `buildPromptMessages` accepts no locale, so the guild setting is structurally unable to
    // reach the model. This asserts the property and fails loudly if a locale is ever threaded in.
    expect(buildPromptMessages.length).toBe(1);
    const clock = createClockSnapshot(new Date('2026-09-15T05:00:00Z'), 'Europe/Bratislava');
    const built = buildPromptMessages({
      conversation: null,
      currentUserContent: 'Aká bude zajtra pokuta?',
      maximumCharacters: 32_000,
      clock,
    });
    const rendered = JSON.stringify(built);
    const perGuild = locales.map((locale) => {
      const input = {
        conversation: null,
        currentUserContent: 'Aká bude zajtra pokuta?',
        maximumCharacters: 32_000,
        clock,
        settings: { ...defaultGuildSettings, locale },
      };
      return JSON.stringify(buildPromptMessages(input));
    });
    expect(perGuild[0]).toBe(perGuild[1]);
    for (const locale of locales) {
      const copy = messages(locale);
      expect(rendered).not.toContain(copy.languageName);
      expect(rendered).not.toContain(copy.progress.thinking);
      expect(rendered).not.toContain(copy.answer.basisModelOnly);
    }
    expect(defaultGuildSettings.locale).toBe('sk');
  });

  it('keeps the prompt builder free of catalog imports', () => {
    const source = readFileSync(new URL('../src/prompt.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('i18n');
  });
});

describe('every catalog entry renders in both languages', () => {
  // Each locale is exercised through the same call list, so a Slovak-only gap in a rarely
  // used branch cannot hide behind the English assertions in the other suites.
  it.each([...locales])('renders the full surface for %s', (locale) => {
    const copy = messages(locale);
    const rendered: string[] = [];
    const push = (...values: (string | string[])[]) => {
      for (const value of values) rendered.push(...(Array.isArray(value) ? value : [value]));
    };

    for (const zdr of [true, false]) {
      for (const contextLimit of [0, 5]) {
        push(
          copy.commands.privacy({
            modelLabel: 'GLM 5.3 Flash',
            supportsZdr: zdr,
            contextLimit,
            transcriptTtlDays: 7,
          }),
          copy.commands.settings({
            reelsDeploymentAvailable: zdr,
            reelsChannelEnabled: !zdr,
            modelLabel: 'Luna',
            reasoning: 'high',
            supportsZdr: zdr,
            contextLimit,
            languageName: copy.languageName,
            dailyCommitted: '$0.0100',
            monthlyCommitted: '$0.2000',
          }),
          copy.commands.modelSet({ label: 'Luna', reasoning: 'high', supportsZdr: zdr }),
        );
      }
    }
    push(
      copy.commands.contextLimitSet(0),
      copy.commands.contextLimitSet(7),
      copy.commands.languageSet(copy.languageName),
      copy.reels.toggled({ enabled: true, deploymentOff: true }),
      copy.reels.toggled({ enabled: false, deploymentOff: false }),
      copy.reels.atLeast('12 MiB'),
      copy.reels.bytes('5'),
      copy.reels.photosRange({ from: 1, to: 10, total: 24 }),
      copy.reels.platformLabel.tiktok,
      copy.reels.platformLabel.instagramPost,
      copy.reels.platformLabel.instagramReel,
      copy.reels.sizeUnknown,
    );
    for (const limitLabel of ['download', 'app', 'plain'] as const) {
      push(
        copy.reels.tooLarge({
          platform: copy.reels.platformLabel.tiktok,
          measurement: '24 MiB',
          limitLabel,
          limit: '20 MiB',
          discordRejected: limitLabel === 'app',
        }),
      );
    }
    for (const feed of ['continuous', 'daily'] as const) {
      push(
        copy.news.feedLabel[feed],
        copy.news.feedName[feed],
        copy.news.feedDisabled(feed),
        copy.news.feedConfigured({
          feed,
          channelId: '7',
          notifyRoleId: '9',
          deploymentEnabled: false,
        }),
        copy.news.feedConfigured({ feed, channelId: '7', deploymentEnabled: true }),
        copy.news.summary({ available: true, feeds: [{ feed, state: 'x' }] }),
      );
      for (const paused of [
        null,
        'destination-unavailable',
        'decryption-failed',
        'deployment-disabled',
        'feed-disabled',
      ] as const) {
        for (const destination of [
          { kind: 'channel', channelId: '5' },
          { kind: 'unavailable' },
          { kind: 'none' },
        ] as const) {
          push(
            copy.news.statusLines({
              feed,
              deploymentEnabled: paused === null,
              configuration: paused === null ? 'enabled' : 'missing',
              destination,
              paused,
              nextCollectionAt: paused === null ? 'soon' : null,
              lastSuccessAt: paused === null ? 'earlier' : null,
              backoffUntil: paused === null ? null : 'later',
              storedEdition: feed === 'daily' ? { current: true, collectedAt: 'now' } : null,
              pending: 1,
              uncertain: paused === null ? 0 : 2,
            }),
          );
        }
      }
    }
    for (const outcome of Object.keys(copy.news.outcome) as (keyof typeof copy.news.outcome)[])
      push(copy.news.outcome[outcome]);

    push(
      copy.briefing.summary({ available: false, configured: false, hour: 7 }),
      copy.briefing.summary({ available: true, configured: true, hour: 7 }),
      copy.briefing.summary({ available: true, configured: false, hour: 7 }),
      copy.briefing.configured({ channelId: '1', hour: 6 }),
      copy.briefing.hourSet(7),
      copy.briefing.cityAdded({ name: 'Bratislava', count: 1, maximum: 5 }),
      copy.briefing.cityRemoved('Košice'),
      copy.briefing.cityUnknown('Atlantis'),
      copy.briefing.cityDuplicate('Bratislava'),
      copy.briefing.cityLimit(5),
      copy.briefing.greeting('15. septembra'),
      copy.briefing.weatherUnavailable('Bratislava'),
      copy.briefing.daylight({ duration: '12h 36m', delta: '3m 27s', shorter: true }),
      copy.briefing.daylight({ duration: '12h 36m', delta: '3m 27s', shorter: false }),
      copy.briefing.namedays(['Jolana']),
      copy.briefing.namedays(['Jolana', 'Melisa']),
      copy.briefing.holiday({
        name: 'Sedembolestná Panna Mária',
        dayOff: true,
        stateHoliday: true,
      }),
      copy.briefing.holiday({
        name: 'Sedembolestná Panna Mária',
        dayOff: false,
        stateHoliday: false,
      }),
      copy.briefing.agenda([{ id: 'a', dueAt: '14:00', text: 'call' }]),
      copy.briefing.feels('23 °C'),
      copy.briefing.rain({ millimetres: 0, probability: 0 }),
      copy.briefing.rain({ millimetres: 3.3, probability: 98 }),
      copy.briefing.wind({ speed: 7.8, gusts: 18.4 }),
      copy.briefing.uv(4.9),
      copy.briefing.statusLines({
        configured: true,
        destination: { kind: 'channel', channelId: '3' },
        hour: 7,
        cities: ['Bratislava'],
        maximumCities: 5,
        nextDeliveryAt: 'tomorrow',
        lastDeliveredAt: 'today',
      }),
      copy.briefing.statusLines({
        configured: false,
        destination: { kind: 'unavailable' },
        hour: 8,
        cities: [],
        maximumCities: 5,
        nextDeliveryAt: null,
        lastDeliveredAt: null,
      }),
      copy.briefing.statusLines({
        configured: false,
        destination: { kind: 'none' },
        hour: 8,
        cities: [],
        maximumCities: 5,
        nextDeliveryAt: null,
        lastDeliveredAt: null,
      }),
      copy.reminders.created({ dueAt: '09:00', id: 'a12c' }),
      copy.reminders.cancelled('a12c'),
      copy.reminders.notFound('a12c'),
      copy.reminders.list([{ id: 'a12c', dueAt: '09:00', text: 'invoice' }]),
      copy.reminders.limitReached(20),
      copy.reminders.deliver({ userId: '1', text: 'invoice', createdAt: 'yesterday' }),
      copy.usage.heading(14),
      copy.usage.lines({
        windowDays: 14,
        memberWindowDays: 7,
        trend: [{ date: '2026-09-15', costMicrodollars: 3100, requests: 4 }],
        sparkline: '▁▂█',
        totalCost: '$0.0412',
        dailyCost: '$0.0031',
        monthlyCost: '$0.4118',
        monthlyLimit: '$10.0000',
        members: [{ name: 'Filip', requests: 41, cost: '$0.0284', failures: 1 }],
        othersIncluded: true,
      }),
      copy.usage.lines({
        windowDays: 14,
        memberWindowDays: 7,
        trend: [],
        sparkline: '',
        totalCost: '$0',
        dailyCost: '$0',
        monthlyCost: '$0',
        monthlyLimit: '$10',
        members: [],
        othersIncluded: false,
      }),
      copy.progress.retry({
        reason: 'r',
        waitSeconds: 1,
        attempt: 2,
        maximum: 5,
        elapsed: '00:01',
      }),
      copy.progress.retry({
        reason: 'r',
        waitSeconds: 0,
        attempt: 2,
        maximum: 5,
        elapsed: '00:01',
      }),
      copy.progress.noActivityFor('00:20'),
      copy.answer.imageModel('GLM 5.3 Flash'),
      copy.answer.omittedSources(1),
      copy.answer.omittedSources(3),
      copy.answer.omittedSources(9),
      copy.answer.sourceLabel(1),
      copy.answer.sourceLabel(2, 'Title'),
      copy.answer.cost('$0.0004'),
    );

    for (const category of [
      'timeout',
      'rate_limited',
      'authentication',
      'payment_required',
      'request_rejected',
      'provider_unavailable',
      'provider_failure',
      'malformed_response',
      'network_failure',
      'cancelled',
      'unknown',
    ] as const) {
      push(
        copy.failures.notice({ category, reference: 'REF' }),
        copy.failures.retryReason({ category }),
        copy.failures.retryReason({ category, status: 500 }),
      );
    }
    for (const malformedReason of ['empty_answer', 'reasoning_budget_exhausted'] as const) {
      push(
        copy.failures.notice({ category: 'malformed_response', malformedReason, reference: 'R' }),
        copy.failures.retryReason({ category: 'malformed_response', malformedReason }),
      );
    }
    push(copy.failures.retryReason({ category: 'provider_failure', status: 502 }));

    expect(rendered.length).toBeGreaterThan(150);
    for (const [index, value] of rendered.entries()) {
      expect(typeof value, `${locale} entry ${index}`).toBe('string');
      expect(value.trim(), `${locale} entry ${index}`).not.toBe('');
      // Unsubstituted plural placeholders are a silent correctness bug in Slovak.
      expect(value, `${locale} entry ${index}`).not.toContain('{count}');
      expect(value, `${locale} entry ${index}`).not.toContain('undefined');
    }
  });
});
