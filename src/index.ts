import { createBriefingRuntime } from './briefing/index.js';
import { createReminderRuntime } from './reminder-runtime.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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
import { createNewsRuntime } from './news/index.js';
import { createIdentifierProtector, safeError } from './security.js';

export const main = async () => {
  loadDotenv({ quiet: true });
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
    monthlyLimitMicrodollars: config.monthlySpendLimitMicrodollars,
    promptsPerMinute: config.PROMPTS_PER_MINUTE,
    transcriptTtlMs: config.transcriptTtlMs,
    instanceId,
    protectIdentifier,
    logger,
    secret: config.DATA_PROTECTION_SECRET,
    news: { secret: config.DATA_PROTECTION_SECRET },
  });

  await store.initialize();
  const modelRunner = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
    logger,
    ...(config.OPENROUTER_APP_URL ? { appUrl: config.OPENROUTER_APP_URL } : {}),
  });
  const jolanda = createJolanda({
    reminders: store.reminders!,
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
    resolveLocale: async (guildId) => (await store.getSettings(guildId)).locale,
  });
  const discord = createDiscordBot({
    briefingStore: store.briefing!,
    briefingMaximumCities: config.BRIEFING_MAX_CITIES,
    reminderStore: store.reminders!,
    timeZone: config.JOLANDA_TIME_ZONE,
    newsStore: store.news!,
    newsEnabled: config.NEWS_ENABLED,
    reels,
    reelStore: store.reels,
    reelsEnabled: config.INSTAGRAM_REELS_ENABLED,
    token: config.DISCORD_TOKEN,
    maximumContextMessages: config.MAX_CONTEXT_MESSAGES,
    promptsPerMinute: config.PROMPTS_PER_MINUTE,
    transcriptTtlDays: config.TRANSCRIPT_TTL_DAYS,
    monthlyLimitMicrodollars: config.monthlySpendLimitMicrodollars,
    protectIdentifier,
    jolanda,
    store,
    logger,
  });
  const news = createNewsRuntime({
    store: store.news!,
    publisher: discord.newsPublisher!,
    enabled: config.NEWS_ENABLED,
    logger,
  });
  const reminders = createReminderRuntime({
    store: store.reminders!,
    publisher: discord.reminderPublisher!,
    logger,
  });
  const briefing = createBriefingRuntime({
    store: store.briefing!,
    publisher: discord.briefingPublisher!,
    reminders: store.reminders!,
    locale: async (guildId) => (await store.getSettings(guildId)).locale,
    logger,
  });
  const lifecycle = createLifecycle({
    stopTurns: async () => {
      discord.stopAccepting();
      const stopped = await Promise.allSettled([
        news.shutdown(),
        reminders.shutdown(),
        briefing.shutdown(),
        jolanda.shutdown(),
        reels.shutdown(),
      ]);
      await discord.drain();
      for (const result of stopped) if (result.status === 'rejected') throw result.reason;
    },
    destroyDiscord: discord.destroy,
    closeStore: store.close,
    logger,
  });

  let stopping = false;
  const shutdown = (reason: string) => {
    stopping = true;
    return lifecycle.shutdown(reason).finally(() => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    });
  };
  const onSignal = (signal: string) => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ event: 'shutdown_failed', signal, error: safeError(error) });
        process.exit(1);
      },
    );
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    await discord.start();
    // A signal during login may already have drained and closed every dependency.
    if (!stopping) await Promise.all([news.start(), reminders.start(), briefing.start()]);
  } catch (error) {
    await shutdown('login_failure');
    throw error;
  }
  return { shutdown };
};

const isEntrypoint = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
};

if (isEntrypoint())
  main().catch((error: unknown) => {
    const failure = safeError(error);
    process.stderr.write(
      `Jolanda failed to start: ${failure.type}${'message' in failure ? `: ${failure.message}` : ''}\n`,
    );
    process.exitCode = 1;
  });
