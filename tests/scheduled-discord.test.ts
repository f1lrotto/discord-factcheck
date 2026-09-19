import { describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits, type Client } from 'discord.js';
import pino from 'pino';
import { createDiscordBot } from '../src/discord-bot.js';
import type { JolandaStore } from '../src/types.js';
import type { ReminderStore } from '../src/reminders.js';
import type { Jolanda } from '../src/jolanda.js';

describe('scheduled Discord transport', () => {
  it.each(['sk', 'en', 'unavailable'] as const)(
    'uses %s copy and only allows the reminder owner mention',
    async (locale) => {
      const posts: Record<string, unknown>[] = [];
      const makeRequest = vi.fn<typeof fetch>(async (url, init) => {
        const route = String(url);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          posts.push(body);
          return json({ id: '5', channel_id: '2', nonce: body.nonce });
        }
        if (route.endsWith('/channels/2'))
          return json({ id: '2', guild_id: '1', type: 0, permission_overwrites: [] });
        if (route.endsWith('/guilds/1/roles'))
          return json([
            {
              id: '1',
              permissions: String(
                PermissionFlagsBits.ViewChannel |
                  PermissionFlagsBits.SendMessages |
                  PermissionFlagsBits.EmbedLinks,
              ),
              mentionable: false,
            },
          ]);
        return json({ user: { id: '4' }, roles: [] });
      });
      const bot = createDiscordBot({
        client: {
          on: vi.fn(),
          once: vi.fn(),
          isReady: () => true,
          user: { id: '4' },
          destroy: vi.fn(),
        } as unknown as Client,
        token: 'test-token',
        maximumContextMessages: 50,
        promptsPerMinute: 3,
        transcriptTtlDays: 7,
        protectIdentifier: (value) => value,
        logger: pino({ enabled: false }),
        jolanda: {} as Jolanda,
        reminderStore: {} as ReminderStore,
        store: {
          getSettings: async () => {
            if (locale === 'unavailable') throw new Error('offline');
            return { locale };
          },
        } as unknown as JolandaStore,
        newsPublisherOptions: { makeRequest },
      });
      const result = await bot.reminderPublisher!.publish({
        destination: { guildId: '1', channelId: '2', userId: '3' },
        reminder: {
          id: 'abcd',
          text: '**@everyone** <@9> invoice',
          dueAt: new Date('2026-09-15T05:00:00Z'),
          createdAt: new Date('2026-09-14T05:00:00Z'),
        },
        nonce: 'stable-reminder',
        signal: new AbortController().signal,
      });
      expect(result).toEqual({ outcome: 'sent', messageId: '5' });
      expect(posts).toHaveLength(1);
      expect(posts[0]!.allowed_mentions).toEqual({ parse: [], users: ['3'] });
      expect(posts[0]!.content).toContain('<@3>');
      expect(posts[0]!.content).not.toContain('@everyone');
      expect(posts[0]!.content).not.toContain('<@9>');
      expect(posts[0]!.content).toContain(locale === 'en' ? 'Set' : 'Nastavené');
      expect(posts[0]!.enforce_nonce).toBe(true);
      await bot.destroy();
    },
  );
});
