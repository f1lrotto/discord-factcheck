import { open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createMediaTransfer, createTikTokPageFetcher, validateMediaUrl } from './media-http.js';
import { reelLimits } from './reel-limits.js';
import { ReelError, type DownloadedPhotos, type Reel, type ReelStage } from './reel-types.js';

const photoSchema = z.object({
  id: z.string(),
  imagePost: z.object({
    images: z
      .array(
        z.object({
          imageURL: z.object({ urlList: z.array(z.string()).min(1).max(10) }),
        }),
      )
      .min(1)
      .max(100),
  }),
});

export const extractTikTokPhotos = (page: string, reel: Reel) => {
  try {
    if (Buffer.byteLength(page) > reelLimits.pageBytes) throw new Error('page too large');
    const json =
      /<script\b[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i.exec(
        page,
      )?.[1];
    if (!json) throw new Error('missing data');
    const raw = JSON.parse(json)?.__DEFAULT_SCOPE__?.['webapp.video-detail'];
    const post = photoSchema.parse(raw?.itemInfo?.itemStruct);
    if (raw.statusCode !== 0 || post.id !== reel.shortcode.split(':').at(-1))
      throw new Error('unavailable post');
    if (post.imagePost.images.length > reelLimits.maximumPhotos)
      throw new ReelError('too_many_photos');
    return post.imagePost.images.map(({ imageURL }) => {
      const candidates = imageURL.urlList.filter((value) => {
        try {
          return /\.(jpe?g|png|webp)$/i.test(validateMediaUrl(value, 'tiktok').pathname);
        } catch {
          return false;
        }
      });
      if (!candidates.length) throw new Error('unsupported photo');
      return candidates.slice(0, reelLimits.sourceAttempts);
    });
  } catch (error) {
    if (error instanceof ReelError) throw error;
    throw new ReelError('photos_unavailable');
  }
};

// Inspect the original file signature without decoding or re-encoding the image.
export const photoExtension = async (path: string) => {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < header.length) throw new ReelError('photos_unavailable');
    if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
    if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')
      return 'webp';
    throw new ReelError('photos_unavailable');
  } finally {
    await file.close();
  }
};

export const downloadTikTokPhotos = async (
  input: {
    reel: Reel;
    cwd: string;
    maximumBytes: number;
    signal: AbortSignal;
    extractionSignal: AbortSignal;
    onStage?: (stage: ReelStage) => void;
  },
  dependencies = { fetchPage: createTikTokPageFetcher(), transfer: createMediaTransfer() },
): Promise<DownloadedPhotos> => {
  const page = await dependencies.fetchPage(input.reel.url, input.extractionSignal);
  const photos = extractTikTokPhotos(page, input.reel);
  input.onStage?.('download');
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(reelLimits.downloadMs)]);
  const files: DownloadedPhotos['files'] = [];
  let bytes = 0;
  for (const [index, candidates] of photos.entries()) {
    const path = join(input.cwd, `photo-${index + 1}`);
    let downloaded = false;
    for (const url of candidates) {
      try {
        const remaining = input.maximumBytes - bytes;
        if (remaining <= 0) throw new ReelError('too_large', { bytes: 0, atLeast: true });
        await dependencies.transfer({
          url,
          path,
          signal,
          maximumBytes: remaining,
          platform: 'tiktok',
          kind: 'image',
        });
        const size = (await stat(path)).size;
        if (size > remaining) throw new ReelError('too_large', { bytes: size });
        const extension = await photoExtension(path);
        files.push({
          path,
          name: `tiktok-photo-${String(index + 1).padStart(2, '0')}.${extension}`,
        });
        bytes += size;
        downloaded = true;
        break;
      } catch (error) {
        await rm(path, { force: true });
        if (signal.aborted) throw new ReelError(input.signal.aborted ? 'cancelled' : 'timeout');
        if (error instanceof ReelError && error.category === 'too_large')
          throw new ReelError(
            'too_large',
            error.size ? { ...error.size, bytes: bytes + error.size.bytes } : undefined,
          );
        if (error instanceof ReelError && error.category === 'rate_limited') throw error;
      }
    }
    if (!downloaded) throw new ReelError('photos_unavailable');
  }
  return { kind: 'photos', files, bytes, url: input.reel.url };
};
