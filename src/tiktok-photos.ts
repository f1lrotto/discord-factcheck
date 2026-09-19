import { z } from 'zod';
import { createMediaTransfer, createTikTokPageFetcher, validateMediaUrl } from './media-http.js';
import { reelLimits } from './reel-limits.js';
import { ReelError, type Reel } from './reel-types.js';
import { downloadMediaPhotos, type PhotoDownloadInput } from './media-photos.js';
export { photoExtension } from './media-photos.js';

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

export const downloadTikTokPhotos = async (
  input: PhotoDownloadInput,
  dependencies = { fetchPage: createTikTokPageFetcher(), transfer: createMediaTransfer() },
) => {
  const page = await dependencies.fetchPage(input.reel.url, input.extractionSignal);
  return downloadMediaPhotos(input, extractTikTokPhotos(page, input.reel), dependencies.transfer);
};
