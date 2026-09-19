import { z } from 'zod';
import { createInstagramPageFetcher, createMediaTransfer, validateMediaUrl } from './media-http.js';
import { downloadMediaPhotos, type PhotoDownloadInput } from './media-photos.js';
import { reelLimits } from './reel-limits.js';
import { ReelError, type Reel } from './reel-types.js';

const imageSchema = z.object({
  is_video: z.literal(false),
  display_url: z.string(),
});
const postSchema = z.object({
  shortcode: z.string(),
  is_video: z.literal(false),
  display_url: z.string(),
  edge_sidecar_to_children: z
    .object({
      edges: z
        .array(z.object({ node: imageSchema }))
        .min(1)
        .max(100),
    })
    .optional(),
});

export const extractInstagramPhotos = (page: string, reel: Reel) => {
  try {
    if (Buffer.byteLength(page) > reelLimits.pageBytes) throw new Error('page too large');
    // Embed metadata is a JSON string inside the page's bootstrap data, never executable code.
    const encoded = /"contextJSON"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(page)?.[1];
    if (!encoded) throw new Error('missing metadata');
    const context = JSON.parse(JSON.parse(encoded));
    if (context.context?.copyright_blocked) throw new Error('unavailable post');
    const post = postSchema.parse(context.gql_data?.shortcode_media);
    if (post.shortcode !== reel.shortcode) throw new Error('wrong post');
    const photos = post.edge_sidecar_to_children?.edges.map(({ node }) => node) ?? [post];
    if (photos.length > reelLimits.maximumPhotos) throw new ReelError('too_many_photos');
    return photos.map(({ display_url }) => {
      const url = validateMediaUrl(display_url, 'instagram');
      if (!/\.(jpe?g|png|webp)$/i.test(url.pathname)) throw new Error('unsupported image');
      return [url.href];
    });
  } catch (error) {
    if (error instanceof ReelError && error.category === 'too_many_photos') throw error;
    throw new ReelError('photos_unavailable');
  }
};

export const downloadInstagramPhotos = async (
  input: PhotoDownloadInput,
  dependencies = { fetchPage: createInstagramPageFetcher(), transfer: createMediaTransfer() },
) => {
  const page = await dependencies.fetchPage(input.reel.url, input.extractionSignal);
  return downloadMediaPhotos(
    input,
    extractInstagramPhotos(page, input.reel),
    dependencies.transfer,
  );
};
