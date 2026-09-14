import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const requiredEnvironment = {
  DATA_PROTECTION_SECRET: 'a'.repeat(32),
  DISCORD_TOKEN: 'discord-token',
  MONGODB_URI: 'mongodb://localhost:27017',
  OPENROUTER_API_KEY: 'openrouter-key',
};

describe('environment configuration', () => {
  it('enables idle-by-default news and accepts only an explicit true/false kill switch', () => {
    expect(loadConfig(requiredEnvironment).NEWS_ENABLED).toBe(true);
    expect(loadConfig({ ...requiredEnvironment, NEWS_ENABLED: 'true' }).NEWS_ENABLED).toBe(true);
    expect(loadConfig({ ...requiredEnvironment, NEWS_ENABLED: 'false' }).NEWS_ENABLED).toBe(false);
    for (const value of ['', '0', 'yes', 'FALSE'])
      expect(() => loadConfig({ ...requiredEnvironment, NEWS_ENABLED: value })).toThrow(
        'NEWS_ENABLED',
      );
  });
  it('accepts an empty optional app URL without a global ZDR flag', () => {
    const config = loadConfig({ ...requiredEnvironment, OPENROUTER_APP_URL: '' });

    expect(config.OPENROUTER_APP_URL).toBeUndefined();
    expect(config).not.toHaveProperty('ENFORCE_ZDR');
    expect(config.JOLANDA_TIME_ZONE).toBe('Europe/Bratislava');
  });

  it('accepts a supported default time zone and rejects invalid values', () => {
    expect(loadConfig({ ...requiredEnvironment, JOLANDA_TIME_ZONE: 'UTC' }).JOLANDA_TIME_ZONE).toBe(
      'UTC',
    );
    expect(() =>
      loadConfig({ ...requiredEnvironment, JOLANDA_TIME_ZONE: 'Not/A_Time_Zone' }),
    ).toThrow('Expected a supported IANA time zone');
  });

  it('derives a bounded cost envelope below the default daily limit', () => {
    const config = loadConfig(requiredEnvironment);

    expect(config.maximumCostEnvelopeMicrodollars).toBeGreaterThan(100_000);
    expect(config.maximumCostEnvelopeMicrodollars).toBeLessThan(config.dailySpendLimitMicrodollars);
    expect(config.MAX_CONCURRENT_TURNS).toBe(2);
  });

  it('requires TLS for production MongoDB connections', () => {
    expect(() => loadConfig({ ...requiredEnvironment, NODE_ENV: 'production' })).toThrow(
      'must enforce TLS',
    );
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://localhost:27017/?tls=true',
      }),
    ).not.toThrow();

    for (const insecureUri of [
      'mongodb+srv://cluster.example/db?tls=false',
      'mongodb+srv://cluster.example/db?tls=false&tls=true',
      'mongodb+srv://cluster.example/db?tlsAllowInvalidCertificates=true',
      'mongodb://cluster.example/db?ssl=true&tlsAllowInvalidHostnames=true',
    ]) {
      expect(() =>
        loadConfig({
          ...requiredEnvironment,
          NODE_ENV: 'production',
          MONGODB_URI: insecureUri,
        }),
      ).toThrow('must enforce TLS');
    }
  });

  it('requires production mode when Railway deployment metadata is present', () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, RAILWAY_PROJECT_ID: 'railway-project' }),
    ).toThrow('NODE_ENV=production');
  });

  it('rejects spend limits below one worst-case turn', () => {
    expect(() => loadConfig({ ...requiredEnvironment, DAILY_SPEND_LIMIT_USD: '0.01' })).toThrow(
      'maximum per-turn cost envelope',
    );
  });

  it('rejects spend limits that cannot be represented as safe microdollar integers', () => {
    for (const unsafeLimit of ['1e308', '10000000000']) {
      expect(() =>
        loadConfig({ ...requiredEnvironment, DAILY_SPEND_LIMIT_USD: unsafeLimit }),
      ).toThrow('finite safe microdollar integers');
    }
  });
});
