import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createNewsCommands } from '../src/news/commands.js';
import type { NewsEdition, NewsStore } from '../src/news/types.js';

const now = new Date('2026-09-16T08:00:00Z');
const edition: NewsEdition = {
  kind: 'edition',
  source: 'aktuality',
  id: 'late',
  title: 'Daily',
  url: 'https://www.aktuality.sk/clanok/late/denny-vyber/',
  publishedAt: new Date(+now - 3600000),
  revision: '1',
  sections: [],
};
const setup = (enabled = true) => {
  const store = {
    getSubscription: vi.fn().mockResolvedValue({ enabled: true, revision: 4 }),
    claimPoll: vi.fn().mockResolvedValue({
      source: 'aktuality',
      lease: { owner: 'worker', expiresAt: new Date(+now + 60000) },
    }),
    getSource: vi.fn().mockResolvedValue({ cache: {} }),
    commitPoll: vi.fn().mockResolvedValue(true),
    queueManualEdition: vi.fn().mockResolvedValue('queued'),
  } as unknown as NewsStore;
  const collect = vi.fn().mockResolvedValue({ outcome: 'edition', edition, cache: {} });
  const editReply = vi.fn();
  const commands = createNewsCommands({
    news: {
      store,
      publisher: { validateDestination: vi.fn() },
      enabled,
      clock: () => now,
      source: { id: 'aktuality', collect },
    },
    logger: pino({ enabled: false }),
    protectIdentifier: (value) => value,
  });
  const interaction = {
    id: 'request',
    guildId: 'guild',
    options: { getSubcommand: () => 'run' },
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return {
    store,
    collect,
    editReply,
    run: () => commands.handle(interaction, 'daily', 'en'),
    continuous: () => commands.handle(interaction, 'continuous', 'en'),
  };
};

describe('manual daily news command', () => {
  it('collects latest content, commits the poll and queues a fenced publication', async () => {
    const s = setup();
    await s.run();
    expect(s.collect).toHaveBeenCalledWith(expect.objectContaining({ latest: true, now }));
    expect(s.store.queueManualEdition).toHaveBeenCalledWith({
      guildId: 'guild',
      requestId: 'request',
      revision: 4,
      edition,
    });
    expect(s.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('queued') }),
    );
  });
  it('does not collect for disabled or unconfigured feeds or an active lease', async () => {
    const disabled = setup(false);
    await disabled.run();
    expect(disabled.collect).not.toHaveBeenCalled();
    const missing = setup();
    vi.mocked(missing.store.getSubscription).mockResolvedValue(null);
    await missing.run();
    expect(missing.collect).not.toHaveBeenCalled();
    const busy = setup();
    vi.mocked(busy.store.claimPoll).mockResolvedValue(null);
    await busy.run();
    expect(busy.collect).not.toHaveBeenCalled();
    const continuous = setup();
    await continuous.continuous();
    expect(continuous.collect).not.toHaveBeenCalled();
  });
  it('does not promise delivery after collection failure or lost poll ownership', async () => {
    const lost = setup();
    vi.mocked(lost.store.commitPoll).mockResolvedValue(false);
    await lost.run();
    expect(lost.store.queueManualEdition).not.toHaveBeenCalled();
    for (const outcome of ['stale', 'malformed', 'unavailable']) {
      const failed = setup();
      failed.collect.mockResolvedValue({ outcome, cache: {} });
      await failed.run();
      expect(failed.store.queueManualEdition).not.toHaveBeenCalled();
    }
    const thrown = setup();
    thrown.collect.mockRejectedValue(new Error('network'));
    await thrown.run();
    expect(thrown.store.commitPoll).toHaveBeenCalledWith(expect.anything(), {
      outcome: 'unavailable',
    });
  });
});
