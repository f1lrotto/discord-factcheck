import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const requiredEnvironment = {
  DATA_PROTECTION_SECRET: 'a'.repeat(32),
  DISCORD_GUILD_ID: 'guild',
  DISCORD_TOKEN: 'discord-token',
  MONGODB_URI: 'mongodb://localhost:27017',
  OPENROUTER_API_KEY: 'openrouter-key',
};

describe('environment configuration', () => {
  it('defaults to privacy-preserving ZDR and accepts an empty optional app URL', () => {
    const config = loadConfig({ ...requiredEnvironment, OPENROUTER_APP_URL: '' });

    expect(config.ENFORCE_ZDR).toBe(true);
    expect(config.OPENROUTER_APP_URL).toBeUndefined();
  });

  it('fails closed on an invalid ZDR value', () => {
    expect(() => loadConfig({ ...requiredEnvironment, ENFORCE_ZDR: 'yes' })).toThrow('ENFORCE_ZDR');
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
