import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runMediaProcess } from './media-process.js';
import { ReelError } from './reel-types.js';

// Average bitrate targets size; two passes distribute that budget across the whole clip.
export const compressReel = async (
  input: {
    executable: string;
    path: string;
    cwd: string;
    bytes: number;
    duration: number;
    hasAudio: boolean;
    maximumBytes: number;
    signal: AbortSignal;
  },
  run = runMediaProcess,
) => {
  const audioBitrate = input.hasAudio ? 96_000 : 0;
  let videoBitrate = Math.floor((input.maximumBytes * 0.95 * 8) / input.duration - audioBitrate);
  if (videoBitrate < 64_000) throw new ReelError('too_large', { bytes: input.bytes });
  const [longEdge, shortEdge] = videoBitrate >= 1_200_000 ? [1280, 720] : [854, 480];
  const scale = `scale=w='min(iw,if(gte(iw,ih),${longEdge},${shortEdge}))':h='min(ih,if(gte(iw,ih),${shortEdge},${longEdge}))':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const path = join(input.cwd, 'compressed.mp4');
  const common = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-xerror',
    '-max_alloc',
    '67108864',
    '-threads',
    '1',
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    'mov',
    '-probesize',
    '5000000',
    '-analyzeduration',
    '5000000',
    '-i',
    input.path,
    '-map',
    '0:v:0',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-filter_threads',
    '1',
    '-vf',
    scale,
    '-fpsmax',
    '30',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-passlogfile',
    join(input.cwd, 'encoding'),
  ];
  let bytes = input.bytes;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const pass of [1, 2]) {
      const output =
        pass === 1
          ? ['-an', '-f', 'null', '/dev/null']
          : [
              ...(input.hasAudio
                ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', String(audioBitrate), '-ac', '2']
                : ['-an']),
              // A runaway output is stopped above the upload cap and will be rejected below.
              '-fs',
              String(input.maximumBytes * 2),
              '-movflags',
              '+faststart',
              path,
            ];
      await run({
        executable: input.executable,
        args: [...common, '-b:v', String(videoBitrate), '-pass', String(pass), ...output],
        cwd: input.cwd,
        signal: input.signal,
      });
    }
    bytes = (await stat(path)).size;
    if (!bytes) throw new ReelError('unsupported_media');
    if (bytes <= input.maximumBytes) return { path, bytes };
    videoBitrate = Math.floor(videoBitrate * (input.maximumBytes / bytes) * 0.85);
    if (videoBitrate < 64_000) break;
  }
  throw new ReelError('too_large', { bytes });
};
