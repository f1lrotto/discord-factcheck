import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const environmentWithoutLiveKey = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== 'OPENROUTER_LIVE_TEST_KEY'),
  );

describe('paid OpenRouter test gate', () => {
  it.each([undefined, '   '])('fails closed when the capped key is %s', (key) => {
    const result = spawnSync(process.execPath, ['scripts/require-openrouter-live-key.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...environmentWithoutLiveKey(),
        ...(key === undefined ? {} : { OPENROUTER_LIVE_TEST_KEY: key }),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OPENROUTER_LIVE_TEST_KEY is required');
    expect(result.stdout).toBe('');
  });

  it('makes the complete release command fail before Vitest without a key', () => {
    const result = spawnSync('pnpm', ['test:release-live'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: environmentWithoutLiveKey(),
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('OPENROUTER_LIVE_TEST_KEY is required');
    expect(`${result.stdout}${result.stderr}`).not.toContain('RUN  v');
  });
});
