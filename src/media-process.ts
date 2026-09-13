import { spawn } from 'node:child_process';
import { ReelError } from './reel-types.js';
import { reelLimits } from './reel-limits.js';

export const runMediaProcess = (input: {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  maximumOutput?: number;
  killGraceMs?: number;
}) =>
  new Promise<string>((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new ReelError(input.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled'));
      return;
    }
    const child = spawn(input.executable, input.args, {
      shell: false,
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: input.cwd,
        TMPDIR: input.cwd,
        LANG: 'C.UTF-8',
        PYTHONNOUSERSITE: '1',
      },
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failure: ReelError | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const terminate = (error: ReelError) => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), input.killGraceMs ?? 250);
    };
    const abort = () =>
      terminate(
        new ReelError(input.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled'),
      );
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > (input.maximumOutput ?? reelLimits.stdoutBytes))
        terminate(new ReelError('extractor_failed'));
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length > reelLimits.stderrBytes)
        terminate(new ReelError('extractor_failed'));
      else stderr = Buffer.concat([stderr, chunk]);
    });
    child.on('error', () => {
      failure ??= new ReelError('extractor_failed');
    });
    child.on('close', (code) => {
      clearTimeout(escalation);
      input.signal.removeEventListener('abort', abort);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        const diagnostic = stderr.toString();
        reject(
          new ReelError(
            /login required|log in to|login is required/i.test(diagnostic)
              ? 'authentication_required'
              : /429|too many requests/i.test(diagnostic)
                ? 'rate_limited'
                : /not available|not found|removed/i.test(diagnostic)
                  ? 'unavailable'
                  : 'extractor_failed',
          ),
        );
        return;
      }
      resolve(stdout.toString());
    });
  });
