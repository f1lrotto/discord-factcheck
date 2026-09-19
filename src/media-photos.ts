import { open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createMediaTransfer } from './media-http.js';
import { reelLimits } from './reel-limits.js';
import { ReelError, type DownloadedPhotos, type Reel, type ReelStage } from './reel-types.js';

export type PhotoDownloadInput = {
  reel: Reel;
  cwd: string;
  maximumBytes: number;
  signal: AbortSignal;
  extractionSignal: AbortSignal;
  onStage?: (stage: ReelStage) => void;
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

export const downloadMediaPhotos = async (
  input: PhotoDownloadInput,
  photos: string[][],
  transfer = createMediaTransfer(),
): Promise<DownloadedPhotos> => {
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
        await transfer({
          url,
          path,
          signal,
          maximumBytes: remaining,
          platform: input.reel.platform,
          kind: 'image',
        });
        const size = (await stat(path)).size;
        if (size > remaining) throw new ReelError('too_large', { bytes: size });
        const extension = await photoExtension(path);
        files.push({
          path,
          name: `${input.reel.platform}-photo-${String(index + 1).padStart(2, '0')}.${extension}`,
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
