import { downloadInstagramPhotos } from '../src/instagram-photos.js';
import { downloadTikTokPhotos } from '../src/tiktok-photos.js';
import { mkdtemp, writeFile, readdir, mkdir, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReelDownloader, inspectReel, selectReelFormats } from '../src/reel-downloader.js';
import type { runMediaProcess } from '../src/media-process.js';
import type { createMediaTransfer } from '../src/media-http.js';
import { parseTikTokPosts } from '../src/tiktok-links.js';
import { ReelError } from '../src/reel-types.js';
import { reelLimits, ytDlpVersion } from '../src/reel-limits.js';
const url = 'https://video.cdninstagram.com/video.mp4?secret=token';
const format = { url, ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a', height: 720 };
const metadata = (formats: unknown[] = [format], duration = 10) =>
  JSON.stringify({ formats, duration });
const probe = (
  streams: unknown[] = [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  duration = '10',
  format_name = 'mov,mp4,m4a,3gp,3g2,mj2',
) => JSON.stringify({ streams, format: { format_name, duration } });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'reel-test-'));
  roots.push(root);
  const run = vi.fn<typeof runMediaProcess>(async ({ args }) =>
    args.includes('--version')
      ? ytDlpVersion
      : args.includes('-version')
        ? 'ffprobe version 8'
        : args.includes('-encoders')
          ? 'V..... libx264\n A..... aac'
          : args.includes('--dump-single-json')
            ? metadata()
            : probe(),
  );
  const transfer = vi.fn<ReturnType<typeof createMediaTransfer>>(async ({ path }) => {
    await writeFile(path, 'video');
    return 5;
  });
  const resolveTikTok = vi.fn(async (url: string) => parseTikTokPosts(url)[0]!);
  const downloadPhotos = vi.fn(downloadTikTokPhotos);
  const instagramPhotos = vi.fn(downloadInstagramPhotos);
  const downloader = createReelDownloader(
    { ytDlpPath: '/yt-dlp', ffprobePath: '/ffprobe', ffmpegPath: '/ffmpeg', scratchRoot: root },
    { run, transfer, resolveTikTok, downloadPhotos, downloadInstagramPhotos: instagramPhotos },
  );
  const job = {
    reel: {
      platform: 'instagram' as const,
      shortcode: 'id',
      url: 'https://www.instagram.com/reel/id/',
    },
    signal: new AbortController().signal,
    maximumBytes: 100,
  };
  return { root, run, transfer, downloader, job, resolveTikTok, downloadPhotos, instagramPhotos };
};
describe('format selection and inspection', () => {
  it('selects best progressive compatible candidate under the hard known size cap', () => {
    expect(
      selectReelFormats(metadata([{ ...format, height: 1080, filesize: 101 }, format]), 100, 100),
    ).toEqual([{ url, requireAudio: true }]);
    expect(selectReelFormats(metadata([{ ...format, filesize_approx: 9999 }]), 100)[0]?.url).toBe(
      url,
    );
    expect(
      selectReelFormats(metadata([{ ...format, vcodec: null, acodec: null }]), 100)[0]
        ?.requireAudio,
    ).toBe(false);
  });
  it.each([
    [{ ...format, protocol: 'm3u8_native' }],
    [{ ...format, vcodec: 'vp9' }],
    [{ ...format, acodec: 'opus' }],
    [{ ...format, url: 'https://evil.test/a' }],
    [{ ...format, vcodec: 'none' }],
    [
      { ...format, acodec: 'none' },
      { ...format, vcodec: 'none' },
    ],
  ])('rejects unsupported candidates %j', (...formats) =>
    expect(() => selectReelFormats(metadata(formats), 100)).toThrow('unsupported_media'),
  );
  it('rejects invalid metadata, long and oversized media', () => {
    expect(() => selectReelFormats('invalid', 100)).toThrow('extractor_failed');
    expect(() => selectReelFormats(metadata([format], 181), 100)).toThrow('unsupported_media');
    expect(() => selectReelFormats(metadata([{ ...format, filesize: 101 }]), 100, 100)).toThrow(
      'too_large',
    );
  });
  it('reports the smallest compatible file when every format exceeds the limit', () => {
    expect(() =>
      selectReelFormats(
        metadata([
          { ...format, filesize: 150 },
          { ...format, filesize: 101 },
        ]),
        100,
        100,
      ),
    ).toThrowError(
      expect.objectContaining({ category: 'too_large', size: { bytes: 101, downloadLimit: 100 } }),
    );
  });
  it('accepts sound and silent clips, rejects invalid properties', () => {
    expect(inspectReel(probe(), true)).toEqual({ duration: 10, hasAudio: true });
    const silent = [{ codec_type: 'video', codec_name: 'h264' }];
    expect(inspectReel(probe(silent), false).hasAudio).toBe(false);
    for (const raw of [
      'broken',
      probe([], '10'),
      probe(silent, '181'),
      probe(silent, 'NaN'),
      probe(silent, '0'),
      probe(silent, '10', 'matroska'),
      probe([{ codec_type: 'video', codec_name: 'hevc' }]),
      probe([...silent, { codec_type: 'audio', codec_name: 'opus' }]),
    ])
      expect(() => inspectReel(raw, false)).toThrow('unsupported_media');
    expect(() => inspectReel(probe(silent), true)).toThrow('unsupported_media');
  });
  it('prioritizes native files, then unknown sizes, then the smallest compression sources', () => {
    const options = [
      { ...format, url: `${url}&large`, filesize: 400, height: 1080 },
      { ...format, url: `${url}&small`, filesize: 200 },
      { ...format, url: `${url}&unknown`, height: 1080 },
      { ...format, url: `${url}&native`, filesize: 90, height: 480 },
      { ...format, url: `${url}&native`, filesize: 90, height: 480 },
    ];
    expect(selectReelFormats(metadata(options), 100).map(({ url }) => url)).toEqual([
      `${url}&native`,
      `${url}&unknown`,
      `${url}&small`,
    ]);
  });
});
describe('owned temporary media lifetime', () => {
  it('validates binaries, cleans only stale owned directories, and encloses upload cleanup', async () => {
    const { root, downloader, run, job } = await setup();
    await mkdir(join(root, 'reel-stale'));
    await utimes(join(root, 'reel-stale'), new Date(0), new Date(0));
    await mkdir(join(root, 'unrelated'));
    await mkdir(join(root, 'reel-fresh'));
    await downloader.initialize();
    expect(await readdir(root)).toEqual(['reel-fresh', 'unrelated']);
    await expect(
      downloader.withDownloadedReel(job, async (media) => {
        expect(media).toMatchObject({ bytes: 5, duration: 10, hasAudio: true, url: job.reel.url });
        throw new Error('upload failure');
      }),
    ).rejects.toThrow('upload failure');
    expect(await readdir(root)).toEqual(['reel-fresh', 'unrelated']);
    expect(run.mock.calls.at(-1)?.[0].args).toContain('file');
    expect(run.mock.calls.at(-1)?.[0].args).toContain('-protocol_whitelist');
    expect(
      run.mock.calls.find(([call]) => call.args.includes('--dump-single-json'))?.[0].args,
    ).toContain('^Instagram$');
  });
  it.each(['wrong_version', 'missing_probe', 'spawn'])(
    'rejects broken startup: %s',
    async (failure) => {
      const { root, downloader, run } = await setup();
      if (failure === 'spawn') run.mockRejectedValue(new ReelError('extractor_failed'));
      else if (failure === 'wrong_version') run.mockResolvedValue('old');
      else
        run.mockImplementation(async ({ args }) =>
          args.includes('--version') ? ytDlpVersion : 'bad',
        );
      await expect(downloader.initialize()).rejects.toThrow('Reel reposting');
      expect(await readdir(root)).toEqual([]);
    },
  );
  it.each(['extract', 'transfer', 'probe', 'size', 'empty', 'cancel'])(
    'cleans after %s failure',
    async (failure) => {
      const { root, downloader, run, transfer, job } = await setup();
      await downloader.initialize();
      if (failure === 'extract') run.mockResolvedValue('invalid json');
      if (failure === 'transfer') transfer.mockRejectedValue(new Error('disk failed'));
      if (failure === 'probe')
        run.mockImplementation(async ({ args }) =>
          args.includes('--dump-single-json') ? metadata() : 'broken',
        );
      if (failure === 'size' || failure === 'empty')
        transfer.mockImplementation(async ({ path }) => {
          await writeFile(path, 'x'.repeat(failure === 'size' ? 101 : 0));
          return 0;
        });
      if (failure === 'cancel') {
        job.signal = AbortSignal.abort();
        transfer.mockRejectedValue(new Error('aborted'));
      }
      await expect(downloader.withDownloadedReel(job, async () => undefined)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    },
  );
  it('returns consumer result and supports silent metadata', async () => {
    const { downloader, run, job } = await setup();
    await downloader.initialize();
    run.mockImplementation(async ({ args }) =>
      args.includes('--dump-single-json')
        ? metadata([{ ...format, acodec: 'none' }])
        : probe([{ codec_type: 'video', codec_name: 'h264' }]),
    );
    expect(await downloader.withDownloadedReel(job, async () => 42)).toBe(42);
  });
  it('requires both compression encoders at startup', async () => {
    const { downloader, run, root } = await setup();
    const original = run.getMockImplementation()!;
    run.mockImplementation((input) =>
      input.args.includes('-encoders') ? Promise.resolve('aac') : original(input),
    );
    await expect(downloader.initialize()).rejects.toThrow('libx264');
    expect(await readdir(root)).toEqual([]);
  });
  it('tries a smaller source after discovering a large file and avoids compression if it fits', async () => {
    const { downloader, run, transfer, root, job } = await setup();
    await downloader.initialize();
    const original = run.getMockImplementation()!;
    run.mockImplementation((input) =>
      input.args.includes('--dump-single-json')
        ? Promise.resolve(metadata([format, { ...format, url: `${url}&small`, height: 480 }]))
        : original(input),
    );
    transfer.mockImplementation(async ({ path, url: sourceUrl, maximumBytes }) => {
      expect(maximumBytes).toBe(reelLimits.sourceBytes);
      await writeFile(path, Buffer.alloc(sourceUrl === url ? 200 : 50));
      return 0;
    });
    const consume = vi.fn(async (media) => {
      expect(media.bytes).toBe(50);
      expect(await readdir(join(media.path, '..'))).toEqual(['source-1.mp4']);
    });
    await downloader.withDownloadedReel(job, consume);
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([call]) => call.args.includes('-pass'))).toBe(false);
    expect(consume).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });
  it('bounds size retries and reports the download cap when no source can be retained', async () => {
    const { downloader, run, transfer, root, job } = await setup();
    await downloader.initialize();
    run.mockResolvedValue(
      metadata(Array.from({ length: 8 }, (_, index) => ({ ...format, url: `${url}&${index}` }))),
    );
    transfer.mockImplementation(async ({ path }) => {
      await writeFile(path, 'partial');
      throw new ReelError('too_large', { bytes: reelLimits.sourceBytes + 1, atLeast: true });
    });
    const consume = vi.fn();
    await expect(downloader.withDownloadedReel(job, consume)).rejects.toMatchObject({
      category: 'too_large',
      size: { downloadLimit: reelLimits.sourceBytes, atLeast: true },
    });
    expect(transfer).toHaveBeenCalledTimes(3);
    expect(consume).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
  it.each([
    'valid',
    'silent',
    'retry_success',
    'oversized',
    'empty',
    'truncated',
    'lost_audio',
    'encoder_failed',
    'cancelled',
  ])('verifies compression output and cleanup: %s', async (mode) => {
    const { downloader, run, transfer, root, job } = await setup();
    await downloader.initialize();
    job.maximumBytes = 1024 * 1024;
    const controller = new AbortController();
    job.signal = controller.signal;
    const hasAudio = mode !== 'silent';
    const streams = [
      { codec_type: 'video', codec_name: 'h264' },
      ...(hasAudio ? [{ codec_type: 'audio', codec_name: 'aac' }] : []),
    ];
    let outputs = 0;
    transfer.mockImplementation(async ({ path }) => {
      await writeFile(path, Buffer.alloc(2 * job.maximumBytes));
      return 2 * job.maximumBytes;
    });
    run.mockImplementation(async ({ executable, args, signal }) => {
      if (args.includes('--dump-single-json'))
        return metadata([
          { ...format, acodec: hasAudio ? 'aac' : 'none', filesize: 2 * job.maximumBytes },
        ]);
      if (executable === '/ffmpeg') {
        if (mode === 'encoder_failed') throw new ReelError('extractor_failed');
        if (mode === 'cancelled') {
          controller.abort();
          expect(signal.aborted).toBe(true);
          throw new ReelError('cancelled');
        }
        if (args.at(-1)?.endsWith('compressed.mp4')) {
          outputs++;
          await writeFile(
            args.at(-1)!,
            Buffer.alloc(
              mode === 'oversized' || (mode === 'retry_success' && outputs === 1)
                ? job.maximumBytes + 1
                : mode === 'empty'
                  ? 0
                  : 100,
            ),
          );
        }
        return '';
      }
      const output = args.at(-1)?.endsWith('compressed.mp4');
      return probe(
        output && mode === 'lost_audio' ? streams.slice(0, 1) : streams,
        output && mode === 'truncated' ? '5' : '10',
      );
    });
    const consume = vi.fn(async () => 'sent');
    const onStage = vi.fn();
    const task = downloader.withDownloadedReel({ ...job, onStage }, consume);
    if (mode === 'valid' || mode === 'silent' || mode === 'retry_success') {
      expect(await task).toBe('sent');
      expect(consume).toHaveBeenCalledWith(
        expect.objectContaining({ bytes: 100, duration: 10, hasAudio }),
      );
      expect(run.mock.calls.filter(([call]) => call.args.includes('-pass'))).toHaveLength(
        mode === 'retry_success' ? 4 : 2,
      );
    } else {
      await expect(task).rejects.toThrow();
      expect(consume).not.toHaveBeenCalled();
    }
    expect(onStage).toHaveBeenCalledWith('compression');
    expect(await readdir(root)).toEqual([]);
  });
  it('compresses a retained source when a smaller alternative is unavailable', async () => {
    const { downloader, run, transfer, root, job } = await setup();
    await downloader.initialize();
    job.maximumBytes = 1024 * 1024;
    transfer.mockImplementation(async ({ path, url: sourceUrl }) => {
      if (sourceUrl !== url) throw new ReelError('unavailable');
      await writeFile(path, Buffer.alloc(2 * job.maximumBytes));
      return 2 * job.maximumBytes;
    });
    run.mockImplementation(async ({ executable, args }) => {
      if (args.includes('--dump-single-json'))
        return metadata([format, { ...format, height: 480, url: `${url}&smaller` }]);
      if (executable === '/ffmpeg') {
        if (args.at(-1)?.endsWith('compressed.mp4')) await writeFile(args.at(-1)!, 'compressed');
        return '';
      }
      return probe();
    });
    expect(await downloader.withDownloadedReel(job, async (media) => media.bytes)).toBe(10);
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toEqual([]);
  });
  it('shares one compression deadline across passes and cleans up on timeout', async () => {
    const { downloader, run, transfer, root, job } = await setup();
    await downloader.initialize();
    job.maximumBytes = 1024 * 1024;
    transfer.mockImplementation(async ({ path }) => {
      await writeFile(path, Buffer.alloc(2 * job.maximumBytes));
      return 2 * job.maximumBytes;
    });
    run.mockImplementation(async ({ executable, args, signal }) => {
      if (args.includes('--dump-single-json')) return metadata();
      if (executable === '/ffmpeg') {
        if (args.at(-1) === '/dev/null') return '';
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new ReelError('timeout')), { once: true }),
        );
      }
      return probe();
    });
    const timeout = AbortSignal.timeout;
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => timeout(ms === reelLimits.compressionMs ? 50 : ms));
    try {
      const consume = vi.fn();
      const task = downloader.withDownloadedReel(job, consume);
      await expect(task).rejects.toMatchObject({ category: 'timeout' });
      const passes = run.mock.calls.filter(([call]) => call.args.includes('-pass'));
      expect(passes).toHaveLength(2);
      expect(passes[0]?.[0].signal).toBe(passes[1]?.[0].signal);
      expect(consume).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe('TikTok through the shared downloader', () => {
  const video = parseTikTokPosts('https://www.tiktok.com/@creator/video/123456789')[0]!;
  const cdn = 'https://v16.tiktokcdn.com/video.mp4?signature=private';
  it.each(['direct', 'share'])(
    'downloads a %s link with restricted extraction and a canonical source',
    async (kind) => {
      const s = await setup();
      await s.downloader.initialize();
      s.resolveTikTok.mockResolvedValue(video);
      s.run.mockImplementation(async ({ args }) =>
        args.includes('--dump-single-json')
          ? JSON.stringify({
              id: '123456789',
              uploader: 'creator',
              formats: [{ ...format, url: cdn }],
              duration: 10,
            })
          : probe(),
      );
      const reel = kind === 'direct' ? video : parseTikTokPosts('https://vm.tiktok.com/ABC/')[0]!;
      await s.downloader.withDownloadedReel({ ...s.job, reel }, async (media) => {
        expect(media).toMatchObject({ url: video.url, hasAudio: true, bytes: 5 });
      });
      expect(s.resolveTikTok).toHaveBeenCalledWith(reel.url, expect.any(AbortSignal));
      const extraction = s.run.mock.calls.find(([call]) =>
        call.args.includes('--dump-single-json'),
      )![0];
      expect(extraction.args).toEqual(
        expect.arrayContaining(['--use-extractors', '^TikTok$', video.url]),
      );
      expect(s.transfer).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'tiktok', url: cdn }),
      );
      expect(await readdir(s.root)).toEqual([]);
    },
  );
  it.each(['wrong_id', 'missing_id', 'invalid_url', 'foreign_cdn'])(
    'fails closed for %s and cleans up',
    async (kind) => {
      const s = await setup();
      await s.downloader.initialize();
      s.run.mockResolvedValue(
        JSON.stringify({
          id: kind === 'missing_id' ? undefined : kind === 'wrong_id' ? '987' : '123456789',
          formats: [{ ...format, url: kind === 'foreign_cdn' ? url : cdn }],
        }),
      );
      await expect(
        s.downloader.withDownloadedReel(
          {
            ...s.job,
            reel: kind === 'invalid_url' ? { ...video, url: 'https://evil.test' } : video,
          },
          async () => undefined,
        ),
      ).rejects.toThrow();
      expect(s.transfer).not.toHaveBeenCalled();
      expect(await readdir(s.root)).toEqual([]);
    },
  );
});

describe('photo jobs in the shared media lifetime', () => {
  it.each(['success', 'consumer_failure', 'download_failure'])(
    'owns photo cleanup through %s',
    async (kind) => {
      const s = await setup();
      await s.downloader.initialize();
      const photo = parseTikTokPosts('https://www.tiktok.com/@creator/photo/123')[0]!;
      s.resolveTikTok.mockResolvedValue(photo);
      s.downloadPhotos.mockImplementation(async ({ cwd }) => {
        const path = join(cwd, 'original');
        await writeFile(path, 'photo');
        if (kind === 'download_failure') throw new ReelError('photos_unavailable');
        return { kind: 'photos', url: photo.url, bytes: 5, files: [{ path, name: 'photo.jpg' }] };
      });
      const consume = vi.fn(async () => {
        if (kind === 'consumer_failure') throw new Error('upload');
        return 42;
      });
      const task = s.downloader.withDownloadedReel({ ...s.job, reel: photo }, consume);
      if (kind === 'success') expect(await task).toBe(42);
      else await expect(task).rejects.toThrow();
      expect(await readdir(s.root)).toEqual([]);
      expect(s.run.mock.calls.some(([call]) => call.args.includes('--dump-single-json'))).toBe(
        false,
      );
    },
  );
  it('carries only validated guest-session data into a TikTok media request', () => {
    const formatData = {
      ...format,
      url: 'https://new-cdn.tiktok.com/video.mp4',
      cookies:
        'tt_chain_token="guest=="; Domain=.tiktok.com; Path=/; Secure; sid_tt=account; Domain=.tiktok.com; Path=/',
      http_headers: {
        'User-Agent': 'extractor-agent',
        Authorization: 'forbidden',
        Cookie: 'unscoped=forbidden',
      },
    };
    const selected = selectReelFormats(
      metadata([formatData]),
      100,
      1000,
      'tiktok',
      'https://www.tiktok.com/@creator/video/123',
    )[0]!;
    expect(selected.request).toEqual({
      userAgent: 'extractor-agent',
      referer: 'https://www.tiktok.com/@creator/video/123',
      cookie: 'tt_chain_token=guest==',
    });
  });
});

describe('Instagram carousels through the shared downloader', () => {
  it.each(['success', 'consumer_failure', 'download_failure'])(
    'routes /p/ to photos and owns temporary files through %s',
    async (mode) => {
      const s = await setup();
      await s.downloader.initialize();
      const reel = {
        platform: 'instagram' as const,
        shortcode: 'carousel',
        url: 'https://www.instagram.com/p/carousel/',
      };
      s.instagramPhotos.mockImplementation(async ({ cwd }) => {
        const path = join(cwd, 'original');
        await writeFile(path, 'photo');
        if (mode === 'download_failure') throw new ReelError('photos_unavailable');
        return {
          kind: 'photos',
          bytes: 5,
          files: [{ path, name: 'instagram-photo-01.jpg' }],
          url: reel.url,
        };
      });
      const consume = vi.fn(async () => {
        if (mode === 'consumer_failure') throw new Error('upload');
        return 'sent';
      });
      const result = s.downloader.withDownloadedReel({ ...s.job, reel }, consume);
      if (mode === 'success') expect(await result).toBe('sent');
      else await expect(result).rejects.toThrow();
      expect(s.instagramPhotos).toHaveBeenCalledOnce();
      expect(s.downloadPhotos).not.toHaveBeenCalled();
      expect(s.run.mock.calls.some(([call]) => call.args.includes('--dump-single-json'))).toBe(
        false,
      );
      expect(await readdir(s.root)).toEqual([]);
    },
  );
});
