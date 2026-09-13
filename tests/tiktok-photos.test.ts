import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTikTokPhotos, extractTikTokPhotos, photoExtension } from '../src/tiktok-photos.js';
import { parseTikTokPosts } from '../src/tiktok-links.js';
import type { createMediaTransfer } from '../src/media-http.js';
import { ReelError } from '../src/reel-types.js';
import { reelLimits } from '../src/reel-limits.js';

const reel = parseTikTokPosts('https://www.tiktok.com/@creator/photo/123')[0]!;
const url = 'https://p16-common-sign.tiktokcdn-eu.com/photo.jpeg?signature=private';
const page = (images: unknown[] = [{ imageURL: { urlList: [url] } }], id = '123') =>
  `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      'webapp.video-detail': {
        statusCode: 0,
        itemInfo: { itemStruct: { id, imagePost: { images } } },
      },
    },
  })}</script>`;
const jpeg = Buffer.from('ffd8ffe000104a464946000101', 'hex');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const setup = async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tiktok-photo-test-'));
  roots.push(cwd);
  const signal = AbortSignal.timeout(2000);
  const fetchPage = vi.fn(async () => page());
  const transfer = vi.fn<ReturnType<typeof createMediaTransfer>>(async ({ path }) => {
    await writeFile(path, jpeg);
    return jpeg.length;
  });
  const input = { reel, cwd, maximumBytes: 1000, signal, extractionSignal: signal };
  return { input, fetchPage, transfer };
};

describe('TikTok original photo extraction', () => {
  it('keeps all 18 images in order and restricts CDN alternatives', () => {
    const images = Array.from({ length: 18 }, (_, i) => ({
      imageURL: { urlList: [`${url}&i=${i}`, 'https://evil.test/a.jpg'] },
    }));
    expect(extractTikTokPhotos(page(images), reel)).toEqual(
      images.map(({ imageURL }) => [imageURL.urlList[0]]),
    );
  });
  it.each(['missing', 'malformed', 'wrong_id', 'empty', 'foreign', 'heic', 'huge'])(
    'rejects %s data',
    (kind) => {
      const raw =
        kind === 'missing'
          ? '<html></html>'
          : kind === 'malformed'
            ? '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">broken</script>'
            : kind === 'wrong_id'
              ? page(undefined, '999')
              : kind === 'empty'
                ? page([])
                : kind === 'huge'
                  ? 'x'.repeat(reelLimits.pageBytes + 1)
                  : page([
                      {
                        imageURL: {
                          urlList: [
                            kind === 'foreign'
                              ? 'https://evil.test/x.jpg'
                              : url.replace('.jpeg', '.heic'),
                          ],
                        },
                      },
                    ]);
      expect(() => extractTikTokPhotos(raw, reel)).toThrow('photos_unavailable');
    },
  );
  it('rejects oversized albums without silently dropping photos', () => {
    expect(() =>
      extractTikTokPhotos(
        page(Array.from({ length: 36 }, () => ({ imageURL: { urlList: [url] } }))),
        reel,
      ),
    ).toThrow('too_many_photos');
  });
  it('downloads originals in order under one aggregate byte cap', async () => {
    const s = await setup();
    s.fetchPage.mockResolvedValue(
      page(Array.from({ length: 18 }, (_, i) => ({ imageURL: { urlList: [`${url}&i=${i}`] } }))),
    );
    const result = await downloadTikTokPhotos(s.input, s);
    expect(result).toMatchObject({ kind: 'photos', bytes: 18 * jpeg.length, url: reel.url });
    expect(result.files.map(({ name }) => name)).toEqual(
      Array.from({ length: 18 }, (_, i) => `tiktok-photo-${String(i + 1).padStart(2, '0')}.jpg`),
    );
    expect(s.transfer.mock.calls.map(([call]) => call.maximumBytes)).toEqual(
      Array.from({ length: 18 }, (_, i) => 1000 - i * jpeg.length),
    );
    expect(s.transfer.mock.calls[0]![0]).toMatchObject({ kind: 'image', platform: 'tiktok' });
  });
  it('tries a bounded alternative when an image is inaccessible', async () => {
    const s = await setup();
    s.fetchPage.mockResolvedValue(page([{ imageURL: { urlList: [url, `${url}&alternative`] } }]));
    s.transfer.mockRejectedValueOnce(new ReelError('unavailable'));
    expect((await downloadTikTokPhotos(s.input, s)).files).toHaveLength(1);
    expect(s.transfer).toHaveBeenCalledTimes(2);
  });
  it.each(['invalid_image', 'oversized', 'rate_limited', 'cancelled'])(
    'cleans partial files on %s',
    async (kind) => {
      const s = await setup();
      s.transfer.mockImplementation(async ({ path }) => {
        await writeFile(path, kind === 'oversized' ? Buffer.alloc(1001) : 'not an image');
        if (kind === 'rate_limited') throw new ReelError('rate_limited');
        return 12;
      });
      if (kind === 'cancelled') s.input.signal = AbortSignal.abort();
      await expect(downloadTikTokPhotos(s.input, s)).rejects.toThrow();
      expect(await readdir(s.input.cwd)).toEqual([]);
    },
  );
  it('reports album bytes when a later image exceeds the remaining budget', async () => {
    const s = await setup();
    s.fetchPage.mockResolvedValue(
      page([{ imageURL: { urlList: [url] } }, { imageURL: { urlList: [url] } }]),
    );
    // First transfer needs to write its original image before the second size failure.
    s.transfer
      .mockReset()
      .mockImplementationOnce(async ({ path }) => {
        await writeFile(path, jpeg);
        return jpeg.length;
      })
      .mockRejectedValueOnce(new ReelError('too_large', { bytes: 1000, atLeast: true }));
    await expect(downloadTikTokPhotos(s.input, s)).rejects.toMatchObject({
      category: 'too_large',
      size: { bytes: 1000 + jpeg.length, atLeast: true },
    });
  });
  it.each([
    ['png', '89504e470d0a1a0a00000000'],
    ['webp', '524946460000000057454250'],
  ])('recognizes original %s signatures', async (extension, hex) => {
    const s = await setup();
    const path = join(s.input.cwd, 'image');
    await writeFile(path, Buffer.from(hex!, 'hex'));
    expect(await photoExtension(path)).toBe(extension);
  });
});
