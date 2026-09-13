import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { reelLimits } from './reel-limits.js';
import { maximumCostEnvelopeMicrodollars } from './limits.js';
import { timeZoneIsSupported } from './clock.js';

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());

const envSchema = z.object({
  INSTAGRAM_REELS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  INSTAGRAM_YT_DLP_PATH: z
    .string()
    .refine(isAbsolute, 'Expected an absolute executable path')
    .default('/opt/yt-dlp/bin/yt-dlp'),
  INSTAGRAM_FFPROBE_PATH: z
    .string()
    .refine(isAbsolute, 'Expected an absolute executable path')
    .default('/usr/bin/ffprobe'),
  INSTAGRAM_FFMPEG_PATH: z
    .string()
    .refine(isAbsolute, 'Expected an absolute executable path')
    .default('/usr/bin/ffmpeg'),
  INSTAGRAM_REELS_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(reelLimits.maximumBytes)
    .default(reelLimits.maximumBytes),
  INSTAGRAM_REELS_JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(reelLimits.jobMs)
    .default(reelLimits.jobMs),
  DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().default(2),
  DATA_PROTECTION_SECRET: z.string().min(32),
  DISCORD_TOKEN: z.string().min(1),
  LOG_LEVEL: z.enum(['error', 'info']).default('info'),
  JOLANDA_TIME_ZONE: z
    .string()
    .min(1)
    .max(100)
    .refine(timeZoneIsSupported, 'Expected a supported IANA time zone')
    .default('Europe/Bratislava'),
  MAX_CONCURRENT_TURNS: z.coerce.number().int().positive().max(5).default(2),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().min(0).max(100).default(50),
  MAX_PROMPT_CHARACTERS: z.coerce.number().int().min(8_000).max(128_000).default(32_000),
  MONGODB_DB_NAME: z.string().min(1).default('jolanda'),
  MONGODB_URI: z.string().min(1),
  MONTHLY_SPEND_LIMIT_USD: z.coerce.number().positive().default(10),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_APP_URL: optionalUrl,
  PROMPTS_PER_MINUTE: z.coerce.number().int().positive().max(20).default(3),
  TRANSCRIPT_TTL_DAYS: z.coerce.number().int().positive().max(90).default(7),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export const usdToMicrodollars = (usd: number) => Math.ceil(usd * 1_000_000);

const mongoTlsIsSecure = (uri: string) => {
  const query = uri.includes('?') ? (uri.split('?').at(-1) ?? '') : '';
  const options = [...new URLSearchParams(query)].map(
    ([key, value]) => [key.toLowerCase(), value.toLowerCase()] as const,
  );
  const explicitlyDisabled = options.some(
    ([option, value]) => ['tls', 'ssl'].includes(option) && value === 'false',
  );
  const verificationDisabled = [
    'tlsallowinvalidcertificates',
    'tlsallowinvalidhostnames',
    'tlsinsecure',
  ].some((unsafeOption) =>
    options.some(([option, value]) => option === unsafeOption && value === 'true'),
  );
  const tlsEnabled =
    uri.startsWith('mongodb+srv://') ||
    options.some(([option, value]) => ['tls', 'ssl'].includes(option) && value === 'true');
  return tlsEnabled && !explicitlyDisabled && !verificationDisabled;
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env) => {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map(({ path, message }) => `${path.join('.')}: ${message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const values = parsed.data;
  const railwayDeployment = Boolean(
    source.RAILWAY_PROJECT_ID || source.RAILWAY_ENVIRONMENT_ID || source.RAILWAY_ENVIRONMENT_NAME,
  );
  if (railwayDeployment && values.NODE_ENV !== 'production')
    throw new Error('Production deployment requires NODE_ENV=production');
  if (values.NODE_ENV === 'production' && !mongoTlsIsSecure(values.MONGODB_URI)) {
    throw new Error('Production MONGODB_URI must enforce TLS');
  }
  const maximumCostEnvelope = maximumCostEnvelopeMicrodollars(values.MAX_PROMPT_CHARACTERS);
  const dailyLimit = usdToMicrodollars(values.DAILY_SPEND_LIMIT_USD);
  const monthlyLimit = usdToMicrodollars(values.MONTHLY_SPEND_LIMIT_USD);

  if (![dailyLimit, monthlyLimit].every((limit) => Number.isSafeInteger(limit) && limit > 0)) {
    throw new Error('Configured spend limits must convert to finite safe microdollar integers');
  }

  if (dailyLimit < maximumCostEnvelope || monthlyLimit < maximumCostEnvelope) {
    throw new Error(
      `Configured spend limits must each cover the maximum per-turn cost envelope of $${(
        maximumCostEnvelope / 1_000_000
      ).toFixed(4)}`,
    );
  }

  return {
    ...values,
    dailySpendLimitMicrodollars: dailyLimit,
    monthlySpendLimitMicrodollars: monthlyLimit,
    maximumCostEnvelopeMicrodollars: maximumCostEnvelope,
    transcriptTtlMs: values.TRANSCRIPT_TTL_DAYS * 24 * 60 * 60 * 1_000,
  };
};
