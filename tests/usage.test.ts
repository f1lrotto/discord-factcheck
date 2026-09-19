import type { ChatInputCommandInteraction } from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createCommandHandler } from '../src/discord-commands.js';
import type { JolandaStore } from '../src/types.js';
import { sparkline, usageFacts } from '../src/usage-report.js';
import { messages } from '../src/i18n/index.js';
import { formatUsd } from '../src/money.js';
import type { BudgetSummary, UsageSummary } from '../src/types.js';

const budget: BudgetSummary = {
  dailyUsedMicrodollars: 3_100,
  dailyReservedMicrodollars: 0,
  monthlyUsedMicrodollars: 411_800,
  monthlyReservedMicrodollars: 0,
};

const summary = (overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  trendDays: 3,
  memberWindowDays: 7,
  trend: [
    { date: '2026-09-13', costMicrodollars: 1_000, requests: 2 },
    { date: '2026-09-14', costMicrodollars: 0, requests: 0 },
    { date: '2026-09-15', costMicrodollars: 4_000, requests: 5 },
  ],
  members: [
    { userKey: 'hash-filip', requests: 41, costMicrodollars: 28_400, failures: 1 },
    { userKey: 'hash-jakub', requests: 12, costMicrodollars: 8_100, failures: 0 },
  ],
  totalCostMicrodollars: 5_000,
  ...overrides,
});

const facts = (overrides: Partial<Parameters<typeof usageFacts>[0]> = {}) =>
  usageFacts({
    summary: summary(),
    budget,
    monthlyLimitMicrodollars: 10_000_000,
    knownMembers: new Map([
      ['hash-filip', 'Filip'],
      ['hash-jakub', 'Jakub'],
    ]),
    othersLabel: 'others',
    ...overrides,
  });

describe('spend sparkline', () => {
  it('scales to the window peak', () => {
    expect(sparkline([0, 50, 100])).toBe('▁▅█');
    expect(sparkline([10])).toBe('█');
  });

  it('renders a flat baseline for a quiet window rather than nothing', () => {
    // An empty string would read as missing data instead of a week with no spend.
    expect(sparkline([0, 0, 0])).toBe('▁▁▁');
    expect(sparkline([])).toBe('');
  });

  it('never exceeds one block per day', () => {
    expect(sparkline(Array.from({ length: 14 }, (_unused, index) => index))).toHaveLength(14);
  });
});

describe('usage facts', () => {
  it('reports both windows separately', () => {
    const value = facts();
    expect(value.windowDays).toBe(3);
    expect(value.memberWindowDays).toBe(7);
    expect(value.totalCost).toBe('$0.0050');
    expect(value.dailyCost).toBe('$0.0031');
    expect(value.monthlyLimit).toBe('$10.0000');
    expect(value.sparkline).toBe('▃▁█');
  });

  it('resolves cached members and names the spend leader first', () => {
    const value = facts();
    expect(value.members.map((member) => member.name)).toEqual(['Filip', 'Jakub']);
    expect(value.members[0]).toMatchObject({ requests: 41, cost: '$0.0284', failures: 1 });
    expect(value.othersIncluded).toBe(false);
  });

  it('groups unresolvable members instead of printing a pseudonym', () => {
    const value = facts({ knownMembers: new Map([['hash-filip', 'Filip']]) });
    expect(value.othersIncluded).toBe(true);
    expect(value.members.map((member) => member.name)).toEqual(['Filip', 'others']);
    // The grouped row keeps the totals rather than dropping them.
    expect(value.members[1]).toMatchObject({ requests: 12, cost: '$0.0081' });
    expect(JSON.stringify(value)).not.toContain('hash-');
  });

  it('folds rows beyond the cap into the grouped row instead of dropping them', () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      userKey: `hash-${index}`,
      requests: 12 - index,
      costMicrodollars: (12 - index) * 100,
      failures: 0,
    }));
    const value = facts({
      summary: summary({ members: many }),
      knownMembers: new Map(many.map((member, index) => [member.userKey, `Member ${index}`])),
      maximumRows: 3,
    });
    expect(value.members).toHaveLength(4);
    expect(value.members.at(-1)?.name).toBe('others');
    const grouped = many.slice(3);
    expect(value.members.at(-1)?.requests).toBe(
      grouped.reduce((total, member) => total + member.requests, 0),
    );
    // The folded spend must survive too, not just the counts.
    const groupedCost = grouped.reduce((total, member) => total + member.costMicrodollars, 0);
    expect(value.members.at(-1)?.cost).toBe(formatUsd(groupedCost));
  });

  it('renders in both languages with the two windows labelled', () => {
    for (const locale of ['sk', 'en'] as const) {
      const rendered = messages(locale).usage.lines(facts());
      expect(rendered).toContain('Filip');
      expect(rendered).toContain('$0.0050');
      expect(rendered).toContain('▃▁█');
      // Both spans must appear so the numbers are not read as one window.
      expect(rendered).toContain('3');
      expect(rendered).toContain('7');
      expect(rendered).not.toContain('undefined');
    }
  });
});

describe('/jolanda usage command', () => {
  const setup = (options: { locale?: 'sk' | 'en'; empty?: boolean; canManage?: boolean } = {}) => {
    const editReply = vi.fn();
    const reply = vi.fn();
    const getUsageSummary = vi.fn(async () =>
      options.empty
        ? {
            trendDays: 14,
            memberWindowDays: 7,
            trend: Array.from({ length: 14 }, (_unused, index) => ({
              date: `2026-09-${String(index + 1).padStart(2, '0')}`,
              costMicrodollars: 0,
              requests: 0,
            })),
            members: [],
            totalCostMicrodollars: 0,
          }
        : summary(),
    );
    const interaction = {
      commandName: 'jolanda',
      guildId: 'guild',
      channelId: 'channel',
      user: { id: 'user' },
      guild: { members: { cache: new Map([['discord-filip', { displayName: 'Filip' }]]) } },
      memberPermissions: {
        has: () => options.canManage ?? true,
      },
      appPermissions: { has: () => true },
      options: { getSubcommandGroup: () => null, getSubcommand: () => 'usage' },
      deferReply: vi.fn(),
      editReply,
      reply,
    };
    const handler = createCommandHandler({
      transcriptTtlDays: 7,
      maximumContextMessages: 50,
      monthlyLimitMicrodollars: 10_000_000,
      store: {
        getSettings: async () => ({
          guildId: 'guild',
          model: 'glm-5.3-flash' as const,
          reasoning: 'high' as const,
          contextLimitMessages: 0,
          locale: options.locale ?? 'en',
          updatedAt: new Date(0),
        }),
        getUsageSummary,
        getBudgetSummary: async () => budget,
      } as unknown as JolandaStore,
      logger: pino({ enabled: false }),
      // Matches the member cache entry above so one row resolves and the rest group.
      protectIdentifier: (value) => (value === 'discord-filip' ? 'hash-filip' : `hash-${value}`),
    });
    return {
      editReply,
      reply,
      getUsageSummary,
      run: () => handler(interaction as unknown as ChatInputCommandInteraction),
    };
  };

  it('reports both windows and resolves a cached member', async () => {
    const s = setup();
    await s.run();
    expect(s.getUsageSummary).toHaveBeenCalledWith(
      'guild',
      expect.objectContaining({ trendDays: 14, memberWindowDays: 7 }),
    );
    const content = String(s.editReply.mock.calls[0]?.[0].content);
    expect(content).toContain('Filip');
    expect(content).toContain('others');
    expect(content).toContain('transcript retention');
    expect(content).not.toContain('hash-');
  });

  it('answers in the configured language', async () => {
    const s = setup({ locale: 'sk' });
    await s.run();
    const content = String(s.editReply.mock.calls[0]?.[0].content);
    expect(content).toContain('Spotreba Jolandy');
    expect(content).toContain('ostatní');
  });

  it('says so plainly when the window holds nothing', async () => {
    const s = setup({ empty: true });
    await s.run();
    expect(String(s.editReply.mock.calls[0]?.[0].content)).toBe(messages('en').usage.noData);
  });

  it('requires Manage Server', async () => {
    const s = setup({ canManage: false });
    await s.run();
    expect(s.getUsageSummary).not.toHaveBeenCalled();
    expect(String(s.editReply.mock.calls[0]?.[0].content)).toContain('Manage Server');
  });
});
