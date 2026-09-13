import { downloadTikTokPhotos } from '../src/tiktok-photos.js';
import { parseTikTokPosts } from '../src/tiktok-links.js';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReelDownloader } from '../src/reel-downloader.js';
import { runMediaProcess } from '../src/media-process.js';
import { ytDlpVersion } from '../src/reel-limits.js';

const binary = (name: string) =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .map((directory) => join(directory, name))
    .find(existsSync);
const ffmpegPath = process.env.INSTAGRAM_FFMPEG_PATH ?? binary('ffmpeg');
const ffprobePath = process.env.INSTAGRAM_FFPROBE_PATH ?? binary('ffprobe');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Offline integration: real codecs and generated clips; no Instagram or Discord requests.
describe.skipIf(!ffmpegPath || !ffprobePath)('real Reel compression', () => {
  it.each([
    {
      dimensions: '720x1280',
      width: 720,
      height: 1280,
      rate: 60,
      audio: true,
      maximumBytes: 192 * 1024,
      maximumEdge: 854,
    },
    {
      dimensions: '640x360',
      width: 640,
      height: 360,
      rate: 24,
      audio: false,
      maximumBytes: 192 * 1024,
      maximumEdge: 854,
    },
    {
      dimensions: '1080x1920',
      width: 1080,
      height: 1920,
      rate: 30,
      audio: true,
      maximumBytes: 1024 * 1024,
      maximumEdge: 1280,
    },
  ])(
    'fits and preserves a $dimensions clip (audio: $audio)',
    async (sample) => {
      const root = await mkdtemp(join(tmpdir(), 'reel-codecs-'));
      roots.push(root);
      const source = join(root, 'original.mp4');
      const scratchRoot = join(root, 'jobs');
      const signal = AbortSignal.timeout(55_000);
      await runMediaProcess({
        executable: ffmpegPath!,
        cwd: root,
        signal,
        args: [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          `testsrc2=size=${sample.dimensions}:rate=${sample.rate}`,
          ...(sample.audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
          '-t',
          '4',
          '-c:v',
          'libx264',
          '-threads',
          '1',
          '-preset',
          'ultrafast',
          '-qp',
          '0',
          '-pix_fmt',
          'yuv420p',
          ...(sample.audio ? ['-c:a', 'aac'] : ['-an']),
          source,
        ],
      });
      const sourceBytes = (await stat(source)).size;
      const maximumBytes = sample.maximumBytes;
      expect(sourceBytes).toBeGreaterThan(maximumBytes);
      const downloader = createReelDownloader(
        {
          ytDlpPath: '/test-extractor',
          ffmpegPath: ffmpegPath!,
          ffprobePath: ffprobePath!,
          scratchRoot,
        },
        {
          run: async (input) =>
            input.executable === '/test-extractor'
              ? input.args.includes('--version')
                ? ytDlpVersion
                : JSON.stringify({
                    duration: 4,
                    formats: [
                      {
                        url: 'https://video.cdninstagram.com/test.mp4',
                        ext: 'mp4',
                        vcodec: 'h264',
                        acodec: sample.audio ? 'aac' : 'none',
                        filesize: sourceBytes,
                      },
                    ],
                  })
              : runMediaProcess(input),
          downloadPhotos: downloadTikTokPhotos,
          resolveTikTok: async (url) => parseTikTokPosts(url)[0]!,
          transfer: async ({ path }) => {
            await copyFile(source, path);
            return sourceBytes;
          },
        },
      );
      await downloader.initialize();
      await downloader.withDownloadedReel(
        {
          reel: {
            platform: 'instagram' as const,
            shortcode: 'test',
            url: 'https://www.instagram.com/reel/test/',
          },
          signal,
          maximumBytes,
        },
        async (media) => {
          expect(media.bytes).toBeGreaterThan(0);
          expect(media.bytes).toBeLessThanOrEqual(maximumBytes);
          if (media.kind !== 'video') throw new Error('Expected video');
          expect(media.hasAudio).toBe(sample.audio);
          expect(Math.abs(media.duration - 4)).toBeLessThanOrEqual(0.25);
          const probe = JSON.parse(
            await runMediaProcess({
              executable: ffprobePath!,
              cwd: root,
              signal,
              args: ['-v', 'error', '-show_streams', '-of', 'json', media.path],
            }),
          );
          const video = probe.streams.find(
            (stream: { codec_type: string }) => stream.codec_type === 'video',
          );
          expect(video.codec_name).toBe('h264');
          expect(video.width).toBeLessThanOrEqual(sample.width);
          expect(video.height).toBeLessThanOrEqual(sample.height);
          expect(Math.max(video.width, video.height)).toBeLessThanOrEqual(sample.maximumEdge);
          expect(Math.abs(video.width / video.height - sample.width / sample.height)).toBeLessThan(
            0.005,
          );
          const [numerator, denominator] = video.avg_frame_rate.split('/').map(Number);
          expect(numerator / denominator).toBeLessThanOrEqual(Math.min(sample.rate, 30));
        },
      );
      expect(await readdir(scratchRoot)).toEqual([]);
    },
    60_000,
  );
});
