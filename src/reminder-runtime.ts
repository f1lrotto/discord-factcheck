import type { Logger } from 'pino';
import { createScheduledRuntime } from './scheduling/runtime.js';
import type { ReminderPublisher, ReminderPublishResult, ReminderStore } from './reminders.js';

export const createReminderRuntime = (input: {
  store: ReminderStore;
  publisher: ReminderPublisher;
  logger: Logger;
  now?: () => Date;
}) =>
  createScheduledRuntime({
    enabled: true,
    logger: input.logger,
    name: 'reminders',
    tick: async (signal) => {
      if (!input.publisher.ready()) return;
      // Bounded work prevents a backlog from starving shutdown or other scheduled features.
      for (let count = 0; count < 20 && !signal.aborted; count++) {
        const claim = await input.store.claimDue((input.now ?? (() => new Date()))());
        if (!claim) break;
        signal.throwIfAborted();
        const destination = await input.store.beginSend(claim);
        if (!destination) continue;
        let result: ReminderPublishResult;
        try {
          result = await input.publisher.publish({
            destination,
            reminder: claim.reminder,
            nonce: claim.nonce,
            signal,
          });
        } catch {
          result = { outcome: 'uncertain' };
        }
        await input.store.finishSend(claim, result);
      }
    },
  });
