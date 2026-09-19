import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  collectImageAttachments,
  createImageLoader,
  validateImageAttachments,
} from '../src/discord-images.js';
import { imageLimits } from '../src/image-limits.js';

const attachment = {
  url: 'https://cdn.discordapp.com/attachments/123/456/private.png?ex=secret&hm=signature',
  size: 1000,
  source: 'latest_message' as const,
};
const signal = () => new AbortController().signal;
const png = () =>
  sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#ff0000' } })
    .png()
    .withMetadata()
    .toBuffer();
const imageResponse = (bytes: Uint8Array) =>
  new Response(new Uint8Array(bytes), {
    headers: { 'content-type': 'image/png' },
  });

describe('Discord image input', () => {
  it('collects image attachments in order without retaining names or other metadata', () => {
    const attachments = [
      { ...attachment, name: 'photo', contentType: 'image/png' },
      { ...attachment, name: 'another.JPEG', contentType: null },
      { ...attachment, name: 'notes.pdf', contentType: 'application/pdf' },
    ];
    expect(collectImageAttachments(attachments, 'replied_message')).toEqual([
      { ...attachment, source: 'replied_message' },
      { ...attachment, source: 'replied_message' },
    ]);
  });

  it('downloads signed Discord attachments, strips metadata, resizes, and sends inline JPEG data', async () => {
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(imageResponse(await png()));
    const loaded = await createImageLoader(fetchImage)([attachment], signal());
    expect(fetchImage).toHaveBeenCalledWith(
      new URL(attachment.url),
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
    expect(loaded[0]?.source).toBe('latest_message');
    expect(loaded[0]?.dataUrl).toMatch(/^data:image\/jpeg;base64,/u);
    const metadata = await sharp(
      Buffer.from(loaded[0]!.dataUrl.split(',')[1]!, 'base64'),
    ).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 1600, height: 800 });
    expect(metadata.exif).toBeUndefined();
    expect(JSON.stringify(loaded)).not.toContain('secret');
    expect(JSON.stringify(loaded)).not.toContain('discordapp');
  });

  it('preserves image order and source across the latest and replied-to messages', async () => {
    const bytes = await png();
    const fetchImage = vi.fn<typeof fetch>().mockImplementation(async () => imageResponse(bytes));
    const loaded = await createImageLoader(fetchImage)(
      [attachment, { ...attachment, source: 'replied_message' }],
      signal(),
    );
    expect(loaded.map(({ source }) => source)).toEqual(['latest_message', 'replied_message']);
  });

  it.each(['jpeg', 'webp', 'gif'] as const)(
    'accepts %s attachments without enlarging them',
    async (format) => {
      const bytes = await sharp({
        create: { width: 10, height: 20, channels: 4, background: '#ff000080' },
      })
        .toFormat(format)
        .toBuffer();
      const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(imageResponse(bytes));
      const loaded = await createImageLoader(fetchImage)(
        [
          {
            ...attachment,
            url: attachment.url.replace('cdn.discordapp.com', 'media.discordapp.net'),
          },
        ],
        signal(),
      );
      const metadata = await sharp(
        Buffer.from(loaded[0]!.dataUrl.split(',')[1]!, 'base64'),
      ).metadata();
      expect(metadata).toMatchObject({ width: 10, height: 20, format: 'jpeg', hasAlpha: false });
    },
  );

  it('uses only the first GIF frame', async () => {
    const frames = Buffer.concat([Buffer.from([255, 0, 0]), Buffer.from([0, 0, 255])]);
    const bytes = await sharp(frames, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })
      .gif()
      .toBuffer();
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(imageResponse(bytes));
    const loaded = await createImageLoader(fetchImage)([attachment], signal());
    const { data, info } = await sharp(Buffer.from(loaded[0]!.dataUrl.split(',')[1]!, 'base64'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 1, height: 1 });
    expect(data[0]).toBeGreaterThan(240);
    expect(data[2]).toBeLessThan(10);
  });

  it('cancels an in-flight download when the turn is aborted', async () => {
    const controller = new AbortController();
    const fetchImage = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const task = createImageLoader(fetchImage)([attachment], controller.signal);
    controller.abort(new Error('shutdown'));
    await expect(task).rejects.toThrow('shutdown');
  });

  it('does no network work for an empty or oversized batch', async () => {
    const fetchImage = vi.fn<typeof fetch>();
    const load = createImageLoader(fetchImage);
    expect(await load([], signal())).toEqual([]);
    await expect(
      load(
        Array.from({ length: imageLimits.count + 1 }, () => attachment),
        signal(),
      ),
    ).rejects.toMatchObject({ reason: 'image_limit' });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, 1.5, imageLimits.sourceBytes + 1])(
    'rejects invalid declared size %s',
    (size) => {
      expect(() => validateImageAttachments([{ ...attachment, size }])).toThrow('image_too_large');
    },
  );

  it.each([
    'not a URL',
    'http://cdn.discordapp.com/attachments/1/2/file.png',
    'https://cdn.discordapp.com.evil.example/attachments/1/2/file.png',
    'https://127.0.0.1/attachments/1/2/file.png',
    'https://cdn.discordapp.com/avatars/1/file.png',
    'https://user:secret@cdn.discordapp.com/attachments/1/2/file.png',
    'https://cdn.discordapp.com:444/attachments/1/2/file.png',
  ])('rejects non-attachment URL %s before fetching', async (url) => {
    const fetchImage = vi.fn<typeof fetch>();
    await expect(
      createImageLoader(fetchImage)([{ ...attachment, url }], signal()),
    ).rejects.toMatchObject({ reason: 'image_unavailable' });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it.each([302, 403, 404, 500])('rejects HTTP %s without exposing a signed URL', async (status) => {
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private response', { status }));
    await expect(createImageLoader(fetchImage)([attachment], signal())).rejects.toMatchObject({
      message: 'image_unavailable',
    });
  });

  it('cancels responses that declare an oversized body', async () => {
    const body = new ReadableStream();
    const cancel = vi.spyOn(body, 'cancel');
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, { headers: { 'content-length': String(imageLimits.sourceBytes + 1) } }),
      );
    await expect(createImageLoader(fetchImage)([attachment], signal())).rejects.toThrow(
      'image_unavailable',
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('bounds actual bytes even if the Content-Length header is missing or wrong', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(imageLimits.sourceBytes + 1));
      },
      cancel,
    });
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(createImageLoader(fetchImage)([attachment], signal())).rejects.toThrow(
      'image_too_large',
    );
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    'not an image',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
  ])('rejects unsupported or corrupt image content', async (body) => {
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(createImageLoader(fetchImage)([attachment], signal())).rejects.toThrow(
      'image_unavailable',
    );
  });

  it('rejects compressed images exceeding the decoded pixel limit', async () => {
    const bytes = await sharp({
      create: { width: 7000, height: 6000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(imageResponse(bytes));
    await expect(createImageLoader(fetchImage)([attachment], signal())).rejects.toThrow(
      'image_unavailable',
    );
  });

  it('normalizes a download failure and preserves caller cancellation', async () => {
    const fetchImage = vi.fn<typeof fetch>().mockRejectedValue(new Error(attachment.url));
    await expect(createImageLoader(fetchImage)([attachment], signal())).rejects.toThrow(
      'image_unavailable',
    );
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    fetchImage.mockClear();
    await expect(createImageLoader(fetchImage)([attachment], controller.signal)).rejects.toThrow(
      'shutdown',
    );
    expect(fetchImage).not.toHaveBeenCalled();
  });
});
