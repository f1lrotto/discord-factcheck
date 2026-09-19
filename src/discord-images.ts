import type { Attachment } from 'discord.js';
import sharp from 'sharp';
import { imageLimits } from './image-limits.js';

export type ImageAttachment = {
  url: string;
  size: number;
  source: 'latest_message' | 'replied_message';
};

export type PromptImage = Pick<ImageAttachment, 'source'> & { dataUrl: string };

export class ImageInputError extends Error {
  constructor(readonly reason: 'image_limit' | 'image_too_large' | 'image_unavailable') {
    super(reason);
  }
}

export const collectImageAttachments = (
  attachments: Iterable<Pick<Attachment, 'url' | 'size' | 'contentType' | 'name'>>,
  source: ImageAttachment['source'],
) =>
  [...attachments]
    .filter(
      (attachment) =>
        attachment.contentType?.startsWith('image/') ||
        /\.(?:jpe?g|png|webp|gif|heic|heif|avif)$/iu.test(attachment.name),
    )
    .map(({ url, size }) => ({ url, size, source }));

const attachmentUrl = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
    !url.pathname.startsWith('/attachments/') ||
    url.username ||
    url.password ||
    url.port
  )
    throw new ImageInputError('image_unavailable');
  return url;
};

export const validateImageAttachments = (images: readonly ImageAttachment[]) => {
  if (images.length > imageLimits.count) throw new ImageInputError('image_limit');
  for (const image of images) {
    if (
      !Number.isSafeInteger(image.size) ||
      image.size <= 0 ||
      image.size > imageLimits.sourceBytes
    )
      throw new ImageInputError('image_too_large');
  }
};

export const createImageLoader =
  (fetchImage: typeof fetch = fetch) =>
  async (images: readonly ImageAttachment[], signal: AbortSignal) => {
    validateImageAttachments(images);
    if (!images.length) return [];
    const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(imageLimits.timeoutMs)]);
    const loaded: PromptImage[] = [];
    try {
      // Sequential decoding bounds peak memory, even when several photos are attached.
      for (const image of images) {
        downloadSignal.throwIfAborted();
        const response = await fetchImage(attachmentUrl(image.url), {
          signal: downloadSignal,
          redirect: 'error',
          headers: { 'Accept-Encoding': 'identity' },
        });
        if (
          !response.ok ||
          !response.body ||
          Number(response.headers.get('content-length')) > imageLimits.sourceBytes
        ) {
          await response.body?.cancel();
          throw new ImageInputError('image_unavailable');
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > imageLimits.sourceBytes) throw new ImageInputError('image_too_large');
          chunks.push(chunk);
        }
        downloadSignal.throwIfAborted();
        const decoder = sharp(Buffer.concat(chunks), {
          limitInputPixels: imageLimits.decodedPixels,
          animated: false,
        });
        const metadata = await decoder.metadata();
        if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format))
          throw new ImageInputError('image_unavailable');
        const normalized = await decoder
          .rotate()
          .resize(imageLimits.dimension, imageLimits.dimension, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 85 })
          .timeout({ seconds: imageLimits.timeoutMs / 1000 })
          .toBuffer();
        downloadSignal.throwIfAborted();
        if (normalized.length > imageLimits.outputBytes)
          throw new ImageInputError('image_too_large');
        loaded.push({
          source: image.source,
          dataUrl: `data:image/jpeg;base64,${normalized.toString('base64')}`,
        });
      }
      return loaded;
    } catch (error) {
      signal.throwIfAborted();
      throw error instanceof ImageInputError ? error : new ImageInputError('image_unavailable');
    }
  };
