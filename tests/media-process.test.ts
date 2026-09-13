import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runMediaProcess } from '../src/media-process.js';

const run = (code: string, extra: Partial<Parameters<typeof runMediaProcess>[0]> = {}) =>
  runMediaProcess({
    executable: process.execPath,
    args: ['-e', code],
    cwd: tmpdir(),
    signal: AbortSignal.timeout(3000),
    ...extra,
  });
describe('bounded media subprocesses', () => {
  it('reads output and excludes inherited secrets/proxy/config', async () => {
    process.env.REEL_TEST_SECRET = 'private';
    try {
      expect(await run('process.stdout.write(JSON.stringify(process.env))')).not.toContain(
        'REEL_TEST_SECRET',
      );
    } finally {
      delete process.env.REEL_TEST_SECRET;
    }
  });
  it.each([
    ['login required', 'authentication_required'],
    ['HTTP Error 429', 'rate_limited'],
    ['video removed', 'unavailable'],
    ['private unknown diagnostic', 'extractor_failed'],
  ])('classifies %s without exposing diagnostics', async (message, category) => {
    await expect(
      run(`process.stderr.write(${JSON.stringify(message)});process.exitCode=1`),
    ).rejects.toMatchObject({ category, message: category });
  });
  it('handles spawn failure and pre-abort', async () => {
    await expect(run('', { executable: '/no/such/executable' })).rejects.toMatchObject({
      category: 'extractor_failed',
    });
    await expect(run('', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      category: 'cancelled',
    });
  });
  it.each(['stdout', 'stderr'])('terminates on %s overflow', async (stream) => {
    await expect(
      run(`process.${stream}.write('x'.repeat(200000));setInterval(()=>{},1000)`, {
        maximumOutput: 100,
      }),
    ).rejects.toMatchObject({ category: 'extractor_failed' });
  });
  it('escalates termination and waits for close', async () => {
    await expect(
      run("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", {
        signal: AbortSignal.timeout(200),
        killGraceMs: 10,
      }),
    ).rejects.toMatchObject({ category: 'timeout' });
  });
  it('cancels a running child', async () => {
    const controller = new AbortController();
    const task = run('setInterval(()=>{},1000)', { signal: controller.signal });
    controller.abort();
    await expect(task).rejects.toMatchObject({ category: 'cancelled' });
  });
});
