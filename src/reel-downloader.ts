import { mkdir, mkdtemp, readdir, lstat, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createMediaTransfer, createTikTokResolver, validateMediaUrl } from './media-http.js';
import { tikTokGuestCookies } from './tiktok-request.js';
import { downloadTikTokPhotos } from './tiktok-photos.js';
import { downloadInstagramPhotos } from './instagram-photos.js';
import { runMediaProcess } from './media-process.js';
import { parseTikTokPosts } from './tiktok-links.js';
import { parseInstagramReels } from './instagram-links.js';
import { compressReel } from './media-compression.js';
import { reelLimits, ytDlpVersion } from './reel-limits.js';
import { ReelError, type ReelDownloader, type ReelPlatform } from './reel-types.js';

const formatSchema = z.object({
  url: z.string(),
  ext: z.string().optional(),
  protocol: z.string().optional(),
  vcodec: z.string().nullish(),
  acodec: z.string().nullish(),
  filesize: z.number().nonnegative().nullish(),
  filesize_approx: z.number().nonnegative().nullish(),
  height: z.number().nullish(),
  cookies: z.string().max(16_384).optional(),
  http_headers: z
    .object({
      'User-Agent': z
        .string()
        .max(512)
        .regex(/^[\x20-\x7e]+$/)
        .optional(),
    })
    .optional(),
});
const metadataSchema = z.object({
  duration: z.number().nullish(),
  formats: z.array(formatSchema).max(1000),
});
export const selectReelFormats = (
  raw: string,
  maximumBytes: number,
  sourceBytes: number = reelLimits.sourceBytes,
  platform: ReelPlatform = 'instagram',
  sourceUrl = 'https://www.tiktok.com/',
) => {
  let metadata: z.infer<typeof metadataSchema>;
  try {
    metadata = metadataSchema.parse(JSON.parse(raw));
  } catch {
    throw new ReelError('extractor_failed');
  }
  if (metadata.duration && metadata.duration > reelLimits.maximumDuration)
    throw new ReelError('unsupported_media');
  const candidates = metadata.formats.filter((format) => {
    try {
      validateMediaUrl(format.url, platform);
    } catch {
      return false;
    }
    return (
      format.ext === 'mp4' &&
      (!format.protocol || format.protocol === 'https') &&
      format.vcodec !== 'none' &&
      (!format.vcodec || /^(h264|avc1)/.test(format.vcodec)) &&
      (!format.acodec || format.acodec === 'none' || /^(aac|mp4a)/.test(format.acodec))
    );
  });
  // Never choose a video-only alternative when the source advertises audio.
  const hasAudio = metadata.formats.some((format) => format.acodec && format.acodec !== 'none');
  const progressive = candidates.filter((format) => !hasAudio || format.acodec !== 'none');
  const eligible = progressive.filter(
    (format) => !format.filesize || format.filesize <= sourceBytes,
  );
  if (!eligible.length) {
    if (!progressive.length) throw new ReelError('unsupported_media');
    throw new ReelError('too_large', {
      bytes: Math.min(...progressive.map((format) => format.filesize!)),
      downloadLimit: sourceBytes,
    });
  }
  const priority = (format: z.infer<typeof formatSchema>) =>
    !format.filesize ? 1 : format.filesize <= maximumBytes ? 0 : 2;
  const sorted = eligible.sort(
    (a, b) =>
      priority(a) - priority(b) ||
      (priority(a) === 2 ? a.filesize! - b.filesize! : 0) ||
      (b.height ?? 0) - (a.height ?? 0),
  );
  return [
    ...new Map(
      sorted.map((format) => [
        format.url,
        {
          url: format.url,
          ...(platform === 'tiktok'
            ? {
                request: {
                  userAgent: format.http_headers?.['User-Agent'] ?? 'Mozilla/5.0',
                  referer: sourceUrl,
                  cookie: tikTokGuestCookies(format.cookies),
                },
              }
            : {}),
          requireAudio: hasAudio || Boolean(format.acodec && format.acodec !== 'none'),
        },
      ]),
    ).values(),
  ].slice(0, reelLimits.sourceAttempts);
};
const probeSchema = z.object({
  format: z.object({ format_name: z.string(), duration: z.string().optional() }),
  streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string().optional() })),
});
export const inspectReel = (
  raw: string,
  requireAudio: boolean,
  maximumDuration: number = reelLimits.maximumDuration,
) => {
  try {
    const probe = probeSchema.parse(JSON.parse(raw));
    const duration = Number(probe.format.duration);
    const video = probe.streams.filter((stream) => stream.codec_type === 'video');
    const audio = probe.streams.filter((stream) => stream.codec_type === 'audio');
    if (
      !probe.format.format_name.split(',').includes('mp4') ||
      video.length !== 1 ||
      video[0]?.codec_name !== 'h264' ||
      audio.some((stream) => stream.codec_name !== 'aac') ||
      (requireAudio && !audio.length) ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > maximumDuration
    )
      throw new Error('unsupported');
    return { duration, hasAudio: audio.length > 0 };
  } catch {
    throw new ReelError('unsupported_media');
  }
};
export const createReelDownloader = (
  input: {
    ytDlpPath: string;
    ffprobePath: string;
    ffmpegPath: string;
    jobMs?: number;
    scratchRoot?: string;
  },
  dependencies = {
    run: runMediaProcess,
    transfer: createMediaTransfer(),
    resolveTikTok: createTikTokResolver(),
    downloadPhotos: downloadTikTokPhotos,
    downloadInstagramPhotos,
  },
) => {
  const root = input.scratchRoot ?? join(tmpdir(), 'jolanda-instagram-media');
  const initialize = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^reel-[A-Za-z0-9]+$/.test(entry.name)) continue;
      const path = join(root, entry.name);
      if (Date.now() - (await lstat(path)).mtimeMs > reelLimits.staleMs)
        await rm(path, { recursive: true, force: true });
    }
    const cwd = await mkdtemp(join(root, 'reel-'));
    try {
      const version = await dependencies.run({
        executable: input.ytDlpPath,
        args: ['--ignore-config', '--no-plugin-dirs', '--version'],
        cwd,
        signal: AbortSignal.timeout(5000),
      });
      if (version.trim() !== ytDlpVersion)
        throw new Error(`Reel reposting requires yt-dlp ${ytDlpVersion}`);
      const probe = await dependencies.run({
        executable: input.ffprobePath,
        args: ['-version'],
        cwd,
        signal: AbortSignal.timeout(5000),
      });
      if (!probe.startsWith('ffprobe version ')) throw new Error('Reel reposting requires ffprobe');
      const encoders = await dependencies.run({
        executable: input.ffmpegPath,
        args: ['-hide_banner', '-encoders'],
        cwd,
        signal: AbortSignal.timeout(5000),
      });
      if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders))
        throw new Error('Reel reposting requires ffmpeg with libx264 and AAC encoders');
    } catch (error) {
      if (error instanceof ReelError)
        throw new Error('Reel reposting binaries unavailable; check executable paths and version', {
          cause: error,
        });
      throw error;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
  const withDownloadedReel: ReelDownloader['withDownloadedReel'] = async (job, consume) => {
    const overall = AbortSignal.any([
      job.signal,
      AbortSignal.timeout(input.jobMs ?? reelLimits.jobMs),
    ]);
    const stage = (ms: number) => AbortSignal.any([overall, AbortSignal.timeout(ms)]);
    const cwd = await mkdtemp(join(root, 'reel-'));
    const inspect = async (
      path: string,
      requireAudio: boolean,
      maximumDuration: number = reelLimits.maximumDuration,
    ) => {
      job.onStage?.('inspection');
      const raw = await dependencies.run({
        executable: input.ffprobePath,
        cwd,
        signal: stage(reelLimits.probeMs),
        maximumOutput: 64 * 1024,
        args: [
          '-v',
          'error',
          '-max_alloc',
          '16777216',
          '-probesize',
          '5000000',
          '-analyzeduration',
          '5000000',
          '-protocol_whitelist',
          'file',
          '-format_whitelist',
          'mov',
          '-show_entries',
          'format=format_name,duration:stream=codec_type,codec_name',
          '-of',
          'json',
          path,
        ],
      });
      return inspectReel(raw, requireAudio, maximumDuration);
    };
    try {
      const parse = job.reel.platform === 'tiktok' ? parseTikTokPosts : parseInstagramReels;
      if (
        !parse(job.reel.url).some(
          (link) => link.url === job.reel.url && link.shortcode === job.reel.shortcode,
        )
      )
        throw new ReelError('unsupported_media');
      job.onStage?.('extraction');
      const extractionSignal = stage(reelLimits.extractionMs);
      const extractionReel =
        job.reel.platform === 'tiktok'
          ? await dependencies.resolveTikTok(job.reel.url, extractionSignal)
          : job.reel;
      const instagramPhotos =
        extractionReel.platform === 'instagram' &&
        new URL(extractionReel.url).pathname.startsWith('/p/');
      if (instagramPhotos || extractionReel.shortcode.startsWith('tiktok:photo:')) {
        const download = instagramPhotos
          ? dependencies.downloadInstagramPhotos
          : dependencies.downloadPhotos;
        const media = await download({
          reel: extractionReel,
          cwd,
          maximumBytes: job.maximumBytes,
          signal: overall,
          extractionSignal,
          ...(job.onStage ? { onStage: job.onStage } : {}),
        });
        if (overall.aborted) throw new ReelError(job.signal.aborted ? 'cancelled' : 'timeout');
        return await consume(media);
      }
      const raw = await dependencies.run({
        executable: input.ytDlpPath,
        cwd,
        signal: extractionSignal,
        args: [
          '--ignore-config',
          '--no-plugin-dirs',
          '--no-cache-dir',
          '--no-playlist',
          '--dump-single-json',
          '--use-extractors',
          job.reel.platform === 'tiktok' ? '^TikTok$' : '^Instagram$',
          '--socket-timeout',
          '10',
          '--retries',
          '0',
          '--extractor-retries',
          '0',
          '--',
          extractionReel.url,
        ],
      });
      const formats = selectReelFormats(
        raw,
        job.maximumBytes,
        reelLimits.sourceBytes,
        job.reel.platform,
        extractionReel.url,
      );
      // Only emit a canonical TikTok video URL, never arbitrary extractor metadata.
      if (job.reel.platform === 'tiktok') {
        const metadata = z
          .object({ id: z.string().regex(/^[0-9]{1,25}$/) })
          .safeParse(JSON.parse(raw));
        if (!metadata.success) throw new ReelError('extractor_failed');
        if (extractionReel.shortcode !== `tiktok:video:${metadata.data.id}`)
          throw new ReelError('unsupported_media');
      }
      job.onStage?.('download');
      const transferSignal = stage(reelLimits.downloadMs);
      let source: { path: string; bytes: number; requireAudio: boolean } | undefined;
      let sizeError = new ReelError('too_large');
      for (const [index, format] of formats.entries()) {
        const path = join(cwd, `source-${index}.mp4`);
        try {
          await dependencies.transfer({
            url: format.url,
            platform: job.reel.platform,
            ...(format.request ? { request: format.request } : {}),
            path,
            maximumBytes: reelLimits.sourceBytes,
            signal: transferSignal,
          });
          const bytes = (await stat(path)).size;
          if (!bytes) throw new ReelError('unsupported_media');
          if (bytes > reelLimits.sourceBytes) throw new ReelError('too_large', { bytes });
          if (!source || bytes < source.bytes) {
            if (source) await rm(source.path, { force: true });
            source = { path, bytes, requireAudio: format.requireAudio };
          } else await rm(path, { force: true });
          if (source.bytes <= job.maximumBytes) break;
        } catch (error) {
          await rm(path, { force: true });
          if (overall.aborted) throw new ReelError(job.signal.aborted ? 'cancelled' : 'timeout');
          if (transferSignal.aborted && source) break;
          if (transferSignal.aborted) throw new ReelError('timeout');
          if (error instanceof ReelError && error.category === 'too_large') {
            sizeError = new ReelError(
              'too_large',
              error.size
                ? {
                    ...error.size,
                    downloadLimit: reelLimits.sourceBytes,
                  }
                : undefined,
            );
            continue;
          }
          if (source) break; // A smaller alternative failed; the retained source can still be compressed.
          throw error;
        }
      }
      if (!source) throw sizeError;
      const properties = await inspect(source.path, source.requireAudio);
      let media = { path: source.path, bytes: source.bytes, ...properties };
      if (source.bytes > job.maximumBytes) {
        job.onStage?.('compression');
        const compressed = await compressReel(
          {
            ...media,
            executable: input.ffmpegPath,
            cwd,
            maximumBytes: job.maximumBytes,
            signal: stage(reelLimits.compressionMs),
          },
          dependencies.run,
        );
        // Allow minor muxing/audio padding, including for clips at the duration cap.
        const verified = await inspect(
          compressed.path,
          properties.hasAudio,
          properties.duration + 0.25,
        );
        if (
          Math.abs(verified.duration - properties.duration) > 0.25 ||
          verified.hasAudio !== properties.hasAudio
        )
          throw new ReelError('unsupported_media');
        media = { ...compressed, ...verified };
      }
      if (overall.aborted) throw new ReelError(job.signal.aborted ? 'cancelled' : 'timeout');
      return await consume({ kind: 'video', ...media, url: extractionReel.url });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
  return { initialize, withDownloadedReel };
};
