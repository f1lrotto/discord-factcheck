import { z } from 'zod';
import { maximumCostEnvelopeMicrodollars } from './limits.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());

const envSchema = z.object({
  DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().default(2),
  DATA_PROTECTION_SECRET: z.string().min(32),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_TOKEN: z.string().min(1),
  ENFORCE_ZDR: booleanFromString,
  LOG_LEVEL: z.enum(['error', 'info']).default('info'),
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
