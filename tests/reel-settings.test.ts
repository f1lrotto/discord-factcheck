import { ChannelType, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createCommandHandler } from '../src/discord-commands.js';
import type { ReelStore } from '../src/reel-types.js';
import type { JolandaStore } from '../src/types.js';
import { loadConfig } from '../src/config.js';
const setup = () => {
  const setEnabled = vi.fn(async () => undefined);
  const editReply = vi.fn();
  const interaction = {
    commandName: 'jolanda',
    guildId: 'guild',
    channelId: 'channel',
    channel: { id: 'channel', type: ChannelType.GuildText },
    user: { id: 'user' },
    memberPermissions: {
      has: (permission: bigint) => permission === PermissionFlagsBits.ManageGuild,
    },
    appPermissions: { has: () => true },
    options: { getSubcommand: () => 'reels', getBoolean: () => true },
    deferReply: vi.fn(),
    editReply,
    reply: vi.fn(),
  };
  const handler = createCommandHandler({
    transcriptTtlDays: 7,
    maximumContextMessages: 50,
    store: {
      getSettings: async () => ({
        guildId: 'guild',
        model: 'glm-5.3-flash' as const,
        reasoning: 'high' as const,
        contextLimitMessages: 0,
        locale: 'en' as const,
        updatedAt: new Date(0),
      }),
    } as unknown as JolandaStore,
    reelStore: { setEnabled } as unknown as ReelStore,
    reelsEnabled: false,
    logger: pino({ enabled: false }),
    protectIdentifier: (value) => value,
  });
  const run = () => handler(interaction as unknown as ChatInputCommandInteraction);
  return { setEnabled, editReply, interaction, run };
};
describe('Reel administration', () => {
  it('persists enable and disable independently of the global switch', async () => {
    const s = setup();
    await s.run();
    expect(s.setEnabled).toHaveBeenCalledWith({ guildId: 'guild', channelId: 'channel' }, true);
    expect(s.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('deployment switch is off') }),
    );
    s.interaction.options.getBoolean = () => false;
    await s.run();
    expect(s.setEnabled).toHaveBeenLastCalledWith(
      { guildId: 'guild', channelId: 'channel' },
      false,
    );
  });
  it.each(['manage', 'attach', 'thread'])(
    'rejects missing permission or unsupported channel: %s',
    async (mode) => {
      const s = setup();
      if (mode === 'manage') s.interaction.memberPermissions.has = () => false;
      if (mode === 'attach') s.interaction.appPermissions.has = () => false;
      if (mode === 'thread') s.interaction.channel.type = ChannelType.PublicThread;
      await s.run();
      expect(s.setEnabled).not.toHaveBeenCalled();
    },
  );
});
describe('strict Reel configuration', () => {
  const base = {
    DISCORD_TOKEN: 'token',
    OPENROUTER_API_KEY: 'key',
    DATA_PROTECTION_SECRET: 'a'.repeat(32),
    MONGODB_URI: 'mongodb://localhost/test',
    NODE_ENV: 'test',
  };
  it('defaults disabled without checking binaries and parses false explicitly', () => {
    expect(loadConfig(base).INSTAGRAM_REELS_ENABLED).toBe(false);
    expect(loadConfig({ ...base, INSTAGRAM_REELS_ENABLED: 'false' }).INSTAGRAM_REELS_ENABLED).toBe(
      false,
    );
    expect(loadConfig({ ...base, INSTAGRAM_REELS_ENABLED: 'true' }).INSTAGRAM_REELS_ENABLED).toBe(
      true,
    );
  });
  it.each([
    { INSTAGRAM_REELS_ENABLED: 'yes' },
    { INSTAGRAM_REELS_MAX_BYTES: '99999999' },
    { INSTAGRAM_REELS_MAX_BYTES: 'NaN' },
    { INSTAGRAM_REELS_JOB_TIMEOUT_MS: '0' },
    { INSTAGRAM_REELS_JOB_TIMEOUT_MS: '240001' },
    { INSTAGRAM_YT_DLP_PATH: 'relative/path' },
    { INSTAGRAM_FFMPEG_PATH: 'relative/path' },
  ])('rejects invalid policy %j', (options) =>
    expect(() => loadConfig({ ...base, ...options })).toThrow('Invalid environment configuration'),
  );
});
