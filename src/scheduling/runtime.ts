import type { Logger } from 'pino';
import { safeError } from '../security.js';

/** Serial ticks, one cancellation lifetime, and shutdown that drains active work. */
export const createScheduledRuntime = (input: {
  enabled: boolean;
  tick: (signal: AbortSignal) => Promise<void>;
  logger: Logger;
  name: string;
  intervalMs?: number;
}) => {
  const lifetime = new AbortController();
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    if (!input.enabled || lifetime.signal.aborted) return Promise.resolve();
    if (active) return active;
    active = input
      .tick(lifetime.signal)
      .catch((error: unknown) => {
        input.logger.error({ event: `${input.name}_tick_failed`, error: safeError(error) });
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  return {
    tick,
    start: async () => {
      if (!input.enabled || timer || lifetime.signal.aborted) return;
      timer = setInterval(() => void tick(), input.intervalMs ?? 30_000);
      await tick();
    },
    shutdown: async () => {
      lifetime.abort();
      clearInterval(timer);
      await active;
    },
  };
};
