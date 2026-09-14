import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each([[], ['--unknown'], ['--live', '--fixtures']])(
  'requires one explicit smoke mode before loading adapters: %j',
  (...args) => {
    const result = spawnSync(process.execPath, ['scripts/news-smoke.mjs', ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Choose --fixtures');
  },
);
