import { describe, expect, it } from 'vitest';
import { createAppLogger } from '../src/logger.js';

describe('application logger', () => {
  it('emits structured deployment context and redacts sensitive fields', () => {
    const lines: string[] = [];
    const logger = createAppLogger({
      level: 'info',
      environment: 'test',
      instanceKey: 'instance-key',
      deploymentId: 'deployment-key',
      destination: { write: (line) => lines.push(line) },
    });

    logger.info({
      event: 'test_event',
      content: 'private prompt',
      authorization: 'Bearer private-token',
    });
    const event = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;

    expect(event).toMatchObject({
      service: 'jolanda-discord-bot',
      environment: 'test',
      instanceKey: 'instance-key',
      deploymentId: 'deployment-key',
      event: 'test_event',
      content: '[REDACTED]',
      authorization: '[REDACTED]',
    });
    expect(lines[0]).not.toContain('private-token');
    expect(lines[0]).not.toContain('private prompt');
  });
});
