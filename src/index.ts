import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from './config.js';
import { createReelDiscordTransport } from './discord-reel-transport.js';
import { createReelDownloader } from './reel-downloader.js';
import { createDiscordReels } from './discord-reels.js';
import { createDiscordBot } from './discord-bot.js';
import { createJolanda } from './jolanda.js';
import { createLifecycle } from './lifecycle.js';
import { createAppLogger } from './logger.js';
import { createMongoStore } from './mongo-store.js';
import { createOpenRouter } from './openrouter.js';
import { createIdentifierProtector, safeError } from './security.js';

loadDotenv({ quiet: true });

const main = async () => {
  const config = loadConfig();
  const protectIdentifier = createIdentifierProtector(config.DATA_PROTECTION_SECRET);
  const instanceId = process.env.RAILWAY_REPLICA_ID ?? randomUUID();
  const logger = createAppLogger({
    level: config.LOG_LEVEL,
    environment: config.NODE_ENV,
    instanceKey: protectIdentifier(instanceId),
    ...(process.env.RAILWAY_DEPLOYMENT_ID
      ? { deploymentId: protectIdentifier(process.env.RAILWAY_DEPLOYMENT_ID) }
      : {}),
  });
  const store = createMongoStore({
    uri: config.MONGODB_URI,
    databaseName: config.MONGODB_DB_NAME,
    dailyLimitMicrodollars: config.dailySpendLimitMicrodollars,
    monthlyLimitMicrodollars: config.monthlySpendLimitMicrodollars,
    promptsPerMinute: config.PROMPTS_PER_MINUTE,
    transcriptTtlMs: config.transcriptTtlMs,
    instanceId,
    protectIdentifier,
    logger,
  });

  await store.initialize();
  const modelRunner = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
    logger,
    ...(config.OPENROUTER_APP_URL ? { appUrl: config.OPENROUTER_APP_URL } : {}),
  });
  const jolanda = createJolanda({
    store,
    modelRunner,
    logger,
    maximumContextMessages: config.MAX_CONTEXT_MESSAGES,
    maximumPromptCharacters: config.MAX_PROMPT_CHARACTERS,
    maximumConcurrentTurns: config.MAX_CONCURRENT_TURNS,
    transcriptTtlMs: config.transcriptTtlMs,
    timeZone: config.JOLANDA_TIME_ZONE,
    protectIdentifier,
  });
  const downloader = createReelDownloader({
    ytDlpPath: config.INSTAGRAM_YT_DLP_PATH,
    ffprobePath: config.INSTAGRAM_FFPROBE_PATH,
    ffmpegPath: config.INSTAGRAM_FFMPEG_PATH,
    jobMs: config.INSTAGRAM_REELS_JOB_TIMEOUT_MS,
  });
  try {
    if (config.INSTAGRAM_REELS_ENABLED) await downloader.initialize();
  } catch (error) {
    logger.error({
      event: 'reels_startup_failed',
      outcome: 'invalid_downloader',
      message:
        'Verify INSTAGRAM_YT_DLP_PATH points to yt-dlp 2026.08.19, INSTAGRAM_FFPROBE_PATH points to ffprobe, INSTAGRAM_FFMPEG_PATH points to ffmpeg with libx264/AAC, and the media scratch directory is writable.',
    });
    await jolanda.shutdown();
    await store.close();
    throw error;
  }
  const reels = createDiscordReels({
    enabled: config.INSTAGRAM_REELS_ENABLED,
    store: store.reels,
    downloader,
    logger,
    protectIdentifier,
    maximumBytes: config.INSTAGRAM_REELS_MAX_BYTES,
    jobMs: config.INSTAGRAM_REELS_JOB_TIMEOUT_MS,
    transport: createReelDiscordTransport(config.DISCORD_TOKEN),
  });
  const discord = createDiscordBot({
    reels,
    reelStore: store.reels,
    reelsEnabled: config.INSTAGRAM_REELS_ENABLED,
    token: config.DISCORD_TOKEN,
    maximumContextMessages: config.MAX_CONTEXT_MESSAGES,
    promptsPerMinute: config.PROMPTS_PER_MINUTE,
    transcriptTtlDays: config.TRANSCRIPT_TTL_DAYS,
    protectIdentifier,
    jolanda,
    store,
    logger,
  });
  const lifecycle = createLifecycle({
    stopTurns: async () => {
      discord.stopAccepting();
      await Promise.all([jolanda.shutdown(), reels.shutdown()]);
      await discord.drain();
    },
    destroyDiscord: discord.destroy,
    closeStore: store.close,
    logger,
  });

  const onSignal = (signal: string) => {
    void lifecycle.shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ event: 'shutdown_failed', signal, error: safeError(error) });
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    await discord.start();
  } catch (error) {
    await lifecycle.shutdown('login_failure');
    throw error;
  }
};

main().catch((error: unknown) => {
  const failure = safeError(error);
  process.stderr.write(
    `Jolanda failed to start: ${failure.type}${'message' in failure ? `: ${failure.message}` : ''}\n`,
  );
  process.exitCode = 1;
});
