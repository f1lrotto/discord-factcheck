import process from 'node:process';
import { createReelDownloader } from '../dist/reel-downloader.js';
import { parseRepostLinks } from '../dist/repost-links.js';
import { reelFailure } from '../dist/reel-types.js';
import { reelLimits, ytDlpVersion } from '../dist/reel-limits.js';

const urls = process.argv.slice(2);
if (!urls.length)
  throw new Error('Pass public Reel URLs explicitly. This test contacts Instagram/Meta or TikTok.');
const downloader = createReelDownloader({
  ytDlpPath: process.env.INSTAGRAM_YT_DLP_PATH ?? '/opt/yt-dlp/bin/yt-dlp',
  ffprobePath: process.env.INSTAGRAM_FFPROBE_PATH ?? '/usr/bin/ffprobe',
  ffmpegPath: process.env.INSTAGRAM_FFMPEG_PATH ?? '/usr/bin/ffmpeg',
});
await downloader.initialize();
for (const [index, url] of urls.entries()) {
  const reel = parseRepostLinks(url)[0];
  if (!reel) throw new Error(`Invalid Reel URL at position ${index + 1}`);
  const started = Date.now();
  let stage = 'admission';
  try {
    await downloader.withDownloadedReel(
      {
        reel,
        onStage: (next) => {
          stage = next;
        },
        signal: globalThis.AbortSignal.timeout(reelLimits.jobMs),
        maximumBytes: reelLimits.maximumBytes,
      },
      async (media) => {
        process.stdout.write(
          JSON.stringify({
            sample: index + 1,
            platform: reel.platform,
            outcome: 'downloaded',
            bytes: media.bytes,
            kind: media.kind,
            ...(media.kind === 'video'
              ? { duration: media.duration, hasAudio: media.hasAudio }
              : { photos: media.files.length }),
            elapsedMs: Date.now() - started,
            downloaderVersion: ytDlpVersion,
            memory: process.memoryUsage().rss,
          }) + '\n',
        );
      },
    );
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(
      JSON.stringify({
        sample: index + 1,
        platform: reel.platform,
        outcome: reelFailure(error),
        stage,
        elapsedMs: Date.now() - started,
      }) + '\n',
    );
  }
}
