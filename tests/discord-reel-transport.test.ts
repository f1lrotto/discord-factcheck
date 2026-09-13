import { Client, GatewayIntentBits, Message, REST } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createReelDiscordTransport } from '../src/discord-reel-transport.js';

const setup = () => {
  const rest = new REST();
  const get = vi.spyOn(rest, 'get').mockResolvedValue({ content: 'source' });
  const post = vi.spyOn(rest, 'post').mockResolvedValue({ id: 'delivered' });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const message = Reflect.construct(Message, [
    client,
    {
      id: '123456789012345678',
      channel_id: '234567890123456789',
      guild_id: '345678901234567890',
      author: { id: '456789012345678901', username: 'human', discriminator: '0', avatar: null },
      content: 'source',
      timestamp: new Date().toISOString(),
      type: 0,
    },
  ]) as Message;
  return {
    rest,
    get,
    post,
    client,
    message: message as Message<true>,
    transport: createReelDiscordTransport('token', rest),
  };
};
describe('finite Discord media REST transport', () => {
  it('fetches fresh content and serializes an ordinary attachment reply', async () => {
    const s = setup();
    expect(await s.transport.fetchContent(s.message)).toBe('source');
    expect(
      await s.transport.reply(s.message, {
        content: 'Instagram Reel',
        files: [{ attachment: Buffer.from('mp4'), name: 'instagram-reel.mp4' }],
        allowedMentions: { parse: [], repliedUser: false },
        nonce: 'stable',
        enforceNonce: true,
      }),
    ).toEqual({ id: 'delivered' });
    expect(s.post).toHaveBeenCalledWith(
      '/channels/234567890123456789/messages',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        body: expect.objectContaining({
          content: 'Instagram Reel',
          nonce: 'stable',
          enforce_nonce: true,
          allowed_mentions: { parse: [], replied_user: false },
          message_reference: { message_id: s.message.id, fail_if_not_exists: true },
        }),
        files: [expect.objectContaining({ name: 'instagram-reel.mp4', data: Buffer.from('mp4') })],
      }),
    );
    s.transport.close?.();
    await s.client.destroy();
  });
  it('rejects unknown receipts and does not invent source content', async () => {
    const s = setup();
    s.get.mockResolvedValue({});
    s.post.mockResolvedValue({});
    expect(await s.transport.fetchContent(s.message)).toBeNull();
    await expect(s.transport.reply(s.message, { content: 'test' })).rejects.toThrow(
      'Invalid Discord media receipt',
    );
    s.transport.close?.();
    await s.client.destroy();
  });
  it('constructs a production transport without connecting', () => {
    const transport = createReelDiscordTransport('token');
    expect(transport).toHaveProperty('reply');
    transport.close?.();
  });
});
