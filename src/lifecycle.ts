import type { Logger } from 'pino';

export const createLifecycle = (input: {
  stopTurns: () => Promise<void>;
  destroyDiscord: () => void;
  closeStore: () => Promise<void>;
  logger: Logger;
}) => {
  let shuttingDown: Promise<void> | null = null;

  const shutdown = (signal: string) => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      input.logger.info({ event: 'shutdown_started', signal });
      await input.stopTurns();
      input.destroyDiscord();
      await input.closeStore();
      input.logger.info({ event: 'shutdown_completed', signal });
    })();
    return shuttingDown;
  };

  return { shutdown };
};
