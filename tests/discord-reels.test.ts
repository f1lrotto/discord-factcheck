import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, type Message } from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createDiscordReels } from '../src/discord-reels.js';
import { ReelError, type ReelDownloader, type ReelStore } from '../src/reel-types.js';
const url = 'https://www.instagram.com/reel/sample/';
const setup = (enabled = true, maximumBytes?: number) => {
  const store: ReelStore = {
    getEnabled: vi.fn(async () => true),
    setEnabled: vi.fn(async () => undefined),
    claim: vi.fn(async () => ({ key: 'claim', owner: 'owner' })),
    transition: vi.fn(async () => true),
  };
  const downloader: ReelDownloader = {
    withDownloadedReel: vi.fn(async (job, consume) =>
      consume({
        kind: 'video',
        path: '/private/generated/video.mp4',
        bytes: 5,
        duration: 10,
        hasAudio: true,
        url: job.reel.url,
      }),
    ),
  };
  const permissions = { has: vi.fn(() => true) };
  const reply = vi.fn(async () => ({ id: 'delivered' }));
  const message = {
    type: 0,
    id: 'source',
    guildId: 'guild',
    channelId: 'channel',
    content: url,
    author: { id: 'human', bot: false },
    guild: { members: { me: { id: 'bot' } } },
    channel: {
      type: ChannelType.GuildText,
      permissionsFor: () => permissions,
      messages: { fetch: vi.fn() },
    },
    inGuild: () => true,
    reply,
  };
  message.channel.messages.fetch.mockResolvedValue(message);
  const logger = pino({ enabled: false });
  const log = vi.spyOn(logger, 'info');
  const reels = createDiscordReels({
    enabled,
    ...(maximumBytes === undefined ? {} : { maximumBytes }),
    store,
    downloader,
    logger,
    protectIdentifier: (raw) => createHash('sha256').update(raw).digest('hex'),
  });
  const offer = (overrides: Record<string, unknown> = {}) =>
    reels.offer({ ...message, ...overrides } as unknown as Message);
  return { reels, store, downloader, message, permissions, reply, log, offer };
};
describe('automatic Reel delivery', () => {
  it('replies with one attachment, protected mentions, source, durable nonce and receipt', async () => {
    const s = setup();
    s.offer();
    await vi.waitFor(() => expect(s.reply).toHaveBeenCalledOnce());
    await s.reels.shutdown();
    expect(s.reply).toHaveBeenCalledWith({
      content: `Instagram Reel · <${url}>`,
      files: [{ attachment: '/private/generated/video.mp4', name: 'instagram-reel.mp4' }],
      allowedMentions: { parse: [], repliedUser: false },
      nonce: expect.stringMatching(/^[a-f0-9]{25}$/),
      enforceNonce: true,
      failIfNotExists: true,
    });
    expect(s.store.transition).toHaveBeenLastCalledWith(
      { key: 'claim', owner: 'owner' },
      'publishing',
      'sent',
      'sent',
      'delivered',
    );
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('sample');
    expect(s.permissions.has).toHaveBeenCalledWith(
      expect.arrayContaining([PermissionFlagsBits.AttachFiles]),
    );
  });
  it('does no settings lookup for ineligible traffic or global disable', async () => {
    const s = setup();
    for (const overrides of [
      { content: 'hello' },
      { author: { bot: true } },
      { webhookId: 'hook' },
      { inGuild: () => false },
      { channel: { type: ChannelType.PublicThread } },
    ])
      s.offer(overrides);
    await s.reels.shutdown();
    expect(s.store.getEnabled).not.toHaveBeenCalled();
    const off = setup(false);
    off.offer();
    await off.reels.shutdown();
    expect(off.store.getEnabled).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'permissions', 'duplicate'])('skips %s silently', async (mode) => {
    const s = setup();
    if (mode === 'disabled') vi.mocked(s.store.getEnabled).mockResolvedValue(false);
    if (mode === 'permissions') s.permissions.has.mockReturnValue(false);
    if (mode === 'duplicate') vi.mocked(s.store.claim).mockResolvedValue(null);
    s.offer();
    await new Promise((resolve) => setImmediate(resolve));
    await s.reels.shutdown();
    expect(s.downloader.withDownloadedReel).not.toHaveBeenCalled();
    expect(s.reply).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'deleted', 'edited', 'permissions', 'claim'])(
    'rechecks before publishing: %s',
    async (mode) => {
      const s = setup();
      vi.mocked(s.downloader.withDownloadedReel).mockImplementation(async (_job, consume) => {
        if (mode === 'disabled') vi.mocked(s.store.getEnabled).mockResolvedValue(false);
        if (mode === 'deleted')
          s.message.channel.messages.fetch.mockRejectedValue(new Error('deleted'));
        if (mode === 'edited') s.message.content = 'edited away';
        if (mode === 'permissions') s.permissions.has.mockReturnValue(false);
        if (mode === 'claim') vi.mocked(s.store.transition).mockResolvedValue(false);
        return consume({
          kind: 'video',
          path: '/file',
          bytes: 5,
          duration: 10,
          hasAudio: true,
          url,
        });
      });
      s.offer();
      await vi.waitFor(() => expect(s.log).toHaveBeenCalled());
      await s.reels.shutdown();
      expect(s.reply).not.toHaveBeenCalled();
    },
  );
  it.each([
    'authentication_required',
    'too_large',
    'unsupported_media',
    'timeout',
    'extractor_failed',
    'cancelled',
  ] as const)('contains download failure %s', async (category) => {
    const s = setup();
    vi.mocked(s.downloader.withDownloadedReel).mockRejectedValue(new ReelError(category));
    s.offer();
    await vi.waitFor(() => expect(s.log).toHaveBeenCalled());
    await s.reels.shutdown();
    expect(s.reply).toHaveBeenCalledTimes(category === 'cancelled' ? 0 : 1);
    if (category !== 'cancelled') expect(s.reply.mock.calls[0]).not.toHaveProperty('files');
  });
  it.each([
    {
      size: { bytes: 24 * 1024 * 1024 },
      maximumBytes: undefined,
      expected: 'Reel is too large: 24 MiB (limit: 20 MiB).',
    },
    {
      size: { bytes: 120 * 1024 * 1024, downloadLimit: 100 * 1024 * 1024 },
      maximumBytes: undefined,
      expected: 'Reel is too large: 120 MiB (download limit: 100 MiB).',
    },
    {
      size: { bytes: 12 * 1024 * 1024, atLeast: true },
      maximumBytes: 9 * 1024 * 1024,
      expected: 'Reel is too large: at least 12 MiB (limit: 9 MiB).',
    },
    {
      size: undefined,
      maximumBytes: undefined,
      expected: 'Reel is too large: size unknown (limit: 20 MiB).',
    },
  ])(
    'reports file size and the configured limit: $expected',
    async ({ size, maximumBytes, expected }) => {
      const s = setup(true, maximumBytes);
      vi.mocked(s.downloader.withDownloadedReel).mockRejectedValue(
        new ReelError('too_large', size),
      );
      s.offer();
      await vi.waitFor(() => expect(s.reply).toHaveBeenCalledOnce());
      await s.reels.shutdown();
      expect(s.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expected }));
    },
  );
  it.each([50013, 10008, undefined])(
    'does not repeat rejected or uncertain upload %s',
    async (code) => {
      const s = setup();
      s.reply.mockRejectedValue(Object.assign(new Error('sensitive'), { code }));
      s.offer();
      await vi.waitFor(() => expect(s.log).toHaveBeenCalled());
      await s.reels.shutdown();
      expect(s.reply).toHaveBeenCalledOnce();
      expect(s.store.transition).toHaveBeenLastCalledWith(
        expect.any(Object),
        'publishing',
        code ? 'failed' : 'uncertain',
        code === 40005
          ? 'too_large'
          : code === 50013
            ? 'permission_denied'
            : code === 10008
              ? 'source_unavailable'
              : 'uncertain',
      );
    },
  );
  it('replies with text after a definite oversized upload rejection', async () => {
    const s = setup();
    s.reply.mockRejectedValueOnce({ code: 40005 });
    s.offer();
    await vi.waitFor(() => expect(s.log).toHaveBeenCalled());
    await s.reels.shutdown();
    expect(s.reply).toHaveBeenCalledTimes(2);
    expect(s.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        files: [],
        content: 'Reel is too large for Discord: 5 bytes (app limit: 20 MiB).',
      }),
    );
    expect(s.store.transition).toHaveBeenLastCalledWith(
      expect.any(Object),
      'publishing',
      'sent',
      'too_large',
      'delivered',
    );
  });

  it('does not retry a successful upload after receipt failure', async () => {
    const s = setup();
    vi.mocked(s.store.transition).mockImplementation(async (_claim, from) => {
      if (from === 'publishing') throw new Error('database');
      return true;
    });
    s.offer();
    await vi.waitFor(() => expect(s.log).toHaveBeenCalled());
    await s.reels.shutdown();
    expect(s.reply).toHaveBeenCalledOnce();
  });
  it('honors channel disable while the fresh source read is pending', async () => {
    const s = setup();
    s.message.channel.messages.fetch.mockImplementation(async () => {
      vi.mocked(s.store.getEnabled).mockResolvedValue(false);
      return s.message;
    });
    s.offer();
    await vi.waitFor(() => expect(s.log).toHaveBeenCalled());
    await s.reels.shutdown();
    expect(s.reply).not.toHaveBeenCalled();
  });

  it('enforces the guild attempt budget across different members', async () => {
    const s = setup();
    vi.mocked(s.downloader.withDownloadedReel).mockRejectedValue(new ReelError('cancelled'));
    for (let i = 0; i < 11; i++) {
      s.offer({ id: String(i), author: { id: String(i), bot: false } });
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(s.downloader.withDownloadedReel).toHaveBeenCalledTimes(10);
    await s.reels.shutdown();
  });

  it('bounds pre-admission, owns the slot through upload, and drains on shutdown', async () => {
    const s = setup();
    let complete: () => void = () => undefined;
    const upload = new Promise<void>((resolve) => {
      complete = resolve;
    });
    s.reply.mockImplementation(async () => {
      await upload;
      return { id: 'delivered' };
    });
    s.offer();
    await vi.waitFor(() => expect(s.reply).toHaveBeenCalledOnce());
    for (let i = 0; i < 20; i++) s.offer({ id: `other${i}` });
    let drained = false;
    const closing = s.reels.shutdown().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    complete();
    await closing;
    s.offer();
    expect(s.downloader.withDownloadedReel).toHaveBeenCalledOnce();
  });
  it('cancels active downloads and waits for cleanup', async () => {
    const s = setup();
    let cancelled = false;
    vi.mocked(s.downloader.withDownloadedReel).mockImplementation(
      async ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              reject(new ReelError('cancelled'));
            },
            { once: true },
          ),
        ),
    );
    s.offer();
    await vi.waitFor(() => expect(s.downloader.withDownloadedReel).toHaveBeenCalledOnce());
    await s.reels.shutdown();
    expect(cancelled).toBe(true);
    expect(s.reply).not.toHaveBeenCalled();
  });
  it('counts failed attempts separately from AI limits and contains admission failures', async () => {
    const s = setup();
    vi.mocked(s.downloader.withDownloadedReel).mockRejectedValue(new ReelError('cancelled'));
    for (let i = 0; i < 3; i++) {
      s.offer({ id: String(i) });
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(s.downloader.withDownloadedReel).toHaveBeenCalledTimes(2);
    await s.reels.shutdown();
    const fail = setup();
    vi.mocked(fail.store.getEnabled).mockRejectedValue(new Error('private'));
    fail.offer();
    await vi.waitFor(() => expect(fail.log).toHaveBeenCalled());
    await fail.reels.shutdown();
    expect(fail.reply).not.toHaveBeenCalled();
  });
});

describe('TikTok under the Reels umbrella', () => {
  const tiktok = 'https://www.tiktok.com/@creator/video/123456789';
  it('uses the same channel setting, delivery claim and upload flow', async () => {
    const s = setup();
    s.message.content = tiktok;
    s.offer();
    await vi.waitFor(() => expect(s.reply).toHaveBeenCalledOnce());
    await s.reels.shutdown();
    expect(s.store.claim).toHaveBeenCalledWith(
      expect.objectContaining({ shortcode: 'tiktok:video:123456789' }),
    );
    expect(s.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: `TikTok · <${tiktok}>`,
        files: [{ attachment: '/private/generated/video.mp4', name: 'tiktok.mp4' }],
      }),
    );
  });
  it.each(['deployment', 'channel'])('honors the shared %s disable', async (kind) => {
    const s = setup(kind !== 'deployment');
    s.message.content = tiktok;
    if (kind === 'channel') vi.mocked(s.store.getEnabled).mockResolvedValue(false);
    s.offer();
    await s.reels.shutdown();
    expect(s.downloader.withDownloadedReel).not.toHaveBeenCalled();
  });
  it('only reposts the first link in a mixed message', async () => {
    const s = setup();
    s.message.content = `${tiktok} ${url}`;
    s.offer();
    await vi.waitFor(() => expect(s.reply).toHaveBeenCalledOnce());
    await s.reels.shutdown();
    expect(s.downloader.withDownloadedReel).toHaveBeenCalledOnce();
    expect(s.reply.mock.calls[0]).toEqual([
      expect.objectContaining({ content: `TikTok · <${tiktok}>` }),
    ]);
  });
  it('does not publish when the TikTok link is removed during download', async () => {
    const s = setup();
    s.message.content = tiktok;
    vi.mocked(s.downloader.withDownloadedReel).mockImplementation(async (_job, consume) => {
      s.message.content = url;
      await consume({
        kind: 'video',
        path: '/file',
        url: tiktok,
        bytes: 5,
        duration: 10,
        hasAudio: true,
      });
    });
    s.offer();
    await vi.waitFor(() => expect(s.downloader.withDownloadedReel).toHaveBeenCalledOnce());
    await s.reels.shutdown();
    expect(s.reply).not.toHaveBeenCalled();
  });
  it('names TikTok in failure replies', async () => {
    const s = setup();
    s.message.content = tiktok;
    vi.mocked(s.downloader.withDownloadedReel).mockRejectedValue(new ReelError('unavailable'));
    s.offer();
    await vi.waitFor(() => expect(s.reply).toHaveBeenCalledOnce());
    await s.reels.shutdown();
    expect(s.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'I couldn’t access this TikTok without a TikTok login.' }),
    );
  });
});

describe('TikTok photo album delivery', () => {
  const url = 'https://www.tiktok.com/@creator/photo/123';
  const photos = Array.from({ length: 18 }, (_, i) => ({
    path: `/photo-${i}`,
    name: `photo-${i}.jpg`,
  }));
  const photoSetup = () => {
    const s = setup();
    s.message.content = url;
    vi.mocked(s.downloader.withDownloadedReel).mockImplementation(async (_job, consume) =>
      consume({ kind: 'photos', files: photos, bytes: 100, url }),
    );
    return s;
  };
  it('reposts all 18 photos in two ordered batches under one claim with distinct stable nonces', async () => {
    const s = photoSetup();
    s.offer();
    await vi.waitFor(() =>
      expect(s.store.transition).toHaveBeenLastCalledWith(
        expect.anything(),
        'publishing',
        'sent',
        'sent',
        'delivered',
      ),
    );
    await s.reels.shutdown();
    expect(s.reply).toHaveBeenCalledTimes(2);
    expect(s.reply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: `TikTok · <${url}> · Photos 1–10 of 18`,
        files: photos.slice(0, 10).map(({ path, name }) => ({ attachment: path, name })),
      }),
    );
    expect(s.reply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: `TikTok · <${url}> · Photos 11–18 of 18`,
        files: photos.slice(10).map(({ path, name }) => ({ attachment: path, name })),
      }),
    );
    const calls = s.reply.mock.calls as unknown as [{ nonce: string }][];
    expect(calls[0]![0].nonce).not.toBe(calls[1]![0].nonce);
    expect(s.store.claim).toHaveBeenCalledOnce();
    expect(s.store.transition).toHaveBeenCalledTimes(2);
  });
  it.each(['disable', 'delete', 'failure'])(
    'stops after the first batch on %s without restarting the album',
    async (kind) => {
      const s = photoSetup();
      s.reply.mockImplementationOnce(async () => {
        if (kind === 'disable') vi.mocked(s.store.getEnabled).mockResolvedValue(false);
        if (kind === 'delete') s.message.content = 'removed';
        return { id: 'first' };
      });
      if (kind === 'failure') s.reply.mockRejectedValueOnce(new Error('ambiguous send'));
      s.offer();
      await vi.waitFor(() => expect(s.store.transition).toHaveBeenCalledTimes(2));
      await s.reels.shutdown();
      expect(s.reply).toHaveBeenCalledTimes(kind === 'failure' ? 2 : 1);
      expect(s.store.transition).not.toHaveBeenCalledWith(
        expect.anything(),
        'publishing',
        'sent',
        'sent',
        expect.anything(),
      );
    },
  );
});
