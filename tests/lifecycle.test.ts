import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createLifecycle } from '../src/lifecycle.js';

describe('application lifecycle', () => {
  it('drains turns before disconnecting Discord and closing Mongo, once', async () => {
    const events: string[] = [];
    const lifecycle = createLifecycle({
      stopTurns: vi.fn(async () => {
        events.push('turns');
      }),
      destroyDiscord: vi.fn(() => {
        events.push('discord');
      }),
      closeStore: vi.fn(async () => {
        events.push('mongo');
      }),
      logger: pino({ enabled: false }),
    });

    await Promise.all([lifecycle.shutdown('SIGTERM'), lifecycle.shutdown('SIGTERM')]);

    expect(events).toEqual(['turns', 'discord', 'mongo']);
  });

  it('does not close Mongo when active-turn settlement fails', async () => {
    const closeStore = vi.fn(async () => undefined);
    const destroyDiscord = vi.fn();
    const lifecycle = createLifecycle({
      stopTurns: vi.fn(async () => Promise.reject(new Error('settlement failed'))),
      destroyDiscord,
      closeStore,
      logger: pino({ enabled: false }),
    });

    await expect(lifecycle.shutdown('SIGTERM')).rejects.toThrow('settlement failed');
    expect(destroyDiscord).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();
  });
});
